import { isAbsolute } from 'node:path';

import { z } from 'zod/mini';

import type { ComputerClipboardOperationV1, ComputerClipboardResultV1 } from '@happier-dev/protocol/computer/v1';
import { ComputerAccessibilityNodeV1Schema, ComputerCaptureGeometryV1Schema, computerTargetKeyV1 } from '@happier-dev/protocol/computer/v1';
import type { ComputerAccessibilityNodeV1, ComputerCaptureGeometryV1, ComputerTargetV1, ComputerInputOperationV1, ComputerTargetsListResponseV1, ComputerProviderIdV1, ComputerUseSettingsV1 } from '@happier-dev/protocol';
import { createAgentDesktopComputerDriver } from './agentDesktopDriver';
import { resolveComputerProvider, resolveComputerProviderId } from './provider';

import { ComputerDriverError, nativeRefusalCode, openNativeComputerTransport, type NativeToolResult } from './nativeTransport';

export { ComputerDriverError } from './nativeTransport';

export type ComputerDriverInputResult = Readonly<{ status: 'dispatched' }>
  | Readonly<{ status: 'verified'; property: string }> | Readonly<{ status: 'failed'; code: string }>
  | Readonly<{ status: 'interrupted'; completion: 'known' | 'unknown' }>;
export type ComputerDriverCapture = Readonly<{ png: Buffer; captureId: string; geometry: ComputerCaptureGeometryV1;
  accessibility: Readonly<{ nodes: readonly ComputerAccessibilityNodeV1[]; complete: boolean; degradedReason?: string }> }>;
export type ManagedComputerDriver = Readonly<{
  listTargets(options?: Readonly<{ includeThumbnails?: boolean }>): Promise<readonly ComputerTargetsListResponseV1['targets'][number][]>;
  checkPermissions(): Promise<Readonly<{ capture: 'granted' | 'denied' | 'unknown'; input: 'granted' | 'denied' | 'unknown' }>>;
  capture(target: ComputerTargetV1): Promise<ComputerDriverCapture>;
  captureFrame(target: ComputerTargetV1, options?: Readonly<{ maxImageDimension: number }>): Promise<Readonly<{ png: Buffer; geometry: ComputerCaptureGeometryV1 }>>;
  /** Only host-admitted viewer keys/text omit capture grounding; pointer input always requires it. */
  input(target: ComputerTargetV1, captureId: string | null, operation: ComputerInputOperationV1, context?: Readonly<{ signal?: AbortSignal }>): Promise<ComputerDriverInputResult>;
  clipboard?(target: ComputerTargetV1, operation: ComputerClipboardOperationV1, context?: Readonly<{ signal?: AbortSignal }>): Promise<ComputerClipboardResultV1>;
  close(): Promise<void>;
}>;

const finite = z.number();
const nativeStateSchema = z.object({ pid: z.number().check(z.int(), z.positive()), window_id: z.number().check(z.int(), z.positive()),
  capture_id: z.optional(z.string().check(z.minLength(1))), screenshot_width: z.optional(z.number().check(z.int(), z.positive())),
  screenshot_height: z.optional(z.number().check(z.int(), z.positive())), screenshot_frame_valid: z.optional(z.boolean()),
  window_bounds: z.object({ x: finite, y: finite, width: finite.check(z.positive()), height: finite.check(z.positive()) }),
  elements_complete: z.optional(z.boolean()), degraded_reason: z.optional(z.string()), truncated: z.optional(z.boolean()), truncation_reason: z.optional(z.string()),
  elements: z.optional(z.array(z.object({ element_index: z.number().check(z.int(), z.nonnegative()), role: z.string().check(z.minLength(1)),
    element_token: z.optional(z.string().check(z.regex(/^s[0-9a-f]{8}:[0-9]+$/))),
    label: z.optional(z.string()), value: z.optional(z.string()), frame: z.optional(z.object({ x: finite, y: finite, w: finite, h: finite })) }))),
});
type WindowTarget = Extract<ComputerTargetV1, { kind: 'window' }>;
const screenSizeSchema = z.object({ width: z.number().check(z.int(), z.positive()), height: z.number().check(z.int(), z.positive()), scale_factor: finite.check(z.positive()) });
const desktopStateSchema = z.object({ display: z.literal('primary'), capture_id: z.string().check(z.minLength(1)),
  screenshot_width: z.number().check(z.int(), z.positive()), screenshot_height: z.number().check(z.int(), z.positive()),
  screen_width: z.number().check(z.int(), z.positive()), screen_height: z.number().check(z.int(), z.positive()),
  scale_factor: z.optional(finite.check(z.positive())), frame_scale: z.optional(finite.check(z.positive())) });

/** The pinned native driver exposes one logical primary desktop, not a physical-monitor catalog. */
export function resolveComputerDisplayId(displayId?: string, defaultDisplayId?: string): string | undefined {
  // Explicit connections remain exact; native primary on macOS/Windows is
  // independent of X11 variables. Prefer the native compositor to XWayland.
  return displayId?.trim() || (process.platform === 'darwin' || process.platform === 'win32' ? 'primary'
    : process.platform === 'linux' ? process.env.WAYLAND_DISPLAY?.trim() || defaultDisplayId?.trim() || undefined : undefined);
}

function capturePng(result: NativeToolResult, width: number, height: number): Buffer {
  const image = result.content?.find(part => part.type === 'image' && part.mimeType === 'image/png');
  if (!image?.data) throw new ComputerDriverError('capture_unavailable');
  const png = Buffer.from(image.data, 'base64');
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) throw new ComputerDriverError('driver_result_invalid');
  return png;
}

/** One installed-native executor for the selected native desktop connection. */
export async function createManagedComputerDriver(params: Readonly<{ displayId: string; executablePath?: string;
  environment?: Readonly<Record<string, string>>; provider?: ComputerProviderIdV1; settings?: ComputerUseSettingsV1 }>): Promise<ManagedComputerDriver> {
  // An explicit executable is the internal/test seam after admission, not another install decision.
  const resolved = params.executablePath ? { provider: resolveComputerProviderId(params), executablePath: params.executablePath }
    : await resolveComputerProvider(params);
  const factories = { cua: createCuaComputerDriver, 'agent-desktop': createAgentDesktopComputerDriver };
  return factories[resolved.provider]({ ...params, executablePath: resolved.executablePath });
}

async function createCuaComputerDriver(params: Readonly<{ displayId: string; executablePath: string;
  environment?: Readonly<Record<string, string>> }>): Promise<ManagedComputerDriver> {
  const wayland = process.platform === 'linux' && Boolean(process.env.WAYLAND_DISPLAY?.trim())
    && params.displayId === process.env.WAYLAND_DISPLAY?.trim();
  if (!(process.platform === 'linux' && /^:\d+(?:\.\d+)?$/.test(params.displayId))
    && !wayland && !((process.platform === 'darwin' || process.platform === 'win32') && params.displayId === 'primary')) throw new ComputerDriverError('target_unsupported');
  const executablePath = params.executablePath;
  if (!executablePath || !isAbsolute(executablePath)) throw new ComputerDriverError('driver_executable_invalid');
  const resolvedExecutablePath = executablePath;
  const native = await openNativeComputerTransport(resolvedExecutablePath, params.displayId, { environment: params.environment });
  let frameNative: ReturnType<typeof openNativeComputerTransport> | undefined;
  const frameInitialization = new AbortController();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const inputs = new Set<Promise<unknown>>();
  const trackInput = <T>(operation: Promise<T>): Promise<T> => {
    inputs.add(operation);
    void operation.then(() => inputs.delete(operation), () => inputs.delete(operation));
    return operation;
  };
  // Retain only action-binding facts, never duplicate the native PNG store.
  let captureBinding: Readonly<{ captureId: string; target: ComputerTargetV1; geometry: ComputerCaptureGeometryV1;
    elementTokens: ReadonlyMap<string, string>; nativeScale?: number }> | undefined;
  const assertTarget = (target: ComputerTargetV1): ComputerTargetV1 => {
    if (target.displayId !== params.displayId) throw new ComputerDriverError('target_mismatch');
    if (target.kind === 'window' && typeof target.windowId !== 'number') throw new ComputerDriverError('target_unsupported');
    if (native.unavailable() || closing) throw new ComputerDriverError('driver_unavailable');
    return target;
  };
  const checkPermissions: ManagedComputerDriver['checkPermissions'] = async () => {
    const result = await native.call('check_permissions', {});
    const grant = (value: unknown) => value === true ? 'granted' as const : value === false ? 'denied' as const : 'unknown' as const;
    if (result.isError) return { capture: 'unknown', input: 'unknown' };
    if (process.platform === 'win32') {
      const permissions = z.object({ uia: z.boolean(), post_message: z.boolean() }).safeParse(result.structuredContent);
      // Windows has no separate capture permission prompt. Elevation is not
      // required for ordinary desktop use; UIPI/native failures still refuse.
      return permissions.success ? { capture: 'granted', input: grant(permissions.data.post_message) }
        : { capture: 'unknown', input: 'unknown' };
    }
    if (wayland) {
      // This means the native backend is available, not that every compositor
      // supports capture/input. Actual native operations enforce their grants
      // and target identity; the X11 bits do not describe Wayland permission.
      const available = result.structuredContent?.wayland === true && result.structuredContent?.wayland_enabled === true;
      return { capture: available ? 'granted' : 'unknown', input: available ? 'granted' : 'unknown' };
    }
    return process.platform === 'darwin'
      ? { capture: grant(result.structuredContent?.screen_recording), input: grant(result.structuredContent?.accessibility) }
      : { capture: grant(result.structuredContent?.x11), input: grant(result.structuredContent?.xsend_event) };
  };
  // X11 grants belong to this native connection. Admit once; native input still
  // enforces the OS boundary. Status reads remain fresh and reselection reconnects.
  let x11InputAdmission: ReturnType<ManagedComputerDriver['checkPermissions']> | undefined;
  const requireCaptureGrant = async (target: ComputerTargetV1) => {
    if (process.platform !== 'darwin' && target.kind !== 'display') return;
    const grants = await checkPermissions();
    const grant = grants.capture;
    if (grant !== 'granted') throw new ComputerDriverError(grant === 'denied' ? 'capture_permission_denied' : 'capture_permission_unknown');
    return grants;
  };
  type NativeCapture = ComputerDriverCapture & Readonly<{ elementTokens: ReadonlyMap<string, string>; nativeScale?: number }>;
  const decodeCapture = (result: NativeToolResult, window: WindowTarget): NativeCapture => {
    if (result.isError) throw new ComputerDriverError(nativeRefusalCode(result));
    const state = nativeStateSchema.safeParse(result.structuredContent);
    if (!state.success) throw new ComputerDriverError('driver_result_invalid');
    if (state.data.pid !== window.pid || state.data.window_id !== window.windowId) throw new ComputerDriverError('target_mismatch');
    const { capture_id: captureId, screenshot_width: captureWidth, screenshot_height: captureHeight, window_bounds: bounds } = state.data;
    if (!captureId || !captureWidth || !captureHeight || state.data.screenshot_frame_valid === false) throw new ComputerDriverError('capture_unavailable');
    const png = capturePng(result, captureWidth, captureHeight);
    const geometry = ComputerCaptureGeometryV1Schema.parse({ captureWidth, captureHeight, nativeWidth: bounds.width, nativeHeight: bounds.height,
      originX: bounds.x, originY: bounds.y, scaleX: bounds.width / captureWidth, scaleY: bounds.height / captureHeight,
      crop: { x: 0, y: 0, width: bounds.width, height: bounds.height } });
    const nodes = (state.data.elements ?? []).map(element => ComputerAccessibilityNodeV1Schema.parse({ id: String(element.element_index), role: element.role,
      ...(element.label !== undefined ? { name: element.label } : {}), ...(element.value !== undefined ? { value: element.value } : {}),
      ...(element.frame && element.frame.w > 0 && element.frame.h > 0 ? { bounds: { x: element.frame.x, y: element.frame.y, width: element.frame.w, height: element.frame.h } } : {}) }));
    const elementTokens = new Map((state.data.elements ?? []).flatMap(element => element.element_token
      ? [[String(element.element_index), element.element_token] as const] : []));
    return { png, captureId, geometry, elementTokens, accessibility: { nodes, complete: state.data.elements_complete === true && state.data.truncated !== true,
      ...(state.data.degraded_reason || state.data.truncation_reason ? { degradedReason: state.data.degraded_reason ?? state.data.truncation_reason } : {}) } };
  };
  const decodeDesktopCapture = (result: NativeToolResult): NativeCapture => {
    if (result.isError) throw new ComputerDriverError(nativeRefusalCode(result));
    const parsed = desktopStateSchema.safeParse(result.structuredContent);
    if (!parsed.success || (process.platform === 'darwin' && parsed.data.scale_factor === undefined)) throw new ComputerDriverError('driver_result_invalid');
    const state = parsed.data;
    const geometry = ComputerCaptureGeometryV1Schema.parse({ captureWidth: state.screenshot_width, captureHeight: state.screenshot_height,
      nativeWidth: state.screen_width, nativeHeight: state.screen_height, originX: 0, originY: 0,
      scaleX: state.screen_width / state.screenshot_width, scaleY: state.screen_height / state.screenshot_height,
      crop: { x: 0, y: 0, width: state.screen_width, height: state.screen_height } });
    return { png: capturePng(result, state.screenshot_width, state.screenshot_height), captureId: state.capture_id, geometry,
      elementTokens: new Map(), nativeScale: state.scale_factor ?? 1,
      accessibility: { nodes: [], complete: false, degradedReason: 'desktop_vision_only' } };
  };
  const capture = async (target: ComputerTargetV1): Promise<ComputerDriverCapture> => {
    assertTarget(target);
    // A failed observation cannot leave an older model action admitted.
    captureBinding = undefined;
    const grants = await requireCaptureGrant(target);
    const result = target.kind === 'display' ? await native.call('get_desktop_state', { max_image_dimension: 0 })
      : await native.call('get_window_state', { pid: target.pid, window_id: target.windowId,
        include_screenshot: true, include_accessibility_tree: process.platform !== 'darwin' || grants?.input === 'granted', max_image_dimension: 0,
        full_output: true });
    const { elementTokens, nativeScale, ...observation } = target.kind === 'display' ? decodeDesktopCapture(result) : decodeCapture(result, target);
    captureBinding = { captureId: observation.captureId, target, geometry: observation.geometry, elementTokens,
      ...(nativeScale !== undefined ? { nativeScale } : {}) };
    return observation;
  };
  const performInput = async (target: ComputerTargetV1, captureId: string | null, operation: ComputerInputOperationV1,
    context?: Readonly<{ signal?: AbortSignal }>): Promise<ComputerDriverInputResult> => {
    if (context?.signal?.aborted) return { status: 'interrupted', completion: 'known' };
    try { assertTarget(target); } catch (error) { return { status: 'failed', code: error instanceof ComputerDriverError ? error.code : 'driver_unavailable' }; }
    // Cua's window move_cursor routes reveal its overlay rather than delivering app hover.
    if (operation.kind === 'move' && target.kind === 'window') return { status: 'failed', code: 'input_not_supported' };
    const observation = captureId === null ? undefined : captureBinding;
    if ((captureId !== null || !['press', 'type'].includes(operation.kind)) && (!observation || observation.captureId !== captureId
      || computerTargetKeyV1(observation.target) !== computerTargetKeyV1(target))) return { status: 'failed', code: operation.kind === 'element' ? 'computer_element_stale' : 'stale_capture' };
    // Cua 0.37.0's atomic click has no modifier field. Never silently deliver an unmodified click.
    if (operation.kind === 'click' && operation.modifiers?.length) return { status: 'failed', code: 'input_not_supported' };
    if (operation.kind === 'press' && operation.modifiers?.includes('fn') && process.platform !== 'darwin') {
      return { status: 'failed', code: 'input_not_supported' };
    }
    const elementToken = operation.kind === 'element' ? observation?.elementTokens.get(operation.elementId) : undefined;
    if (operation.kind === 'element' && !elementToken) return { status: 'failed', code: 'computer_element_stale' };
    if (operation.kind === 'click' && (!observation || !Number.isFinite(operation.x) || !Number.isFinite(operation.y) || operation.x < 0 || operation.y < 0
      || operation.x >= observation.geometry.captureWidth || operation.y >= observation.geometry.captureHeight)) return { status: 'failed', code: 'point_outside_capture' };
    const point = (x: number, y: number) => {
      if (!observation || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0
        || x >= observation.geometry.captureWidth || y >= observation.geometry.captureHeight) throw new ComputerDriverError('point_outside_capture');
      return { x: x * observation.geometry.scaleX, y: y * observation.geometry.scaleY };
    };
    if (observation) captureBinding = undefined;
    const nativeTarget = target.kind === 'display' ? { target: { kind: 'desktop', display_id: 'primary' } }
      : { pid: target.pid, window_id: target.windowId };
    // Pinned desktop input is foreground-only; background delivery is a window capability.
    const deliveryMode = target.kind === 'display' ? 'foreground' : 'background';
    let admitted = false;
    try {
      if (process.platform === 'darwin' || target.kind === 'display') {
        const grant = (await (process.platform === 'linux' && !wayland
          ? x11InputAdmission ??= checkPermissions() : checkPermissions())).input;
        if (context?.signal?.aborted) return { status: 'interrupted', completion: 'known' };
        if (grant !== 'granted') return { status: 'failed', code: grant === 'denied' ? 'input_permission_denied' : 'input_permission_unknown' };
      }
      if (observation && target.kind === 'display' && operation.kind !== 'element') {
        const current = await native.call('get_screen_size', {});
        if (context?.signal?.aborted) return { status: 'interrupted', completion: 'known' };
        if (current.isError) return { status: 'failed', code: nativeRefusalCode(current) };
        const size = screenSizeSchema.safeParse(current.structuredContent);
        if (!size.success) return { status: 'failed', code: 'driver_result_invalid' };
        if (size.data.width !== observation.geometry.nativeWidth || size.data.height !== observation.geometry.nativeHeight
          || size.data.scale_factor !== observation.nativeScale) return { status: 'failed', code: 'stale_capture' };
      } else if (observation && target.kind === 'window' && operation.kind !== 'element') {
        const current = await native.call('get_window_state', { ...nativeTarget, include_screenshot: false, include_accessibility_tree: true, full_output: true });
        if (context?.signal?.aborted) return { status: 'interrupted', completion: 'known' };
        if (current.isError) return { status: 'failed', code: nativeRefusalCode(current) };
        const state = nativeStateSchema.safeParse(current.structuredContent);
        if (!state.success) return { status: 'failed', code: 'driver_result_invalid' };
        const bounds = state.data.window_bounds;
        if (state.data.pid !== target.pid || state.data.window_id !== target.windowId || bounds.width !== observation.geometry.nativeWidth || bounds.height !== observation.geometry.nativeHeight
          || bounds.x !== observation.geometry.originX || bounds.y !== observation.geometry.originY) return { status: 'failed', code: 'stale_capture' };
        if (closing || native.unavailable()) return { status: 'failed', code: 'driver_unavailable' };
      }
      // Cua owns capture→native conversion and live identity/dimensions checks.
      // Input targets this exact native source. The native route
      // may use accessibility, MPX or paired XSendEvent; no held-input
      // primitive is exposed, and failed native settlement remains unknown.
      if (context?.signal?.aborted) return { status: 'interrupted', completion: 'known' };
      if (closing || native.unavailable()) return { status: 'failed', code: 'driver_unavailable' };
      const calls: Array<Readonly<{ name: string; args: Record<string, unknown> }>> = [];
      const frame = { scope: target.kind === 'display' ? 'desktop' : 'window', coordinate_frame: target.kind === 'display' ? 'desktop' : 'window' };
      switch (operation.kind) {
        case 'move':
          point(operation.x, operation.y);
          calls.push({ name: 'move_cursor', args: { scope: 'desktop', x: operation.x, y: operation.y } }); break;
        case 'element': calls.push({ name: operation.action === 'click' ? 'click' : 'set_value', args: {
          element_token: elementToken, ...(operation.action === 'set_value' ? { value: operation.value } : {}),
        } }); break;
        case 'click': calls.push({ name: 'click', args: { capture_id: captureId, x: operation.x, y: operation.y, button: operation.button ?? 'left',
          ...(operation.clickCount ? { count: operation.clickCount } : {}) } }); break;
        case 'type': calls.push({ name: 'type_text', args: { text: operation.text } }); break;
        case 'press': calls.push({ name: 'press_key', args: { key: operation.key,
          ...(operation.modifiers?.length ? { modifiers: operation.modifiers } : {}) } }); break;
        case 'drag': {
          const from = point(operation.fromX, operation.fromY); const to = point(operation.toX, operation.toY);
          calls.push({ name: 'drag', args: { ...frame, from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y } }); break;
        }
        case 'wheel': {
          const p = point(operation.x, operation.y);
          for (const [delta, positive, negative] of [[operation.deltaX, 'right', 'left'], [operation.deltaY, 'up', 'down']] as const) {
            if (delta !== 0) calls.push({ name: 'scroll', args: { ...frame, ...p, direction: delta > 0 ? positive : negative, amount: Math.abs(delta), by: 'line' } });
          }
          break;
        }
      }
      let result: NativeToolResult = { structuredContent: { effect: 'unverifiable' } };
      for (const call of calls) {
        admitted = true;
        result = await native.call(call.name, operation.kind === 'move'
          ? { ...call.args, ...(process.platform === 'darwin' ? { delivery_mode: deliveryMode } : {}) }
          : { ...nativeTarget, ...call.args, delivery_mode: deliveryMode });
        if (result.isError || result.structuredContent?.effect === 'refused') break;
      }
      if (result.isError || result.structuredContent?.effect === 'refused') {
        const code = nativeRefusalCode(result);
        // Pinned Cua rejects an unknown/expired native snapshot token before delivery.
        if (operation.kind === 'element' && result.structuredContent?.status === 'refused' && code === 'stale_element_token') {
          return { status: 'failed', code: 'computer_element_stale' };
        }
        // Cua 0.37.0's Windows class detector refuses before injection. The
        // same code after a UIA timeout or actuator attempt does NOT prove that.
        const refusedBackgroundClass = process.platform === 'win32' && target.kind === 'window' && code === 'background_unavailable'
          && typeof result.structuredContent?.target_class === 'string'
          && result.structuredContent?.event_kind === (operation.kind === 'click' ? 'mouse_click' : operation.kind === 'type' ? 'text_input' : 'keystroke')
          && result.structuredContent?.effect === undefined && result.structuredContent?.cause === undefined;
        // These pinned codes arise before native input. A generic tool error
        // may instead follow a press, so it cannot establish no effect.
        if ((operation.kind === 'click' && (code === 'capture_action_refused' || code === 'capture_id_invalid' || code === 'capture_not_found'
          || code === 'capture_target_mismatch' || code === 'point_outside_window' || code === 'capture_expired'
          || code === 'capture_generation_mismatch' || code === 'capture_frame_mismatch' || code === 'capture_coordinate_invalid'))
          || (operation.kind === 'type' && code === 'browser_field_needs_keystrokes') || refusedBackgroundClass) return { status: 'failed', code };
        native.quarantine();
        return { status: 'interrupted', completion: 'unknown' };
      }
      const effect = result.structuredContent?.effect;
      if (effect === 'confirmed' && calls.length === 1) {
        const evidence = z.array(z.object({ kind: z.enum(['value_readback', 'window_change']) })).safeParse(result.structuredContent?.evidence);
        if (evidence.success && evidence.data[0]) return { status: 'verified', property: evidence.data[0].kind };
      }
      if (effect === 'confirmed' && calls.length > 1) return { status: 'dispatched' };
      if (effect === 'unverifiable' || effect === 'suspected_noop') return { status: 'dispatched' };
      native.quarantine();
      return { status: 'interrupted', completion: 'unknown' };
    } catch (error) {
      if (!admitted) return { status: 'failed', code: error instanceof ComputerDriverError ? error.code : 'driver_unavailable' };
      native.quarantine();
      return { status: 'interrupted', completion: 'unknown' };
    }
  };
  const captureFrame: ManagedComputerDriver['captureFrame'] = async (target, options) => {
    assertTarget(target);
    await requireCaptureGrant(target);
    // Viewer and preview images cannot evict the model's one-shot action token.
    frameNative ??= openNativeComputerTransport(resolvedExecutablePath, params.displayId, { signal: frameInitialization.signal, environment: params.environment });
    const frameTransport = await frameNative;
    if (closing) throw new ComputerDriverError('driver_unavailable');
    const result = target.kind === 'display' ? await frameTransport.call('get_desktop_state', { max_image_dimension: options?.maxImageDimension ?? 0 })
      : await frameTransport.call('get_window_state', { pid: target.pid, window_id: target.windowId,
        include_screenshot: true, include_accessibility_tree: false, max_image_dimension: options?.maxImageDimension ?? 0 });
    const frame = target.kind === 'display' ? decodeDesktopCapture(result) : decodeCapture(result, target);
    return { png: frame.png, geometry: frame.geometry };
  };
  return {
    async listTargets(options) {
      if (closing || native.unavailable()) throw new ComputerDriverError('driver_unavailable');
      const result = await native.call('list_windows', { on_screen_only: true });
      if (result.isError) throw new ComputerDriverError(nativeRefusalCode(result));
      const windows = z.object({ windows: z.array(z.object({ pid: z.nullable(z.number().check(z.int(), z.positive())), window_id: z.number().check(z.int(), z.positive()), title: z.string(), app_name: z.optional(z.string()) })) }).safeParse(result.structuredContent);
      if (!windows.success) throw new ComputerDriverError('driver_result_invalid');
      const targets: ComputerTargetsListResponseV1['targets'] = windows.data.windows.flatMap(window => window.pid === null ? [] : [{
        target: { kind: 'window' as const, displayId: params.displayId, pid: window.pid, windowId: window.window_id }, title: window.title,
        ...(window.app_name?.trim() ? { appName: window.app_name.trim() } : {}),
      }]);
      const screen = await native.call('get_screen_size', {});
      const size = screenSizeSchema.safeParse(screen.structuredContent);
      if (!screen.isError && size.success) {
        const label = 'primary';
        targets.push({ target: { kind: 'display', displayId: params.displayId },
          label, title: label, width: size.data.width, height: size.data.height });
      }
      if (wayland && targets.length === 0) throw new ComputerDriverError('wayland_target_unavailable',
        'The compositor did not expose identifiable windows or native desktop geometry to Cua. Use a supported compositor/helper or an explicit X11 desktop.');
      if (!options?.includeThumbnails) return targets;
      return await Promise.all(targets.map(async entry => {
        try {
          // The picker uses a 256-pixel long-edge preview, not a model observation.
          const frame = await captureFrame(entry.target, { maxImageDimension: 256 });
          return { ...entry, thumbnail: { mimeType: 'image/png' as const, base64: frame.png.toString('base64'),
            width: frame.geometry.captureWidth, height: frame.geometry.captureHeight } };
        } catch (error) {
          // Enumeration can outlive a window, and OS capture permission can be absent.
          if (error instanceof ComputerDriverError && error.code !== 'driver_result_invalid' && error.code !== 'driver_unavailable') return entry;
          throw error;
        }
      }));
    },
    checkPermissions,
    capture,
    captureFrame,
    input(target, captureId, operation, context) {
      return trackInput(performInput(target, captureId, operation, context));
    },
    clipboard(target, operation, context) {
      return trackInput((async (): Promise<ComputerClipboardResultV1> => {
        try {
          assertTarget(target);
          if (context?.signal?.aborted) return { ok: false, code: 'user_canceled' };
          const result = await native.call(operation.kind === 'read' ? 'clipboard_read' : 'clipboard_write',
            operation.kind === 'read' ? { include_text: true } : { text: operation.text });
          if (result.isError) return { ok: false, code: nativeRefusalCode(result) };
          if (operation.kind === 'read') {
            const parsed = z.object({ supported: z.boolean(), text: z.nullable(z.string()) }).safeParse(result.structuredContent);
            if (!parsed.success) return { ok: false, code: 'driver_result_invalid' };
            if (!parsed.data.supported) return { ok: false, code: 'clipboard_not_supported' };
            return parsed.data.text === null ? { ok: false, code: 'clipboard_text_unavailable' } : { ok: true, text: parsed.data.text };
          }
          const parsed = z.object({ supported: z.boolean(), written_type: z.literal('text') }).safeParse(result.structuredContent);
          return !parsed.success ? { ok: false, code: 'driver_result_invalid' }
            : parsed.data.supported ? { ok: true } : { ok: false, code: 'clipboard_not_supported' };
        } catch (error) {
          return { ok: false, code: error instanceof ComputerDriverError ? error.code : 'driver_unavailable' };
        }
      })());
    },
    close() {
      if (!closePromise) {
        closing = true;
        frameInitialization.abort();
        closePromise = (async () => {
          await Promise.allSettled([...inputs]);
          const frame = frameNative ? await frameNative.catch(() => null) : null;
          await Promise.all([native.close(), frame?.close()]);
          captureBinding = undefined;
        })();
      }
      return closePromise;
    },
  };
}
