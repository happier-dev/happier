import type {
    BrowserContextSnapshotAxNodeV1,
    BrowserContextSnapshotInteractiveElementV1,
} from '@happier-dev/protocol';
import { synthesizeLocatorNameExpression } from '../../automation/locators';
import type { SnapshotMasking } from './snapshotMasking';

/**
 * Combined-snapshot extraction shared by context capture and automation semantic snapshots.
 * Preserve complete valid page content rather than clipping it to a second local budget.
 * Secret values still require affirmative DOM evidence; missing evidence marks values incomplete.
 */

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function nonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    return trimmed;
}

/**
 * Interactive-element evaluator: a structural list of actionable/landmark elements as
 * `{ role, name, selector, rect }`. The synthesized selector prefers a unique `#id`, then a
 * `[data-testid]`, else a short `:nth-of-type` ancestor path — a resilient locator an agent can act
 * on without coordinates. `name` is the visible accessible label (metadata), never field values;
 * `rect` is layout geometry only. Executable selectors are always returned whole.
 */
export function interactiveElementsExpression(): string {
    return `(() => {
    const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s);
    const isUnique = (s) => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
    const synth = (el) => {
      try {
        if (el.id) { const s = '#' + cssEsc(el.id); if (isUnique(s)) return s; }
        const tid = el.getAttribute && el.getAttribute('data-testid');
        if (tid) { const s = '[data-testid="' + tid.replace(/"/g, '\\\\"') + '"]'; if (isUnique(s)) return s; }
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1) {
          let part = node.tagName.toLowerCase();
          const parent = node.parentElement;
          if (parent) {
            const sibs = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
            if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
          }
          parts.unshift(part);
          node = parent;
          const candidate = parts.join(' > ');
          if (isUnique(candidate)) return candidate;
        }
        return '';
      } catch { return ''; }
    };
    const out = [];
    const sel = 'a,button,input,select,textarea,[role],h1,h2,h3,[aria-label]';
    const nodes = document.querySelectorAll(sel);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      const name = ${synthesizeLocatorNameExpression('el')};
      let rect = { x: 0, y: 0, width: 0, height: 0 };
      try {
        const r = el.getBoundingClientRect();
        rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      } catch {}
      const selector = synth(el);
      out.push({ role, name, selector, rect });
    }
    return out;
  })()`;
}

function numberOr(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function parseInteractiveElements(
    value: unknown,
): Readonly<{ elements: readonly BrowserContextSnapshotInteractiveElementV1[]; truncated: boolean }> {
    if (!Array.isArray(value)) return { elements: [], truncated: false };
    const elements: BrowserContextSnapshotInteractiveElementV1[] = [];
    for (const raw of value) {
        const r = record(raw);
        if (!r) continue;
        const role = nonEmptyString(r.role);
        // Selectors are executable code, not display text: never return a sliced selector.
        const selector = nonEmptyString(r.selector);
        if (!role || !selector) continue;
        const name = nonEmptyString(r.name);
        const rectRecord = record(r.rect);
        const rect = {
            x: numberOr(rectRecord?.x, 0),
            y: numberOr(rectRecord?.y, 0),
            width: Math.max(0, numberOr(rectRecord?.width, 0)),
            height: Math.max(0, numberOr(rectRecord?.height, 0)),
        };
        elements.push({ role, selector, rect, ...(name ? { name } : {}) });
    }
    return { elements, truncated: value.length > elements.length };
}

function axValue(node: Record<string, unknown>, field: string): string | undefined {
    const wrapped = record(node[field]);
    return nonEmptyString(wrapped?.value);
}

/**
 * AX supplies current values; DOM metadata establishes which editable fields may disclose them.
 * Unknown metadata fails closed for values while preserving the structural snapshot.
 */
export function parseAxNodes(
    value: unknown,
    masking?: SnapshotMasking,
): Readonly<{ nodes: readonly BrowserContextSnapshotAxNodeV1[]; truncated: boolean }> {
    const raw = record(value)?.nodes;
    if (!Array.isArray(raw)) return { nodes: [], truncated: false };
    const nodes: BrowserContextSnapshotAxNodeV1[] = [];
    let valuesTruncated = false;
    for (const entry of raw) {
        const node = record(entry);
        if (!node) continue;
        if (node.ignored === true) continue;
        const role = axValue(node, 'role');
        if (!role) continue;
        const name = axValue(node, 'name');
        const rawValue = record(node.value)?.value;
        const isEditable = Array.isArray(node.properties) && node.properties.some((property) => {
            const entry = record(property);
            const kind = record(entry?.value)?.value;
            return entry?.name === 'editable' && (kind === 'plaintext' || kind === 'richtext');
        });
        const allowed = typeof node.backendDOMNodeId === 'number'
            ? masking?.sensitiveBackendNodeIds.has(node.backendDOMNodeId) ? false
                : masking?.editableBackendNodeIds.get(node.backendDOMNodeId)
            : undefined;
        const fieldValue = isEditable && allowed === true && typeof rawValue === 'string'
            ? rawValue : undefined;
        if (isEditable && typeof rawValue === 'string' && allowed === undefined) valuesTruncated = true;
        nodes.push({ role, ...(name ? { name } : {}), ...(fieldValue !== undefined ? { value: fieldValue } : {}) });
    }
    return { nodes, truncated: valuesTruncated };
}
