import test from "node:test";
import assert from "node:assert/strict";
import {
  name,
  Config,
  apply,
  formatQuoteBlock,
  formatQuoteForChat,
  formatQuoteAndComment,
  formatBatchItems,
  truncateQuotePreview,
  insertTextIntoShellDraft,
} from "../lib/index.js";

test("host plugin exports valid metadata and formatting helpers", () => {
  assert.equal(name, "selection-quote");
  assert.ok(Config);

  assert.equal(
    formatQuoteBlock("const port = 8080;\nconsole.log(port);"),
    "> const port = 8080;\n> console.log(port);"
  );

  assert.equal(
    formatQuoteForChat("单行选中文本"),
    "> 单行选中文本\n\n"
  );

  assert.equal(
    formatQuoteAndComment("listen 8080;", "这里端口不对，应该改成 9090"),
    "> listen 8080;\n**批注**：这里端口不对，应该改成 9090"
  );

  const batch = formatBatchItems([
    { quote: "选中的原文片段 1", comment: "这里端口不对，应该改成 9090" },
    { quote: "选中的原文片段 2", comment: "这段异常处理逻辑冗余，可以直接简化" },
  ]);

  assert.equal(
    batch,
    [
      "> 选中的原文片段 1",
      "**批注**：这里端口不对，应该改成 9090",
      "",
      "> 选中的原文片段 2",
      "**批注**：这段异常处理逻辑冗余，可以直接简化",
      "",
      "",
    ].join("\n")
  );

  assert.equal(truncateQuotePreview("a".repeat(20), 10), "aaaaaaaaa…");
});

test("insertTextIntoShellDraft appends or inserts cleanly into SessionInputShell", () => {
  let currentDraft = "";
  let focused = false;
  const shell = {
    projection: {
      get clipboardText() {
        return currentDraft;
      },
    },
    actions: {
      captureInsertion() {
        return { from: 0, to: 0 };
      },
      insertText(text) {
        currentDraft = text;
        return true;
      },
    },
    setDraft(next) {
      currentDraft = next;
    },
    focus() {
      focused = true;
    },
  };

  const ok1 = insertTextIntoShellDraft(shell, "> 第一段引用");
  assert.equal(ok1, true);
  assert.equal(currentDraft, "> 第一段引用\n\n");
  assert.equal(focused, true);

  const ok2 = insertTextIntoShellDraft(shell, "> 第二段引用\n**批注**：修改意见");
  assert.equal(ok2, true);
  assert.equal(
    currentDraft,
    "> 第一段引用\n\n> 第二段引用\n**批注**：修改意见\n\n"
  );
});

test("client bundle registers conversation.input.overlay and conversation.input.dock slots and manages dock state", async () => {
  let loadedModuleDef = null;
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    __ModuleLoader__: {
      load(def) {
        loadedModuleDef = def;
      },
    },
  };

  await import("../lib/client.js");
  assert.ok(loadedModuleDef, "client bundle should register via window.__ModuleLoader__.load");
  assert.equal(loadedModuleDef.id, "dsh-selection-quote-auto");

  const clientMod = loadedModuleDef.factory((pkg) => {
    if (pkg === "react") {
      return {
        useMemo: (fn) => fn(),
        useRef: (v) => ({ current: v }),
        useEffect: () => {},
        useCallback: (fn) => fn,
        useSyncExternalStore: (_sub, getSnap) => getSnap(),
      };
    }
    if (pkg === "react-dom") {
      return {
        createPortal: (node) => node,
      };
    }
    if (pkg === "react/jsx-runtime") {
      return {
        Fragment: "Fragment",
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
      };
    }
    return {};
  });

  assert.equal(clientMod.name, "selection-quote");
  assert.deepEqual(clientMod.inject, ["slots", "locale", "sessions", "conversation", "uiConversation"]);

  let registeredUserTextRule = null;
  const registeredSlots = [];
  const mockCtx = {
    slots: {
      inject(slotName, fn) {
        fn();
      },
      register(spec, component) {
        registeredSlots.push({ spec, component });
      },
    },
    conversation: {
      input: {
        shell() {
          return null;
        },
      },
    },
    uiConversation: {
      userText: {
        register(rule) {
          registeredUserTextRule = rule;
          return () => {};
        },
      },
    },
  };

  clientMod.apply(mockCtx);
  assert.equal(registeredSlots.length, 3);
  const slotNames = registeredSlots.map((s) => s.spec.name).sort();
  assert.deepEqual(slotNames, [
    "conversation.input.dock",
    "conversation.input.overlay",
    "conversation.user.text.node",
  ]);
  assert.ok(registeredUserTextRule, "should register selection-quote userText rule");
  const matched = registeredUserTextRule.match(
    "只有注释为什么没办法发送消息 不应该是这样\n\n> 在对话消息中鼠标划选任意文字后\n**批注**：测试 1\n\n> 确认按钮\n**批注**：测试 2",
    0
  );
  assert.ok(matched);
  assert.equal(matched.id, "selection-quote");
  assert.equal(matched.data.items.length, 2);
  assert.equal(matched.data.items[0].quote, "在对话消息中鼠标划选任意文字后");
  assert.equal(matched.data.items[0].comment, "测试 1");
  assert.equal(matched.data.userMessage, "只有注释为什么没办法发送消息 不应该是这样");

  // Verify store lifecycle: showPill -> openCommentMode -> addItem -> edit -> batch format
  const store = clientMod.getSessionStore("session-test-1");
  store.showPill("function connect() {}", {
    top: 240,
    left: 300,
    bottom: 260,
    right: 460,
    width: 160,
    height: 20,
  });
  assert.equal(store.getSnapshot().toolbar.visible, true);
  assert.equal(store.getSnapshot().toolbar.mode, "pill");

  store.openCommentMode();
  assert.equal(store.getSnapshot().toolbar.mode, "comment");
  store.setCommentDraft("建议增加重连退避逻辑");

  const added = store.addItem({
    quote: store.getSnapshot().toolbar.text,
    comment: store.getSnapshot().toolbar.commentDraft,
  });
  assert.ok(added.id);
  assert.equal(store.getSnapshot().toolbar.visible, false);
  assert.equal(store.getSnapshot().items.length, 1);
  assert.equal(store.getSnapshot().items[0].comment, "建议增加重连退避逻辑");

  // Edit comment in dock
  store.startEditing(added.id);
  store.setEditingComment("建议增加指数退避重连逻辑");
  store.commitEditing();
  assert.equal(store.getSnapshot().items[0].comment, "建议增加指数退避重连逻辑");

  // Selection validation excludes composer input and accepts conversation content
  const convRoot = {
    nodeType: 1,
    contains(node) {
      return node === msgNode || node === composerNode;
    },
  };
  const msgNode = {
    nodeType: 1,
    closest() {
      return null;
    },
  };
  const composerNode = {
    nodeType: 1,
    closest(sel) {
      return sel.includes("[data-composer-card]") ? {} : null;
    },
  };

  const validSel = clientMod.isValidMessageSelection(
    {
      isCollapsed: false,
      rangeCount: 1,
      toString: () => "选中的有效回复文本",
      getRangeAt: () => ({
        startContainer: msgNode,
        endContainer: msgNode,
        commonAncestorContainer: msgNode,
        getBoundingClientRect: () => ({
          top: 120,
          left: 200,
          bottom: 140,
          right: 320,
          width: 120,
          height: 20,
        }),
      }),
    },
    convRoot
  );
  assert.equal(validSel.valid, true);
  assert.equal(validSel.text, "选中的有效回复文本");

  const invalidComposerSel = clientMod.isValidMessageSelection(
    {
      isCollapsed: false,
      rangeCount: 1,
      toString: () => "输入框内部文字",
      getRangeAt: () => ({
        startContainer: composerNode,
        endContainer: composerNode,
        commonAncestorContainer: composerNode,
        getBoundingClientRect: () => ({
          top: 600,
          left: 200,
          bottom: 620,
          right: 320,
          width: 120,
          height: 20,
        }),
      }),
    },
    convRoot
  );
  assert.equal(invalidComposerSel.valid, false);

  // Verify computeToolbarPosition flips below when selection is near top edge
  const posNearTop = clientMod.computeToolbarPosition(
    { top: 20, left: 400, bottom: 42, right: 520, width: 120, height: 22 },
    { width: 1280, height: 800 },
    "comment"
  );
  assert.equal(posNearTop.placement, "below");

  const posNormal = clientMod.computeToolbarPosition(
    { top: 320, left: 400, bottom: 342, right: 520, width: 120, height: 22 },
    { width: 1280, height: 800 },
    "pill"
  );
  assert.equal(posNormal.placement, "above");
});

test("QuotesCommentsDock returns null when empty and batch-inserts structured markdown into SessionInputShell", async () => {
  await import("../lib/client.js");
  assert.equal(typeof globalThis.__DSH_SELECTION_QUOTE_BUILD__, "function");
  const clientMod = globalThis.__DSH_SELECTION_QUOTE_BUILD__((pkg) => {
    if (pkg === "react") {
      return {
        useMemo: (fn) => fn(),
        useRef: (v) => ({ current: v }),
        useEffect: () => {},
        useCallback: (fn) => fn,
        useSyncExternalStore: (_sub, getSnap) => getSnap(),
      };
    }
    if (pkg === "react-dom") {
      return { createPortal: (node) => node };
    }
    if (pkg === "react/jsx-runtime") {
      return {
        Fragment: "Fragment",
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
      };
    }
    return {};
  });

  let draftContent = "";
  const registered = {};
  const mockCtx = {
    slots: {
      inject(_name, fn) {
        fn();
      },
      register(spec, comp) {
        registered[spec.name] = comp;
      },
    },
    conversation: {
      input: {
        shell() {
          return {
            projection: {
              get clipboardText() {
                return draftContent;
              },
            },
            setDraft(val) {
              draftContent = val;
            },
            focus() {},
          };
        },
      },
    },
  };

  clientMod.apply(mockCtx);
  const DockComponent = registered["conversation.input.dock"];
  assert.ok(DockComponent);

  // Empty queue -> returns null (zero height)
  const emptyTree = DockComponent({ sessionId: "session-dock-test" });
  assert.equal(emptyTree, null);

  // Add 2 items and render dock
  const store = clientMod.getSessionStore("session-dock-test");
  store.addItem({ quote: "选中的原文片段 1", comment: "这里端口不对，应该改成 9090" });
  store.addItem({ quote: "选中的原文片段 2", comment: "这段异常处理逻辑冗余，可以直接简化" });

  const nonEmptyTree = DockComponent({ sessionId: "session-dock-test" });
  assert.ok(nonEmptyTree);
  assert.equal(nonEmptyTree.props["data-dsh-quote-dock"], "session-dock-test");

  // Find batch insert button and invoke onClick
  const headerActions = nonEmptyTree.props.children.props.children[0].props.children[1].props.children;
  const batchInsertBtn = headerActions.find((el) => el.props["data-action"] === "batch-insert-all");
  assert.ok(batchInsertBtn);
  batchInsertBtn.props.onClick();

  assert.equal(
    draftContent,
    [
      "> 选中的原文片段 1",
      "**批注**：这里端口不对，应该改成 9090",
      "",
      "> 选中的原文片段 2",
      "**批注**：这段异常处理逻辑冗余，可以直接简化",
      "",
      "",
    ].join("\n")
  );
  assert.equal(store.getSnapshot().items.length, 0);

  // Verify compatibility with @deepseek-ai/dsh-client-store's { getSnapshot, subscribe, set } contract
  const dshNativeStore = clientMod.createSelectionQuoteStore((initial) => {
    let cur = initial;
    const subs = new Set();
    return {
      getSnapshot: () => cur,
      subscribe: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      set: (next) => {
        cur = next;
        for (const fn of subs) fn();
      },
    };
  });
  dshNativeStore.showPill(
    "选中文字测试",
    { top: 200, left: 300, bottom: 224, right: 420, width: 120, height: 24 },
    { width: 1280, height: 800 }
  );
  assert.equal(dshNativeStore.getSnapshot().toolbar.visible, true);
  assert.equal(dshNativeStore.getSnapshot().toolbar.text, "选中文字测试");
});

test("custom patch: showTrigger stages the 注释 trigger and opens the comment capsule from it", async () => {
  await import("../lib/client.js");
  assert.equal(typeof globalThis.__DSH_SELECTION_QUOTE_BUILD__, "function");
  const clientMod = globalThis.__DSH_SELECTION_QUOTE_BUILD__((pkg) => {
    if (pkg === "react") {
      return {
        useMemo: (fn) => fn(),
        useRef: (v) => ({ current: v }),
        useEffect: () => {},
        useCallback: (fn) => fn,
        useState: (v) => [v, () => {}],
        useSyncExternalStore: (_sub, getSnap) => getSnap(),
      };
    }
    if (pkg === "react-dom") return { createPortal: (node) => node };
    if (pkg === "react/jsx-runtime") {
      return {
        Fragment: "Fragment",
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
      };
    }
    return {};
  });

  const store = clientMod.getSessionStore("session-trigger-test");
  assert.equal(store.getSnapshot().toolbar.visible, false);

  store.showTrigger(
    "助手消息里的选中文字",
    { top: 300, left: 360, bottom: 324, right: 540, width: 180, height: 24 },
    { width: 1280, height: 800 },
    { range: null }
  );
  const triggered = store.getSnapshot();
  assert.equal(triggered.toolbar.visible, true);
  assert.equal(triggered.toolbar.mode, "trigger");
  assert.equal(triggered.toolbar.text, "助手消息里的选中文字");
  assert.ok(Number(triggered.toolbar.left) > 0);
  assert.ok(Number(triggered.toolbar.top) > 0);

  // 点击「注释」浮框 -> 复用 openCommentMode 打开评论胶囊
  store.openCommentMode();
  const opened = store.getSnapshot();
  assert.equal(opened.toolbar.visible, true);
  assert.equal(opened.toolbar.mode, "comment");
  assert.equal(opened.toolbar.text, "助手消息里的选中文字");

  store.hideToolbar();
  assert.equal(store.getSnapshot().toolbar.visible, false);
});
