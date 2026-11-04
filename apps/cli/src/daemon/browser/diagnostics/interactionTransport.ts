import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { BrowserDiagnosticsElementPickerRequestV1Schema, BrowserDiagnosticsEvalRequestV1Schema, BrowserDiagnosticsGetPropertiesRequestV1Schema, BrowserDiagnosticsReleaseObjectGroupRequestV1Schema } from '@happier-dev/protocol/browser/diagnostics/v1';
import type { BrowserDiagnosticsElementPickerRequestV1, BrowserDiagnosticsElementPickerResultV1, BrowserDiagnosticsEvalRequestV1, BrowserDiagnosticsEvalResultV1, BrowserDiagnosticsExpandedRemoteObjectV1, BrowserDiagnosticsGetPropertiesRequestV1, BrowserDiagnosticsGetPropertiesResultV1, BrowserDiagnosticsObjectPropertyV1, BrowserDiagnosticsReleaseObjectGroupRequestV1, BrowserDiagnosticsReleaseObjectGroupResultV1, BrowserDiagnosticsRemoteObjectPreviewPropertyV1, BrowserDiagnosticsRemoteObjectV1, RuntimeActionIdV1 } from '@happier-dev/protocol';

import type {
  BrowserSidecarCdpEventNotification,
  BrowserSidecarCdpEventSubscriber,
  BrowserSidecarCdpPageHandle,
  BrowserSidecarViewLifecycleSubscriber,
} from '../sidecar/controlAdapter';

import type { BrowserDiagnosticsInteractionTransport } from './actionRoutes';
import type { SurfaceInputControl } from '../../surfaces/inputControl';

/**
 * DIAG-INTERACTION: the LIVE managed-Chromium sidecar CDP interaction transport. It is the producer
 * that flips the `browser.diagnostics` INTERACTION verbs
 * (pause/resume/eval/getProperties/releaseObjectGroup/elementPicker.{start,cancel}) from
 * `browser_diagnostics_route_unavailable` to real CDP-backed results. It rides the SAME live sidecar
 * transport the control adapter + context-capture + offline-diagnostics lanes use
 * (`transport.dispatchPageCommand` + `resolvePageHandle`) — no second Chromium/CDP connection is
 * opened. When the sidecar is not running this owner is simply never constructed, and the route stays
 * honestly fail-closed (the route returns `browser_diagnostics_route_unavailable`, never a fake
 * success).
 *
 * Verb → raw CDP command mapping:
 *  - `pause`                 -> `Debugger.enable` + `Debugger.pause`
 *  - `resume`                -> `Debugger.resume`
 *  - `eval`                  -> `Runtime.evaluate` (object-group scoped, by-reference)
 *  - `getProperties`         -> `Runtime.getProperties` (own properties, previews)
 *  - `releaseObjectGroup`    -> `Runtime.releaseObjectGroup`
 *  - `elementPicker.start`   -> `Overlay.enable` + `Overlay.setInspectMode(searchForNode)`, then awaits
 *                               the `Overlay.inspectNodeRequested` selection event (or cancel)
 *  - `elementPicker.cancel`  -> `Overlay.setInspectMode(none)` + `Overlay.disable` (interrupts a start)
 */

const ID_MAX = 256;
const RELEASED_OBJECT_GROUP_KEY_LIMIT = 512;

type CdpPageCommandTransport = Readonly<{
  dispatchPageCommand(
    input: BrowserSidecarCdpPageHandle & Readonly<{ method: string; params?: Record<string, unknown> }>,
  ): Promise<unknown>;
}>;

type DiagnosticView = Readonly<{ browserSessionId: string; viewId: string }>;
type ScopedRequest<T> = T & DiagnosticView;
type PendingEval = Readonly<{ view: DiagnosticView; handle: BrowserSidecarCdpPageHandle; cancel(): boolean }>;

type PendingPicker = Readonly<{
  handle: BrowserSidecarCdpPageHandle;
  cancel(): void;
}>;

type TrackedObjectGroup = Readonly<{
  browserSessionId: string;
  viewId: string;
  navigationGeneration: number;
  handle: BrowserSidecarCdpPageHandle;
  objectGroupId: string;
}>;

export type BrowserDiagnosticsInteractionContextCapture = Readonly<{
  transport: CdpPageCommandTransport;
  resolvePageHandle(
    view: Readonly<{ browserSessionId: string; viewId: string }>,
  ): BrowserSidecarCdpPageHandle | null;
  /** Session-scoped view ⇄ CDP page-handle binding lifecycle. */
  subscribeViewLifecycle(listener: BrowserSidecarViewLifecycleSubscriber): () => void;
  /** Live CDP event stream — required for the interactive element picker selection await. */
  subscribeCdpEvents?(listener: BrowserSidecarCdpEventSubscriber): () => void;
}>;

export type BrowserDiagnosticsInteractionTransportInput = Readonly<{
  contextCapture: BrowserDiagnosticsInteractionContextCapture;
  onError?: (error: unknown) => void;
  resolveInputControl?: (view: Readonly<{ browserSessionId: string; viewId: string }>) => SurfaceInputControl | undefined;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function valuePreviewString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return '';
}

type RemoteObjectType = BrowserDiagnosticsRemoteObjectV1['type'];

const REMOTE_OBJECT_TYPES = new Set<RemoteObjectType>([
  'undefined',
  'null',
  'boolean',
  'number',
  'string',
  'symbol',
  'bigint',
  'object',
  'function',
]);

function resolveRemoteObjectType(cdp: Record<string, unknown>): RemoteObjectType | null {
  const rawType = typeof cdp.type === 'string' ? cdp.type : '';
  if (rawType === 'object' && cdp.subtype === 'null') return 'null';
  return REMOTE_OBJECT_TYPES.has(rawType as RemoteObjectType) ? (rawType as RemoteObjectType) : null;
}

function buildPreview(cdp: Record<string, unknown>): Readonly<{ properties: BrowserDiagnosticsRemoteObjectPreviewPropertyV1[]; truncated: boolean }> {
  const preview = record(cdp.preview);
  const properties = preview && Array.isArray(preview.properties) ? preview.properties : [];
  const out: BrowserDiagnosticsRemoteObjectPreviewPropertyV1[] = [];
  for (const entry of properties) {
    const prop = record(entry);
    if (!prop) continue;
    if (typeof prop.name !== 'string') continue;
    const name = prop.name;
    const valuePreview = valuePreviewString(prop.value);
    out.push({ name, valuePreview, truncated: record(prop.valuePreview)?.overflow === true });
  }
  return { properties: out, truncated: preview?.overflow === true || properties.length > out.length || out.some(property => property.truncated) };
}

/**
 * Map a raw CDP `Runtime.RemoteObject` to the canonical diagnostics remote-object shape. Returns null
 * when the CDP value cannot satisfy the contract (e.g. an object/function reference with no objectId),
 * so the caller omits the result rather than emit a schema-invalid value.
 */
function toRemoteObject(value: unknown): BrowserDiagnosticsRemoteObjectV1 | null {
  const cdp = record(value);
  if (!cdp) return null;
  const type = resolveRemoteObjectType(cdp);
  if (!type) return null;

  const objectId = typeof cdp.objectId === 'string' && cdp.objectId.length > 0
    ? clamp(cdp.objectId, ID_MAX)
    : undefined;
  const className = typeof cdp.className === 'string' && cdp.className.trim().length > 0
    ? cdp.className.trim()
    : undefined;
  const description = typeof cdp.description === 'string'
    ? cdp.description
    : undefined;

  if (type === 'object' || type === 'function') {
    if (!objectId) return null;
    const preview = buildPreview(cdp);
    return {
      type,
      objectId,
      ...(className ? { className } : {}),
      ...(description ? { description } : {}),
      preview: preview.properties,
      previewTruncated: preview.truncated,
    };
  }

  let scalar: string | number | boolean | null | undefined;
  if (type === 'null') {
    scalar = null;
  } else if (type === 'boolean') {
    scalar = typeof cdp.value === 'boolean' ? cdp.value : undefined;
  } else if (type === 'number') {
    scalar = typeof cdp.value === 'number' ? cdp.value : undefined;
  } else if (type === 'string') {
    scalar = typeof cdp.value === 'string' ? cdp.value : undefined;
  } else {
    // undefined / symbol / bigint carry no inline value; the description conveys the detail.
    scalar = undefined;
  }

  return {
    type,
    ...(scalar !== undefined ? { value: scalar } : {}),
    ...(className ? { className } : {}),
    ...(description ? { description } : {}),
    preview: [],
  };
}

function toExpandedRemoteObject(
  value: unknown,
): BrowserDiagnosticsExpandedRemoteObjectV1 | null {
  return toRemoteObject(value);
}

export function createBrowserDiagnosticsInteractionTransport(
  input: BrowserDiagnosticsInteractionTransportInput,
): BrowserDiagnosticsInteractionTransport {
  const { contextCapture } = input;
  const onError = input.onError ?? (() => undefined);
  let disposed = false;
  const pendingEvals = new Map<string, PendingEval>();

  async function cancelEvals(matches: (pending: PendingEval, key: string) => boolean): Promise<void> {
    const handles = new Map<string, BrowserSidecarCdpPageHandle>();
    for (const [key, pending] of pendingEvals) {
      if (!matches(pending, key)) continue;
      if (pending.cancel()) handles.set(handleKey(pending.handle), pending.handle);
    }
    await Promise.all([...handles.values()].map(handle => tryPageCommand(handle, 'Runtime.terminateExecution')));
  }

  const viewSessions = new Map<string, DiagnosticView & Readonly<{ unregisterDrain?: () => void }>>();
  const unsubscribeLifecycle = contextCapture.subscribeViewLifecycle((event) => {
    if (disposed) return;
    const key = browserViewKey(event);
    if (event.type === 'bound') {
      viewSessions.get(key)?.unregisterDrain?.();
      const control = input.resolveInputControl?.(event);
      const unregisterDrain = control?.registerConfidentialityDrain(async () => {
        await cancelEvals(pending => browserViewKey(pending.view) === key);
        const picker = pendingPickers.get(key);
        if (picker) { picker.cancel(); await disablePickerOverlay(picker.handle); }
        await releaseTrackedObjectGroupsForView(event);
      });
      viewSessions.set(key, { browserSessionId: event.browserSessionId, viewId: event.viewId, unregisterDrain });
    } else {
      void cancelEvals(pending => browserViewKey(pending.view) === key);
      const picker = pendingPickers.get(key);
      if (picker) { picker.cancel(); void disablePickerOverlay(picker.handle); }
      void releaseTrackedObjectGroupsForView({
        browserSessionId: event.browserSessionId,
        viewId: event.viewId,
      });
      viewSessions.get(key)?.unregisterDrain?.();
      viewSessions.delete(key);
    }
  });
  const unsubscribeCdpNavigation = contextCapture.subscribeCdpEvents?.((notification) => {
    if (disposed) return;
    if (!isNavigationInvalidatingEvent(notification)) return;
    void cancelEvals(pending => pending.handle.sessionId === notification.sessionId);
    void releaseTrackedObjectGroupsForCdpEvent(notification);
  }) ?? null;

  // Pending element-picker awaits, keyed by browserViewKey, so an `elementPicker.cancel` can interrupt a
  // standing `elementPicker.start`.
  const pendingPickers = new Map<string, PendingPicker>();
  const trackedObjectGroups = new Map<string, TrackedObjectGroup>();
  const releasedObjectGroupKeys = new Set<string>();
  const pendingDispatches = new Set<Promise<void>>();

  async function runTrackedDispatch<T>(run: () => Promise<T>): Promise<T> {
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    pendingDispatches.add(settled);
    try {
      return await run();
    } finally {
      pendingDispatches.delete(settled);
      markSettled();
    }
  }

  function handleKey(handle: BrowserSidecarCdpPageHandle): string {
    return `${handle.targetId}\u0000${handle.sessionId ?? ''}`;
  }

  function objectGroupKey(handle: BrowserSidecarCdpPageHandle, objectGroupId: string): string {
    return `${handleKey(handle)}\u0000${objectGroupId}`;
  }

  function rememberReleasedObjectGroupKey(key: string): void {
    releasedObjectGroupKeys.add(key);
    if (releasedObjectGroupKeys.size <= RELEASED_OBJECT_GROUP_KEY_LIMIT) return;
    const oldest = releasedObjectGroupKeys.values().next().value;
    if (typeof oldest === 'string') releasedObjectGroupKeys.delete(oldest);
  }

  function trackObjectGroup(
    request: ScopedRequest<Readonly<{ navigationGeneration: number; objectGroupId: string }>>,
    handle: BrowserSidecarCdpPageHandle,
  ): void {
    const normalizedObjectGroupId = request.objectGroupId.trim();
    if (!normalizedObjectGroupId) return;
    const { browserSessionId } = request;
    const key = objectGroupKey(handle, normalizedObjectGroupId);
    releasedObjectGroupKeys.delete(key);
    trackedObjectGroups.delete(key);
    trackedObjectGroups.set(key, {
      browserSessionId,
      viewId: request.viewId,
      navigationGeneration: request.navigationGeneration,
      handle,
      objectGroupId: normalizedObjectGroupId,
    });
  }

  function untrackObjectGroup(handle: BrowserSidecarCdpPageHandle, objectGroupId: string): void {
    const normalizedObjectGroupId = objectGroupId.trim();
    if (!normalizedObjectGroupId) return;
    const key = objectGroupKey(handle, normalizedObjectGroupId);
    trackedObjectGroups.delete(key);
    rememberReleasedObjectGroupKey(key);
  }

  function resolveHandle(view: DiagnosticView): BrowserSidecarCdpPageHandle | null {
    if (disposed) return null;
    return contextCapture.resolvePageHandle(view);
  }

  function pageCommand(
    handle: BrowserSidecarCdpPageHandle,
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return contextCapture.transport.dispatchPageCommand({
      targetId: handle.targetId,
      ...(handle.sessionId ? { sessionId: handle.sessionId } : {}),
      method,
      ...(params ? { params } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  function inputControl(view: DiagnosticView): SurfaceInputControl | undefined {
    return input.resolveInputControl?.(view);
  }

  function reportError(error: unknown, handle: BrowserSidecarCdpPageHandle): void {
    const view = [...viewSessions.values()].find(entry => {
      const current = contextCapture.resolvePageHandle(entry);
      return current?.targetId === handle.targetId && current.sessionId === handle.sessionId;
    });
    if (view && inputControl(view)?.isObservationHeld()) return;
    onError(view || !input.resolveInputControl ? error : new Error('browser_diagnostics_transport_failed'));
  }

  async function tryPageCommand(
    handle: BrowserSidecarCdpPageHandle,
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await pageCommand(handle, method, params, signal);
    } catch (error) {
      // Best-effort domain enables / teardown must never throw out of a verb dispatch.
      if (!signal?.aborted) reportError(error, handle);
    }
  }

  async function disablePickerOverlay(handle: BrowserSidecarCdpPageHandle): Promise<void> {
    await tryPageCommand(handle, 'Overlay.setInspectMode', { mode: 'none' });
    await tryPageCommand(handle, 'Overlay.disable');
  }

  function isNavigationInvalidatingEvent(notification: BrowserSidecarCdpEventNotification): boolean {
    if (notification.method === 'Page.navigatedWithinDocument') return true;
    if (notification.method !== 'Page.frameNavigated') return false;
    const frame = record(notification.params?.frame);
    return !frame || typeof frame.parentId !== 'string';
  }

  function notificationMatchesGroup(
    notification: BrowserSidecarCdpEventNotification,
    group: TrackedObjectGroup,
  ): boolean {
    if (notification.sessionId) return group.handle.sessionId === notification.sessionId;
    return !group.handle.sessionId;
  }

  async function releaseTrackedObjectGroupsWhere(
    predicate: (group: TrackedObjectGroup) => boolean,
  ): Promise<void> {
    const groups = Array.from(trackedObjectGroups.values()).filter(predicate);
    for (const group of groups) {
      const key = objectGroupKey(group.handle, group.objectGroupId);
      trackedObjectGroups.delete(key);
      rememberReleasedObjectGroupKey(key);
    }
    for (const group of groups) {
      await releaseTrackedObjectGroup(group);
    }
  }

  async function releaseTrackedObjectGroup(group: TrackedObjectGroup): Promise<void> {
    try {
      await contextCapture.transport.dispatchPageCommand({
        targetId: group.handle.targetId,
        ...(group.handle.sessionId ? { sessionId: group.handle.sessionId } : {}),
        method: 'Runtime.releaseObjectGroup',
        params: { objectGroup: group.objectGroupId },
      });
    } catch (error) {
      reportError(error, group.handle);
    }
  }

  async function releaseTrackedObjectGroups(): Promise<void> {
    await releaseTrackedObjectGroupsWhere(() => true);
  }

  async function releaseTrackedObjectGroupsForView(
    view: Readonly<{ browserSessionId: string; viewId: string }>,
  ): Promise<void> {
    await releaseTrackedObjectGroupsWhere((group) =>
      group.browserSessionId === view.browserSessionId && group.viewId === view.viewId,
    );
  }

  async function releaseTrackedObjectGroupsForCdpEvent(
    notification: BrowserSidecarCdpEventNotification,
  ): Promise<void> {
    await releaseTrackedObjectGroupsWhere((group) => notificationMatchesGroup(notification, group));
  }

  function evalResult(
    request: BrowserDiagnosticsEvalRequestV1,
    status: BrowserDiagnosticsEvalResultV1['status'],
    extra: Partial<Pick<BrowserDiagnosticsEvalResultV1, 'result' | 'errorCode'>> = {},
  ): BrowserDiagnosticsEvalResultV1 {
    return {
      v: 1,
      evalRequestId: request.evalRequestId,
      viewId: request.viewId,
      navigationGeneration: request.navigationGeneration,
      status,
      tier: request.tier,
      audited: true,
      ...(extra.result ? { result: extra.result } : {}),
      ...(extra.errorCode ? { errorCode: extra.errorCode } : {}),
    };
  }

  async function runEval(request: ScopedRequest<BrowserDiagnosticsEvalRequestV1>): Promise<BrowserDiagnosticsEvalResultV1> {
    if (request.action === 'cancel') {
      await cancelEvals((_pending, key) => key === `${browserViewKey(request)}\u0000${request.evalRequestId}`);
      return evalResult(request, 'cancelled');
    }
    const control = inputControl(request);
    const handle = resolveHandle(request);
    if (!handle) return evalResult(request, 'failed', { errorCode: 'target_detached' });
    let raw: unknown;
    const key = `${browserViewKey(request)}\u0000${request.evalRequestId}`;
    const controller = new AbortController();
    let evaluationIssued = false;
    let cancel!: () => boolean;
    const cancelled = new Promise<Readonly<{ cancelled: true }>>(resolve => { cancel = () => {
      resolve({ cancelled: true });
      controller.abort();
      // CDP terminateExecution can target the next script; only interrupt our issued evaluation.
      return evaluationIssued;
    }; });
    const pending = { view: request, handle, cancel };
    pendingEvals.set(key, pending);
    try {
      const enabled = await Promise.race([tryPageCommand(handle, 'Runtime.enable', undefined, controller.signal).then(() => ({ cancelled: false as const })), cancelled]);
      if (enabled.cancelled) return evalResult(request, 'cancelled');
      if (control?.isObservationHeld()) return evalResult(request, 'failed', { errorCode: 'collector_unavailable' });
      trackObjectGroup(request, handle);
      evaluationIssued = true;
      const outcome = await Promise.race([pageCommand(handle, 'Runtime.evaluate', {
        expression: request.expression,
        objectGroup: request.objectGroupId,
        includeCommandLineAPI: true,
        returnByValue: false,
        generatePreview: true,
        awaitPromise: true,
        userGesture: false,
      }, controller.signal).then(value => ({ cancelled: false as const, value })), cancelled]);
      if (outcome.cancelled) return evalResult(request, 'cancelled');
      raw = outcome.value;
    } catch (error) {
      if (!control?.isObservationHeld()) reportError(error, handle);
      return evalResult(request, 'failed', { errorCode: 'collector_degraded' });
    } finally {
      if (pendingEvals.get(key) === pending) pendingEvals.delete(key);
    }
    const rec = record(raw);
    if (!rec) return evalResult(request, 'completed');
    const exceptionDetails = record(rec.exceptionDetails);
    if (exceptionDetails) {
      const exception = toRemoteObject(exceptionDetails.exception);
      return evalResult(request, 'failed', exception ? { result: exception } : {});
    }
    const result = toRemoteObject(rec.result);
    return evalResult(request, 'completed', result ? { result } : {});
  }

  function propertiesResult(
    request: BrowserDiagnosticsGetPropertiesRequestV1,
    status: BrowserDiagnosticsGetPropertiesResultV1['status'],
    extra: Partial<Pick<BrowserDiagnosticsGetPropertiesResultV1, 'properties' | 'errorCode'>> = {},
  ): BrowserDiagnosticsGetPropertiesResultV1 {
    return {
      v: 1,
      propertyRequestId: request.propertyRequestId,
      viewId: request.viewId,
      navigationGeneration: request.navigationGeneration,
      tier: request.tier,
      status,
      audited: true,
      objectId: request.objectId,
      properties: extra.properties ?? [],
      ...(extra.errorCode ? { errorCode: extra.errorCode } : {}),
    };
  }

  async function runGetProperties(
    request: ScopedRequest<BrowserDiagnosticsGetPropertiesRequestV1>,
  ): Promise<BrowserDiagnosticsGetPropertiesResultV1> {
    const control = inputControl(request);
    const handle = resolveHandle(request);
    if (!handle) return propertiesResult(request, 'failed', { errorCode: 'target_detached' });
    if (releasedObjectGroupKeys.has(objectGroupKey(handle, request.objectGroupId))) {
      return propertiesResult(request, 'failed', { errorCode: 'navigation_stale' });
    }
    let raw: unknown;
    try {
      raw = await pageCommand(handle, 'Runtime.getProperties', {
        objectId: request.objectId,
        ownProperties: true,
        accessorPropertiesOnly: false,
        generatePreview: true,
      });
    } catch (error) {
      if (!control?.isObservationHeld()) reportError(error, handle);
      return propertiesResult(request, 'failed', { errorCode: 'collector_degraded' });
    }
    const rec = record(raw);
    const list = rec && Array.isArray(rec.result) ? rec.result : [];
    const properties: BrowserDiagnosticsObjectPropertyV1[] = [];
    for (const entry of list) {
      const descriptor = record(entry);
      if (!descriptor) continue;
      if (typeof descriptor.name !== 'string') continue;
      const name = descriptor.name;
      const value = toExpandedRemoteObject(descriptor.value);
      if (!value) continue;
      properties.push({ name, value, enumerable: descriptor.enumerable === true });
    }
    return propertiesResult(request, 'completed', { properties });
  }

  function releaseResult(
    request: BrowserDiagnosticsReleaseObjectGroupRequestV1,
    status: BrowserDiagnosticsReleaseObjectGroupResultV1['status'],
    errorCode?: BrowserDiagnosticsReleaseObjectGroupResultV1['errorCode'],
  ): BrowserDiagnosticsReleaseObjectGroupResultV1 {
    return {
      v: 1,
      releaseRequestId: request.releaseRequestId,
      viewId: request.viewId,
      navigationGeneration: request.navigationGeneration,
      tier: request.tier,
      status,
      audited: true,
      objectGroupId: request.objectGroupId,
      ...(errorCode ? { errorCode } : {}),
    };
  }

  async function runReleaseObjectGroup(
    request: ScopedRequest<BrowserDiagnosticsReleaseObjectGroupRequestV1>,
  ): Promise<BrowserDiagnosticsReleaseObjectGroupResultV1> {
    const handle = resolveHandle(request);
    if (!handle) return releaseResult(request, 'failed', 'target_detached');
    try {
      await pageCommand(handle, 'Runtime.releaseObjectGroup', { objectGroup: request.objectGroupId });
      untrackObjectGroup(handle, request.objectGroupId);
      return releaseResult(request, 'completed');
    } catch (error) {
      reportError(error, handle);
      return releaseResult(request, 'failed', 'collector_degraded');
    }
  }

  function pickerResult(
    request: BrowserDiagnosticsElementPickerRequestV1,
    status: BrowserDiagnosticsElementPickerResultV1['status'],
    extra: Partial<Pick<BrowserDiagnosticsElementPickerResultV1, 'backendNodeRef' | 'errorCode'>> = {},
  ): BrowserDiagnosticsElementPickerResultV1 {
    return {
      v: 1,
      pickerRequestId: request.pickerRequestId,
      viewId: request.viewId,
      navigationGeneration: request.navigationGeneration,
      tier: request.tier,
      status,
      audited: true,
      ...(extra.backendNodeRef ? { backendNodeRef: extra.backendNodeRef } : {}),
      ...(extra.errorCode ? { errorCode: extra.errorCode } : {}),
    };
  }

  function awaitInspectSelection(
    handle: BrowserSidecarCdpPageHandle,
    view: DiagnosticView,
  ): Promise<{ kind: 'selected'; backendNodeId: number } | { kind: 'cancelled' }> {
    const subscribe = contextCapture.subscribeCdpEvents;
    const key = browserViewKey(view);
    return new Promise((resolve) => {
      if (disposed) {
        resolve({ kind: 'cancelled' });
        return;
      }
      pendingPickers.get(key)?.cancel();
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      const finish = (
        value: { kind: 'selected'; backendNodeId: number } | { kind: 'cancelled' },
      ): void => {
        if (settled) return;
        settled = true;
        if (unsubscribe) unsubscribe();
        pendingPickers.delete(key);
        resolve(value);
      };
      pendingPickers.set(key, {
        handle,
        cancel: () => finish({ kind: 'cancelled' }),
      });
      if (subscribe) {
        unsubscribe = subscribe((notification: BrowserSidecarCdpEventNotification) => {
          if (handle.sessionId && notification.sessionId !== handle.sessionId) return;
          if (notification.method !== 'Overlay.inspectNodeRequested') return;
          const backendNodeId = notification.params?.backendNodeId;
          if (typeof backendNodeId === 'number' && Number.isInteger(backendNodeId)) {
            finish({ kind: 'selected', backendNodeId });
          }
        });
      }
    });
  }

  async function runElementPickerStart(
    request: ScopedRequest<BrowserDiagnosticsElementPickerRequestV1>,
  ): Promise<BrowserDiagnosticsElementPickerResultV1> {
    const control = inputControl(request);
    const handle = resolveHandle(request);
    if (!handle) return pickerResult(request, 'failed', { errorCode: 'target_detached' });
    if (disposed) return pickerResult(request, 'failed', { errorCode: 'target_detached' });
    if (!contextCapture.subscribeCdpEvents) {
      // No event stream ⇒ no way to observe the selection ⇒ honest unavailable (never a fake select).
      return pickerResult(request, 'failed', { errorCode: 'collector_unavailable' });
    }
    await tryPageCommand(handle, 'DOM.enable');
    if (control?.isObservationHeld()) return pickerResult(request, 'cancelled');
    await tryPageCommand(handle, 'Overlay.enable');
    if (control?.isObservationHeld()) { await disablePickerOverlay(handle); return pickerResult(request, 'cancelled'); }
    const selection = awaitInspectSelection(handle, request);
    await tryPageCommand(handle, 'Overlay.setInspectMode', {
      mode: 'searchForNode',
      highlightConfig: {
        showInfo: true,
        contentColor: { r: 111, g: 168, b: 220, a: 0.5 },
      },
    });
    const outcome = await selection;
    await disablePickerOverlay(handle);
    if (control?.isObservationHeld()) return pickerResult(request, 'cancelled');
    if (outcome.kind === 'selected') {
      return pickerResult(request, 'selected', { backendNodeRef: clamp(String(outcome.backendNodeId), ID_MAX) });
    }
    return pickerResult(request, 'cancelled');
  }

  async function runElementPickerCancel(
    request: ScopedRequest<BrowserDiagnosticsElementPickerRequestV1>,
  ): Promise<BrowserDiagnosticsElementPickerResultV1> {
    const pending = pendingPickers.get(browserViewKey(request));
    if (pending) pending.cancel();
    const handle = resolveHandle(request);
    if (handle) {
      await disablePickerOverlay(handle);
    }
    return pickerResult(request, 'cancelled');
  }

  async function runPauseResume(
    actionId: 'browser.diagnostics.pause' | 'browser.diagnostics.resume',
    input: unknown,
    browserSessionId: string,
  ): Promise<unknown> {
    const view = record(input);
    const viewId = typeof view?.viewId === 'string' ? view.viewId : '';
    if (!viewId) return { ok: false, status: 'unavailable', errorCode: 'invalid_parameters' };
    const handle = resolveHandle({ viewId, browserSessionId });
    if (!handle) return { ok: false, status: 'unavailable', errorCode: 'target_detached' };
    const control = inputControl({ viewId, browserSessionId });
    if (actionId === 'browser.diagnostics.pause') {
      await tryPageCommand(handle, 'Debugger.enable');
      if (control?.isObservationHeld()) return { ok: false, status: 'unavailable', errorCode: 'collector_unavailable' };
      try {
        await pageCommand(handle, 'Debugger.pause');
      } catch (error) {
        if (!control?.isObservationHeld()) reportError(error, handle);
        return { ok: false, status: 'failed', errorCode: 'collector_degraded' };
      }
      return { ok: true, status: 'paused', viewId };
    }
    try {
      await pageCommand(handle, 'Debugger.resume');
    } catch (error) {
      if (!control?.isObservationHeld()) reportError(error, handle);
      return { ok: false, status: 'failed', errorCode: 'collector_degraded' };
    }
    return { ok: true, status: 'resumed', viewId };
  }

  // Defensive only: the action route already validates input against the canonical spec schema before
  // calling the transport, so this is reached only if a caller bypasses the route.
  const invalid = { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' } as const;

  return {
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        unsubscribeLifecycle();
      } catch (error) {
        onError(error);
      }
      try {
        unsubscribeCdpNavigation?.();
      } catch (error) {
        onError(error);
      }
      const pending = Array.from(pendingPickers.values());
      await cancelEvals(() => true);
      for (const picker of pending) {
        picker.cancel();
      }
      await Promise.allSettled(Array.from(pendingDispatches));
      for (const picker of pending) {
        await disablePickerOverlay(picker.handle);
      }
      await releaseTrackedObjectGroups();
      pendingPickers.clear();
      for (const entry of viewSessions.values()) entry.unregisterDrain?.();
      viewSessions.clear();
      releasedObjectGroupKeys.clear();
    },
    releaseObjectGroupsForView: releaseTrackedObjectGroupsForView,
    async dispatch(actionId: RuntimeActionIdV1, input: unknown, browserSessionId: string): Promise<unknown> {
      switch (actionId) {
        case 'browser.diagnostics.pause':
        case 'browser.diagnostics.resume': {
          const view = record(input);
          const viewId = typeof view?.viewId === 'string' ? view.viewId : '';
          const control = inputControl({ viewId, browserSessionId });
          const read = () => runTrackedDispatch(() => runPauseResume(actionId, input, browserSessionId));
          return (control ? await control.observeWhile(read) : await read()) ?? { ok: false, status: 'unavailable', errorCode: 'collector_unavailable' };
        }
        case 'browser.diagnostics.eval': {
          const parsed = BrowserDiagnosticsEvalRequestV1Schema.safeParse(input);
          if (!parsed.success) return invalid;
          if (parsed.data.tier !== 'cdp') return evalResult(parsed.data, 'blocked', { errorCode: 'adapter_unavailable' });
          if (parsed.data.action === 'cancel') return await runTrackedDispatch(() => runEval({ ...parsed.data, browserSessionId }));
          const control = inputControl({ ...parsed.data, browserSessionId });
          const read = () => runTrackedDispatch(() => runEval({ ...parsed.data, browserSessionId }));
          return (control ? await control.observeWhile(read) : await read()) ?? evalResult(parsed.data, 'failed', { errorCode: 'collector_unavailable' });
        }
        case 'browser.diagnostics.getProperties': {
          const parsed = BrowserDiagnosticsGetPropertiesRequestV1Schema.safeParse(input);
          if (!parsed.success) return invalid;
          if (parsed.data.tier !== 'cdp') return propertiesResult(parsed.data, 'blocked', { errorCode: 'adapter_unavailable' });
          const control = inputControl({ ...parsed.data, browserSessionId });
          const read = () => runTrackedDispatch(() => runGetProperties({ ...parsed.data, browserSessionId }));
          return (control ? await control.observeWhile(read) : await read()) ?? propertiesResult(parsed.data, 'failed', { errorCode: 'collector_unavailable' });
        }
        case 'browser.diagnostics.releaseObjectGroup': {
          const parsed = BrowserDiagnosticsReleaseObjectGroupRequestV1Schema.safeParse(input);
          if (!parsed.success) return invalid;
          if (parsed.data.tier !== 'cdp') return releaseResult(parsed.data, 'blocked', 'adapter_unavailable');
          return await runTrackedDispatch(() => runReleaseObjectGroup({ ...parsed.data, browserSessionId }));
        }
        case 'browser.diagnostics.elementPicker.start': {
          const parsed = BrowserDiagnosticsElementPickerRequestV1Schema.safeParse(input);
          if (!parsed.success || parsed.data.action !== 'start') return invalid;
          if (parsed.data.tier !== 'cdp') return pickerResult(parsed.data, 'blocked', { errorCode: 'adapter_unavailable' });
          if (inputControl({ ...parsed.data, browserSessionId })?.isObservationHeld()) return pickerResult(parsed.data, 'cancelled');
          return await runTrackedDispatch(() => runElementPickerStart({ ...parsed.data, browserSessionId }));
        }
        case 'browser.diagnostics.elementPicker.cancel': {
          const parsed = BrowserDiagnosticsElementPickerRequestV1Schema.safeParse(input);
          if (!parsed.success || parsed.data.action !== 'cancel') return invalid;
          if (parsed.data.tier !== 'cdp') return pickerResult(parsed.data, 'blocked', { errorCode: 'adapter_unavailable' });
          return await runTrackedDispatch(() => runElementPickerCancel({ ...parsed.data, browserSessionId }));
        }
        default:
          return invalid;
      }
    },
  };
}
