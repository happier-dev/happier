import {
  BrowserDiagnosticsElementPickerRequestV1Schema,
  BrowserDiagnosticsEvalRequestV1Schema,
  BrowserDiagnosticsGetPropertiesRequestV1Schema,
  BrowserDiagnosticsReleaseObjectGroupRequestV1Schema,
  type BrowserDiagnosticsElementPickerRequestV1,
  type BrowserDiagnosticsElementPickerResultV1,
  type BrowserDiagnosticsEvalRequestV1,
  type BrowserDiagnosticsEvalResultV1,
  type BrowserDiagnosticsExpandedRemoteObjectV1,
  type BrowserDiagnosticsGetPropertiesRequestV1,
  type BrowserDiagnosticsGetPropertiesResultV1,
  type BrowserDiagnosticsObjectPropertyV1,
  type BrowserDiagnosticsReleaseObjectGroupRequestV1,
  type BrowserDiagnosticsReleaseObjectGroupResultV1,
  type BrowserDiagnosticsRemoteObjectPreviewPropertyV1,
  type BrowserDiagnosticsRemoteObjectV1,
  type RuntimeActionIdV1,
} from '@happier-dev/protocol';

import type {
  BrowserSidecarCdpEventNotification,
  BrowserSidecarCdpEventSubscriber,
  BrowserSidecarCdpPageHandle,
  BrowserSidecarViewLifecycleSubscriber,
} from '../sidecar/controlAdapter';

import type { BrowserDiagnosticsInteractionTransport } from './actionRoutes';

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
 *                               the `Overlay.inspectNodeRequested` selection event (or cancel/timeout)
 *  - `elementPicker.cancel`  -> `Overlay.setInspectMode(none)` + `Overlay.disable` (interrupts a start)
 */

const ID_MAX = 256;
const INLINE_VALUE_MAX = 1024;
const EXPANDED_VALUE_MAX = 65_536;
const PREVIEW_MAX = 1024;
const PREVIEW_PROPERTY_LIMIT = 10;
const PROPERTY_LIMIT = 100;
const DEFAULT_PICKER_TIMEOUT_MS = 60_000;
const RELEASED_OBJECT_GROUP_KEY_LIMIT = 512;
const TRACKED_OBJECT_GROUP_LIMIT = 512;

type CdpPageCommandTransport = Readonly<{
  dispatchPageCommand(
    input: BrowserSidecarCdpPageHandle & Readonly<{ method: string; params?: Record<string, unknown> }>,
  ): Promise<unknown>;
}>;

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
  /** View ⇄ CDP page-handle bindings (so a viewId-only request can resolve its browserSessionId). */
  subscribeViewLifecycle(listener: BrowserSidecarViewLifecycleSubscriber): () => void;
  /** Live CDP event stream — required for the interactive element picker selection await. */
  subscribeCdpEvents?(listener: BrowserSidecarCdpEventSubscriber): () => void;
}>;

export type BrowserDiagnosticsInteractionTransportInput = Readonly<{
  contextCapture: BrowserDiagnosticsInteractionContextCapture;
  /** Element-picker selection timeout. Defaults to 60s. */
  pickerTimeoutMs?: number;
  onError?: (error: unknown) => void;
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

function buildPreview(cdp: Record<string, unknown>): BrowserDiagnosticsRemoteObjectPreviewPropertyV1[] {
  const preview = record(cdp.preview);
  const properties = preview && Array.isArray(preview.properties) ? preview.properties : [];
  const out: BrowserDiagnosticsRemoteObjectPreviewPropertyV1[] = [];
  for (const entry of properties) {
    const prop = record(entry);
    if (!prop) continue;
    const name = typeof prop.name === 'string' ? prop.name.trim() : '';
    if (!name) continue;
    const valuePreview = valuePreviewString(prop.value);
    out.push({ name: clamp(name, ID_MAX), valuePreview: clamp(valuePreview, PREVIEW_MAX), truncated: false });
    if (out.length >= PREVIEW_PROPERTY_LIMIT) break;
  }
  return out;
}

/**
 * Map a raw CDP `Runtime.RemoteObject` to the canonical diagnostics remote-object shape. Returns null
 * when the CDP value cannot satisfy the contract (e.g. an object/function reference with no objectId),
 * so the caller omits the result rather than emit a schema-invalid value.
 */
function toRemoteObject(value: unknown, maxValueLen: number): BrowserDiagnosticsRemoteObjectV1 | null {
  const cdp = record(value);
  if (!cdp) return null;
  const type = resolveRemoteObjectType(cdp);
  if (!type) return null;

  const objectId = typeof cdp.objectId === 'string' && cdp.objectId.length > 0
    ? clamp(cdp.objectId, ID_MAX)
    : undefined;
  const className = typeof cdp.className === 'string' && cdp.className.trim().length > 0
    ? clamp(cdp.className.trim(), ID_MAX)
    : undefined;
  const description = typeof cdp.description === 'string'
    ? clamp(cdp.description, INLINE_VALUE_MAX)
    : undefined;

  if (type === 'object' || type === 'function') {
    if (!objectId) return null;
    return {
      type,
      objectId,
      ...(className ? { className } : {}),
      ...(description ? { description } : {}),
      preview: buildPreview(cdp),
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
    scalar = typeof cdp.value === 'string' ? clamp(cdp.value, maxValueLen) : undefined;
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
  // The expanded shape is structurally identical to the remote-object shape but allows a longer
  // inline string value (65 KiB vs 1 KiB). The mapper output satisfies both contracts.
  return toRemoteObject(value, EXPANDED_VALUE_MAX);
}

export function createBrowserDiagnosticsInteractionTransport(
  input: BrowserDiagnosticsInteractionTransportInput,
): BrowserDiagnosticsInteractionTransport {
  const { contextCapture } = input;
  const pickerTimeoutMs = input.pickerTimeoutMs ?? DEFAULT_PICKER_TIMEOUT_MS;
  const onError = input.onError ?? (() => undefined);
  let disposed = false;

  // viewId -> browserSessionId, learned from the control adapter's view-binding lifecycle so a
  // request that carries only a viewId (eval/getProperties/releaseObjectGroup/elementPicker) can be
  // resolved to its owning CDP page handle.
  const viewSessions = new Map<string, string>();
  const unsubscribeLifecycle = contextCapture.subscribeViewLifecycle((event) => {
    if (disposed) return;
    if (event.type === 'bound') {
      viewSessions.set(event.viewId, event.browserSessionId);
    } else {
      void releaseTrackedObjectGroupsForView({
        browserSessionId: event.browserSessionId,
        viewId: event.viewId,
      });
      viewSessions.delete(event.viewId);
    }
  });
  const unsubscribeCdpNavigation = contextCapture.subscribeCdpEvents?.((notification) => {
    if (disposed) return;
    if (!isNavigationInvalidatingEvent(notification)) return;
    void releaseTrackedObjectGroupsForCdpEvent(notification);
  }) ?? null;

  // Pending element-picker awaits, keyed by viewId, so an `elementPicker.cancel` can interrupt a
  // standing `elementPicker.start` instead of waiting out its timeout.
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
    request: Readonly<{ viewId: string; navigationGeneration: number; objectGroupId: string }>,
    handle: BrowserSidecarCdpPageHandle,
  ): void {
    const normalizedObjectGroupId = request.objectGroupId.trim();
    if (!normalizedObjectGroupId) return;
    const browserSessionId = viewSessions.get(request.viewId);
    if (!browserSessionId) return;
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
    if (trackedObjectGroups.size <= TRACKED_OBJECT_GROUP_LIMIT) return;
    const oldest = trackedObjectGroups.keys().next().value;
    if (typeof oldest === 'string') {
      void runTrackedDispatch(() => releaseTrackedObjectGroupByKey(oldest));
    }
  }

  function untrackObjectGroup(handle: BrowserSidecarCdpPageHandle, objectGroupId: string): void {
    const normalizedObjectGroupId = objectGroupId.trim();
    if (!normalizedObjectGroupId) return;
    const key = objectGroupKey(handle, normalizedObjectGroupId);
    trackedObjectGroups.delete(key);
    rememberReleasedObjectGroupKey(key);
  }

  function resolveHandle(view: Readonly<{ viewId: string; browserSessionId?: string }>): BrowserSidecarCdpPageHandle | null {
    if (disposed) return null;
    const browserSessionId = view.browserSessionId ?? viewSessions.get(view.viewId);
    if (!browserSessionId) return null;
    return contextCapture.resolvePageHandle({ browserSessionId, viewId: view.viewId });
  }

  function pageCommand(
    handle: BrowserSidecarCdpPageHandle,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    return contextCapture.transport.dispatchPageCommand({
      targetId: handle.targetId,
      ...(handle.sessionId ? { sessionId: handle.sessionId } : {}),
      method,
      ...(params ? { params } : {}),
    });
  }

  async function tryPageCommand(
    handle: BrowserSidecarCdpPageHandle,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await pageCommand(handle, method, params);
    } catch (error) {
      // Best-effort domain enables / teardown must never throw out of a verb dispatch.
      onError(error);
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

  async function releaseTrackedObjectGroupByKey(key: string): Promise<void> {
    const group = trackedObjectGroups.get(key);
    if (!group) return;
    trackedObjectGroups.delete(key);
    rememberReleasedObjectGroupKey(key);
    await releaseTrackedObjectGroup(group);
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
      onError(error);
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

  async function runEval(request: BrowserDiagnosticsEvalRequestV1): Promise<BrowserDiagnosticsEvalResultV1> {
    const handle = resolveHandle(request);
    if (!handle) return evalResult(request, 'failed', { errorCode: 'target_detached' });
    await tryPageCommand(handle, 'Runtime.enable');
    let raw: unknown;
    try {
      raw = await pageCommand(handle, 'Runtime.evaluate', {
        expression: request.expression,
        objectGroup: request.objectGroupId,
        includeCommandLineAPI: true,
        returnByValue: false,
        generatePreview: true,
        awaitPromise: true,
        timeout: request.timeoutMs,
        userGesture: false,
      });
    } catch (error) {
      onError(error);
      return evalResult(request, 'failed', { errorCode: 'collector_degraded' });
    }
    trackObjectGroup(request, handle);
    const rec = record(raw);
    if (!rec) return evalResult(request, 'completed');
    const exceptionDetails = record(rec.exceptionDetails);
    if (exceptionDetails) {
      const exception = toRemoteObject(exceptionDetails.exception, INLINE_VALUE_MAX);
      return evalResult(request, 'failed', exception ? { result: exception } : {});
    }
    const result = toRemoteObject(rec.result, INLINE_VALUE_MAX);
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
    request: BrowserDiagnosticsGetPropertiesRequestV1,
  ): Promise<BrowserDiagnosticsGetPropertiesResultV1> {
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
      onError(error);
      return propertiesResult(request, 'failed', { errorCode: 'collector_degraded' });
    }
    const rec = record(raw);
    const list = rec && Array.isArray(rec.result) ? rec.result : [];
    const properties: BrowserDiagnosticsObjectPropertyV1[] = [];
    for (const entry of list) {
      const descriptor = record(entry);
      if (!descriptor) continue;
      const name = typeof descriptor.name === 'string' ? descriptor.name.trim() : '';
      if (!name) continue;
      const value = toExpandedRemoteObject(descriptor.value);
      if (!value) continue;
      properties.push({ name: clamp(name, ID_MAX), value, enumerable: descriptor.enumerable === true });
      if (properties.length >= PROPERTY_LIMIT) break;
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
    request: BrowserDiagnosticsReleaseObjectGroupRequestV1,
  ): Promise<BrowserDiagnosticsReleaseObjectGroupResultV1> {
    const handle = resolveHandle(request);
    if (!handle) return releaseResult(request, 'failed', 'target_detached');
    try {
      await pageCommand(handle, 'Runtime.releaseObjectGroup', { objectGroup: request.objectGroupId });
      untrackObjectGroup(handle, request.objectGroupId);
      return releaseResult(request, 'completed');
    } catch (error) {
      onError(error);
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
    viewId: string,
  ): Promise<{ kind: 'selected'; backendNodeId: number } | { kind: 'cancelled' } | { kind: 'timeout' }> {
    const subscribe = contextCapture.subscribeCdpEvents;
    return new Promise((resolve) => {
      if (disposed) {
        resolve({ kind: 'cancelled' });
        return;
      }
      pendingPickers.get(viewId)?.cancel();
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (
        value: { kind: 'selected'; backendNodeId: number } | { kind: 'cancelled' } | { kind: 'timeout' },
      ): void => {
        if (settled) return;
        settled = true;
        if (unsubscribe) unsubscribe();
        if (timer) clearTimeout(timer);
        pendingPickers.delete(viewId);
        resolve(value);
      };
      pendingPickers.set(viewId, {
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
      timer = setTimeout(() => finish({ kind: 'timeout' }), pickerTimeoutMs);
    });
  }

  async function runElementPickerStart(
    request: BrowserDiagnosticsElementPickerRequestV1,
  ): Promise<BrowserDiagnosticsElementPickerResultV1> {
    const handle = resolveHandle(request);
    if (!handle) return pickerResult(request, 'failed', { errorCode: 'target_detached' });
    if (disposed) return pickerResult(request, 'failed', { errorCode: 'target_detached' });
    if (!contextCapture.subscribeCdpEvents) {
      // No event stream ⇒ no way to observe the selection ⇒ honest unavailable (never a fake select).
      return pickerResult(request, 'failed', { errorCode: 'collector_unavailable' });
    }
    await tryPageCommand(handle, 'DOM.enable');
    await tryPageCommand(handle, 'Overlay.enable');
    const selection = awaitInspectSelection(handle, request.viewId);
    await tryPageCommand(handle, 'Overlay.setInspectMode', {
      mode: 'searchForNode',
      highlightConfig: {
        showInfo: true,
        contentColor: { r: 111, g: 168, b: 220, a: 0.5 },
      },
    });
    const outcome = await selection;
    await disablePickerOverlay(handle);
    if (outcome.kind === 'selected') {
      return pickerResult(request, 'selected', { backendNodeRef: clamp(String(outcome.backendNodeId), ID_MAX) });
    }
    return pickerResult(request, 'cancelled');
  }

  async function runElementPickerCancel(
    request: BrowserDiagnosticsElementPickerRequestV1,
  ): Promise<BrowserDiagnosticsElementPickerResultV1> {
    const pending = pendingPickers.get(request.viewId);
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
  ): Promise<unknown> {
    const view = record(input);
    const viewId = typeof view?.viewId === 'string' ? view.viewId : '';
    const browserSessionId = typeof view?.browserSessionId === 'string' ? view.browserSessionId : undefined;
    if (!viewId) return { ok: false, status: 'unavailable', errorCode: 'invalid_parameters' };
    const handle = resolveHandle({ viewId, ...(browserSessionId ? { browserSessionId } : {}) });
    if (!handle) return { ok: false, status: 'unavailable', errorCode: 'target_detached' };
    if (actionId === 'browser.diagnostics.pause') {
      await tryPageCommand(handle, 'Debugger.enable');
      try {
        await pageCommand(handle, 'Debugger.pause');
      } catch (error) {
        onError(error);
        return { ok: false, status: 'failed', errorCode: 'collector_degraded' };
      }
      return { ok: true, status: 'paused', viewId };
    }
    try {
      await pageCommand(handle, 'Debugger.resume');
    } catch (error) {
      onError(error);
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
      for (const picker of pending) {
        picker.cancel();
      }
      await Promise.allSettled(Array.from(pendingDispatches));
      for (const picker of pending) {
        await disablePickerOverlay(picker.handle);
      }
      await releaseTrackedObjectGroups();
      pendingPickers.clear();
      viewSessions.clear();
      releasedObjectGroupKeys.clear();
    },
    releaseObjectGroupsForView: releaseTrackedObjectGroupsForView,
    async dispatch(actionId: RuntimeActionIdV1, input: unknown): Promise<unknown> {
      switch (actionId) {
        case 'browser.diagnostics.pause':
        case 'browser.diagnostics.resume':
          return await runTrackedDispatch(() => runPauseResume(actionId, input));
        case 'browser.diagnostics.eval': {
          const parsed = BrowserDiagnosticsEvalRequestV1Schema.safeParse(input);
          if (!parsed.success) return invalid;
          return await runTrackedDispatch(() => runEval(parsed.data));
        }
        case 'browser.diagnostics.getProperties': {
          const parsed = BrowserDiagnosticsGetPropertiesRequestV1Schema.safeParse(input);
          if (!parsed.success) return invalid;
          return await runTrackedDispatch(() => runGetProperties(parsed.data));
        }
        case 'browser.diagnostics.releaseObjectGroup': {
          const parsed = BrowserDiagnosticsReleaseObjectGroupRequestV1Schema.safeParse(input);
          if (!parsed.success) return invalid;
          return await runTrackedDispatch(() => runReleaseObjectGroup(parsed.data));
        }
        case 'browser.diagnostics.elementPicker.start': {
          const parsed = BrowserDiagnosticsElementPickerRequestV1Schema.safeParse(input);
          if (!parsed.success || parsed.data.action !== 'start') return invalid;
          return await runTrackedDispatch(() => runElementPickerStart(parsed.data));
        }
        case 'browser.diagnostics.elementPicker.cancel': {
          const parsed = BrowserDiagnosticsElementPickerRequestV1Schema.safeParse(input);
          if (!parsed.success || parsed.data.action !== 'cancel') return invalid;
          return await runTrackedDispatch(() => runElementPickerCancel(parsed.data));
        }
        default:
          return invalid;
      }
    },
  };
}
