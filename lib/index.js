/**
 * DeepSeek Harness 划词引用与批注插件 (dsh-selection-quote) — Host 入口与通用纯函数模块
 *
 * 提供：
 * 1. Cordis Host 插件挂载与 Schemastery 配置 Schema（支持插件管理器可视化配置）；
 * 2. 引用块与批注的 Markdown 结构化格式化纯函数（`formatQuoteBlock`、`formatQuoteForChat`、
 *    `formatQuoteAndComment`、`formatBatchItems`、`truncateQuotePreview`）；
 * 3. 面向 `SessionInputShell` 的草稿合并与光标处插入辅助函数（`insertTextIntoShellDraft`）。
 *
 * @module dsh-selection-quote
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function importHostPackage(specifier) {
  try {
    return await import(specifier);
  } catch {
    const anchors = [
      process.argv[1],
      typeof process.resourcesPath === 'string'
        ? path.join(process.resourcesPath, 'app.asar', 'dsh', 'package.json')
        : undefined,
    ].filter((item) => typeof item === 'string' && item.length > 0);

    for (const anchor of anchors) {
      try {
        const req = createRequire(anchor);
        const resolved = req.resolve(specifier);
        return await import(pathToFileURL(resolved).href);
      } catch {
        // try next anchor
      }
    }
    return null;
  }
}

const schemasteryMod = await importHostPackage('@deepseek-ai/schemastery');
const schemastery = schemasteryMod ? (schemasteryMod.default ?? schemasteryMod) : null;

export const name = 'selection-quote';
export const inject = [];

export const DEFAULT_COMMENT_LABEL = '批注';
export const DEFAULT_COMMENT_LABEL_EN = 'Comment';
export const ADD_TO_CHAT_MODES = Object.freeze(['direct', 'dock']);

/**
 * 解包 Schemastery `.volatile()` 包装的响应式配置值。
 */
export function unwrapVolatile(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value;
}

/**
 * 归一化插件配置。
 */
export function normalizeConfig(raw = {}) {
  const unwrappedRoot = unwrapVolatile(raw);
  const input = unwrappedRoot && typeof unwrappedRoot === 'object' ? unwrappedRoot : {};

  const enabledVal = unwrapVolatile(input.enabled);
  const modeVal = unwrapVolatile(input.addToChatMode);
  const labelVal = unwrapVolatile(input.commentLabel);

  const enabled = typeof enabledVal === 'boolean' ? enabledVal : true;
  const addToChatMode = modeVal === 'dock' ? 'dock' : 'direct';
  const rawLabel = typeof labelVal === 'string' ? labelVal.trim() : '';
  const commentLabel = rawLabel.length > 0 ? rawLabel : DEFAULT_COMMENT_LABEL;

  return {
    enabled,
    addToChatMode,
    commentLabel,
  };
}

function makeFallbackFieldNode(uid, type, meta) {
  return {
    uid,
    type,
    meta,
    toJSON() {
      return {
        uid,
        refs: {
          [uid]: { type, meta: { ...meta } },
        },
      };
    },
  };
}

function createFallbackSchema() {
  const schema = (value) => normalizeConfig(value);
  const dict = {
    enabled: makeFallbackFieldNode(1, 'boolean', { default: true, volatile: true }),
    addToChatMode: makeFallbackFieldNode(2, 'string', { default: 'direct', volatile: true }),
    commentLabel: makeFallbackFieldNode(3, 'string', {
      default: DEFAULT_COMMENT_LABEL,
      volatile: true,
    }),
  };

  schema.uid = 0;
  schema.type = 'object';
  schema.meta = {};
  schema.dict = dict;
  schema.toJSON = () => ({
    uid: 0,
    refs: {
      0: {
        type: 'object',
        meta: {},
        dict: {
          enabled: 1,
          addToChatMode: 2,
          commentLabel: 3,
        },
      },
      1: { type: 'boolean', meta: { default: true, volatile: true } },
      2: { type: 'string', meta: { default: 'direct', volatile: true } },
      3: { type: 'string', meta: { default: DEFAULT_COMMENT_LABEL, volatile: true } },
    },
  });

  Object.defineProperty(schema, '~standard', {
    value: {
      version: 1,
      vendor: 'dsh-selection-quote',
      validate(value) {
        return { value: normalizeConfig(value) };
      },
    },
    enumerable: false,
    configurable: true,
  });
  return schema;
}

function withVolatile(fieldSchema) {
  return typeof fieldSchema?.volatile === 'function' ? fieldSchema.volatile() : fieldSchema;
}

function createPluginSchema() {
  if (!schemastery) return createFallbackSchema();
  try {
    return schemastery.object({
      enabled: withVolatile(schemastery.boolean().default(true)),
      addToChatMode: withVolatile(
        typeof schemastery.union === 'function' && typeof schemastery.const === 'function'
          ? schemastery
              .union([schemastery.const('direct'), schemastery.const('dock')])
              .default('direct')
          : schemastery.string().default('direct'),
      ),
      commentLabel: withVolatile(schemastery.string().default(DEFAULT_COMMENT_LABEL)),
    });
  } catch {
    return createFallbackSchema();
  }
}

export const Config = createPluginSchema();

/**
 * 将选中的多行或单行文本转换为 Markdown 引用块（不含末尾空行）。
 * 例如：`"line 1\nline 2"` -> `"> line 1\n> line 2"`
 *
 * @param {string} text
 * @returns {string}
 */
export function formatQuoteBlock(text) {
  if (typeof text !== 'string') return '';
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  return normalized
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * 将选中的文本格式化为直接插入输入框草稿的引用块（带末尾双换行 `> 选中文本\n\n`）。
 *
 * @param {string} text
 * @returns {string}
 */
export function formatQuoteForChat(text) {
  const block = formatQuoteBlock(text);
  return block ? `${block}\n\n` : '';
}

/**
 * 将单条「原文 + 批注」格式化为结构化 Markdown。
 * 格式：
 * ```markdown
 * > 选中的原文片段 1
 * **批注**：这里端口不对，应该改成 9090
 * ```
 *
 * @param {string} quote
 * @param {string} [comment]
 * @param {{ commentLabel?: string }} [options]
 * @returns {string}
 */
export function formatQuoteAndComment(quote, comment = '', options = {}) {
  const block = formatQuoteBlock(quote);
  if (!block) return '';
  const cleanComment = typeof comment === 'string' ? comment.replace(/\r\n?/g, '\n').trim() : '';
  if (!cleanComment) return block;
  const label =
    typeof options?.commentLabel === 'string' && options.commentLabel.trim().length > 0
      ? options.commentLabel.trim()
      : DEFAULT_COMMENT_LABEL;
  return `${block}\n**${label}**：${cleanComment}`;
}

/**
 * 将多条「原文 + 批注」批量汇总为结构化 Markdown。
 *
 * @param {Array<{ quote: string, comment?: string }>} items
 * @param {{ commentLabel?: string, trailingNewlines?: boolean }} [options]
 * @returns {string}
 */
export function formatBatchItems(items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const blocks = items
    .map((item) => formatQuoteAndComment(item?.quote ?? '', item?.comment ?? '', options))
    .filter((block) => block.length > 0);
  if (blocks.length === 0) return '';
  const joined = blocks.join('\n\n');
  return options?.trailingNewlines === false ? joined : `${joined}\n\n`;
}

/**
 * 生成用于卡片/悬浮窗展示的单行或紧凑截断摘要。
 *
 * @param {string} text
 * @param {number} [maxLength=120]
 * @returns {string}
 */
export function truncateQuotePreview(text, maxLength = 120) {
  if (typeof text !== 'string') return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(1, maxLength - 1))}…`;
}

/**
 * 向 `SessionInputShell` 插入格式化后的文本，优先使用光标处插入 (`captureInsertion` + `insertText`)，
 * 若不满足 CAS 或无可映射选区则安全回退到 `setDraft` 追加。
 *
 * @param {object} shell - `ctx.conversation.input.shell(sessionId)` 实例
 * @param {string} formattedText - 待插入的 Markdown 文本
 * @returns {boolean} 是否成功写入
 */
export function insertTextIntoShellDraft(shell, formattedText) {
  if (!shell || typeof formattedText !== 'string') {
    return false;
  }
  const normalized = formattedText.replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    return false;
  }
  const textWithTrailingNewlines = `${normalized}\n\n`;

  const currentText = shell.projection?.clipboardText ?? shell.snapshot?.draft ?? '';
  const trimmedPrev = currentText.replace(/\s+$/u, '');
  const hasExisting = trimmedPrev.length > 0;
  const nextDraft = hasExisting
    ? `${trimmedPrev}\n\n${textWithTrailingNewlines}`
    : textWithTrailingNewlines;

  let inserted = false;

  if (!hasExisting && typeof shell.actions?.insertText === 'function') {
    const span = shell.actions?.captureInsertion?.();
    if (shell.actions.insertText(textWithTrailingNewlines, span)) {
      inserted = true;
    }
  }

  if (!inserted && typeof shell.setDraft === 'function') {
    shell.setDraft(nextDraft);
    inserted = true;
  } else if (!inserted && typeof shell.actions?.setDraft === 'function') {
    shell.actions.setDraft(nextDraft);
    inserted = true;
  } else if (!inserted && typeof shell.actions?.insertText === 'function') {
    const span = shell.actions?.captureInsertion?.();
    const prefix = currentText && !currentText.endsWith('\n') ? '\n\n' : '';
    inserted = Boolean(shell.actions.insertText(`${prefix}${textWithTrailingNewlines}`, span));
  }

  if (inserted && typeof shell.focus === 'function') {
    try {
      shell.focus();
    } catch {
      // ignore focus error
    }
  }

  return inserted;
}

/**
 * Host 端挂载入口。
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config);
  ctx.effect(() => () => {}, `dsh-selection-quote: carrier (enabled=${resolved.enabled})`);
}

export default {
  name,
  inject,
  Config,
  apply,
};
