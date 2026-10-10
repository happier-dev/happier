import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserActiveTargetV1Schema, normalizeBrowserActiveTargetRect, readBrowserActiveTargetLabel } from '@happier-dev/protocol/browser/events/activeTarget';
import { browserViewContextId } from '@happier-dev/protocol/browser/view/key';
import { parseLocator } from '@happier-dev/protocol/browser/automation/locators';
import type { BrowserAutomationSecretFillRequestV1 } from '@happier-dev/protocol/browser/automation/v1';
import type { SecretFillSettlementV1 } from '@happier-dev/protocol/computer/v1';
import type { ConfidentialSecretFillTarget } from '../../../surfaces/confidentialSecretFill';

import type {
  BrowserSidecarCdpPageHandle,
  BrowserSidecarContextCaptureSurface,
} from '../../sidecar/controlAdapter';
import type { BrowserContextRoutes } from '../../context/routes';
import { interactiveElementsExpression, parseInteractiveElements, SNAPSHOT_MAX_INTERACTIVE_ELEMENTS, SNAPSHOT_MAX_VISIBLE_TEXT_CHARS } from '../../context/cdp/snapshotEvaluators';
import type { BrowserDaemonControlAdapter } from '../../control/types';
import { BrowserSidecarCdpTransportError, isBrowserSidecarCdpCommandNotDispatched } from '../../sidecar/cdpTransport';
import type { BrowserAutomationAdapterExecuteResult, BrowserAutomationAdapterExecutionContext } from './types';
import type { BrowserAutomationViewRef } from '../owners';
import {
  synthesizeLocatorElementExpression,
  synthesizeLocatorNameExpression,
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

const MAX_SNAPSHOT_CHARS = SNAPSHOT_MAX_VISIBLE_TEXT_CHARS;

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

function queryElementsExpression(selector: string): string {
  const safeSelector = JSON.stringify(selector);
  return `(() => {
    const out = [];
    let nodes;
    try { nodes = document.querySelectorAll(${safeSelector}); } catch { return { error: 'invalid_selector' }; }
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const name = ${synthesizeLocatorNameExpression('el')};
      out.push({ tag: el.tagName.toLowerCase(), name });
    }
    return { count: nodes.length, elements: out, truncated: false };
  })()`;
}

function queryLocatorExpression(selector: string): string {
  const locator = parseLocator(selector);
  if (locator.strategy === 'css') {
    return queryElementsExpression(locator.selector);
  }
  const elementExpression = synthesizeLocatorElementExpression(locator);
  return `(() => {
    const el = ${elementExpression};
    if (!el) return { count: 0, elements: [] };
    const name = ${synthesizeLocatorNameExpression('el')};
    return { count: 1, elements: [{ tag: el.tagName.toLowerCase(), name }], truncated: false };
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
function elementCenterExpression(selector: string, prepareInput = true): string {
  const locator = parseLocator(selector);
  const locatorLabel = locator.strategy === 'role' ? locator.name : locator.strategy === 'text' ? locator.text : undefined;
  return `(() => {
    const el = ${synthesizeLocatorElementExpression(locator)};
    if (!el) return null;
    ${prepareInput ? "el.scrollIntoView({ block: 'center', inline: 'center' });" : ''}
    const r = el.getBoundingClientRect();
    ${prepareInput ? "if (typeof el.focus === 'function') { try { el.focus(); } catch {} }" : ''}
    const w = typeof innerWidth === 'number' ? innerWidth : 0;
    const h = typeof innerHeight === 'number' ? innerHeight : 0;
    const activeTarget = (${normalizeBrowserActiveTargetRect.toString()})({ x: r.left, y: r.top, width: r.width, height: r.height }, { width: w, height: h });
    const label = (${readBrowserActiveTargetLabel.toString()})(el, 512, ${JSON.stringify(locatorLabel ?? '')});
    return { x: r.left + r.width / 2, y: r.top + r.height / 2,
      ...(activeTarget ? { activeTarget: { ...activeTarget, ...(label ? { label } : {}) } } : {}) };
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

  type CredentialTarget = Pick<BrowserAutomationSecretFillRequestV1,
    'browserSessionId' | 'viewId' | 'tabId' | 'frameId' | 'documentId' | 'navigationGeneration' | 'origin' | 'field'>;
  type Refusal = Extract<SecretFillSettlementV1, { status: 'refused' }>;

  function currentCredentialHandle(target: CredentialTarget): BrowserSidecarCdpPageHandle | null {
    if (!contextCapture || !input.adapter.ownsView(target)) return null;
    const handle = contextCapture.resolvePageHandle(target);
    const navigation = contextCapture.getNavigationState?.(target);
    return handle?.targetId === target.tabId && navigation?.navigationGeneration === target.navigationGeneration
      && navigation.loadingState === 'ready' ? handle : null;
  }

  function findFrame(tree: unknown, frameId: string): Record<string, unknown> | null {
    const node = record(tree);
    const frame = record(node?.frame);
    if (frame?.id === frameId) return frame;
    for (const child of Array.isArray(node?.childFrames) ? node.childFrames : []) {
      const found = findFrame(child, frameId);
      if (found) return found;
    }
    return null;
  }

  async function releaseCredentialObjects(handle: BrowserSidecarCdpPageHandle, objects: string[]): Promise<void> {
    for (const objectId of objects.splice(0)) {
      try { await dispatchPageCommand(handle, 'Runtime.releaseObject', { objectId }); } catch { /* No private error escapes cleanup. */ }
    }
  }

  async function proveCredentialTarget(target: CredentialTarget, objects: string[], signal?: AbortSignal): Promise<Readonly<{
    handle: BrowserSidecarCdpPageHandle; fieldObjectId: string; executionContextId: number;
  }> | null> {
    const handle = currentCredentialHandle(target);
    if (!handle || signal?.aborted || !/^[1-9]\d*$/u.test(target.field.fieldId)
      || target.field.focusId !== target.field.fieldId) return null;
    const isCurrent = () => {
      const current = currentCredentialHandle(target);
      return !signal?.aborted && current?.targetId === handle.targetId && current?.sessionId === handle.sessionId;
    };
    const read = async (method: string, params?: Record<string, unknown>) => {
      if (!isCurrent()) return undefined;
      const result = await dispatchPageCommand(handle, method, params);
      return isCurrent() ? result : undefined;
    };
    const frame = findFrame(record(await read('Page.getFrameTree'))?.frameTree, target.frameId);
    if (frame?.loaderId !== target.documentId || frame?.securityOrigin !== target.origin) return null;
    // Isolated-world DOM bindings prevent page-defined getters/methods from supplying the proof.
    const world = record(await read('Page.createIsolatedWorld', { frameId: target.frameId, worldName: 'happier-confidential-input' }));
    const executionContextId = world?.executionContextId;
    if (typeof executionContextId !== 'number') return null;
    const elementExpression = synthesizeLocatorElementExpression(parseLocator(target.field.locator));
    const resolve = async (expression: string) => {
      const remote = record(await read('Runtime.evaluate', { expression, contextId: executionContextId,
        returnByValue: false, awaitPromise: false, silent: true }));
      const objectId = stringField(remote?.result, 'objectId');
      if (objectId) objects.push(objectId);
      return objectId;
    };
    const fieldObjectId = await resolve(elementExpression);
    const activeObjectId = await resolve('document.activeElement');
    if (!fieldObjectId || !activeObjectId || !isCurrent()) return null;
    for (const objectId of [fieldObjectId, activeObjectId]) {
      const node = record(record(await read('DOM.describeNode', { objectId, depth: 0 }))?.node);
      if (String(node?.backendNodeId) !== target.field.fieldId) return null;
    }
    const finalFrame = findFrame(record(await read('Page.getFrameTree'))?.frameTree, target.frameId);
    if (finalFrame?.loaderId !== target.documentId || finalFrame?.securityOrigin !== target.origin) return null;
    const valid = evaluateValue(await read('Runtime.callFunctionOn', {
      objectId: fieldObjectId, returnByValue: true, silent: true,
      functionDeclaration: `function() { return this.isConnected && this.ownerDocument === document
        && document.hasFocus() && document.activeElement === this && (${elementExpression}) === this
        && location.origin === ${JSON.stringify(target.origin)} && !this.disabled && !this.readOnly
        && (this instanceof HTMLTextAreaElement || (this instanceof HTMLInputElement
          && ['text','password','email','search','tel','url','number'].includes(this.type))); }`,
    }));
    return valid === true && isCurrent() ? { handle, fieldObjectId, executionContextId } : null;
  }

  async function prepareConfidentialFill(request: BrowserAutomationSecretFillRequestV1): Promise<ConfidentialSecretFillTarget | Refusal> {
    if (!contextCapture?.getNavigationState) return { status: 'refused', code: 'field_verification_unsupported' };
    const handle = contextCapture.resolvePageHandle(request);
    if (!handle) return { status: 'refused', code: 'target_unavailable' };
    const objects: string[] = [];
    try {
      if (!await proveCredentialTarget(request, objects)) {
        await releaseCredentialObjects(handle, objects);
        return { status: 'refused', code: 'target_changed' };
      }
    } catch {
      await releaseCredentialObjects(handle, objects);
      return { status: 'refused', code: 'field_verification_unsupported' };
    }
    let finished = false;
    let fillStarted = false;
    let settlement: SecretFillSettlementV1 | undefined;
    let submitStarted = false;
    let submitSettlement: NonNullable<Extract<SecretFillSettlementV1, { status: 'filled' }>['submit']> | undefined;
    return {
      ...(contextCapture.resolveNativeObservation?.(request) === 'not_observable'
        ? { nativeObservation: 'not_observable' as const } : {}),
      async recheck() {
        if (finished) return false;
        try { return !!await proveCredentialTarget(request, objects); } catch { return false; }
      },
      async isSafe() {
        // A live invocation still needs its hold. Clearing a field or changing loaders cannot
        // establish safety after delivery: page script and Chromium's back/forward cache can retain it.
        return finished && settlement?.status !== 'filled' && settlement?.status !== 'unknown';
      },
      async fill(value, signal, beforeDelivery) {
        let text: string | undefined;
        let parameters: Record<string, unknown> | undefined;
        let issued = false;
        try {
          if (fillStarted) return settlement ?? { status: 'unknown', code: 'delivery_unknown' };
          fillStarted = true;
          if (signal?.aborted) return settlement = { status: 'canceled', code: 'canceled' };
          if (finished) return settlement = { status: 'refused', code: 'target_changed' };
          if (!await proveCredentialTarget(request, objects, signal)) {
            return settlement = signal?.aborted ? { status: 'canceled', code: 'canceled' }
              : { status: 'refused', code: 'target_changed' };
          }
          if (beforeDelivery && !await beforeDelivery()) {
            return settlement = signal?.aborted ? { status: 'canceled', code: 'canceled' }
              : { status: 'refused', code: 'approval_changed' };
          }
          if (!await proveCredentialTarget(request, objects, signal)) {
            return settlement = signal?.aborted ? { status: 'canceled', code: 'canceled' }
              : { status: 'refused', code: 'target_changed' };
          }
          // The service's input owner serializes this CDP sequence. D46 accepts the residual
          // verify→insert micro-race; no await or page script carrying material intervenes here.
          text = new TextDecoder('utf-8', { fatal: true }).decode(value);
          parameters = { text };
          issued = true;
          await dispatchPageCommand(handle, 'Input.insertText', parameters);
          return settlement = { status: 'filled', code: 'filled' };
        } catch (error) {
          return settlement = issued && !isBrowserSidecarCdpCommandNotDispatched(error) ? { status: 'unknown', code: 'delivery_unknown' }
            : signal?.aborted ? { status: 'canceled', code: 'canceled' }
              : { status: 'refused', code: 'target_changed' };
        } finally {
          value.fill(0);
          if (parameters) delete parameters.text;
          parameters = undefined;
          text = undefined;
        }
      },
      ...(request.submit ? { async submit(signal?: AbortSignal, beforeDelivery?: () => Promise<boolean>) {
        if (submitStarted) return submitSettlement ?? { status: 'unknown' as const, code: 'submit_unknown' as const };
        if (finished || settlement?.status !== 'filled' || signal?.aborted) {
          return { status: 'refused' as const, code: 'submit_refused' as const };
        }
        const submit = request.submit!;
        let issued = false;
        try {
          const proof = await proveCredentialTarget(request, objects, signal);
          if (!proof || !/^[1-9]\d*$/u.test(submit.controlId)) return { status: 'refused' as const, code: 'submit_refused' as const };
          const controlExpression = synthesizeLocatorElementExpression(parseLocator(submit.locator));
          const remote = await dispatchPageCommand(handle, 'Runtime.evaluate', { expression: controlExpression,
            contextId: proof.executionContextId, returnByValue: false, awaitPromise: false, silent: true });
          const objectId = stringField(record(remote)?.result, 'objectId');
          if (objectId) objects.push(objectId);
          if (!objectId || !currentCredentialHandle(request) || signal?.aborted) return { status: 'refused' as const, code: 'submit_refused' as const };
          const node = record(record(await dispatchPageCommand(handle, 'DOM.describeNode', { objectId, depth: 0 }))?.node);
          if (String(node?.backendNodeId) !== submit.controlId || !currentCredentialHandle(request) || signal?.aborted) {
            return { status: 'refused' as const, code: 'submit_refused' as const };
          }
          if (beforeDelivery && !await beforeDelivery()) return { status: 'refused' as const, code: 'submit_refused' as const };
          const finalProof = await proveCredentialTarget(request, objects, signal);
          if (!finalProof) return { status: 'refused' as const, code: 'submit_refused' as const };
          submitStarted = true;
          issued = true;
          // Only the separately reviewed exact control is activated. There is no generic Enter
          // fallback, coordinate click, caller script or credential argument in this step.
          const response = await dispatchPageCommand(handle, 'Runtime.callFunctionOn', {
            objectId, arguments: [{ objectId: finalProof.fieldObjectId }], returnByValue: true, silent: true,
            functionDeclaration: `function(field) {
              if (!this.isConnected || this.ownerDocument !== document || !field.isConnected
                || field.ownerDocument !== document || !document.hasFocus() || document.activeElement !== field
                || (${synthesizeLocatorElementExpression(parseLocator(request.field.locator))}) !== field
                || (${controlExpression}) !== this || location.origin !== ${JSON.stringify(request.origin)}
                || this.disabled || !(this instanceof HTMLButtonElement || (this instanceof HTMLInputElement
                  && ['submit','button'].includes(this.type)))) return false;
              HTMLElement.prototype.click.call(this); return true;
            }`,
          });
          const clicked = record(response)?.exceptionDetails ? undefined : evaluateValue(response);
          return submitSettlement = clicked === true ? { status: 'submitted', code: 'submitted' }
            : clicked === false ? { status: 'refused', code: 'submit_refused' }
              : { status: 'unknown', code: 'submit_unknown' };
        } catch (error) {
          return submitSettlement = issued && !isBrowserSidecarCdpCommandNotDispatched(error) ? { status: 'unknown', code: 'submit_unknown' }
            : { status: 'refused', code: 'submit_refused' };
        }
      } } : {}),
      async finish() {
        finished = true;
        await releaseCredentialObjects(handle, objects);
      },
    };
  }

  async function readFocusedCredentialTarget(view: BrowserAutomationViewRef): Promise<CredentialTarget | undefined> {
    const handle = contextCapture?.resolvePageHandle(view);
    const navigation = contextCapture?.getNavigationState?.(view);
    if (!handle || !navigation || navigation.loadingState !== 'ready' || !input.adapter.ownsView(view)) return undefined;
    const objects: string[] = [];
    const current = () => {
      const bound = contextCapture?.resolvePageHandle(view);
      const state = contextCapture?.getNavigationState?.(view);
      return input.adapter.ownsView(view) && bound?.targetId === handle.targetId && bound?.sessionId === handle.sessionId
        && state?.navigationGeneration === navigation.navigationGeneration && state.loadingState === 'ready';
    };
    try {
      const tree = record(await dispatchPageCommand(handle, 'Page.getFrameTree'));
      if (!current()) return undefined;
      const frame = record(record(tree?.frameTree)?.frame);
      const frameId = stringField(frame, 'id');
      const documentId = stringField(frame, 'loaderId');
      const origin = stringField(frame, 'securityOrigin');
      if (!frameId || !documentId || !origin || !/^https?:\/\//u.test(origin)) return undefined;
      const world = record(await dispatchPageCommand(handle, 'Page.createIsolatedWorld', { frameId, worldName: 'happier-confidential-input' }));
      if (!current() || typeof world?.executionContextId !== 'number') return undefined;
      const remote = await dispatchPageCommand(handle, 'Runtime.evaluate', { expression: 'document.activeElement',
        contextId: world.executionContextId, returnByValue: false, awaitPromise: false, silent: true });
      const objectId = stringField(record(remote)?.result, 'objectId');
      if (objectId) objects.push(objectId);
      if (!objectId || !current()) return undefined;
      const node = record(record(await dispatchPageCommand(handle, 'DOM.describeNode', { objectId, depth: 0 }))?.node);
      if (!current() || typeof node?.backendNodeId !== 'number' || !Number.isSafeInteger(node.backendNodeId) || node.backendNodeId < 1) return undefined;
      const locator = evaluateValue(await dispatchPageCommand(handle, 'Runtime.callFunctionOn', {
        objectId, returnByValue: true, silent: true,
        functionDeclaration: `function() {
          if (this.id) { const selector = '#' + CSS.escape(this.id); if (document.querySelectorAll(selector).length === 1) return selector; }
          const id = Element.prototype.getAttribute.call(this, 'data-testid');
          if (id) { const selector = '[data-testid="' + CSS.escape(id) + '"]'; if (document.querySelectorAll(selector).length === 1) return selector; }
          return null;
        }`,
      }));
      if (!current() || typeof locator !== 'string' || !locator || locator.length > 256) return undefined;
      const target: CredentialTarget = { ...view, tabId: handle.targetId, frameId, documentId,
        navigationGeneration: navigation.navigationGeneration, origin,
        field: { fieldId: String(node.backendNodeId), focusId: String(node.backendNodeId), locator } };
      return await proveCredentialTarget(target, objects) ? target : undefined;
    } catch { return undefined; }
    finally { await releaseCredentialObjects(handle, objects); }
  }

  async function dispatchRichSnapshot(
    query: BrowserAutomationCdpPageQueryInput,
  ): Promise<BrowserAutomationCdpPageQueryResult | null> {
    if (!input.browserContext?.captureSnapshot) return null;
    const snapshot = await input.browserContext.captureSnapshot({
      browserSessionId: query.browserSessionId,
      viewId: query.viewId,
      navigationGeneration: query.navigationGeneration,
      contextId: browserViewContextId(query),
    }, { signal: query.signal, deadlineMs: query.deadlineMs });
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
    context: BrowserAutomationAdapterExecutionContext = {},
  ): Promise<unknown> {
    if (!contextCapture) return undefined;
    if (context.signal?.aborted) throw new DOMException('Browser automation canceled', 'AbortError');
    if (context.deadlineMs !== undefined && Date.now() >= context.deadlineMs) {
      throw new BrowserSidecarCdpTransportError('cdp_request_timeout', 'Browser automation deadline elapsed before dispatch.', 'not_dispatched');
    }
    return contextCapture.transport.dispatchPageCommand({
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.deadlineMs !== undefined ? { deadlineMs: context.deadlineMs } : {}),
      targetId: handle.targetId,
      ...(handle.sessionId ? { sessionId: handle.sessionId } : {}),
      method,
      ...(params ? { params } : {}),
    });
  }

  async function evaluate(handle: BrowserSidecarCdpPageHandle, expression: string, context: BrowserAutomationAdapterExecutionContext = {}): Promise<unknown> {
    return dispatchPageCommand(handle, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
    }, context);
  }

  function operationError(context: BrowserAutomationAdapterExecutionContext): BrowserAutomationCdpPageQueryResult {
    return { ok: false, errorCode: context.signal?.aborted ? 'user_canceled' : context.deadlineMs !== undefined && Date.now() >= context.deadlineMs ? 'timed_out' : 'runtime_unavailable' };
  }

  async function withDismissedDialogs(
    handle: BrowserSidecarCdpPageHandle,
    context: BrowserAutomationAdapterExecutionContext,
    execute: () => Promise<BrowserAutomationAdapterExecuteResult>,
  ): Promise<BrowserAutomationAdapterExecuteResult> {
    const dismissals: Promise<void>[] = [];
    const kinds = new Set<string>();
    let dismissed = 0;
    let failed = false;
    let uncertainDismissal = false;
    const unsubscribe = contextCapture?.subscribeCdpEvents?.(event => {
      if (event.method !== 'Page.javascriptDialogOpening' || event.sessionId !== handle.sessionId) return;
      const kind = ['alert', 'confirm', 'prompt', 'beforeunload'].includes(String(event.params?.type)) ? String(event.params?.type) : 'unknown';
      const dismissal = dispatchPageCommand(handle, 'Page.handleJavaScriptDialog', { accept: false }, { deadlineMs: context.deadlineMs })
        .then(() => { dismissed += 1; kinds.add(kind); }, error => {
          failed = true;
          if (!isBrowserSidecarCdpCommandNotDispatched(error)) uncertainDismissal = true;
        });
      dismissals.push(dismissal);
    });
    try {
      const result = await execute();
      // A dismissal can resume page script which immediately opens another dialog.
      for (let index = 0; index < dismissals.length; index += 1) await dismissals[index];
      if (failed) {
        const error = operationError(context);
        return { ...result, status: context.signal?.aborted ? 'canceled' : error.ok === false && error.errorCode === 'timed_out' ? 'timed_out' : 'failed', errorCode: error.ok === false ? error.errorCode : 'runtime_unavailable',
          interruptionCompletion: uncertainDismissal || result.interruptionCompletion === 'uncertain' ? 'uncertain' : 'stopped' };
      }
      if (dismissed === 0) return result;
      return { ...result, resultSummary: { ...result.resultSummary, javascriptDialogs: { count: dismissed, kinds: [...kinds], handling: 'dismissed' } } };
    } finally {
      unsubscribe?.();
      for (const dismissal of dismissals) await dismissal;
    }
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
          const history = await dispatchPageCommand(handle, 'Page.getNavigationHistory', undefined, query);
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

          const text = evaluateValue(await evaluate(handle, DOM_TEXT_EXPRESSION, query));
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

          const raw = evaluateValue(await evaluate(handle, interactiveElementsExpression(SNAPSHOT_MAX_INTERACTIVE_ELEMENTS), query));
          const parsed = parseInteractiveElements(raw, SNAPSHOT_MAX_INTERACTIVE_ELEMENTS);
          return { ok: true, data: { elements: parsed.elements, truncated: parsed.truncated } };
        }
        case 'queryElements': {
          const selector = typeof query.payload.selector === 'string' ? query.payload.selector : '';
          if (!selector) {
            return { ok: false, errorCode: 'unsupported_action' };
          }
          const result = evaluateValue(await evaluate(handle, queryLocatorExpression(selector), query));
          const r = record(result);
          if (r?.error === 'invalid_selector') {
            return { ok: false, errorCode: 'selector_not_found' };
          }
          return {
            ok: true,
            data: {
              count: typeof r?.count === 'number' ? r.count : 0,
              elements: Array.isArray(r?.elements) ? r.elements : [],
              truncated: r?.truncated === true || typeof r?.count === 'number' && Array.isArray(r.elements) && r.count > r.elements.length,
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
          while (true) {
            const present = evaluateValue(await evaluate(handle, waitForLocatorExpression(selector), query));
            if (query.signal?.aborted || query.deadlineMs !== undefined && Date.now() >= query.deadlineMs) return operationError(query);
            if (present === true) return { ok: true, data: { present: true } };
            // Direct seam callers have no containing action; they can only request a single probe.
            if (query.deadlineMs === undefined) return { ok: false, errorCode: 'timed_out' };
            await delay(Math.min(100, Math.max(0, query.deadlineMs - Date.now())), undefined, { signal: query.signal });
          }
        }
        default:
          return { ok: false, errorCode: 'unsupported_action' };
      }
    } catch {
      return operationError(query);
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
    const selector = typeof command.payload.selector === 'string' ? command.payload.selector : typeof command.payload.locator === 'string' ? command.payload.locator : '';
    const heldInput: { mouse: Record<string, unknown> | null; key: string | null } = { mouse: null, key: null };
    let uncertainEffect = false;
    let cleanupFailed = false;
    const send = async (method: string, params?: Record<string, unknown>) => {
      command.signal?.throwIfAborted();
      const previousMouse = heldInput.mouse;
      const previousKey = heldInput.key;
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') heldInput.mouse = { ...params };
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseMoved' && heldInput.mouse) heldInput.mouse = { ...heldInput.mouse, x: params.x, y: params.y };
      if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown' && typeof params.key === 'string') heldInput.key = params.key;
      try {
        // Once sent, an abort cannot retract CDP input. Await its acknowledgement, then stop at
        // the next checkpoint. Dropping this promise on abort would free admission too early.
        const result = await dispatchPageCommand(handle, method, params, { deadlineMs: command.deadlineMs });
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') heldInput.mouse = null;
        if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyUp') heldInput.key = null;
        return result;
      } catch (error) {
        if (isBrowserSidecarCdpCommandNotDispatched(error)) {
          heldInput.mouse = previousMouse;
          heldInput.key = previousKey;
        } else if (method.startsWith('Input.') || method === 'DOM.setFileInputFiles') {
          uncertainEffect = true;
        }
        throw error;
      }
    };
    const read = async (expression: string, affectsPage = false) => {
      command.signal?.throwIfAborted();
      try {
        const result = await evaluate(handle, expression, { deadlineMs: command.deadlineMs });
        return result;
      } catch (error) {
        if (affectsPage && !isBrowserSidecarCdpCommandNotDispatched(error)) {
          uncertainEffect = true;
        }
        throw error;
      }
    };

    const readAndCheck = async (expression: string, affectsPage = false) => {
      const result = await read(expression, affectsPage);
      command.signal?.throwIfAborted();
      return result;
    };

    const targetPoint = async (locator = selector, prepareInput = true) => {
      const value = evaluateValue(await readAndCheck(elementCenterExpression(locator, prepareInput), prepareInput));
      const target = BrowserActiveTargetV1Schema.safeParse(record(value)?.activeTarget);
      if (target.success) command.onActiveTarget?.(target.data);
      return readPoint(value);
    };

    // Arrow const (not a hoisted `function` declaration) so the narrowed non-null `handle` const is
    // preserved inside the closure; a hoisted declaration is lifted above the `if (!handle)` guard
    // and loses the narrowing.
    const clickAtSelector = async (): Promise<BrowserAutomationCdpInputResult> => {
      const hasCoordinates = command.payload.x !== undefined || command.payload.y !== undefined;
      if (!selector && !hasCoordinates) return { ok: false, errorCode: 'unsupported_action' };
      const point = hasCoordinates ? readPoint(command.payload)
        : await targetPoint();
      if (!point) return { ok: false, errorCode: 'selector_not_found' };
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      return { ok: true };
    };

    const executeInput = async (): Promise<BrowserAutomationCdpInputResult> => { try {
      switch (command.actionKind) {
        case 'click':
        case 'tap':
          return await clickAtSelector();
        case 'hover': {
          if (!selector) return { ok: false, errorCode: 'unsupported_action' };
          const point = await targetPoint();
          if (!point) return { ok: false, errorCode: 'selector_not_found' };
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
          return { ok: true };
        }
        case 'focus': {
          if (!selector) return { ok: false, errorCode: 'unsupported_action' };
          const point = await targetPoint();
          if (!point) return { ok: false, errorCode: 'selector_not_found' };
          return { ok: true };
        }
        case 'type': {
          // Optionally focus a target selector first, then insert text at the focused element.
          if (selector) {
            const point = await targetPoint();
            if (!point) return { ok: false, errorCode: 'selector_not_found' };
          }
          const text = typeof command.payload.text === 'string' ? command.payload.text : '';
          await send('Input.insertText', { text });
          return { ok: true };
        }
        case 'setValue': {
          if (!selector) return { ok: false, errorCode: 'unsupported_action' };
          await targetPoint(selector, false);
          const value = typeof command.payload.value === 'string' ? command.payload.value : '';
          const ok = evaluateValue(await read(setValueExpression(selector, value), true));
          return ok === true ? { ok: true } : { ok: false, errorCode: 'selector_not_found' };
        }
        case 'select': {
          if (!selector) return { ok: false, errorCode: 'unsupported_action' };
          await targetPoint(selector, false);
          const value = typeof command.payload.value === 'string' ? command.payload.value : '';
          const ok = evaluateValue(await read(selectOptionExpression(selector, value), true));
          return ok === true ? { ok: true } : { ok: false, errorCode: 'selector_not_found' };
        }
        case 'upload': {
          if (!selector || !Array.isArray(command.payload.files)) return { ok: false, errorCode: 'unsupported_action' };
          await targetPoint(selector, false);
          const files = command.payload.files.map(record);
          if (files.some(file => {
            if (!file || typeof file.name !== 'string' || typeof file.text !== 'string') return true;
            const name = basename(file.name.replaceAll('\\', '/'));
            return !name || name === '.' || name === '..' || name !== file.name;
          })) return { ok: false, errorCode: 'unsupported_action' };
          const expression = `(() => { const el = ${synthesizeLocatorElementExpression(parseLocator(selector))}; return el && el.tagName === 'INPUT' && el.type === 'file' ? el : null; })()`;
          const remote = await send('Runtime.evaluate', { expression, returnByValue: false, awaitPromise: false });
          const objectId = stringField(record(remote)?.result, 'objectId');
          if (!objectId) return { ok: false, errorCode: 'selector_not_found' };
          let directory: string | undefined;
          try {
            directory = await mkdtemp(join(tmpdir(), 'happier-browser-upload-'));
            const paths: string[] = [];
            for (const [index, file] of files.entries()) {
              // Separate directories preserve duplicate browser filenames without collisions.
              const fileDirectory = join(directory, String(index));
              await mkdir(fileDirectory);
              const name = basename(String(file?.name).replaceAll('\\', '/'));
              if (!name || name === '.' || name === '..') return { ok: false, errorCode: 'unsupported_action' };
              const path = join(fileDirectory, name);
              await writeFile(path, Buffer.from(String(file?.text), file?.base64 === true ? 'base64' : 'utf8'));
              paths.push(path);
            }
            await send('DOM.setFileInputFiles', { objectId, files: paths });
            return { ok: true, data: { fileCount: paths.length } };
          } finally {
            try { if (directory) await rm(directory, { recursive: true, force: true }); }
            finally {
              // Releasing an owned remote object is cleanup, not another mutating action.
              await contextCapture.transport.dispatchPageCommand({ targetId: handle.targetId, ...(handle.sessionId ? { sessionId: handle.sessionId } : {}), method: 'Runtime.releaseObject', params: { objectId } });
            }
          }
        }
        case 'drag': {
          const source = command.payload.from ?? command.payload.source ?? command.payload.locator;
          const target = command.payload.to ?? command.payload.target ?? command.payload.destination;
          if (typeof source !== 'string' || typeof target !== 'string') return { ok: false, errorCode: 'unsupported_action' };
          const from = await targetPoint(source);
          const to = await targetPoint(target);
          if (!from || !to) return { ok: false, errorCode: 'selector_not_found' };
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...to, button: 'left', buttons: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', buttons: 0, clickCount: 1 });
          return { ok: true };
        }
        case 'press': {
          if (selector) await targetPoint(selector, false);
          const key = typeof command.payload.key === 'string' ? command.payload.key : '';
          if (!key) return { ok: false, errorCode: 'unsupported_action' };
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key });
          return { ok: true };
        }
        case 'scroll': {
          const deltaX = typeof command.payload.deltaX === 'number' ? command.payload.deltaX : 0;
          const deltaY = typeof command.payload.deltaY === 'number' ? command.payload.deltaY : 0;
          const coordinates = readPoint(command.payload);
          let x = coordinates?.x ?? 0;
          let y = coordinates?.y ?? 0;
          if (selector) {
            const point = await targetPoint();
            if (point) {
              x = point.x;
              y = point.y;
            }
          }
          await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
          return { ok: true };
        }
        default:
          return { ok: false, errorCode: 'unsupported_action' };
      }
    } catch {
      return operationError(command);
    } };
    let result: BrowserAutomationCdpInputResult;
    try {
      result = await executeInput();
    } finally {
      // Cleanup is not another action phase: it must release held input even after the containing
      // action's abort/deadline. A failed acknowledgement is reported as uncertain, never stopped.
      if (heldInput.mouse) {
        try { await dispatchPageCommand(handle, 'Input.dispatchMouseEvent', { ...heldInput.mouse, type: 'mouseReleased', buttons: 0 }); }
        catch { cleanupFailed = true; }
      }
      if (heldInput.key) {
        try { await dispatchPageCommand(handle, 'Input.dispatchKeyEvent', { type: 'keyUp', key: heldInput.key }); }
        catch { cleanupFailed = true; }
      }
    }
    if (command.signal?.aborted) {
      return { ok: false, errorCode: 'user_canceled', interruptionCompletion: uncertainEffect || cleanupFailed ? 'uncertain' : 'stopped' };
    }
    return uncertainEffect || cleanupFailed
      ? { ok: false, errorCode: 'runtime_unavailable', interruptionCompletion: 'uncertain' }
      : result;
  }

  return {
    ownsView: (view) => input.adapter.ownsView(view),
    getNavigationGeneration: (view) => contextCapture?.getNavigationState?.(view)?.navigationGeneration ?? null,
    dispatchControlCommand: async (command, context) => await input.adapter.dispatchCommand(command, context),
    dispatchPageQuery,
    prepareConfidentialFill,
    readFocusedCredentialTarget,
    ...(contextCapture ? {
      dispatchInputCommand,
      executePageOperation: (context: BrowserAutomationViewRef & BrowserAutomationAdapterExecutionContext, execute: () => Promise<BrowserAutomationAdapterExecuteResult>) => {
        const handle = contextCapture.resolvePageHandle(context);
        return handle ? withDismissedDialogs(handle, context, execute) : execute();
      },
    } : {}),
  };
}
