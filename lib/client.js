(() => {
  const MODULE_ID = "dsh-selection-quote-auto";
  const NS = "selection-quote";
  const STYLE_ELEMENT_ID = "dsh-selection-quote-styles";

  // ==== selection-quote-auto: 选中即复制 + 「注释」触发浮框（本地定制，非上游代码） ====
  // 选中助手消息文字后自动复制原文，并在选区上方弹出「注释」浮框；点击浮框才展开评论胶囊。
  const AUTO_COPY_ON_SELECT = true;
  const AUTO_TRIGGER_ON_SELECT = true;
  // "assistant"：仅助手消息正文触发；"any"：所有会话消息选区都触发（DOM 结构变化时的兜底）。
  const AUTO_TRIGGER_SCOPE = "assistant";
  // 「已复制」小提示的显示时长（毫秒）。
  const COPIED_HINT_MS = 1600;
  const FLOW_KIND_SELECTOR = "[data-chat-flow-kind]";

  function normalizeQuoteText(text) {
    if (typeof text !== "string") return "";
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  }

  /**
   * 复制纯文本到剪贴板：优先 Clipboard API，失败时退回隐藏 textarea + execCommand。
   * 返回 Promise<boolean>，永不抛出（失败就是 false，调用方不打扰用户）。
   */
  function copyPlainTextToClipboard(text) {
    const cleaned = normalizeQuoteText(text);
    if (!cleaned) return Promise.resolve(false);
    const fallback = () => legacyCopyToClipboard(cleaned);
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        return navigator.clipboard.writeText(cleaned).then(
          () => true,
          () => fallback()
        );
      }
    } catch (_err) {
      // 继续走回退路径
    }
    return Promise.resolve(fallback());
  }

  function legacyCopyToClipboard(text) {
    if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "-9999px";
      area.style.left = "-9999px";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return Boolean(ok);
    } catch (_err) {
      return false;
    }
  }

  /**
   * 判断选区是否命中「自动复制 + 注释浮框」的目标消息。
   * 依赖 DSH chat 的 [data-chat-flow-kind] 标注：assistant = 助手正文，
   * user/steering/turn-process/turn-trigger 等一律跳过；标注缺失时放行，避免 DSH 升级后功能整体失效。
   */
  function isAutoQuoteTargetSelection(range) {
    if (!range) return false;
    if (AUTO_TRIGGER_SCOPE !== "assistant") return true;
    const flow = closestElement(range.startContainer, FLOW_KIND_SELECTOR);
    if (!flow) return true;
    const kind = flow.getAttribute("data-chat-flow-kind") || "";
    // assistant = 助手正文节点，assistant-step = 助手回答步骤节点，两者都算助手消息。
    return kind === "assistant" || kind.startsWith("assistant-");
  }

  function formatQuoteBlock(text) {
    const cleaned = normalizeQuoteText(text);
    if (!cleaned) return "";
    return cleaned
      .split("\n")
      .map((line) => (line.trim().length > 0 ? `> ${line}` : ">"))
      .join("\n");
  }

  function formatQuoteForChat(text) {
    const block = formatQuoteBlock(text);
    if (!block) return "";
    return `${block}\n\n`;
  }

  function formatQuoteAndComment(quote, comment, options = {}) {
    const block = formatQuoteBlock(quote);
    if (!block) return "";
    const label = options.commentLabel || "批注";
    const cleanedComment = normalizeQuoteText(comment);
    if (!cleanedComment) {
      return block;
    }
    return `${block}\n**${label}**：${cleanedComment}`;
  }

  function formatBatchItems(items, options = {}) {
    if (!Array.isArray(items) || items.length === 0) return "";
    const blocks = items
      .map((item) => {
        if (!item || typeof item.quote !== "string") return "";
        return formatQuoteAndComment(item.quote, item.comment || "", options);
      })
      .filter(Boolean);
    if (blocks.length === 0) return "";
    return `${blocks.join("\n\n")}\n\n`;
  }

  function parseSentSelectionQuotes(text) {
    if (typeof text !== "string" || !text.includes(">")) {
      return null;
    }
    const normalized = text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/(\*\*(?:批注|用户评论|评论|Comment)\*\*[：:][^\n>]+?)[ \t]*(?=>[ \t]?)/g, "$1\n\n")
      .trim();
    if (!normalized) return null;
    const paragraphs = normalized.split(/\n{2,}/);
    const items = [];
    const userParagraphs = [];

    for (const para of paragraphs) {
      const lines = para.split("\n");
      if (/^>(?:[ \t]?(.*))?$/.test(lines[0])) {
        let i = 0;
        const quoteLines = [];
        while (i < lines.length && /^>(?:[ \t]?(.*))?$/.test(lines[i])) {
          const m = /^>(?:[ \t]?(.*))?$/.exec(lines[i]);
          quoteLines.push(m ? m[1] || "" : "");
          i += 1;
        }
        const quote = quoteLines.join("\n").trim();
        if (quote && i === lines.length) {
          items.push({ quote, comment: "" });
          continue;
        }
        if (quote && i < lines.length) {
          const commentMatch = /^\*\*(?:批注|用户评论|评论|Comment)\*\*[：:]\s*(.*)$/.exec(lines[i]);
          if (commentMatch) {
            const comment = [commentMatch[1] || "", ...lines.slice(i + 1)].join("\n").trim();
            items.push({ quote, comment });
            continue;
          }
        }
      }
      userParagraphs.push(para);
    }

    if (items.length === 0) {
      return null;
    }

    return {
      items,
      userMessage: userParagraphs.join("\n\n").trim(),
    };
  }

  function truncateQuotePreview(text, maxChars = 140) {
    const cleaned = normalizeQuoteText(text).replace(/\s+/g, " ");
    if (cleaned.length <= maxChars) return cleaned;
    return `${cleaned.slice(0, Math.max(1, maxChars - 1))}…`;
  }

  function computeToolbarPosition(rect, viewport = {}, mode = "pill") {
    const vw = Number(viewport.width) || (typeof window !== "undefined" ? window.innerWidth : 1280) || 1280;
    const vh = Number(viewport.height) || (typeof window !== "undefined" ? window.innerHeight : 800) || 800;
    const halfWidth = mode === "comment" ? 200 : 190;
    const margin = 16;
    const requiredTopSpace = mode === "comment" ? 84 : 64;
    const gap = mode === "comment" ? 24 : 10;

    const rawCenterX = (Number(rect?.left) || 0) + (Number(rect?.width) || 0) / 2;
    const minX = margin + halfWidth;
    const maxX = Math.max(minX, vw - margin - halfWidth);
    const left = Math.min(Math.max(rawCenterX, minX), maxX);

    const rectTop = Number(rect?.top) || 0;
    const rectBottom = Number(rect?.bottom) || rectTop + (Number(rect?.height) || 20);

    if (rectTop >= requiredTopSpace) {
      return {
        left: Math.round(left),
        top: Math.round(Math.max(margin, rectTop - gap)),
        placement: "above",
      };
    }

    return {
      left: Math.round(left),
      top: Math.round(Math.min(vh - margin, rectBottom + gap)),
      placement: "below",
    };
  }

  function focusComposerElement(hostRoot) {
    if (typeof document === "undefined") return false;
    const root =
      (hostRoot && hostRoot.closest && hostRoot.closest("[data-conversation-content]")) ||
      document;
    const editor =
      root.querySelector?.('[data-composer-card] [contenteditable="true"]') ||
      root.querySelector?.("[data-composer-card] textarea") ||
      document.querySelector?.('[data-composer-card] [contenteditable="true"]') ||
      document.querySelector?.("[data-composer-card] textarea");

    if (editor && typeof editor.focus === "function") {
      try {
        editor.focus();
        if (
          editor.getAttribute?.("contenteditable") === "true" &&
          typeof window !== "undefined" &&
          typeof window.getSelection === "function" &&
          typeof document.createRange === "function"
        ) {
          const sel = window.getSelection();
          if (sel) {
            const range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
          }
        }
        return true;
      } catch (_err) {
        return false;
      }
    }
    return false;
  }

  function insertIntoComposerDraft(ctx, sessionId, rawFormattedText, hostRoot) {
    const normalized = normalizeQuoteText(rawFormattedText);
    if (!normalized) return false;
    const textWithTrailingNewlines = `${normalized}\n\n`;

    const shell = ctx?.conversation?.input?.shell?.(sessionId);
    let inserted = false;

    if (shell) {
      const currentDraft = shell.projection?.clipboardText ?? "";
      const hasExisting = currentDraft.trim().length > 0;
      const payload = hasExisting
        ? `${currentDraft.replace(/\s+$/, "")}\n\n${textWithTrailingNewlines}`
        : textWithTrailingNewlines;

      if (!hasExisting && shell.actions && typeof shell.actions.insertText === "function") {
        try {
          const span =
            typeof shell.actions.captureInsertion === "function"
              ? shell.actions.captureInsertion()
              : undefined;
          inserted = Boolean(shell.actions.insertText(textWithTrailingNewlines, span));
        } catch (_err) {
          inserted = false;
        }
      }

      if (!inserted && typeof shell.setDraft === "function") {
        shell.setDraft(payload);
        inserted = true;
      } else if (!inserted && shell.actions && typeof shell.actions.insertText === "function") {
        const prefix = currentDraft && !currentDraft.endsWith("\n") ? "\n\n" : "";
        const span =
          typeof shell.actions.captureInsertion === "function"
            ? shell.actions.captureInsertion()
            : undefined;
        inserted = Boolean(shell.actions.insertText(`${prefix}${textWithTrailingNewlines}`, span));
      }

      if (typeof shell.focus === "function") {
        try {
          shell.focus();
        } catch (_err) {
          // ignore
        }
      }
    }

    focusComposerElement(hostRoot);
    return inserted;
  }

  function closestElement(node, selector) {
    if (!node) return null;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || typeof el.closest !== "function") return null;
    return el.closest(selector);
  }

  function isValidMessageSelection(selection, conversationRoot, minSelectionLength = 2) {
    if (!selection || selection.isCollapsed || selection.rangeCount < 1) {
      return { valid: false, text: "", rect: null };
    }
    const rawText = typeof selection.toString === "function" ? selection.toString() : "";
    const trimmed = normalizeQuoteText(rawText);
    if (trimmed.length < minSelectionLength) {
      return { valid: false, text: "", rect: null };
    }

    const range = selection.getRangeAt(0);
    const startNode = range.startContainer;
    const endNode = range.endContainer;
    const commonNode = range.commonAncestorContainer;

    const forbiddenSelector = [
      "[data-composer-seat]",
      "[data-composer-card]",
      "[data-dsh-quote-toolbar]",
      "[data-dsh-quote-dock]",
      "[data-dsh-quote-popover]",
      "[data-dsh-pin-badge]",
      '[contenteditable="true"]',
      "textarea",
      "input",
    ].join(", ");

    if (
      closestElement(startNode, forbiddenSelector) ||
      closestElement(endNode, forbiddenSelector) ||
      closestElement(commonNode, forbiddenSelector)
    ) {
      return { valid: false, text: "", rect: null, pinRect: null, range: null };
    }

    if (conversationRoot && typeof conversationRoot.contains === "function") {
      const startInside = conversationRoot.contains(startNode);
      const endInside = conversationRoot.contains(endNode);
      if (!startInside || !endInside) {
        return { valid: false, text: "", rect: null, pinRect: null, range: null };
      }
    }

    let rect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
    let firstLineRect = null;
    if (typeof range.getClientRects === "function") {
      const rects = range.getClientRects();
      if (rects && rects.length > 0) {
        firstLineRect = rects[0];
        if (!rect || (rect.width === 0 && rect.height === 0)) {
          rect = rects[0];
        }
      }
    }

    if (!rect || (rect.width === 0 && rect.height === 0)) {
      return { valid: false, text: "", rect: null, pinRect: null, range: null };
    }

    const pinSource = firstLineRect && (firstLineRect.width > 0 || firstLineRect.height > 0) ? firstLineRect : rect;
    const clonedRange = typeof range.cloneRange === "function" ? range.cloneRange() : null;

    return {
      valid: true,
      text: trimmed,
      rect: {
        top: rect.top,
        left: rect.left,
        bottom: rect.bottom,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      },
      pinRect: {
        top: pinSource.top,
        left: pinSource.left,
        bottom: pinSource.bottom,
        right: pinSource.right,
        width: pinSource.width,
        height: pinSource.height,
      },
      range: clonedRange,
    };
  }

  function createFallbackSnapshotStore(initialState) {
    let state = initialState;
    const listeners = new Set();
    const set = (next) => {
      if (Object.is(next, state)) return state;
      state = next;
      for (const listener of [...listeners]) {
        listener();
      }
      return state;
    };
    return {
      getSnapshot() {
        return state;
      },
      set,
      setState(updater) {
        const next = typeof updater === "function" ? updater(state) : updater;
        return set(next);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  function createSelectionQuoteStore(createSnapshotStoreFn = createFallbackSnapshotStore) {
    let seq = 0;
    const initialToolbar = {
      visible: false,
      mode: "pill",
      text: "",
      rect: null,
      pinRect: null,
      range: null,
      editingItemId: null,
      placement: "above",
      commentDraft: "",
    };

    const store = (createSnapshotStoreFn || createFallbackSnapshotStore)({
      items: [],
      editingId: null,
      editingComment: "",
      toolbar: initialToolbar,
    });

    const update = (recipe) => {
      if (typeof store.set === "function") {
        const prev = store.getSnapshot();
        const next = typeof recipe === "function" ? recipe(prev) : recipe;
        if (Object.is(next, prev)) return prev;
        store.set(next);
        return store.getSnapshot();
      }
      if (typeof store.setState === "function") {
        return store.setState(recipe);
      }
      if (typeof store.setSnapshot === "function") {
        const next = typeof recipe === "function" ? recipe(store.getSnapshot()) : recipe;
        store.setSnapshot(next);
        return next;
      }
      return store.getSnapshot();
    };

    return {
      getSnapshot: () => store.getSnapshot(),
      subscribe: (listener) => store.subscribe(listener),

      showContextMenu(text, rect, cursor, viewport, extra = {}) {
        const cleaned = normalizeQuoteText(text);
        if (!cleaned) return;
        const vw = viewport?.width || 1280;
        const vh = viewport?.height || 800;
        const menuWidth = 176;
        const menuHeight = 84;
        const rawX = typeof cursor?.x === "number" ? cursor.x : rect?.left || 320;
        const rawY = typeof cursor?.y === "number" ? cursor.y : rect?.bottom || 200;
        const left = Math.max(12, Math.min(rawX, vw - menuWidth - 12));
        const top = Math.max(12, Math.min(rawY, vh - menuHeight - 12));
        update((prev) => ({
          ...prev,
          toolbar: {
            visible: true,
            mode: "contextmenu",
            text: cleaned,
            rect,
            pinRect: extra.pinRect || rect,
            range: extra.range || null,
            editingItemId: null,
            left,
            top,
            placement: "contextmenu",
            commentDraft: "",
          },
        }));
      },

      showPill(text, rect, viewport, extra = {}) {
        const cleaned = normalizeQuoteText(text);
        if (!cleaned) return;
        const pos = computeToolbarPosition(rect, viewport, "pill");
        update((prev) => ({
          ...prev,
          toolbar: {
            visible: true,
            mode: "pill",
            text: cleaned,
            rect,
            pinRect: extra.pinRect || rect,
            range: extra.range || null,
            editingItemId: extra.editingItemId || null,
            left: pos.left,
            top: pos.top,
            placement: pos.placement,
            commentDraft: typeof extra.commentDraft === "string" ? extra.commentDraft : "",
          },
        }));
      },

      /**
       * 选中后直接弹出的「注释」触发浮框（本插件定制能力）。
       * 只负责把选区位置/文本存进 toolbar，真正的评论胶囊由 openCommentMode 打开。
       */
      showTrigger(text, rect, viewport, extra = {}) {
        const cleaned = normalizeQuoteText(text);
        if (!cleaned) return;
        const pos = computeToolbarPosition(rect, viewport, "pill");
        update((prev) => ({
          ...prev,
          toolbar: {
            visible: true,
            mode: "trigger",
            text: cleaned,
            rect,
            pinRect: extra.pinRect || rect,
            range: extra.range || null,
            editingItemId: null,
            left: pos.left,
            top: pos.top,
            placement: pos.placement,
            commentDraft: "",
          },
        }));
      },

      openCommentMode(textOverride, rectOverride, viewport, extra = {}) {
        update((prev) => {
          const text = normalizeQuoteText(textOverride || prev.toolbar.text);
          if (!text) return prev;
          const rect = rectOverride || prev.toolbar.rect || {
            top: 180,
            left: 480,
            bottom: 204,
            right: 640,
            width: 160,
            height: 24,
          };
          const pos = computeToolbarPosition(rect, viewport, "comment");
          return {
            ...prev,
            toolbar: {
              visible: true,
              mode: "comment",
              text,
              rect,
              pinRect: extra.pinRect || prev.toolbar.pinRect || rect,
              range: extra.range !== undefined ? extra.range : prev.toolbar.range || null,
              editingItemId:
                extra.editingItemId !== undefined ? extra.editingItemId : prev.toolbar.editingItemId || null,
              left: pos.left,
              top: pos.top,
              placement: pos.placement,
              commentDraft:
                typeof extra.commentDraft === "string"
                  ? extra.commentDraft
                  : prev.toolbar.mode === "comment" || prev.toolbar.visible
                  ? prev.toolbar.commentDraft
                  : "",
            },
          };
        });
      },

      setCommentDraft(commentDraft) {
        update((prev) => ({
          ...prev,
          toolbar: {
            ...prev.toolbar,
            commentDraft: String(commentDraft ?? ""),
          },
        }));
      },

      hideToolbar() {
        update((prev) => {
          if (!prev.toolbar.visible) return prev;
          return {
            ...prev,
            toolbar: initialToolbar,
          };
        });
      },

      addItem({ quote, comment = "", rect = null, pinRect = null, range = null }, maxItems = 20) {
        const cleanedQuote = normalizeQuoteText(quote);
        if (!cleanedQuote) return null;
        const cleanedComment = normalizeQuoteText(comment);
        seq += 1;
        const newItem = {
          id: `sq-${Date.now()}-${seq}`,
          quote: cleanedQuote,
          comment: cleanedComment,
          rect: rect || null,
          pinRect: pinRect || rect || null,
          range: range || null,
          createdAt: Date.now(),
        };
        update((prev) => {
          const nextItems = [...prev.items, newItem].slice(-Math.max(1, maxItems));
          return {
            ...prev,
            items: nextItems,
            toolbar: initialToolbar,
          };
        });
        return newItem;
      },

      removeItem(id) {
        update((prev) => ({
          ...prev,
          items: prev.items.filter((item) => item.id !== id),
          editingId: prev.editingId === id ? null : prev.editingId,
          editingComment: prev.editingId === id ? "" : prev.editingComment,
        }));
      },

      updateItem(id, patch) {
        update((prev) => ({
          ...prev,
          items: prev.items.map((item) =>
            item.id === id
              ? {
                  ...item,
                  ...(typeof patch.quote === "string" ? { quote: normalizeQuoteText(patch.quote) } : {}),
                  ...(typeof patch.comment === "string"
                    ? { comment: normalizeQuoteText(patch.comment) }
                    : {}),
                  ...(patch.range !== undefined ? { range: patch.range } : {}),
                  ...(patch.rect !== undefined ? { rect: patch.rect } : {}),
                  ...(patch.pinRect !== undefined ? { pinRect: patch.pinRect } : {}),
                }
              : item
          ),
        }));
      },

      startEditing(id) {
        update((prev) => {
          const target = prev.items.find((item) => item.id === id);
          if (!target) return prev;
          return {
            ...prev,
            editingId: id,
            editingComment: target.comment || "",
          };
        });
      },

      setEditingComment(comment) {
        update((prev) => ({
          ...prev,
          editingComment: String(comment ?? ""),
        }));
      },

      commitEditing() {
        update((prev) => {
          if (!prev.editingId) return prev;
          const cleaned = normalizeQuoteText(prev.editingComment);
          return {
            ...prev,
            items: prev.items.map((item) =>
              item.id === prev.editingId ? { ...item, comment: cleaned } : item
            ),
            editingId: null,
            editingComment: "",
          };
        });
      },

      cancelEditing() {
        update((prev) => ({
          ...prev,
          editingId: null,
          editingComment: "",
        }));
      },

      clearItems() {
        update((prev) => ({
          ...prev,
          items: [],
          editingId: null,
          editingComment: "",
        }));
      },
    };
  }

  function ensureStylesInjected() {
    if (typeof document === "undefined") return;
    let style = document.getElementById(STYLE_ELEMENT_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ELEMENT_ID;
      document.head.appendChild(style);
    }
    style.textContent = `
      /* Ensure composer overlay anchor expands in flow when the N-comments pill is mounted inside the input card */
      [data-composer-overlay]:has([data-dsh-quote-dock]) {
        position: relative !important;
        height: auto !important;
        inset: auto !important;
        padding: 4px 12px 0 12px !important;
        display: flex !important;
        align-items: center !important;
        z-index: 20 !important;
      }

      /* Also keep standalone dock fallback clean if rendered in conversation.input.dock */
      [data-composer-seat] > div:has(> [data-dsh-quote-dock]) {
        order: -1;
        flex-wrap: wrap !important;
        width: 100% !important;
        max-width: var(--dsh-composer-card-max-width, 820px) !important;
        padding-top: 0 !important;
        padding-bottom: 6px !important;
      }

      [data-dsh-quote-dock] {
        position: relative;
        display: inline-flex;
        align-items: center;
        box-sizing: border-box;
        font-family: var(--dsh-font-sans, var(--dsw-font-family, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif));
      }

      /* Floating selection capsule anchor */
      .dsh-sq-toolbar-anchor {
        position: fixed;
        z-index: 9999;
        pointer-events: auto;
        font-family: var(--dsh-font-sans, var(--dsw-font-family, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif));
        transition: opacity 0.14s cubic-bezier(0.16, 1, 0.3, 1), transform 0.14s cubic-bezier(0.16, 1, 0.3, 1);
      }

      .dsh-sq-toolbar-anchor[data-placement="above"] {
        transform: translate(-50%, -100%);
      }

      .dsh-sq-toolbar-anchor[data-placement="below"] {
        transform: translate(-50%, 0);
      }

      .dsh-sq-toolbar-anchor[data-placement="contextmenu"] {
        transform: none;
      }

      /* 选中/已引用的文本标记：暖色波浪下划线，不再用蓝色底色压住文字。
         分两个 Highlight 名称：active = 刚选中/待确认的选区；saved = 已加入 💬 队列的引用片段。 */
      ::highlight(dsh-selection-quote-active) {
        background-color: rgba(245, 158, 11, 0.12);
        color: inherit;
        text-decoration: underline wavy rgb(234, 88, 12);
        text-decoration-thickness: 2px;
        text-underline-offset: 3px;
      }

      ::highlight(dsh-selection-quote-saved) {
        background-color: transparent;
        color: inherit;
        text-decoration: underline dotted rgba(194, 65, 12, 0.85);
        text-decoration-thickness: 2px;
        text-underline-offset: 3px;
      }

      @media (prefers-color-scheme: dark) {
        ::highlight(dsh-selection-quote-active) {
          background-color: rgba(251, 191, 36, 0.16);
          color: inherit;
          text-decoration: underline wavy rgb(251, 191, 36);
        }

        ::highlight(dsh-selection-quote-saved) {
          background-color: transparent;
          color: inherit;
          text-decoration: underline dotted rgba(251, 191, 36, 0.75);
        }
      }

      .dsh-sq-selection-rect {
        position: fixed;
        pointer-events: none;
        background: rgba(245, 158, 11, 0.16);
        border-radius: 3px;
        z-index: 9990;
      }

      /* Right-click context menu ("拷贝" + "添加到对话") */
      .dsh-sq-context-menu {
        display: flex;
        flex-direction: column;
        min-width: 172px;
        padding: 5px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.96);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        border: 1px solid rgba(15, 23, 42, 0.11);
        box-shadow:
          0 12px 32px -4px rgba(15, 23, 42, 0.18),
          0 2px 8px -1px rgba(15, 23, 42, 0.08);
        box-sizing: border-box;
        user-select: none;
      }

            body[data-ds-dark-theme] .dsh-sq-context-menu {
        background: rgba(30, 35, 46, 0.96);
        border-color: rgba(255, 255, 255, 0.14);
        box-shadow:
        0 14px 36px -4px rgba(0, 0, 0, 0.55),
        0 2px 10px -1px rgba(0, 0, 0, 0.35);
      }

      body[data-ds-dark-theme] .dsh-sq-context-menu,
      .dark .dsh-sq-context-menu {
        background: rgba(30, 35, 46, 0.96);
        border-color: rgba(255, 255, 255, 0.14);
      }

      .dsh-sq-context-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        width: 100%;
        padding: 6px 10px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--dsh-text-primary, #14171f);
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        text-align: left;
        cursor: pointer;
        transition: background-color 0.1s ease, color 0.1s ease;
      }

      .dsh-sq-context-item:hover {
        background: #2563eb;
        color: #ffffff;
      }

            body[data-ds-dark-theme] .dsh-sq-context-item {
        color: #f1f5f9;
      }

      body[data-ds-dark-theme] .dsh-sq-context-item,
      .dark .dsh-sq-context-item {
        color: #f1f5f9;
      }

      .dsh-sq-context-item-left {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }

      .dsh-sq-context-item-kbd {
        font-size: 11.5px;
        opacity: 0.65;
        font-weight: 400;
      }

      .dsh-sq-context-item:hover .dsh-sq-context-item-kbd {
        opacity: 0.92;
      }

      .dsh-sq-context-sep {
        height: 1px;
        margin: 4px 6px;
        background: rgba(15, 23, 42, 0.08);
      }

            body[data-ds-dark-theme] .dsh-sq-context-sep {
        background: rgba(255, 255, 255, 0.1);
      }

      /* selection-quote-auto: 选中后直接弹出的「注释」触发浮框 + 「已复制」提示 */
      .dsh-sq-trigger {
        position: relative;
        display: inline-flex;
        align-items: center;
        user-select: none;
      }

      .dsh-sq-trigger-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 5px 11px;
        border-radius: 999px;
        border: 1px solid rgba(15, 23, 42, 0.12);
        background: rgba(255, 255, 255, 0.96);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        box-shadow:
          0 8px 24px -6px rgba(15, 23, 42, 0.22),
          0 1px 4px rgba(15, 23, 42, 0.08);
        color: rgb(30, 41, 59);
        font: inherit;
        font-size: 12px;
        line-height: 18px;
        cursor: pointer;
        transition: background 0.12s ease, border-color 0.12s ease;
      }

      .dsh-sq-trigger-btn:hover {
        background: rgba(241, 245, 249, 0.98);
        border-color: rgba(37, 99, 235, 0.32);
      }

      .dsh-sq-trigger-btn:active {
        transform: translateY(0.5px);
      }

      .dsh-sq-trigger-copied {
        position: absolute;
        left: calc(100% + 6px);
        top: 50%;
        transform: translateY(-50%);
        white-space: nowrap;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        background: rgba(255, 255, 255, 0.92);
        color: rgb(100, 116, 139);
        font-size: 11px;
        line-height: 16px;
        pointer-events: none;
        animation: dsh-sq-copied-in 0.14s ease-out;
      }

      @keyframes dsh-sq-copied-in {
        from {
          opacity: 0;
          transform: translateY(-50%) translateX(-3px);
        }
        to {
          opacity: 1;
          transform: translateY(-50%) translateX(0);
        }
      }

      body[data-ds-dark-theme] .dsh-sq-trigger-btn,
      .dark .dsh-sq-trigger-btn {
        background: rgba(30, 35, 46, 0.96);
        border-color: rgba(255, 255, 255, 0.14);
        color: rgb(226, 232, 240);
      }

      body[data-ds-dark-theme] .dsh-sq-trigger-btn:hover,
      .dark .dsh-sq-trigger-btn:hover {
        background: rgba(45, 52, 66, 0.98);
      }

      body[data-ds-dark-theme] .dsh-sq-trigger-copied,
      .dark .dsh-sq-trigger-copied {
        background: rgba(30, 35, 46, 0.92);
        border-color: rgba(255, 255, 255, 0.12);
        color: rgb(148, 163, 184);
      }

      /* Codex-style rounded capsule input ("添加可选评论...") */
      .dsh-sq-capsule {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        width: 368px;
        max-width: calc(100vw - 32px);
        height: 46px;
        padding: 0 7px 0 18px;
        border-radius: 999px;
        background: var(--dsh-surface-floating, #ffffff);
        color: var(--dsh-text-primary, #14171f);
        border: 1px solid rgba(15, 23, 42, 0.09);
        box-shadow:
          0 12px 32px -6px rgba(15, 23, 42, 0.16),
          0 2px 8px -1px rgba(15, 23, 42, 0.07);
        box-sizing: border-box;
      }

            body[data-ds-dark-theme] .dsh-sq-capsule {
        background: var(--dsh-surface-floating, #1f2430);
        color: var(--dsh-text-primary, #f1f5f9);
        border-color: rgba(255, 255, 255, 0.14);
        box-shadow:
        0 14px 36px -6px rgba(0, 0, 0, 0.56),
        0 2px 10px -1px rgba(0, 0, 0, 0.36);
      }

      body[data-ds-dark-theme] .dsh-sq-capsule,
      .dark .dsh-sq-capsule {
        background: var(--dsh-surface-floating, #1f2430);
        color: var(--dsh-text-primary, #f1f5f9);
        border-color: rgba(255, 255, 255, 0.14);
        box-shadow:
          0 14px 36px -6px rgba(0, 0, 0, 0.56),
          0 2px 10px -1px rgba(0, 0, 0, 0.36);
      }

      .dsh-sq-capsule-input {
        flex: 1;
        min-width: 0;
        height: 100%;
        border: none;
        outline: none;
        background: transparent;
        color: inherit;
        font-family: inherit;
        font-size: 14px;
        line-height: 20px;
        padding: 0;
      }

      .dsh-sq-capsule-input::placeholder {
        color: #9ca3af;
      }

      .dsh-sq-capsule-submit {
        width: 32px;
        height: 32px;
        border-radius: 999px;
        border: none;
        background: #14171f;
        color: #ffffff;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        flex-shrink: 0;
        padding: 0;
        transition: transform 0.12s ease, opacity 0.12s ease, background-color 0.12s ease;
      }

            body[data-ds-dark-theme] .dsh-sq-capsule-submit {
        background: #3b82f6;
        color: #ffffff;
      }

      body[data-ds-dark-theme] .dsh-sq-capsule-submit,
      .dark .dsh-sq-capsule-submit {
        background: #3b82f6;
        color: #ffffff;
      }

      .dsh-sq-capsule-submit:hover {
        opacity: 0.9;
        transform: scale(1.03);
      }

      .dsh-sq-capsule-submit:active {
        transform: scale(0.96);
      }

      /* Blue teardrop numbered pin badge (1, 2...) anchored at top-right of selected text */
      .dsh-sq-pin-badge {
        position: fixed;
        z-index: 9998;
        width: 26px;
        height: 26px;
        border-radius: 50% 50% 50% 4px;
        background: var(--dsw-alias-state-business-primary, #2563eb);
        color: #ffffff;
        font-family: var(--dsh-font-sans, var(--dsw-font-family, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif));
        font-size: 12.5px;
        font-weight: 700;
        line-height: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 12px rgba(37, 99, 235, 0.35), 0 0 0 1.5px #ffffff;
        transform: translate(2px, -85%);
        cursor: pointer;
        user-select: none;
        pointer-events: auto;
        transition: transform 0.12s ease, filter 0.12s ease;
      }

      .dsh-sq-pin-badge:hover {
        transform: translate(2px, -85%) scale(1.08);
        filter: brightness(1.06);
      }

      /* Compact "N 条注释 ×" pill inside top-left of composer input card */
      .dsh-sq-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 30px;
        padding: 0 9px 0 10px;
        border-radius: 999px;
        background: var(--dsh-surface-card, #ffffff);
        color: var(--dsh-text-primary, #1f2329);
        border: 1px solid rgba(15, 23, 42, 0.11);
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
        font-size: 13px;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        user-select: none;
        transition: border-color 0.12s ease, background-color 0.12s ease;
      }

      .dsh-sq-chip:hover {
        border-color: rgba(37, 99, 235, 0.36);
        background: rgba(37, 99, 235, 0.03);
      }

            body[data-ds-dark-theme] .dsh-sq-chip {
        background: rgba(30, 35, 46, 0.92);
        color: #f1f5f9;
        border-color: rgba(255, 255, 255, 0.14);
      }

      body[data-ds-dark-theme] .dsh-sq-chip,
      .dark .dsh-sq-chip {
        background: rgba(30, 35, 46, 0.92);
        color: #f1f5f9;
        border-color: rgba(255, 255, 255, 0.14);
      }

      .dsh-sq-chip-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #64748b;
      }

      .dsh-sq-chip-clear {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        margin-left: 1px;
        border-radius: 999px;
        border: none;
        background: rgba(148, 163, 184, 0.22);
        color: #475569;
        padding: 0;
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
        transition: background-color 0.12s ease, color 0.12s ease;
      }

      .dsh-sq-chip-clear:hover {
        background: rgba(148, 163, 184, 0.38);
        color: #0f172a;
      }

            body[data-ds-dark-theme] .dsh-sq-chip-clear {
        background: rgba(255, 255, 255, 0.16);
        color: #cbd5e1;
      }
      body[data-ds-dark-theme] .dsh-sq-chip-clear:hover {
        background: rgba(255, 255, 255, 0.28);
        color: #ffffff;
      }

      /* Hover/click popover detail card above the "N 条注释 ×" pill */
      .dsh-sq-popover-card {
        position: absolute;
        left: 0;
        bottom: calc(100% + 10px);
        width: 440px;
        max-width: min(460px, calc(100vw - 40px));
        max-height: 360px;
        overflow-y: auto;
        border-radius: 16px;
        background: var(--dsh-surface-floating, #ffffff);
        color: var(--dsh-text-primary, #14171f);
        border: 1px solid rgba(15, 23, 42, 0.09);
        box-shadow:
          0 16px 40px -8px rgba(15, 23, 42, 0.18),
          0 4px 12px -2px rgba(15, 23, 42, 0.08);
        padding: 6px 0;
        z-index: 10000;
        box-sizing: border-box;
      }

            body[data-ds-dark-theme] .dsh-sq-popover-card {
        background: #1e2330;
        color: #f1f5f9;
        border-color: rgba(255, 255, 255, 0.14);
        box-shadow:
        0 18px 44px -8px rgba(0, 0, 0, 0.58),
        0 4px 14px -2px rgba(0, 0, 0, 0.36);
      }

      body[data-ds-dark-theme] .dsh-sq-popover-card,
      .dark .dsh-sq-popover-card {
        background: #1e2330;
        color: #f1f5f9;
        border-color: rgba(255, 255, 255, 0.14);
        box-shadow:
          0 18px 44px -8px rgba(0, 0, 0, 0.58),
          0 4px 14px -2px rgba(0, 0, 0, 0.36);
      }

      .dsh-sq-popover-item {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 12px 16px;
        border-bottom: 1px solid rgba(15, 23, 42, 0.06);
      }

      .dsh-sq-popover-item:last-child {
        border-bottom: none;
      }

            body[data-ds-dark-theme] .dsh-sq-popover-item {
        border-bottom-color: rgba(255, 255, 255, 0.08);
      }

      .dsh-sq-popover-index {
        font-size: 13.5px;
        font-weight: 500;
        color: #64748b;
        line-height: 1.45;
        flex-shrink: 0;
        min-width: 18px;
      }

      .dsh-sq-popover-body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .dsh-sq-popover-label {
        font-size: 12.5px;
        color: #94a3b8;
        line-height: 1.35;
      }

      .dsh-sq-popover-text {
        font-size: 13.5px;
        line-height: 1.5;
        color: var(--dsh-text-primary, #14171f);
        word-break: break-word;
      }

            body[data-ds-dark-theme] .dsh-sq-popover-text {
        color: #f1f5f9;
      }

      body[data-ds-dark-theme] .dsh-sq-popover-text,
      .dark .dsh-sq-popover-text {
        color: #f1f5f9;
      }

      .dsh-sq-popover-actions {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
        margin-left: 4px;
      }

      .dsh-sq-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border-radius: 7px;
        border: none;
        background: transparent;
        color: #64748b;
        cursor: pointer;
        padding: 0;
        transition: background-color 0.12s ease, color 0.12s ease;
      }

      .dsh-sq-icon-btn:hover {
        background: rgba(148, 163, 184, 0.16);
        color: #0f172a;
      }

            body[data-ds-dark-theme] .dsh-sq-icon-btn:hover {
        background: rgba(255, 255, 255, 0.12);
        color: #ffffff;
      }

      .dsh-sq-edit-input {
        width: 100%;
        padding: 5px 8px;
        border-radius: 8px;
        border: 1px solid #2563eb;
        background: var(--dsh-surface-input, rgba(255, 255, 255, 0.95));
        color: inherit;
        font-size: 13px;
        font-family: inherit;
        outline: none;
        box-sizing: border-box;
      }

            body[data-ds-dark-theme] .dsh-sq-edit-input {
        background: rgba(15, 18, 26, 0.9);
      }

      /* Enable the composer Send button visually & interactively when staged comments exist even if text draft is empty */
      [data-composer-card]:has([data-dsh-quote-dock]) button:has(svg path[d^="M8.3125"]) {
        opacity: 1 !important;
        cursor: pointer !important;
        pointer-events: auto !important;
      }

      [data-composer-card]:has([data-dsh-quote-dock]) button:has(svg path[d^="M8.3125"]):hover {
        background: var(--dsw-alias-button-info-hover, #1d4ed8) !important;
      }

      /* Sent user message bubble transformation: show "💬 N 条注释" pill on top + optional user text bubble below */
      [class*="_bubble"]:has([data-dsh-sent-quotes]),
      div:has(> span > [data-dsh-sent-quotes]) {
        background: transparent !important;
        padding: 0 !important;
        border-radius: 0 !important;
        box-shadow: none !important;
      }

      [class*="_userStack"]:has([data-dsh-sent-quotes]) > [class*="_bubble"] {
        background: transparent !important;
        padding: 0 !important;
        border-radius: 0 !important;
        box-shadow: none !important;
      }

      span:has([data-dsh-sent-quotes]) {
        display: flex !important;
        flex-direction: column !important;
        align-items: flex-end !important;
      }

      .dsh-sq-sent-stack {
        display: inline-flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
        max-width: 100%;
        font-family: var(--dsh-font-sans, var(--dsw-font-family, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif));
      }

      .dsh-sq-sent-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 30px;
        padding: 0 12px;
        border-radius: 999px;
        background: var(--dsh-surface-card, #ffffff);
        color: var(--dsh-text-primary, #1f2329);
        border: 1px solid rgba(15, 23, 42, 0.11);
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
        font-size: 13px;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        transition: border-color 0.12s ease, background-color 0.12s ease;
      }

      .dsh-sq-sent-chip:hover {
        border-color: rgba(37, 99, 235, 0.36);
        background: rgba(37, 99, 235, 0.03);
      }

            body[data-ds-dark-theme] .dsh-sq-sent-chip {
        background: rgba(30, 35, 46, 0.92);
        color: #f1f5f9;
        border-color: rgba(255, 255, 255, 0.14);
      }

      body[data-ds-dark-theme] .dsh-sq-sent-chip,
      .dark .dsh-sq-sent-chip {
        background: rgba(30, 35, 46, 0.92);
        color: #f1f5f9;
        border-color: rgba(255, 255, 255, 0.14);
      }

      .dsh-sq-sent-user-bubble {
        background: var(--dsw-specific-bubble, #fcefe3);
        border-radius: var(--dsw-radius-xl, 18px);
        max-width: 100%;
        font-size: var(--dsh-content-font-size, 14px);
        line-height: calc(22px + var(--dsh-content-font-delta, 0px));
        color: var(--dsw-alias-label-primary, #14171f);
        white-space: pre-wrap;
        word-break: break-word;
        padding: 10px 16px;
        box-sizing: border-box;
      }

      .dsh-sq-sent-popover-card {
        position: fixed;
        bottom: auto;
        left: auto;
        width: 440px;
        max-width: min(460px, calc(100vw - 32px));
        max-height: 360px;
        overflow-y: auto;
        z-index: 10001;
      }
    
      /* ==== Liquid Glass（selection-quote-auto）：白色磨砂玻璃浮层 ==== */
      .dsh-sq-chip,
      .dsh-sq-popover-card,
      .dsh-sq-sent-chip,
      .dsh-sq-sent-popover-card {
        background-color: rgba(255, 255, 255, 0.5);
        background-image:
          radial-gradient(130% 150% at 18% 0%, rgba(255, 255, 255, 0.95) 0%, rgba(255, 255, 255, 0.26) 46%, rgba(255, 255, 255, 0) 74%),
          linear-gradient(155deg, rgba(255, 255, 255, 0.82) 0%, rgba(255, 255, 255, 0.44) 52%, rgba(255, 255, 255, 0.68) 100%);
        -webkit-backdrop-filter: blur(26px) saturate(190%);
        backdrop-filter: blur(26px) saturate(190%);
        border: 1px solid rgba(255, 255, 255, 0.8);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.98),
          inset 1px 0 0 rgba(255, 255, 255, 0.55),
          inset 0 -1px 0 rgba(15, 23, 42, 0.05),
          0 0 0 1px rgba(15, 23, 42, 0.06),
          0 14px 34px -10px rgba(15, 23, 42, 0.24),
          0 3px 10px -4px rgba(15, 23, 42, 0.12);
        color: #1f2329;
      }

      .dsh-sq-chip:hover,
      .dsh-sq-sent-chip:hover {
        background-color: rgba(255, 255, 255, 0.74);
        border-color: rgba(255, 255, 255, 0.94);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.98),
          inset 0 -1px 0 rgba(15, 23, 42, 0.05),
          0 0 0 1px rgba(37, 99, 235, 0.1),
          0 16px 36px -10px rgba(15, 23, 42, 0.26);
      }

      .dsh-sq-popover-label {
        color: #64748b;
      }

      body[data-ds-dark-theme] .dsh-sq-chip,
      body[data-ds-dark-theme] .dsh-sq-popover-card,
      body[data-ds-dark-theme] .dsh-sq-sent-chip,
      body[data-ds-dark-theme] .dsh-sq-sent-popover-card {
        background-color: rgba(32, 38, 50, 0.58);
        background-image:
          radial-gradient(130% 150% at 18% 0%, rgba(255, 255, 255, 0.26) 0%, rgba(255, 255, 255, 0.05) 46%, rgba(255, 255, 255, 0) 72%),
          linear-gradient(155deg, rgba(52, 60, 76, 0.66) 0%, rgba(26, 31, 42, 0.56) 55%, rgba(40, 47, 60, 0.62) 100%);
        border-color: rgba(255, 255, 255, 0.22);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.24),
          inset 0 -1px 0 rgba(0, 0, 0, 0.22),
          0 0 0 1px rgba(0, 0, 0, 0.22),
          0 16px 38px -10px rgba(0, 0, 0, 0.55);
        color: #f1f5f9;
      }

      body[data-ds-dark-theme] .dsh-sq-popover-label {
        color: #94a3b8;
      }
`;
  }

  function buildModule(require) {
    const React = require("react");
    const ReactDOM = require("react-dom");
    const jsxRuntime = require("react/jsx-runtime");
    const storePkg = (() => {
      try {
        return require("@deepseek-ai/dsh-client-store");
      } catch (_err) {
        return {};
      }
    })();

    const createSnapshotStore = storePkg.createSnapshotStore || createFallbackSnapshotStore;
    const useStore =
      storePkg.useStore ||
      ((store, selector = (s) => s) =>
        React.useSyncExternalStore(
          store.subscribe,
          () => selector(store.getSnapshot()),
          () => selector(store.getSnapshot())
        ));

    const sessionStores = new Map();
    function getSessionStore(sessionId) {
      const key = String(sessionId || "__default__");
      let store = sessionStores.get(key);
      if (!store) {
        store = createSelectionQuoteStore(createSnapshotStore);
        sessionStores.set(key, store);
      }
      return store;
    }

    function rectToPlain(rect) {
      if (!rect) return null;
      const top = Number(rect.top);
      const left = Number(rect.left);
      if (!Number.isFinite(top) || !Number.isFinite(left)) return null;
      return {
        top,
        left,
        bottom: Number(rect.bottom),
        right: Number(rect.right),
        width: Number(rect.width) || 0,
        height: Number(rect.height) || 0,
      };
    }

    /** Range 指向的节点是否仍在文档里（消息重渲染后 cloneRange 会失效）。 */
    function isRangeConnected(range) {
      if (!range) return false;
      const start = range.startContainer;
      const end = range.endContainer;
      if (!start || !end) return false;
      return start.isConnected !== false && end.isConnected !== false;
    }

    /**
     * Range 是否仍然可信：节点在文档里，且它当前覆盖的文字与记录的原引用一致。
     * DOM 重渲染时浏览器会把失效 Range 的边界重映射到被移除节点的父元素上（isConnected 仍为 true），
     * 只查 isConnected 会拿到整块容器的 rect —— 这正是角标“穿模”到标题栏/输入框的根因。
     */
    function rangeMatchesQuote(range, quote) {
      if (!range || !isRangeConnected(range)) return false;
      const expected = normalizeQuoteText(quote);
      if (!expected) return false;
      try {
        return normalizeQuoteText(range.toString()) === expected;
      } catch (_err) {
        return false;
      }
    }

    function collectTextNodeIndex(root) {
      const nodes = [];
      let full = "";
      if (!root || typeof document === "undefined") return { nodes, full };
      const walker = document.createTreeWalker(
        root,
        typeof NodeFilter !== "undefined" ? NodeFilter.SHOW_TEXT : 4
      );
      let current = walker.nextNode();
      while (current) {
        const value = current.nodeValue || "";
        if (value.length > 0) {
          nodes.push({ node: current, start: full.length, end: full.length + value.length });
          full += value;
        }
        current = walker.nextNode();
      }
      return { nodes, full };
    }

    function locateTextOffset(nodes, offset) {
      if (!nodes.length) return null;
      const target = Math.max(0, offset);
      let lo = 0;
      let hi = nodes.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (nodes[mid].end <= target) lo = mid + 1;
        else hi = mid;
      }
      const entry = nodes[lo];
      const length = (entry.node.nodeValue || "").length;
      return { node: entry.node, offset: Math.max(0, Math.min(target - entry.start, length)) };
    }

    /**
     * 消息 DOM 重渲染后，用引用原文在会话文本里重新定位，生成新的 Range。
     * 多行引用按行顺序查找（允许行与行之间夹杂 DOM 结构），找到几行就锚定几行。
     */
    function findQuoteTextRange(root, quote) {
      const cleaned = normalizeQuoteText(quote);
      if (!root || !cleaned) return null;
      const { nodes, full } = collectTextNodeIndex(root);
      if (!full) return null;
      const parts = cleaned
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (parts.length === 0) return null;
      let cursor = 0;
      let startOffset = -1;
      let endOffset = -1;
      for (let i = 0; i < parts.length; i++) {
        const found = full.indexOf(parts[i], cursor);
        if (found < 0) break;
        if (i === 0) startOffset = found;
        cursor = found + parts[i].length;
        endOffset = cursor;
      }
      if (startOffset < 0 || endOffset <= startOffset) return null;
      const start = locateTextOffset(nodes, startOffset);
      const end = locateTextOffset(nodes, endOffset);
      if (!start || !end) return null;
      try {
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        return isRangeConnected(range) ? range : null;
      } catch (_err) {
        return null;
      }
    }

    function resolveLivePinRect(item) {
      if (!item) return null;
      const range = item.range;
      if (range) {
        // 有 Range 就必须仍然对得上原文；失效时宁可隐藏角标，也不要回退到过期的 viewport 坐标（会“穿模”到标题栏/输入框上）。
        if (!rangeMatchesQuote(range, item.quote)) return null;
        try {
          const r = range.getBoundingClientRect();
          if (r && (r.width > 0 || r.height > 0)) {
            if (typeof range.getClientRects === "function") {
              const rects = range.getClientRects();
              if (rects && rects.length > 0 && (rects[0].width > 0 || rects[0].height > 0)) {
                return rects[0];
              }
            }
            return r;
          }
        } catch (_err) {
          // 失效 Range：直接隐藏
        }
        return null;
      }
      return item.pinRect || item.rect || null;
    }

    /** 角标允许出现的“消息可读区域”（滚动区与输入框之间），避免压在标题栏/输入框上。 */
    function computePinBounds() {
      if (typeof document === "undefined" || typeof window === "undefined") return null;
      const rectOf = (el) => (el && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null);
      const scrollRect = rectOf(document.querySelector("[data-conversation-scroll]"));
      const contentRect = rectOf(document.querySelector("[data-conversation-content]"));
      const composerRect = rectOf(document.querySelector("[data-composer-card]"));
      const area = scrollRect || contentRect;
      if (!area && !composerRect) return null;
      return {
        top: Math.max(area ? area.top : 0, 8) + 6,
        bottom:
          Math.min(area ? area.bottom : window.innerHeight, composerRect ? composerRect.top : window.innerHeight) - 6,
        left: (area ? area.left : 0) - 24,
        right: (area ? area.right : window.innerWidth) + 24,
      };
    }

    function isRectInPinBounds(rect, bounds) {
      if (!rect || (rect.width === 0 && rect.height === 0)) return false;
      if (!bounds) return true;
      return (
        rect.bottom >= bounds.top &&
        rect.top <= bounds.bottom &&
        rect.right >= bounds.left &&
        rect.left <= bounds.right
      );
    }

    function pinCoords(rect) {
      const maxRight = (typeof window !== "undefined" ? window.innerWidth : 1280) - 30;
      return {
        left: Math.round(Math.min(rect.right, maxRight)),
        top: Math.round(rect.top),
      };
    }

    function createSelectionOverlayComponent(ctx, InlineDockComponent) {
      return function SelectionQuoteOverlay({ sessionId }) {
        const store = React.useMemo(() => getSessionStore(sessionId), [sessionId]);
        const toolbar = useStore(store, (s) => s.toolbar);
        const items = useStore(store, (s) => s.items);
        const probeRef = React.useRef(null);
        const toolbarRef = React.useRef(null);
        const inputRef = React.useRef(null);
        const lastSelectionRef = React.useRef(null);
        const copiedHintTimerRef = React.useRef(null);
        const syncPinsRef = React.useRef(null);
        const [copiedHint, setCopiedHint] = React.useState ? React.useState(false) : [false, () => {}];

        React.useEffect(() => {
          return () => {
            if (copiedHintTimerRef.current) clearTimeout(copiedHintTimerRef.current);
          };
        }, []);

        const flashCopiedHint = React.useCallback(() => {
          if (copiedHintTimerRef.current) clearTimeout(copiedHintTimerRef.current);
          setCopiedHint(true);
          copiedHintTimerRef.current = setTimeout(() => {
            copiedHintTimerRef.current = null;
            setCopiedHint(false);
          }, COPIED_HINT_MS);
        }, []);

        React.useEffect(() => {
          ensureStylesInjected();
        }, []);

        React.useEffect(() => {
          if (toolbar.visible && toolbar.mode === "comment" && inputRef.current) {
            const timer = setTimeout(() => {
              inputRef.current?.focus?.();
            }, 15);
            return () => clearTimeout(timer);
          }
        }, [toolbar.visible, toolbar.mode, toolbar.text]);

        const getConversationRoot = React.useCallback(() => {
          if (probeRef.current && typeof probeRef.current.closest === "function") {
            const found = probeRef.current.closest("[data-conversation-content]");
            if (found) return found;
          }
          return typeof document !== "undefined"
            ? document.querySelector("[data-conversation-content]")
            : null;
        }, []);

        const handleAddToChat = React.useCallback(
          (textToInsert) => {
            const targetText = normalizeQuoteText(textToInsert || store.getSnapshot().toolbar.text);
            if (!targetText) return false;
            const formatted = formatQuoteForChat(targetText);
            insertIntoComposerDraft(ctx, sessionId, formatted, probeRef.current);
            store.hideToolbar();
            if (typeof window !== "undefined" && typeof window.getSelection === "function") {
              try {
                window.getSelection()?.removeAllRanges?.();
              } catch (_err) {
                // ignore
              }
            }
            return true;
          },
          [sessionId, store]
        );

        const handleCommitCapsuleComment = React.useCallback(() => {
          const snap = store.getSnapshot().toolbar;
          const targetText = normalizeQuoteText(snap.text);
          if (!targetText) return false;
          const commentText = normalizeQuoteText(snap.commentDraft);
          if (snap.editingItemId) {
            store.updateItem(snap.editingItemId, { comment: commentText });
            store.hideToolbar();
          } else {
            store.addItem({
              quote: targetText,
              comment: commentText,
              rect: snap.rect,
              pinRect: snap.pinRect || snap.rect,
              range: snap.range || null,
            });
          }
          if (typeof window !== "undefined" && typeof window.getSelection === "function") {
            try {
              window.getSelection()?.removeAllRanges?.();
            } catch (_err) {
              // ignore
            }
          }
          setTimeout(() => {
            try {
              ctx?.conversation?.input?.shell?.(sessionId)?.focus?.();
            } catch (_err) {
              // ignore
            }
            focusComposerElement(probeRef.current);
          }, 20);
          return true;
        }, [sessionId, store]);

        const handleDirectInsertWithComment = React.useCallback(() => {
          const snap = store.getSnapshot().toolbar;
          if (!snap.text) return false;
          const formatted = formatQuoteAndComment(snap.text, snap.commentDraft);
          insertIntoComposerDraft(ctx, sessionId, formatted, probeRef.current);
          store.hideToolbar();
          if (typeof window !== "undefined" && typeof window.getSelection === "function") {
            try {
              window.getSelection()?.removeAllRanges?.();
            } catch (_err) {
              // ignore
            }
          }
          return true;
        }, [sessionId, store]);

        // 角标跟随滚动：滚动/惯性滚动时用 rAF 直接改 DOM 坐标（不经 React 重渲染），
        // 否则 React 的异步渲染会比内容慢 1~2 帧，视觉上就是角标“拖着惯性”跟不上文字。
        React.useEffect(() => {
          if (typeof document === "undefined" || typeof window === "undefined") return;
          let raf = 0;
          let lastActivity = 0;

          const resolvePinRectByKey = (key) => {
            const snapshot = store.getSnapshot();
            if (key === "pin-active-selection") {
              const toolbarState = snapshot.toolbar;
              if (!toolbarState) return null;
              if (toolbarState.range === null || toolbarState.range === undefined) {
                return toolbarState.pinRect || toolbarState.rect || null;
              }
              return resolveLivePinRect({ quote: toolbarState.text, range: toolbarState.range });
            }
            const prefix = "pin-item-";
            if (typeof key === "string" && key.indexOf(prefix) === 0) {
              const itemId = key.slice(prefix.length);
              const list = Array.isArray(snapshot.items) ? snapshot.items : [];
              const item = list.find((entry) => entry.id === itemId);
              return item ? resolveLivePinRect(item) : null;
            }
            return null;
          };

          const syncPinNodes = () => {
            const nodes = document.querySelectorAll("[data-dsh-pin-key]");
            if (nodes.length === 0) return;
            // 先集中读完所有 rect / 边界，再统一写样式，避免逐节点读写交替触发强制重排。
            const bounds = computePinBounds();
            const updates = [];
            for (const node of nodes) {
              const rect = resolvePinRectByKey(node.getAttribute("data-dsh-pin-key"));
              if (!isRectInPinBounds(rect, bounds)) {
                updates.push({ node, hidden: true });
                continue;
              }
              updates.push({ node, hidden: false, coords: pinCoords(rect) });
            }
            for (const update of updates) {
              const node = update.node;
              if (update.hidden) {
                node.style.visibility = "hidden";
                continue;
              }
              node.style.visibility = "visible";
              node.style.left = `${update.coords.left}px`;
              node.style.top = `${update.coords.top}px`;
            }
          };
          syncPinsRef.current = syncPinNodes;

          const frame = () => {
            raf = 0;
            syncPinNodes();
            if (Date.now() - lastActivity < 180) raf = requestAnimationFrame(frame);
          };
          const kick = () => {
            lastActivity = Date.now();
            if (raf === 0) raf = requestAnimationFrame(frame);
          };

          document.addEventListener("scroll", kick, true);
          window.addEventListener("resize", kick);
          kick();
          return () => {
            document.removeEventListener("scroll", kick, true);
            window.removeEventListener("resize", kick);
            if (raf) cancelAnimationFrame(raf);
            raf = 0;
            syncPinsRef.current = null;
          };
        }, [store]);

        // React 重渲染会把 style 重置成渲染时算出的坐标，渲染后再同步一次（无依赖 = 每次渲染后）。
        React.useEffect(() => {
          if (typeof requestAnimationFrame !== "function") return;
          const id = requestAnimationFrame(() => {
            if (syncPinsRef.current) syncPinsRef.current();
          });
          return () => cancelAnimationFrame(id);
        });

        // Keep composer Send button enabled when staged comments exist even if composer text is empty
        React.useEffect(() => {
          if (typeof document === "undefined") return;
          const hasItems = Boolean(items && items.length > 0);
          const syncSendButton = () => {
            const root =
              (probeRef.current && probeRef.current.closest && probeRef.current.closest("[data-composer-card]")) ||
              document.querySelector("[data-composer-card]");
            if (!root || typeof root.querySelectorAll !== "function") return;
            const buttons = root.querySelectorAll("button");
            for (const btn of buttons) {
              if (!btn.querySelector?.('svg path[d^="M8.3125"]')) continue;
              if (hasItems) {
                if (btn.disabled) {
                  btn.disabled = false;
                  btn.removeAttribute("disabled");
                  btn.setAttribute("data-dsh-quote-send-enabled", "true");
                }
              } else if (btn.getAttribute("data-dsh-quote-send-enabled") === "true") {
                btn.removeAttribute("data-dsh-quote-send-enabled");
                const shell = ctx?.conversation?.input?.shell?.(sessionId);
                const draft = (shell?.projection?.clipboardText ?? "").trim();
                const attCount = shell?.snapshot?.attachmentIds?.length ?? 0;
                if (!draft && attCount === 0) {
                  btn.disabled = true;
                }
              }
            }
          };
          syncSendButton();
          if (!hasItems || typeof MutationObserver === "undefined") return;
          const card =
            (probeRef.current && probeRef.current.closest && probeRef.current.closest("[data-composer-card]")) ||
            document.querySelector("[data-composer-card]");
          if (!card) return;
          const observer = new MutationObserver(syncSendButton);
          observer.observe(card, { attributes: true, subtree: true, attributeFilter: ["disabled"] });
          return () => observer.disconnect();
        }, [items?.length, sessionId]);

        // Automatically merge staged comments and submit (even when composer text draft is empty!)
        React.useEffect(() => {
          if (typeof document === "undefined") return;

          const submitWithStagedComments = (source = "enter") => {
            const currentItems = store.getSnapshot().items;
            if (!currentItems || currentItems.length === 0) return false;
            const formatted = formatBatchItems(currentItems).trim();
            if (!formatted) return false;

            const shell = ctx?.conversation?.input?.shell?.(sessionId);
            if (!shell) {
              const inserted = insertIntoComposerDraft(ctx, sessionId, formatted, probeRef.current);
              if (inserted) store.clearItems();
              return inserted;
            }

            const currentDraft = (shell.projection?.clipboardText ?? "").trim();
            const combined = !currentDraft
              ? formatted
              : currentDraft.startsWith(formatted)
              ? currentDraft
              : `${formatted}\n\n${currentDraft}`;

            if (typeof shell.setDraft === "function") {
              shell.setDraft(combined);
            } else {
              insertIntoComposerDraft(ctx, sessionId, formatted, probeRef.current);
            }

            store.clearItems();

            if (typeof shell.submit === "function") {
              shell.submit("queue", source);
              return true;
            }
            if (shell.actions && typeof shell.actions.submit === "function") {
              shell.actions.submit();
              return true;
            }
            return true;
          };

          const onCaptureKeyDown = (e) => {
            if (e.defaultPrevented || e.isComposing || e.key !== "Enter" || e.shiftKey || e.altKey) {
              return;
            }
            const currentItems = store.getSnapshot().items;
            if (!currentItems || currentItems.length === 0) return;
            if (store.getSnapshot().toolbar.visible) return;
            if (store.getSnapshot().editingId) return;

            const target = e.target;
            if (target && typeof target.closest === "function") {
              if (
                target.closest("[data-dsh-quote-toolbar]") ||
                target.closest("[data-dsh-quote-popover]") ||
                target.closest("input, textarea")
              ) {
                if (!target.closest("[data-composer-card]")) return;
              }
              const cardSession = target.closest("[data-conversation-session]")?.dataset?.conversationSession;
              if (cardSession && sessionId && cardSession !== sessionId) return;
            }

            e.preventDefault();
            e.stopPropagation();
            submitWithStagedComments("enter");
          };

          const onCaptureSendPress = (e) => {
            if (e.type === "mousedown" && e.button !== 0) return;
            const currentItems = store.getSnapshot().items;
            if (!currentItems || currentItems.length === 0) return;
            const target = e.target;
            if (!target || typeof target.closest !== "function") return;
            const btn = target.closest("[data-composer-card] button");
            if (!btn) return;
            if (
              btn.closest("[data-dsh-quote-dock]") ||
              btn.closest("[data-dsh-quote-toolbar]") ||
              btn.closest("[data-dsh-quote-popover]")
            ) {
              return;
            }
            const hasSendPath = Boolean(btn.querySelector('svg path[d^="M8.3125"]'));
            if (!hasSendPath) return;
            const cardSession = btn.closest("[data-conversation-session]")?.dataset?.conversationSession;
            if (cardSession && sessionId && cardSession !== sessionId) return;
            e.preventDefault();
            e.stopPropagation();
            submitWithStagedComments("click");
          };

          document.addEventListener("keydown", onCaptureKeyDown, true);
          document.addEventListener("mousedown", onCaptureSendPress, true);
          document.addEventListener("click", onCaptureSendPress, true);
          return () => {
            document.removeEventListener("keydown", onCaptureKeyDown, true);
            document.removeEventListener("mousedown", onCaptureSendPress, true);
            document.removeEventListener("click", onCaptureSendPress, true);
          };
        }, [sessionId, store]);

        React.useEffect(() => {
          if (typeof document === "undefined" || typeof window === "undefined") return;

          const recordSelectionIfValid = () => {
            const sel = window.getSelection?.();
            const convRoot = getConversationRoot();
            const result = isValidMessageSelection(sel, convRoot, 2);
            if (result.valid) {
              lastSelectionRef.current = {
                text: result.text,
                rect: result.rect,
                pinRect: result.pinRect,
                range: result.range,
                ts: Date.now(),
              };
            }
            return result;
          };

          const onMouseUp = (e) => {
            if (toolbarRef.current && toolbarRef.current.contains(e.target)) {
              return;
            }
            if (e.target && typeof e.target.closest === "function" && e.target.closest("[data-dsh-pin-badge]")) {
              return;
            }
            if (e.button === 2) {
              return;
            }
            setTimeout(() => {
              const result = recordSelectionIfValid();
              if (!result || !result.valid || !result.range) return;
              if (!isAutoQuoteTargetSelection(result.range)) return;
              const viewport = {
                width: typeof window !== "undefined" ? window.innerWidth : 1280,
                height: typeof window !== "undefined" ? window.innerHeight : 800,
              };
              if (AUTO_TRIGGER_ON_SELECT) {
                store.showTrigger(
                  result.text,
                  result.rect,
                  viewport,
                  { pinRect: result.pinRect, range: result.range }
                );
              }
              if (AUTO_COPY_ON_SELECT) {
                copyPlainTextToClipboard(result.text).then((ok) => {
                  if (!ok) return;
                  try {
                    flashCopiedHint();
                  } catch (_err) {
                    // 组件已卸载时忽略
                  }
                });
              }
            }, 16);
          };

          const onMouseDown = (e) => {
            if (toolbarRef.current && toolbarRef.current.contains(e.target)) {
              return;
            }
            if (e.target && typeof e.target.closest === "function" && e.target.closest("[data-dsh-pin-badge]")) {
              return;
            }
            if (e.button === 2 || (e.button === 0 && e.ctrlKey)) {
              recordSelectionIfValid();
              return;
            }
            const currentToolbar = store.getSnapshot().toolbar;
            if (currentToolbar.visible) {
              store.hideToolbar();
            }
          };

          const onContextMenu = (e) => {
            if (toolbarRef.current && toolbarRef.current.contains(e.target)) {
              return;
            }
            const sel = window.getSelection?.();
            const convRoot = getConversationRoot();
            let result = isValidMessageSelection(sel, convRoot, 2);
            if (
              !result.valid &&
              lastSelectionRef.current &&
              Date.now() - lastSelectionRef.current.ts < 800
            ) {
              result = {
                valid: true,
                text: lastSelectionRef.current.text,
                rect: lastSelectionRef.current.rect,
                pinRect: lastSelectionRef.current.pinRect,
                range: lastSelectionRef.current.range,
              };
            }
            if (!result.valid) {
              return;
            }
            e.preventDefault();
            e.stopPropagation();
            store.showContextMenu(
              result.text,
              result.rect,
              { x: e.clientX, y: e.clientY },
              {
                width: window.innerWidth,
                height: window.innerHeight,
              },
              {
                pinRect: result.pinRect,
                range: result.range,
              }
            );
          };

          const onKeyDown = (e) => {
            const currentToolbar = store.getSnapshot().toolbar;
            if (e.key === "Escape" && currentToolbar.visible) {
              e.preventDefault();
              e.stopPropagation();
              store.hideToolbar();
              return;
            }

            const isMod = Boolean(e.metaKey || e.ctrlKey);
            const isKeyL = e.code === "KeyL" || (typeof e.key === "string" && e.key.toLowerCase() === "l");
            if (!isMod || e.altKey || !isKeyL) return;

            const sel = window.getSelection?.();
            const convRoot = getConversationRoot();
            const check = isValidMessageSelection(sel, convRoot, 2);
            const activeText = check.valid ? check.text : currentToolbar.visible ? currentToolbar.text : "";
            const activeRect = check.valid ? check.rect : currentToolbar.rect;

            if (!activeText) return;

            e.preventDefault();
            e.stopPropagation();

            store.openCommentMode(
              activeText,
              activeRect,
              {
                width: window.innerWidth,
                height: window.innerHeight,
              },
              {
                pinRect: check.valid ? check.pinRect : currentToolbar.pinRect,
                range: check.valid ? check.range : currentToolbar.range,
              }
            );
          };

          document.addEventListener("mouseup", onMouseUp, true);
          document.addEventListener("mousedown", onMouseDown, true);
          document.addEventListener("contextmenu", onContextMenu, true);
          document.addEventListener("keydown", onKeyDown, true);

          return () => {
            document.removeEventListener("mouseup", onMouseUp, true);
            document.removeEventListener("mousedown", onMouseDown, true);
            document.removeEventListener("contextmenu", onContextMenu, true);
            document.removeEventListener("keydown", onKeyDown, true);
          };
        }, [getConversationRoot, handleAddToChat, store]);

        // Keep selected text visually highlighted (via CSS Custom Highlight API + fallback) after clicking "添加到对话"
        const supportsCssHighlight =
          typeof window !== "undefined" &&
          typeof window.Highlight === "function" &&
          typeof CSS !== "undefined" &&
          CSS.highlights &&
          typeof CSS.highlights.set === "function";

        React.useEffect(() => {
          if (!supportsCssHighlight) return;
          const savedRanges = [];
          if (Array.isArray(items)) {
            for (const item of items) {
              if (item && item.range && rangeMatchesQuote(item.range, item.quote)) {
                savedRanges.push(item.range);
              }
            }
          }
          const activeRanges = [];
          if (toolbar.visible && toolbar.range && rangeMatchesQuote(toolbar.range, toolbar.text)) {
            activeRanges.push(toolbar.range);
          }
          const applyHighlight = (name, ranges) => {
            try {
              if (ranges.length > 0) {
                CSS.highlights.set(name, new window.Highlight(...ranges));
              } else {
                CSS.highlights.delete(name);
              }
            } catch (_err) {
              // ignore detached ranges
            }
          };
          applyHighlight("dsh-selection-quote-active", activeRanges);
          applyHighlight("dsh-selection-quote-saved", savedRanges);
          return () => {
            try {
              CSS.highlights.delete("dsh-selection-quote-active");
              CSS.highlights.delete("dsh-selection-quote-saved");
            } catch (_err) {
              // ignore
            }
          };
        }, [items, toolbar.visible, toolbar.range, supportsCssHighlight]);

        // 消息重渲染会让暂存的 cloneRange 失效：用原文重新定位，避免角标停在旧坐标、波浪标记丢失。
        React.useEffect(() => {
          if (typeof document === "undefined" || typeof window === "undefined") return;
          let timer = null;
          let observer = null;

          const reanchorDetachedItems = () => {
            timer = null;
            const currentItems = store.getSnapshot().items;
            if (!Array.isArray(currentItems) || currentItems.length === 0) return;
            const root = document.querySelector("[data-conversation-content]");
            if (!root) return;
            for (const item of currentItems) {
              if (!item || !item.quote || rangeMatchesQuote(item.range, item.quote)) continue;
              const range = findQuoteTextRange(root, item.quote);
              if (!range) continue;
              let sourceRect = null;
              try {
                const rects = typeof range.getClientRects === "function" ? range.getClientRects() : null;
                sourceRect = rects && rects.length > 0 ? rects[0] : range.getBoundingClientRect();
              } catch (_err) {
                sourceRect = null;
              }
              const rect = rectToPlain(range.getBoundingClientRect());
              const pinRect = rectToPlain(sourceRect) || rect;
              store.updateItem(item.id, {
                range,
                ...(rect ? { rect } : {}),
                ...(pinRect ? { pinRect } : {}),
              });
            }
          };

          const schedule = () => {
            if (timer) return;
            timer = setTimeout(reanchorDetachedItems, 180);
          };

          schedule();
          if (typeof MutationObserver !== "undefined") {
            const root = document.querySelector("[data-conversation-content]");
            if (root) {
              observer = new MutationObserver(schedule);
              observer.observe(root, { childList: true, subtree: true, characterData: true });
            }
          }
          return () => {
            if (timer) clearTimeout(timer);
            if (observer) observer.disconnect();
          };
        }, [items, store]);

        // 角标允许出现的“消息可读区域”：标题栏之上、输入框/浮层之下的位置隐藏，避免穿模压住 UI。
        const pinBounds = computePinBounds();

        // 所有有效引用都渲染角标节点（可见性交给滚动同步函数控制），滚动时不再依赖 React 重渲染。
        const pinBadges = [];
        if (Array.isArray(items)) {
          items.forEach((item, idx) => {
            const r = resolveLivePinRect(item);
            if (!r) return;
            const coords = pinCoords(r);
            pinBadges.push({
              key: `pin-item-${item.id}`,
              number: idx + 1,
              left: coords.left,
              top: coords.top,
              visible: isRectInPinBounds(r, pinBounds),
              title: item.comment ? `#${idx + 1} 批注：${item.comment}` : `#${idx + 1} 点击编辑评论`,
              onClick: (e) => {
                e.preventDefault();
                e.stopPropagation();
                store.openCommentMode(
                  item.quote,
                  item.rect || r,
                  {
                    width: typeof window !== "undefined" ? window.innerWidth : 1280,
                    height: typeof window !== "undefined" ? window.innerHeight : 800,
                  },
                  {
                    pinRect: r,
                    range: item.range || null,
                    editingItemId: item.id,
                    commentDraft: item.comment || "",
                  }
                );
              },
            });
          });
        }

        if (toolbar.visible && toolbar.mode === "comment" && !toolbar.editingItemId) {
          const activePinRect =
            toolbar.range !== undefined && toolbar.range !== null
              ? resolveLivePinRect({ quote: toolbar.text, range: toolbar.range })
              : toolbar.pinRect || toolbar.rect;
          if (activePinRect) {
            const nextNum = (Array.isArray(items) ? items.length : 0) + 1;
            const activeCoords = pinCoords(activePinRect);
            pinBadges.push({
              key: "pin-active-selection",
              number: nextNum,
              left: activeCoords.left,
              top: activeCoords.top,
              visible: isRectInPinBounds(activePinRect, pinBounds),
              title: `第 ${nextNum} 条注释`,
              onClick: (e) => {
                e.preventDefault();
                e.stopPropagation();
                inputRef.current?.focus?.();
              },
            });
          }
        }

        const handleCopySelectedText = () => {
          const textToCopy = toolbar.text || "";
          if (textToCopy) {
            if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
              navigator.clipboard.writeText(textToCopy).catch(() => {});
            } else if (typeof document !== "undefined" && typeof document.execCommand === "function") {
              try {
                document.execCommand("copy");
              } catch (_err) {
                // ignore
              }
            }
          }
          store.hideToolbar();
        };

        const handleOpenCommentFromContextMenu = () => {
          const snap = store.getSnapshot().toolbar;
          store.openCommentMode(
            snap.text,
            snap.rect,
            {
              width: typeof window !== "undefined" ? window.innerWidth : 1280,
              height: typeof window !== "undefined" ? window.innerHeight : 800,
            },
            {
              pinRect: snap.pinRect || snap.rect,
              range: snap.range || null,
            }
          );
        };

        const floatingNode =
          (toolbar.visible || pinBadges.length > 0) && typeof document !== "undefined" && document.body
            ? ReactDOM.createPortal(
                jsxRuntime.jsxs(jsxRuntime.Fragment, {
                  children: [
                    pinBadges.map((pin) =>
                      jsxRuntime.jsx(
                        "div",
                        {
                          className: "dsh-sq-pin-badge",
                          "data-dsh-pin-badge": String(pin.number),
                          "data-dsh-pin-key": pin.key,
                          title: pin.title,
                          style: {
                            left: `${pin.left}px`,
                            top: `${pin.top}px`,
                            visibility: pin.visible === false ? "hidden" : "visible",
                          },
                          onMouseDown: (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                          },
                          onClick: pin.onClick,
                          children: String(pin.number),
                        },
                        pin.key
                      )
                    ),
                    toolbar.visible
                      ? jsxRuntime.jsx("div", {
                          ref: toolbarRef,
                          className: "dsh-sq-toolbar-anchor",
                          "data-dsh-quote-toolbar": sessionId,
                          "data-mode": toolbar.mode,
                          "data-placement": toolbar.placement || "above",
                          style: {
                            left: `${toolbar.left ?? 320}px`,
                            top: `${toolbar.top ?? 160}px`,
                          },
                          onMouseDown: (e) => {
                            e.stopPropagation();
                          },
                          children:
                            toolbar.mode === "trigger"
                              ? jsxRuntime.jsxs("div", {
                                  className: "dsh-sq-trigger",
                                  "data-dsh-quote-trigger": sessionId,
                                  children: [
                                    jsxRuntime.jsxs("button", {
                                      type: "button",
                                      className: "dsh-sq-trigger-btn",
                                      "data-action": "open-comment-capsule",
                                      title: "添加注释",
                                      onMouseDown: (e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                      },
                                      onClick: (e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        handleOpenCommentFromContextMenu();
                                      },
                                      children: [
                                        jsxRuntime.jsx("svg", {
                                          viewBox: "0 0 16 16",
                                          width: "13",
                                          height: "13",
                                          fill: "none",
                                          "aria-hidden": "true",
                                          children: jsxRuntime.jsx("path", {
                                            d: "M3.2 2.8H12.8C13.57 2.8 14.2 3.43 14.2 4.2V9.8C14.2 10.57 13.57 11.2 12.8 11.2H6.4L3.1 13.6V11.2C2.43 11.2 1.8 10.57 1.8 9.8V4.2C1.8 3.43 2.43 2.8 3.2 2.8ZM4.8 5.8H11.2M4.8 8.2H8.8",
                                            stroke: "currentColor",
                                            strokeWidth: "1.35",
                                            strokeLinecap: "round",
                                            strokeLinejoin: "round",
                                          }),
                                        }),
                                        jsxRuntime.jsx("span", { children: "注释" }),
                                      ],
                                    }),
                                    copiedHint
                                      ? jsxRuntime.jsx("span", {
                                          className: "dsh-sq-trigger-copied",
                                          "aria-live": "polite",
                                          children: "已复制",
                                        })
                                      : null,
                                  ],
                                })
                              : toolbar.mode === "contextmenu"
                              ? jsxRuntime.jsxs("div", {
                                  className: "dsh-sq-context-menu",
                                  role: "menu",
                                  "aria-label": "选中文本操作菜单",
                                  children: [
                                    jsxRuntime.jsxs("button", {
                                      type: "button",
                                      className: "dsh-sq-context-item",
                                      role: "menuitem",
                                      "data-action": "copy-selected-text",
                                      onMouseDown: (e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                      },
                                      onClick: (e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        handleCopySelectedText();
                                      },
                                      children: [
                                        jsxRuntime.jsxs("span", {
                                          className: "dsh-sq-context-item-left",
                                          children: [
                                            jsxRuntime.jsx("svg", {
                                              viewBox: "0 0 16 16",
                                              width: "14",
                                              height: "14",
                                              fill: "none",
                                              children: jsxRuntime.jsx("path", {
                                                d: "M5.5 5.5H12.2C12.92 5.5 13.5 6.08 13.5 6.8V12.2C13.5 12.92 12.92 13.5 12.2 13.5H5.5C4.78 13.5 4.2 12.92 4.2 12.2V6.8C4.2 6.08 4.78 5.5 5.5 5.5ZM2.5 10.5V3.8C2.5 3.08 3.08 2.5 3.8 2.5H10.5",
                                                stroke: "currentColor",
                                                strokeWidth: "1.35",
                                                strokeLinecap: "round",
                                                strokeLinejoin: "round",
                                              }),
                                            }),
                                            jsxRuntime.jsx("span", { children: "拷贝 (Copy)" }),
                                          ],
                                        }),
                                        jsxRuntime.jsx("span", {
                                          className: "dsh-sq-context-item-kbd",
                                          children: "⌘C",
                                        }),
                                      ],
                                    }),
                                    jsxRuntime.jsx("div", {
                                      className: "dsh-sq-context-sep",
                                    }),
                                    jsxRuntime.jsxs("button", {
                                      type: "button",
                                      className: "dsh-sq-context-item",
                                      role: "menuitem",
                                      "data-action": "open-comment-capsule",
                                      onMouseDown: (e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                      },
                                      onClick: (e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        handleOpenCommentFromContextMenu();
                                      },
                                      children: [
                                        jsxRuntime.jsxs("span", {
                                          className: "dsh-sq-context-item-left",
                                          children: [
                                            jsxRuntime.jsx("svg", {
                                              viewBox: "0 0 16 16",
                                              width: "14",
                                              height: "14",
                                              fill: "none",
                                              children: jsxRuntime.jsx("path", {
                                                d: "M3.2 2.8H12.8C13.57 2.8 14.2 3.43 14.2 4.2V9.8C14.2 10.57 13.57 11.2 12.8 11.2H6.4L3.1 13.6V11.2C2.43 11.2 1.8 10.57 1.8 9.8V4.2C1.8 3.43 2.43 2.8 3.2 2.8ZM4.8 5.8H11.2M4.8 8.2H8.8",
                                                stroke: "currentColor",
                                                strokeWidth: "1.35",
                                                strokeLinecap: "round",
                                                strokeLinejoin: "round",
                                              }),
                                            }),
                                            jsxRuntime.jsx("span", { children: "添加到对话" }),
                                          ],
                                        }),
                                        jsxRuntime.jsx("span", {
                                          className: "dsh-sq-context-item-kbd",
                                          children: "⌘L",
                                        }),
                                      ],
                                    }),
                                  ],
                                })
                              : jsxRuntime.jsxs("div", {
                                  className: "dsh-sq-capsule",
                                  role: "dialog",
                                  "aria-label": "添加可选评论",
                                  children: [
                                    jsxRuntime.jsx("input", {
                                      ref: inputRef,
                                      type: "text",
                                      className: "dsh-sq-capsule-input",
                                      "data-dsh-comment-input": "true",
                                      value: toolbar.commentDraft,
                                      placeholder: "添加可选评论...",
                                      onChange: (e) => store.setCommentDraft(e.target.value),
                                      onKeyDown: (e) => {
                                        if (e.nativeEvent?.isComposing) return;
                                        if (e.key === "Escape") {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          store.hideToolbar();
                                          return;
                                        }
                                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          handleDirectInsertWithComment();
                                          return;
                                        }
                                        if (e.key === "Enter") {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          handleCommitCapsuleComment();
                                        }
                                      },
                                    }),
                                    jsxRuntime.jsx("button", {
                                      type: "button",
                                      className: "dsh-sq-capsule-submit",
                                      "data-action": "add-comment-to-dock",
                                      title: "确认添加注释 (Enter)",
                                      onMouseDown: (e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                      },
                                      onClick: (e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        handleCommitCapsuleComment();
                                      },
                                      children: jsxRuntime.jsx("svg", {
                                        viewBox: "0 0 16 16",
                                        width: "15",
                                        height: "15",
                                        fill: "none",
                                        "aria-hidden": "true",
                                        children: jsxRuntime.jsx("path", {
                                          d: "M3.5 8.2L6.6 11.3L12.7 4.8",
                                          stroke: "currentColor",
                                          strokeWidth: "1.9",
                                          strokeLinecap: "round",
                                          strokeLinejoin: "round",
                                        }),
                                      }),
                                    }),
                                  ],
                                }),
                        })
                      : null,
                  ],
                }),
                document.body
              )
            : null;

        return jsxRuntime.jsxs(jsxRuntime.Fragment, {
          children: [
            jsxRuntime.jsx("span", {
              ref: probeRef,
              "data-dsh-selection-quote-probe": sessionId,
              style: { display: "none" },
            }),
            InlineDockComponent ? jsxRuntime.jsx(InlineDockComponent, { sessionId }) : null,
            floatingNode,
          ],
        });
      };
    }

    function createQuotesCommentsDockComponent(ctx) {
      return function QuotesCommentsDock({ sessionId, inlineOnly }) {
        const store = React.useMemo(() => getSessionStore(sessionId), [sessionId]);
        const items = useStore(store, (s) => s.items);
        const editingId = useStore(store, (s) => s.editingId);
        const editingComment = useStore(store, (s) => s.editingComment);
        const dockRef = React.useRef(null);
        const hoverTimerRef = React.useRef(null);
        const [popoverOpen, setPopoverOpen] = React.useState
          ? React.useState(false)
          : [true, () => {}];

        React.useEffect(() => {
          ensureStylesInjected();
        }, []);

        if (inlineOnly && typeof document !== "undefined" && document.querySelector("[data-composer-overlay]")) {
          return null;
        }

        if (!items || items.length === 0) {
          return null;
        }

        const handleBatchInsertAll = () => {
          const formatted = formatBatchItems(items);
          if (!formatted) return;
          insertIntoComposerDraft(ctx, sessionId, formatted, dockRef.current);
          store.clearItems();
        };

        const openPopover = () => {
          if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
          }
          setPopoverOpen(true);
        };

        const closePopoverDelayed = () => {
          if (editingId) return;
          if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = setTimeout(() => {
            setPopoverOpen(false);
          }, 160);
        };

        const showPopover = Boolean(popoverOpen || editingId);

        const headerActionsNode = jsxRuntime.jsxs("div", {
          style: { display: "none" },
          children: [
            jsxRuntime.jsx("button", {
              type: "button",
              "data-action": "clear-dock",
              onClick: () => store.clearItems(),
              children: "清空",
            }),
            jsxRuntime.jsx("button", {
              type: "button",
              "data-action": "batch-insert-all",
              onClick: handleBatchInsertAll,
              children: "一键汇总插入输入框",
            }),
          ],
        });

        return jsxRuntime.jsx("div", {
          ref: dockRef,
          "data-dsh-quote-dock": sessionId,
          onMouseEnter: openPopover,
          onMouseLeave: closePopoverDelayed,
          children: jsxRuntime.jsxs("div", {
            className: "dsh-sq-dock-wrapper",
            style: { position: "relative", display: "inline-flex", alignItems: "center" },
            children: [
              jsxRuntime.jsxs("div", {
                className: "dsh-sq-dock-header",
                children: [
                  jsxRuntime.jsxs("div", {
                    className: "dsh-sq-chip",
                    role: "button",
                    tabIndex: 0,
                    "aria-label": `${items.length} 条注释`,
                    onClick: (e) => {
                      e.stopPropagation();
                      setPopoverOpen(!showPopover);
                    },
                    children: [
                      jsxRuntime.jsx("span", {
                        className: "dsh-sq-chip-icon",
                        "aria-hidden": "true",
                        children: jsxRuntime.jsxs("svg", {
                          viewBox: "0 0 16 16",
                          width: "14",
                          height: "14",
                          fill: "none",
                          children: [
                            jsxRuntime.jsx("path", {
                              d: "M2.5 3.8C2.5 3.08 3.08 2.5 3.8 2.5H12.2C12.92 2.5 13.5 3.08 13.5 3.8V9.7C13.5 10.42 12.92 11 12.2 11H6.2L3.3 13.3C2.95 13.58 2.5 13.33 2.5 12.88V3.8Z",
                              stroke: "currentColor",
                              strokeWidth: "1.35",
                              strokeLinejoin: "round",
                            }),
                            jsxRuntime.jsx("path", {
                              d: "M5.2 5.8H10.8M5.2 8.2H8.8",
                              stroke: "currentColor",
                              strokeWidth: "1.35",
                              strokeLinecap: "round",
                            }),
                          ],
                        }),
                      }),
                      jsxRuntime.jsx("span", {
                        children: `${items.length} 条注释`,
                      }),
                      jsxRuntime.jsx("button", {
                        type: "button",
                        className: "dsh-sq-chip-clear",
                        "data-action": "clear-dock-chip",
                        title: "清空全部注释",
                        onMouseDown: (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        },
                        onClick: (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          store.clearItems();
                        },
                        children: "×",
                      }),
                    ],
                  }),
                  headerActionsNode,
                ],
              }),
              showPopover
                ? jsxRuntime.jsx("div", {
                    className: "dsh-sq-popover-card",
                    "data-dsh-quote-popover": sessionId,
                    onMouseEnter: openPopover,
                    onMouseLeave: closePopoverDelayed,
                    onMouseDown: (e) => {
                      e.stopPropagation();
                    },
                    children: items.map((item, idx) => {
                      const isEditing = editingId === item.id;
                      return jsxRuntime.jsxs(
                        "div",
                        {
                          className: "dsh-sq-popover-item",
                          "data-dock-item-id": item.id,
                          children: [
                            jsxRuntime.jsx("div", {
                              className: "dsh-sq-popover-index",
                              children: `${idx + 1}。`,
                            }),
                            jsxRuntime.jsxs("div", {
                              className: "dsh-sq-popover-body",
                              children: [
                                jsxRuntime.jsx("div", {
                                  className: "dsh-sq-popover-label",
                                  children: "所选文本：",
                                }),
                                jsxRuntime.jsx("div", {
                                  className: "dsh-sq-popover-text",
                                  title: item.quote,
                                  children: truncateQuotePreview(item.quote, 180),
                                }),
                                isEditing
                                  ? jsxRuntime.jsxs(jsxRuntime.Fragment, {
                                      children: [
                                        jsxRuntime.jsx("div", {
                                          className: "dsh-sq-popover-label",
                                          style: { marginTop: "4px" },
                                          children: "用户评论：",
                                        }),
                                        jsxRuntime.jsx("input", {
                                          type: "text",
                                          className: "dsh-sq-edit-input",
                                          "data-dock-edit-input": item.id,
                                          autoFocus: true,
                                          value: editingComment,
                                          placeholder: "添加可选评论... (Enter 保存，Esc 取消)",
                                          onChange: (e) => store.setEditingComment(e.target.value),
                                          onBlur: () => store.commitEditing(),
                                          onKeyDown: (e) => {
                                            if (e.nativeEvent?.isComposing) return;
                                            if (e.key === "Enter") {
                                              e.preventDefault();
                                              store.commitEditing();
                                            } else if (e.key === "Escape") {
                                              e.preventDefault();
                                              store.cancelEditing();
                                            }
                                          },
                                        }),
                                      ],
                                    })
                                  : item.comment
                                  ? jsxRuntime.jsxs(jsxRuntime.Fragment, {
                                      children: [
                                        jsxRuntime.jsx("div", {
                                          className: "dsh-sq-popover-label",
                                          style: { marginTop: "4px" },
                                          children: "用户评论：",
                                        }),
                                        jsxRuntime.jsx("div", {
                                          className: "dsh-sq-popover-text",
                                          style: { cursor: "pointer" },
                                          title: "点击修改评论",
                                          onClick: () => store.startEditing(item.id),
                                          children: item.comment,
                                        }),
                                      ],
                                    })
                                  : null,
                              ],
                            }),
                            jsxRuntime.jsxs("div", {
                              className: "dsh-sq-popover-actions",
                              children: [
                                jsxRuntime.jsx("button", {
                                  type: "button",
                                  className: "dsh-sq-icon-btn",
                                  "data-action": "edit-dock-item",
                                  title: "编辑评论",
                                  onClick: (e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    store.startEditing(item.id);
                                  },
                                  children: jsxRuntime.jsx("svg", {
                                    viewBox: "0 0 16 16",
                                    width: "14",
                                    height: "14",
                                    fill: "none",
                                    children: jsxRuntime.jsx("path", {
                                      d: "M11.4 2.4C11.95 1.85 12.85 1.85 13.4 2.4C13.95 2.95 13.95 3.85 13.4 4.4L5.6 12.2L2.5 13L3.3 9.9L11.4 2.4Z",
                                      stroke: "currentColor",
                                      strokeWidth: "1.35",
                                      strokeLinecap: "round",
                                      strokeLinejoin: "round",
                                    }),
                                  }),
                                }),
                                jsxRuntime.jsx("button", {
                                  type: "button",
                                  className: "dsh-sq-icon-btn",
                                  "data-action": "remove-dock-item",
                                  title: "删除注释",
                                  onClick: (e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    store.removeItem(item.id);
                                  },
                                  children: jsxRuntime.jsx("svg", {
                                    viewBox: "0 0 16 16",
                                    width: "14",
                                    height: "14",
                                    fill: "none",
                                    children: jsxRuntime.jsx("path", {
                                      d: "M3 4.5H13M6.2 4.5V3.1C6.2 2.77 6.47 2.5 6.8 2.5H9.2C9.53 2.5 9.8 2.77 9.8 3.1V4.5M4.4 4.5L5 12.6C5.03 13.1 5.45 13.5 5.95 13.5H10.05C10.55 13.5 10.97 13.1 11 12.6L11.6 4.5",
                                      stroke: "currentColor",
                                      strokeWidth: "1.35",
                                      strokeLinecap: "round",
                                      strokeLinejoin: "round",
                                    }),
                                  }),
                                }),
                              ],
                            }),
                          ],
                        },
                        item.id
                      );
                    }),
                  })
                : null,
            ],
          }),
        });
      };
    }

    function createSentSelectionQuoteComponent() {
      return function SentSelectionQuoteNode({ node }) {
        const data = node?.data || {};
        const items = Array.isArray(data.items) ? data.items : [];
        const userMessage = typeof data.userMessage === "string" ? data.userMessage : "";
        const chipRef = React.useRef(null);
        const hoverTimerRef = React.useRef(null);
        const [popoverOpen, setPopoverOpen] = React.useState
          ? React.useState(false)
          : [false, () => {}];
        const [popoverPos, setPopoverPos] = React.useState
          ? React.useState({ left: 16, top: 60 })
          : [{ left: 16, top: 60 }, () => {}];

        React.useEffect(() => {
          ensureStylesInjected();
        }, []);

        const updatePopoverPosition = React.useCallback(() => {
          if (!chipRef.current || typeof chipRef.current.getBoundingClientRect !== "function") {
            return;
          }
          const rect = chipRef.current.getBoundingClientRect();
          const vw = typeof window !== "undefined" ? window.innerWidth || 1200 : 1200;
          const vh = typeof window !== "undefined" ? window.innerHeight || 800 : 800;
          const cardWidth = Math.min(440, vw - 32);
          let left = rect.left;
          if (left + cardWidth > vw - 16) {
            left = Math.max(16, rect.right - cardWidth);
          }
          left = Math.max(16, Math.min(left, vw - cardWidth - 16));

          if (rect.bottom + 240 <= vh || rect.top < 220) {
            setPopoverPos({ left: Math.round(left), top: Math.round(rect.bottom + 6) });
          } else {
            setPopoverPos({
              left: Math.round(left),
              bottom: Math.round(vh - rect.top + 6),
            });
          }
        }, []);

        const openPopover = () => {
          if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
          }
          updatePopoverPosition();
          setPopoverOpen(true);
        };

        const scheduleClosePopover = () => {
          if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
          }
          hoverTimerRef.current = setTimeout(() => {
            setPopoverOpen(false);
          }, 180);
        };

        if (items.length === 0) {
          return jsxRuntime.jsx("span", { children: userMessage });
        }

        const popoverCard =
          popoverOpen && typeof document !== "undefined" && ReactDOM && typeof ReactDOM.createPortal === "function"
            ? ReactDOM.createPortal(
                jsxRuntime.jsx("div", {
                  className: "dsh-sq-popover-card dsh-sq-sent-popover-card",
                  "data-dsh-sent-quote-popover": "true",
                  onMouseEnter: openPopover,
                  onMouseLeave: scheduleClosePopover,
                  style: {
                    left: `${popoverPos.left}px`,
                    top: popoverPos.top !== undefined ? `${popoverPos.top}px` : "auto",
                    bottom: popoverPos.bottom !== undefined ? `${popoverPos.bottom}px` : "auto",
                  },
                  children: items.map((item, idx) =>
                    jsxRuntime.jsxs(
                      "div",
                      {
                        className: "dsh-sq-popover-item",
                        children: [
                          jsxRuntime.jsx("div", {
                            className: "dsh-sq-popover-index",
                            children: `${idx + 1}。`,
                          }),
                          jsxRuntime.jsxs("div", {
                            className: "dsh-sq-popover-body",
                            children: [
                              jsxRuntime.jsx("div", {
                                className: "dsh-sq-popover-label",
                                children: "所选文本：",
                              }),
                              jsxRuntime.jsx("div", {
                                className: "dsh-sq-popover-text",
                                children: item.quote,
                              }),
                              item.comment
                                ? jsxRuntime.jsxs(jsxRuntime.Fragment, {
                                    children: [
                                      jsxRuntime.jsx("div", {
                                        className: "dsh-sq-popover-label",
                                        style: { marginTop: "4px" },
                                        children: "用户评论：",
                                      }),
                                      jsxRuntime.jsx("div", {
                                        className: "dsh-sq-popover-text",
                                        children: item.comment,
                                      }),
                                    ],
                                  })
                                : null,
                            ],
                          }),
                        ],
                      },
                      idx
                    )
                  ),
                }),
                document.body
              )
            : null;

        return jsxRuntime.jsxs("div", {
          className: "dsh-sq-sent-stack",
          "data-dsh-sent-quotes": "true",
          children: [
            jsxRuntime.jsxs("div", {
              ref: chipRef,
              className: "dsh-sq-sent-chip",
              "data-dsh-sent-quote-chip": "true",
              onMouseEnter: openPopover,
              onMouseLeave: scheduleClosePopover,
              onClick: (e) => {
                e.stopPropagation();
                updatePopoverPosition();
                setPopoverOpen(!popoverOpen);
              },
              children: [
                jsxRuntime.jsx("span", {
                  className: "dsh-sq-chip-icon",
                  children: jsxRuntime.jsx("svg", {
                    viewBox: "0 0 16 16",
                    width: "14",
                    height: "14",
                    fill: "none",
                    children: jsxRuntime.jsx("path", {
                      d: "M3.2 2.8H12.8C13.57 2.8 14.2 3.43 14.2 4.2V9.8C14.2 10.57 13.57 11.2 12.8 11.2H6.4L3.1 13.6V11.2C2.43 11.2 1.8 10.57 1.8 9.8V4.2C1.8 3.43 2.43 2.8 3.2 2.8ZM4.8 5.8H11.2M4.8 8.2H8.8",
                      stroke: "currentColor",
                      strokeWidth: "1.35",
                      strokeLinecap: "round",
                      strokeLinejoin: "round",
                    }),
                  }),
                }),
                jsxRuntime.jsx("span", {
                  children: `${items.length} 条注释`,
                }),
              ],
            }),
            userMessage
              ? jsxRuntime.jsx("div", {
                  className: "dsh-sq-sent-user-bubble",
                  children: userMessage,
                })
              : null,
            popoverCard,
          ],
        });
      };
    }

    const selectionQuoteUserTextRule = {
      id: "selection-quote",
      order: 1,
      match(text, from) {
        if (from !== 0 || typeof text !== "string" || text.length === 0) {
          return undefined;
        }
        const parsed = parseSentSelectionQuotes(text);
        if (!parsed || !parsed.items || parsed.items.length === 0) {
          return undefined;
        }
        return {
          id: "selection-quote",
          start: 0,
          end: text.length,
          data: {
            items: parsed.items,
            userMessage: parsed.userMessage,
          },
        };
      },
    };

    const inject = ["slots", "locale", "sessions", "conversation", "uiConversation"];
    const name = NS;

    const LOCALE_STRINGS = {
      zh: {
        addToChat: "添加到对话",
        addComment: "写批注",
        dockTitle: "引用与批注队列",
        clearAll: "清空",
        insertAll: "一键汇总插入输入框",
      },
      en: {
        addToChat: "Add to Chat",
        addComment: "Add Comment",
        dockTitle: "Quotes & Comments",
        clearAll: "Clear",
        insertAll: "Insert All into Chat",
      },
    };

    const CONFIG_LOCALE_STRINGS = {
      zh: {
        _title: "划词引用与批注 (Selection Quote & Comment)",
        _description:
          "支持在会话消息流中鼠标划词一键添加到对话（Add to Chat ⌘L）、针对选中文本写注释/批注（Add Comment ⇧⌘L），并在输入框上方提供引用与批注汇总卡片栏。",
        enabled: {
          _title: "启用划词引用与批注工具条",
          _description: "开启后，在对话消息中鼠标划选任意文字即可弹出「添加到对话 (⌘L)」与「写批注 (⇧⌘L)」浮动工具条。",
        },
        addToChatMode: {
          _title: "Add to Chat 默认行为",
          _description: "控制点击 Add to Chat（或按 ⌘L）时是直接插入底部输入框，还是先加入输入框上方的待发送引用卡片栏。",
        },
        commentLabel: {
          _title: "批注前缀标签文本",
          _description: "将批注格式化为 Markdown 时的加粗标签名称（例如「批注」或「Comment」）。",
        },
      },
      en: {
        _title: "Selection Quote & Comment",
        _description:
          "Select text in conversation messages to Add to Chat (⌘L) or Add Comment (⇧⌘L), with a Quotes & Comments Dock right above the composer input box.",
        enabled: {
          _title: "Enable Selection Quote & Comment Toolbar",
          _description: "When enabled, selecting text in conversation messages pops up the floating Add to Chat (⌘L) and Add Comment (⇧⌘L) toolbar.",
        },
        addToChatMode: {
          _title: "Default Add to Chat Behavior",
          _description: "Whether Add to Chat (⌘L) inserts the quote directly into the composer draft or stages it in the Quotes & Comments Dock above the input box.",
        },
        commentLabel: {
          _title: "Comment Prefix Label",
          _description: "Bold prefix label used when formatting a comment into Markdown (e.g., '批注' or 'Comment').",
        },
      },
    };

    function apply(ctx) {
      if (ctx.locale && typeof ctx.locale.register === "function") {
        if (typeof ctx.effect === "function") {
          ctx.effect(() => ctx.locale.register(NS, LOCALE_STRINGS), "selection-quote: locale");
          ctx.effect(
            () => ctx.locale.register(`plugin-config.${NS}`, CONFIG_LOCALE_STRINGS),
            "selection-quote: plugin-config locale"
          );
        } else {
          ctx.locale.register(NS, LOCALE_STRINGS);
          ctx.locale.register(`plugin-config.${NS}`, CONFIG_LOCALE_STRINGS);
        }
      }

      const QuotesCommentsDock = createQuotesCommentsDockComponent(ctx);
      const SelectionQuoteOverlay = createSelectionOverlayComponent(ctx, QuotesCommentsDock);
      const SentSelectionQuoteNode = createSentSelectionQuoteComponent();

      const uiConversation =
        ctx.uiConversation || (typeof ctx.get === "function" ? ctx.get("uiConversation") : null);
      if (uiConversation && uiConversation.userText && typeof uiConversation.userText.register === "function") {
        if (typeof ctx.effect === "function") {
          ctx.effect(
            () => uiConversation.userText.register(selectionQuoteUserTextRule),
            "selection-quote: user-text rule"
          );
        } else {
          uiConversation.userText.register(selectionQuoteUserTextRule);
        }
      }

      ctx.slots.inject("conversation.user.text.node", () =>
        ctx.slots.register(
          {
            name: "conversation.user.text.node",
            key: "selection-quote",
            priority: 100,
          },
          SentSelectionQuoteNode
        )
      );

      ctx.slots.inject("conversation.input.overlay", () =>
        ctx.slots.register(
          {
            name: "conversation.input.overlay",
            id: "selection-quote-overlay",
            order: -10,
            locale: NS,
            inject: (sessionId) => ({ sessionId }),
          },
          SelectionQuoteOverlay
        )
      );

      ctx.slots.inject("conversation.input.dock", () =>
        ctx.slots.register(
          {
            name: "conversation.input.dock",
            id: "selection-quote-dock",
            order: -10,
            locale: NS,
            inject: (sessionId) => ({ sessionId, inlineOnly: true }),
          },
          QuotesCommentsDock
        )
      );
    }

    return {
      name,
      inject,
      apply,
      getSessionStore,
      createSelectionQuoteStore,
      formatQuoteBlock,
      formatQuoteForChat,
      formatQuoteAndComment,
      formatBatchItems,
      parseSentSelectionQuotes,
      truncateQuotePreview,
      computeToolbarPosition,
      isValidMessageSelection,
      insertIntoComposerDraft,
      // 便于本地测试与调试：Range 失效检测 / 原文重定位 / 角标锚点解析
      isRangeConnected,
      rangeMatchesQuote,
      findQuoteTextRange,
      resolveLivePinRect,
      computePinBounds,
      isRectInPinBounds,
      pinCoords,
    };
  }

  if (typeof window !== "undefined" && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === "function") {
    window.__ModuleLoader__.load({
      id: MODULE_ID,
      factory: buildModule,
    });
  }

  if (typeof globalThis !== "undefined") {
    globalThis.__DSH_SELECTION_QUOTE_BUILD__ = buildModule;
  }
})();
