import type {
    BrowserContextSnapshotAxNodeV1,
    BrowserContextSnapshotInteractiveElementV1,
} from '@happier-dev/protocol';

/**
 * BA-2 combined-snapshot evaluators + parsers. The injected expressions are bounded + try/guarded so
 * a hostile or huge DOM can never throw out of the evaluator or return an unbounded dump; the parsers
 * defensively coerce the raw CDP result into the bounded protocol shapes. These are the snapshot-only
 * page-query primitives owned by the context producer; the automation control bridge owns its own
 * read-only query expressions (kept separate so the two read surfaces evolve independently).
 */

export const SNAPSHOT_MAX_VISIBLE_TEXT_CHARS = 16_384;
export const SNAPSHOT_MAX_AX_NODES = 512;
export const SNAPSHOT_MAX_INTERACTIVE_ELEMENTS = 512;

const MAX_ROLE_CHARS = 128;
const MAX_NAME_CHARS = 256;
const MAX_SELECTOR_CHARS = 1024;

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function clampString(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    return trimmed.slice(0, max);
}

/**
 * Interactive-element evaluator: a bounded, structural list of actionable/landmark elements as
 * `{ role, name, selector, rect }`. The synthesized selector prefers a unique `#id`, then a
 * `[data-testid]`, else a short `:nth-of-type` ancestor path — a resilient locator an agent can act
 * on without coordinates. `name` is the visible accessible label (metadata), never field values;
 * `rect` is layout geometry only. Count + selector length are capped in-page.
 */
export function interactiveElementsExpression(maxElements: number): string {
    return `(() => {
    const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s);
    const isUnique = (s) => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
    const synth = (el) => {
      try {
        if (el.id) { const s = '#' + cssEsc(el.id); if (isUnique(s)) return s.slice(0, 256); }
        const tid = el.getAttribute && el.getAttribute('data-testid');
        if (tid) { const s = '[data-testid="' + tid.replace(/"/g, '\\\\"') + '"]'; if (isUnique(s)) return s.slice(0, 256); }
        const parts = [];
        let node = el;
        let depth = 0;
        while (node && node.nodeType === 1 && depth < 5) {
          let part = node.tagName.toLowerCase();
          const parent = node.parentElement;
          if (node.id) { parts.unshift('#' + cssEsc(node.id)); break; }
          if (parent) {
            const sibs = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
            if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
          }
          parts.unshift(part);
          node = parent;
          depth++;
        }
        return parts.join(' > ').slice(0, 256);
      } catch { return ''; }
    };
    const out = [];
    const sel = 'a,button,input,select,textarea,[role],h1,h2,h3,[aria-label]';
    const nodes = document.querySelectorAll(sel);
    for (let i = 0; i < nodes.length && out.length < ${maxElements}; i++) {
      const el = nodes[i];
      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      const name = (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
      let rect = { x: 0, y: 0, width: 0, height: 0 };
      try {
        const r = el.getBoundingClientRect();
        rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      } catch {}
      const selector = synth(el);
      if (!selector) continue;
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
    cap: number,
): Readonly<{ elements: readonly BrowserContextSnapshotInteractiveElementV1[]; truncated: boolean }> {
    if (!Array.isArray(value)) return { elements: [], truncated: false };
    const elements: BrowserContextSnapshotInteractiveElementV1[] = [];
    for (const raw of value) {
        if (elements.length >= cap) break;
        const r = record(raw);
        if (!r) continue;
        const role = clampString(r.role, MAX_ROLE_CHARS);
        const selector = clampString(r.selector, MAX_SELECTOR_CHARS);
        if (!role || !selector) continue;
        const name = clampString(r.name, MAX_NAME_CHARS);
        const rectRecord = record(r.rect);
        const rect = {
            x: numberOr(rectRecord?.x, 0),
            y: numberOr(rectRecord?.y, 0),
            width: Math.max(0, numberOr(rectRecord?.width, 0)),
            height: Math.max(0, numberOr(rectRecord?.height, 0)),
        };
        elements.push({ role, selector, rect, ...(name ? { name } : {}) });
    }
    return { elements, truncated: Array.isArray(value) && value.length > elements.length };
}

function axValue(node: Record<string, unknown>, field: string): string | undefined {
    const wrapped = record(node[field]);
    return clampString(wrapped?.value, field === 'role' ? MAX_ROLE_CHARS : MAX_NAME_CHARS);
}

/**
 * Parses a CDP `Accessibility.getFullAXTree` result into a bounded `{ role, name }[]`. Ignored nodes
 * and nodes without a role are dropped; names are capped. The full tree can be large, so the count is
 * capped and truncation is flagged honestly.
 */
export function parseAxNodes(
    value: unknown,
    cap: number,
): Readonly<{ nodes: readonly BrowserContextSnapshotAxNodeV1[]; truncated: boolean }> {
    const raw = record(value)?.nodes;
    if (!Array.isArray(raw)) return { nodes: [], truncated: false };
    const nodes: BrowserContextSnapshotAxNodeV1[] = [];
    let considered = 0;
    for (const entry of raw) {
        const node = record(entry);
        if (!node) continue;
        if (node.ignored === true) continue;
        const role = axValue(node, 'role');
        if (!role) continue;
        considered += 1;
        if (nodes.length >= cap) continue;
        const name = axValue(node, 'name');
        nodes.push({ role, ...(name ? { name } : {}) });
    }
    return { nodes, truncated: considered > nodes.length };
}
