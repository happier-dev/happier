import type {
  BrowserSidecarCdpPageHandle,
  BrowserSidecarContextCaptureSurface,
} from '../../sidecar/controlAdapter';
import type { BrowserContextRoutes } from '../../context/routes';
import type { BrowserDaemonControlAdapter } from '../../control/types';
import {
  parseLocator,
  synthesizeLocatorElementExpression,
} from '../locators';
import type {
  BrowserAutomationCdpInputInput,
  BrowserAutomationCdpInputResult,
  BrowserAutomationCdpPageQueryInput,
  BrowserAutomationCdpPageQueryResult,
  BrowserAutomationCdpTransport,
} from './cdp';

/**
 * Bridges the chromiumSidecar control adapter into the automation CDP transport seam (MCH-3).
 *
 * Navigation/mutation rides the real control-command producer. Read-only page queries
 * (snapshot/semanticSnapshot/queryElements/getStatus/getDiagnosticsSummary/waitFor) ride the SAME
 * live CDP transport the control adapter already opened — exposed via the optional
 * `BrowserSidecarContextCaptureSurface` (page handle + `dispatchPageCommand`). No second Chromium
 * connection is opened. When no context-capture surface is present (in-memory/QA adapters), queries
 * fail closed honestly (`runtime_unavailable`) — the navigation bit stays real either way.
 */

const MAX_SNAPSHOT_CHARS = 16_384;
const MAX_QUERY_ELEMENTS = 200;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: unknown, field: string): string | undefined {
  const r = record(value);
  const v = r?.[field];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function evaluateValue(result: unknown): unknown {
  const r = record(result);
  const evalResult = record(r?.result);
  if (!evalResult) return undefined;
  return evalResult.value;
}

function readCurrentHistoryEntry(history: unknown): Record<string, unknown> | null {
  const r = record(history);
  const currentIndex = r?.currentIndex;
  const entries = r?.entries;
  if (typeof currentIndex !== 'number' || !Number.isInteger(currentIndex) || !Array.isArray(entries)) {
    return null;
  }
  return record(entries[currentIndex]);
}

// Visible body text snapshot, whitespace-collapsed + length-capped so an unbounded DOM dump can
// never be returned. Read-only; never carries field input.
const DOM_TEXT_EXPRESSION =
  "(() => { const b = document.body; return b && b.innerText ? b.innerText : ''; })()";

// Semantic snapshot (BA-2): a bounded, structural list of interactive/landmark elements as
// `{ role, name, tag, selector, rect }`. The synthesized selector prefers a unique `#id`, then a
// `[data-testid]`, else a short `:nth-of-type` ancestor path — a resilient locator the agent can
// act on without coordinates. Names are visible accessible labels (metadata), never field values;
// rects are layout geometry only. Count + selector length capped; all in-page work is try/guarded
// so a hostile DOM can never throw out of the evaluator or return an unbounded dump.
function semanticSnapshotExpression(maxElements: number): string {
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
      out.push({ role, name, tag: el.tagName.toLowerCase(), selector: synth(el), rect });
    }
    return out;
  })()`;
}

function queryElementsExpression(selector: string, maxElements: number): string {
  const safeSelector = JSON.stringify(selector);
  return `(() => {
    const out = [];
    let nodes;
    try { nodes = document.querySelectorAll(${safeSelector}); } catch { return { error: 'invalid_selector' }; }
    for (let i = 0; i < nodes.length && out.length < ${maxElements}; i++) {
      const el = nodes[i];
      const name = (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
      out.push({ tag: el.tagName.toLowerCase(), name });
    }
    return { count: nodes.length, elements: out };
  })()`;
}

function queryLocatorExpression(selector: string, maxElements: number): string {
  const locator = parseLocator(selector);
  if (locator.strategy === 'css') {
    return queryElementsExpression(locator.selector, maxElements);
  }
  const elementExpression = synthesizeLocatorElementExpression(locator);
  return `(() => {
    const el = ${elementExpression};
    if (!el) return { count: 0, elements: [] };
    const name = (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    return { count: 1, elements: [{ tag: el.tagName.toLowerCase(), name }] };
  })()`;
}

function waitForExpression(selector: string): string {
  const safeSelector = JSON.stringify(selector);
  return `(() => { try { return !!document.querySelector(${safeSelector}); } catch { return false; } })()`;
}

function waitForLocatorExpression(selector: string): string {
  const locator = parseLocator(selector);
  if (locator.strategy === 'css') {
    return waitForExpression(locator.selector);
  }
  const elementExpression = synthesizeLocatorElementExpression(locator);
  return `(() => !!(${elementExpression}))()`;
}

// Resolves a selector to its center viewport point + focuses it (so keyboard verbs target it).
// Returns null when the selector is invalid/absent. Read+focus only; never carries field values.
function elementCenterExpression(selector: string): string {
  return `(() => {
    const el = ${synthesizeLocatorElementExpression(parseLocator(selector))};
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (typeof el.focus === 'function') { try { el.focus(); } catch {} }
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`;
}

function setValueExpression(selector: string, value: string): string {
  const safeValue = JSON.stringify(value);
  return `(() => {
    const el = ${synthesizeLocatorElementExpression(parseLocator(selector))};
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) { desc.set.call(el, ${safeValue}); } else { el.value = ${safeValue}; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

function selectOptionExpression(selector: string, value: string): string {
  const safeValue = JSON.stringify(value);
  return `(() => {
    const el = ${synthesizeLocatorElementExpression(parseLocator(selector))};
    if (!el || !(el instanceof HTMLSelectElement)) return false;
    el.value = ${safeValue};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

function readPoint(value: unknown): Readonly<{ x: number; y: number }> | null {
  const r = record(value);
  if (!r) return null;
  const x = r.x;
  const y = r.y;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return { x, y };
}

export function createControlAdapterAutomationTransport(input: Readonly<{
  adapter: BrowserDaemonControlAdapter;
  /**
   * Optional rich browser-context route. Production startup passes the canonical context route when
   * `browser.context` is enabled, so agent snapshot verbs consume the same producer as context
   * attach/capture instead of rebuilding a parallel snapshot path in automation.
   */
  browserContext?: Pick<BrowserContextRoutes, 'captureSnapshot'>;
  /**
   * Optional live CDP read surface (MCH-3). When present, read-only page queries dispatch over the
   * SAME transport + view bindings the control adapter opened. Absent ⇒ queries fail closed.
   */
  contextCapture?: BrowserSidecarContextCaptureSurface;
  /**
   * Optional diagnostics summarizer for `getDiagnosticsSummary` queries. Reads the redacted
   * diagnostics ring; never a live DOM query.
   */
  summarizeDiagnostics?: (input: Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
  }>) => Readonly<{ summary: string; truncated?: boolean }> | null;
}>): BrowserAutomationCdpTransport {
  const contextCapture = input.contextCapture;

  async function dispatchRichSnapshot(
    query: BrowserAutomationCdpPageQueryInput,
  ): Promise<BrowserAutomationCdpPageQueryResult | null> {
    if (!input.browserContext?.captureSnapshot) return null;
    const snapshot = await input.browserContext.captureSnapshot({
      browserSessionId: query.browserSessionId,
      viewId: query.viewId,
      navigationGeneration: query.navigationGeneration,
      contextId: `${query.browserSessionId} ${query.viewId} ${query.navigationGeneration}`,
    });
    const payload = record(snapshot);
    if (!payload) {
      return { ok: false, errorCode: 'runtime_unavailable' };
    }
    if (payload.ok === false) {
      return {
        ok: false,
        errorCode: payload.errorCode === 'invalid_parameters' ? 'unsupported_action' : 'runtime_unavailable',
      };
    }
    return { ok: true, data: payload };
  }

  async function dispatchPageCommand(
    handle: BrowserSidecarCdpPageHandle,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!contextCapture) return undefined;
    return contextCapture.transport.dispatchPageCommand({
      targetId: handle.targetId,
      ...(handle.sessionId ? { sessionId: handle.sessionId } : {}),
      method,
      ...(params ? { params } : {}),
    });
  }

  async function evaluate(handle: BrowserSidecarCdpPageHandle, expression: string): Promise<unknown> {
    return dispatchPageCommand(handle, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
  }

  async function dispatchPageQuery(
    query: BrowserAutomationCdpPageQueryInput,
  ): Promise<BrowserAutomationCdpPageQueryResult> {
    if (query.actionKind === 'snapshot') {
      const richSnapshot = await dispatchRichSnapshot(query);
      if (richSnapshot) return richSnapshot;
    }
    if (query.actionKind === 'semanticSnapshot') {
      const richSnapshot = await dispatchRichSnapshot(query);
      if (richSnapshot) {
        if (!richSnapshot.ok) return richSnapshot;
        const snapshot = record(richSnapshot.data) ?? {};
        return {
          ok: true,
          data: {
            ...snapshot,
            elements: Array.isArray(snapshot?.interactiveElements) ? snapshot.interactiveElements : [],
          },
        };
      }
    }

    if (!contextCapture) {
      return { ok: false, errorCode: 'runtime_unavailable' };
    }
    const handle = contextCapture.resolvePageHandle({
      browserSessionId: query.browserSessionId,
      viewId: query.viewId,
    });
    if (!handle) {
      return { ok: false, errorCode: 'view_closed' };
    }

    try {
      switch (query.actionKind) {
        case 'getStatus': {
          const history = await dispatchPageCommand(handle, 'Page.getNavigationHistory');
          const entry = readCurrentHistoryEntry(history);
          return {
            ok: true,
            data: {
              ...(stringField(entry, 'url') ? { url: stringField(entry, 'url') } : {}),
              ...(stringField(entry, 'title') ? { title: stringField(entry, 'title') } : {}),
              navigationGeneration: query.navigationGeneration,
            },
          };
        }
        case 'snapshot': {
          const richSnapshot = await dispatchRichSnapshot(query);
          if (richSnapshot) return richSnapshot;

          const text = evaluateValue(await evaluate(handle, DOM_TEXT_EXPRESSION));
          const collapsed = (typeof text === 'string' ? text : '').replace(/\s+/gu, ' ').trim();
          const truncated = collapsed.length > MAX_SNAPSHOT_CHARS;
          return {
            ok: true,
            data: {
              text: truncated ? `${collapsed.slice(0, MAX_SNAPSHOT_CHARS)}...` : collapsed,
              ...(truncated ? { truncated: true } : {}),
            },
          };
        }
        case 'semanticSnapshot': {
          const richSnapshot = await dispatchRichSnapshot(query);
          if (richSnapshot) {
            if (!richSnapshot.ok) return richSnapshot;
            const snapshot = record(richSnapshot.data) ?? {};
            return {
              ok: true,
              data: {
                ...snapshot,
                elements: Array.isArray(snapshot?.interactiveElements) ? snapshot.interactiveElements : [],
              },
            };
          }

          const elements = evaluateValue(await evaluate(handle, semanticSnapshotExpression(MAX_QUERY_ELEMENTS)));
          return { ok: true, data: { elements: Array.isArray(elements) ? elements : [] } };
        }
        case 'queryElements': {
          const selector = typeof query.payload.selector === 'string' ? query.payload.selector : '';
          if (!selector) {
            return { ok: false, errorCode: 'unsupported_action' };
          }
          const result = evaluateValue(await evaluate(handle, queryLocatorExpression(selector, MAX_QUERY_ELEMENTS)));
          const r = record(result);
          if (r?.error === 'invalid_selector') {
            return { ok: false, errorCode: 'selector_not_found' };
          }
          return {
            ok: true,
            data: {
              count: typeof r?.count === 'number' ? r.count : 0,
              elements: Array.isArray(r?.elements) ? r.elements : [],
            },
          };
        }
        case 'getDiagnosticsSummary': {
          if (!input.summarizeDiagnostics) {
            return { ok: false, errorCode: 'runtime_unavailable' };
          }
          const summary = input.summarizeDiagnostics({
            browserSessionId: query.browserSessionId,
            viewId: query.viewId,
            navigationGeneration: query.navigationGeneration,
          });
          if (!summary) {
            return { ok: false, errorCode: 'runtime_unavailable' };
          }
          return {
            ok: true,
            data: { summary: summary.summary, ...(summary.truncated ? { truncated: true } : {}) },
          };
        }
        case 'waitFor': {
          const selector = typeof query.payload.selector === 'string' ? query.payload.selector : '';
          if (!selector) {
            return { ok: false, errorCode: 'unsupported_action' };
          }
          const present = evaluateValue(await evaluate(handle, waitForLocatorExpression(selector)));
          return { ok: true, data: { present: present === true } };
        }
        default:
          return { ok: false, errorCode: 'unsupported_action' };
      }
    } catch {
      return { ok: false, errorCode: 'runtime_unavailable' };
    }
  }

  async function dispatchInputCommand(
    command: BrowserAutomationCdpInputInput,
  ): Promise<BrowserAutomationCdpInputResult> {
    if (!contextCapture) {
      return { ok: false, errorCode: 'runtime_unavailable' };
    }
    const handle = contextCapture.resolvePageHandle({
      browserSessionId: command.browserSessionId,
      viewId: command.viewId,
    });
    if (!handle) {
      return { ok: false, errorCode: 'view_closed' };
    }
    const selector = typeof command.payload.selector === 'string' ? command.payload.selector : '';

    // Arrow const (not a hoisted `function` declaration) so the narrowed non-null `handle` const is
    // preserved inside the closure; a hoisted declaration is lifted above the `if (!handle)` guard
    // and loses the narrowing.
    const clickAtSelector = async (): Promise<BrowserAutomationCdpInputResult> => {
      if (!selector) return { ok: false, errorCode: 'unsupported_action' };
      const point = readPoint(evaluateValue(await evaluate(handle, elementCenterExpression(selector))));
      if (!point) return { ok: false, errorCode: 'selector_not_found' };
      await dispatchPageCommand(handle, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await dispatchPageCommand(handle, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await dispatchPageCommand(handle, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      return { ok: true };
    };

    try {
      switch (command.actionKind) {
        case 'click':
        case 'tap':
          return await clickAtSelector();
        case 'hover': {
          if (!selector) return { ok: false, errorCode: 'unsupported_action' };
          const point = readPoint(evaluateValue(await evaluate(handle, elementCenterExpression(selector))));
          if (!point) return { ok: false, errorCode: 'selector_not_found' };
          await dispatchPageCommand(handle, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
          return { ok: true };
        }
        case 'focus': {
          if (!selector) return { ok: false, errorCode: 'unsupported_action' };
          const point = readPoint(evaluateValue(await evaluate(handle, elementCenterExpression(selector))));
          if (!point) return { ok: false, errorCode: 'selector_not_found' };
          return { ok: true };
        }
        case 'type': {
          // Optionally focus a target selector first, then insert text at the focused element.
          if (selector) {
            const point = readPoint(evaluateValue(await evaluate(handle, elementCenterExpression(selector))));
            if (!point) return { ok: false, errorCode: 'selector_not_found' };
          }
          const text = typeof command.payload.text === 'string' ? command.payload.text : '';
          await dispatchPageCommand(handle, 'Input.insertText', { text });
          return { ok: true };
        }
        case 'setValue': {
          if (!selector) return { ok: false, errorCode: 'unsupported_action' };
          const value = typeof command.payload.value === 'string' ? command.payload.value : '';
          const ok = evaluateValue(await evaluate(handle, setValueExpression(selector, value)));
          return ok === true ? { ok: true } : { ok: false, errorCode: 'selector_not_found' };
        }
        case 'select': {
          if (!selector) return { ok: false, errorCode: 'unsupported_action' };
          const value = typeof command.payload.value === 'string' ? command.payload.value : '';
          const ok = evaluateValue(await evaluate(handle, selectOptionExpression(selector, value)));
          return ok === true ? { ok: true } : { ok: false, errorCode: 'selector_not_found' };
        }
        case 'press': {
          const key = typeof command.payload.key === 'string' ? command.payload.key : '';
          if (!key) return { ok: false, errorCode: 'unsupported_action' };
          await dispatchPageCommand(handle, 'Input.dispatchKeyEvent', { type: 'keyDown', key });
          await dispatchPageCommand(handle, 'Input.dispatchKeyEvent', { type: 'keyUp', key });
          return { ok: true };
        }
        case 'scroll': {
          const deltaX = typeof command.payload.deltaX === 'number' ? command.payload.deltaX : 0;
          const deltaY = typeof command.payload.deltaY === 'number' ? command.payload.deltaY : 0;
          let x = 0;
          let y = 0;
          if (selector) {
            const point = readPoint(evaluateValue(await evaluate(handle, elementCenterExpression(selector))));
            if (point) {
              x = point.x;
              y = point.y;
            }
          }
          await dispatchPageCommand(handle, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
          return { ok: true };
        }
        default:
          return { ok: false, errorCode: 'unsupported_action' };
      }
    } catch {
      return { ok: false, errorCode: 'runtime_unavailable' };
    }
  }

  return {
    ownsView: (view) => input.adapter.ownsView(view),
    dispatchControlCommand: async (command) => await input.adapter.dispatchCommand(command),
    dispatchPageQuery,
    ...(contextCapture ? { dispatchInputCommand } : {}),
  };
}
