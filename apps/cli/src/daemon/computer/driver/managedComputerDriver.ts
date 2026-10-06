import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { ComputerAccessibilityNodeV1Schema, ComputerCaptureGeometryV1Schema } from '@happier-dev/protocol/computer/v1';
import type { ComputerAccessibilityNodeV1, ComputerCaptureGeometryV1, ComputerTargetV1, ComputerInputOperationV1, ComputerTargetsListResponseV1 } from '@happier-dev/protocol';

import { getArchiveDownloadInstallableAdapter } from '../../../packagedRuntime/installables/registry';
import { COMPUTER_CUA_DRIVER_INSTALLABLE_KEY } from '../../../packagedRuntime/installables/sourceAdapters/computerCuaDriver';

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
  input(target: ComputerTargetV1, captureId: string, operation: ComputerInputOperationV1, context?: Readonly<{ signal?: AbortSignal }>): Promise<ComputerDriverInputResult>;
  close(): Promise<void>;
}>;

const finite = z.number().finite();
const nativeStateSchema = z.object({ pid: z.number().int().positive(), window_id: z.number().int().positive(),
  capture_id: z.string().min(1).optional(), screenshot_width: z.number().int().positive().optional(),
  screenshot_height: z.number().int().positive().optional(), screenshot_frame_valid: z.boolean().optional(),
  window_bounds: z.object({ x: finite, y: finite, width: finite.positive(), height: finite.positive() }),
  elements_complete: z.boolean().optional(), degraded_reason: z.string().optional(), truncated: z.boolean().optional(), truncation_reason: z.string().optional(),
  elements: z.array(z.object({ element_index: z.number().int().nonnegative(), role: z.string().min(1),
    label: z.string().optional(), value: z.string().optional(), frame: z.object({ x: finite, y: finite, w: finite, h: finite }).optional() })).optional(),
});
type WindowTarget = Extract<ComputerTargetV1, { kind: 'window' }>;
function sameTarget(left: WindowTarget, right: WindowTarget) {
  return left.displayId === right.displayId && left.pid === right.pid && left.windowId === right.windowId;
}

/** First proved executor: explicit X11 window, direct embedded native process. */
export async function createManagedComputerDriver(params: Readonly<{ displayId: string; executablePath?: string }>): Promise<ManagedComputerDriver> {
  if (process.platform !== 'linux' || !/^:\d+(?:\.\d+)?$/.test(params.displayId)) throw new ComputerDriverError('target_unsupported');
  let executablePath = params.executablePath;
  if (!executablePath) {
    const adapter = getArchiveDownloadInstallableAdapter(COMPUTER_CUA_DRIVER_INSTALLABLE_KEY);
    if (!adapter) throw new ComputerDriverError('driver_unavailable');
    executablePath = await adapter.resolveInstalledExecutable() ?? undefined;
    if (!executablePath) {
      const installed = await adapter.installOrUpgrade();
      if (!installed.ok) throw new ComputerDriverError('driver_install_failed');
      executablePath = installed.executablePath;
    }
  }
  if (!executablePath || !isAbsolute(executablePath)) throw new ComputerDriverError('driver_executable_invalid');
  const resolvedExecutablePath = executablePath;
  const native = await openNativeComputerTransport(resolvedExecutablePath, params.displayId);
  let frameNative: ReturnType<typeof openNativeComputerTransport> | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const inputs = new Set<Promise<ComputerDriverInputResult>>();
  // Retain only action-binding facts, never duplicate the native PNG store.
  let captureBinding: Readonly<{ captureId: string; target: WindowTarget; geometry: ComputerCaptureGeometryV1 }> | undefined;
  const assertTarget = (target: ComputerTargetV1): WindowTarget => {
    if (target.displayId !== params.displayId) throw new ComputerDriverError('target_mismatch');
    if (target.kind !== 'window') throw new ComputerDriverError('target_unsupported');
    if (native.unavailable() || closing) throw new ComputerDriverError('driver_unavailable');
    return target;
  };
  const decodeCapture = (result: NativeToolResult, window: WindowTarget): ComputerDriverCapture => {
    if (result.isError) throw new ComputerDriverError(nativeRefusalCode(result));
    const state = nativeStateSchema.safeParse(result.structuredContent);
    if (!state.success) throw new ComputerDriverError('driver_result_invalid');
    if (state.data.pid !== window.pid || state.data.window_id !== window.windowId) throw new ComputerDriverError('target_mismatch');
    const { capture_id: captureId, screenshot_width: captureWidth, screenshot_height: captureHeight, window_bounds: bounds } = state.data;
    const image = result.content?.find(part => part.type === 'image' && part.mimeType === 'image/png');
    if (!captureId || !captureWidth || !captureHeight || state.data.screenshot_frame_valid === false || !image?.data) throw new ComputerDriverError('capture_unavailable');
    const png = Buffer.from(image.data, 'base64');
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || png.readUInt32BE(16) !== captureWidth || png.readUInt32BE(20) !== captureHeight) throw new ComputerDriverError('driver_result_invalid');
    const geometry = ComputerCaptureGeometryV1Schema.parse({ captureWidth, captureHeight, nativeWidth: bounds.width, nativeHeight: bounds.height,
      originX: bounds.x, originY: bounds.y, scaleX: bounds.width / captureWidth, scaleY: bounds.height / captureHeight,
      crop: { x: 0, y: 0, width: bounds.width, height: bounds.height } });
    const nodes = (state.data.elements ?? []).map(element => ComputerAccessibilityNodeV1Schema.parse({ id: String(element.element_index), role: element.role,
      ...(element.label !== undefined ? { name: element.label } : {}), ...(element.value !== undefined ? { value: element.value } : {}),
      ...(element.frame && element.frame.w > 0 && element.frame.h > 0 ? { bounds: { x: element.frame.x, y: element.frame.y, width: element.frame.w, height: element.frame.h } } : {}) }));
    return { png, captureId, geometry, accessibility: { nodes, complete: state.data.elements_complete === true && state.data.truncated !== true,
      ...(state.data.degraded_reason || state.data.truncation_reason ? { degradedReason: state.data.degraded_reason ?? state.data.truncation_reason } : {}) } };
  };
  const capture = async (target: ComputerTargetV1): Promise<ComputerDriverCapture> => {
    const window = assertTarget(target);
    const result = await native.call('get_window_state', { pid: window.pid, window_id: window.windowId,
      include_screenshot: true, include_accessibility_tree: true, max_image_dimension: 0 });
    const observation = decodeCapture(result, window);
    captureBinding = { captureId: observation.captureId, target: window, geometry: observation.geometry };
    return observation;
  };
  const performInput = async (target: ComputerTargetV1, captureId: string, operation: ComputerInputOperationV1,
    context?: Readonly<{ signal?: AbortSignal }>): Promise<ComputerDriverInputResult> => {
    if (context?.signal?.aborted) return { status: 'interrupted', completion: 'known' };
    let window: WindowTarget;
    try { window = assertTarget(target); } catch (error) { return { status: 'failed', code: error instanceof ComputerDriverError ? error.code : 'driver_unavailable' }; }
    const observation = captureBinding;
    if (!observation || observation.captureId !== captureId || !sameTarget(observation.target, window)) return { status: 'failed', code: 'stale_capture' };
    if (operation.kind === 'click' && (!Number.isFinite(operation.x) || !Number.isFinite(operation.y) || operation.x < 0 || operation.y < 0
      || operation.x >= observation.geometry.captureWidth || operation.y >= observation.geometry.captureHeight)) return { status: 'failed', code: 'point_outside_capture' };
    captureBinding = undefined;
    const nativeTarget = { pid: window.pid, window_id: window.windowId };
    let admitted = false;
    try {
      if (operation.kind !== 'click') {
        const current = await native.call('get_window_state', { ...nativeTarget, include_screenshot: false, include_accessibility_tree: true });
        if (context?.signal?.aborted) return { status: 'interrupted', completion: 'known' };
        if (current.isError) return { status: 'failed', code: nativeRefusalCode(current) };
        const state = nativeStateSchema.safeParse(current.structuredContent);
        if (!state.success) return { status: 'failed', code: 'driver_result_invalid' };
        const bounds = state.data.window_bounds;
        if (state.data.pid !== window.pid || state.data.window_id !== window.windowId || bounds.width !== observation.geometry.nativeWidth || bounds.height !== observation.geometry.nativeHeight
          || bounds.x !== observation.geometry.originX || bounds.y !== observation.geometry.originY) return { status: 'failed', code: 'stale_capture' };
        if (closing || native.unavailable()) return { status: 'failed', code: 'driver_unavailable' };
      }
      // Cua owns capture→native conversion and live identity/dimensions checks.
      // Background input targets this exact X11 window. The native route
      // may use accessibility, MPX or paired XSendEvent; no held-input
      // primitive is exposed, and failed native settlement remains unknown.
      if (context?.signal?.aborted) return { status: 'interrupted', completion: 'known' };
      admitted = true;
      const result = operation.kind === 'click'
        ? await native.call('click', { ...nativeTarget, capture_id: captureId, x: operation.x, y: operation.y, delivery_mode: 'background', button: operation.button ?? 'left' })
        : operation.kind === 'type' ? await native.call('type_text', { ...nativeTarget, text: operation.text, delivery_mode: 'background' })
          : await native.call('press_key', { ...nativeTarget, key: operation.key, delivery_mode: 'background' });
      if (result.isError || result.structuredContent?.effect === 'refused') {
        const code = nativeRefusalCode(result);
        // These pinned codes arise before native input. A generic tool error
        // may instead follow a press, so it cannot establish no effect.
        if (code === 'capture_action_refused' || code === 'capture_id_invalid' || code === 'point_outside_window') return { status: 'failed', code };
        native.quarantine();
        return { status: 'interrupted', completion: 'unknown' };
      }
      const effect = result.structuredContent?.effect;
      if (effect === 'confirmed') {
        const evidence = z.array(z.object({ kind: z.enum(['value_readback', 'window_change']) })).safeParse(result.structuredContent?.evidence);
        if (evidence.success && evidence.data[0]) return { status: 'verified', property: evidence.data[0].kind };
      }
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
    const window = assertTarget(target);
    // Viewer and preview images cannot evict the model's one-shot action token.
    frameNative ??= openNativeComputerTransport(resolvedExecutablePath, params.displayId);
    const frameTransport = await frameNative;
    if (closing) throw new ComputerDriverError('driver_unavailable');
    const result = await frameTransport.call('get_window_state', { pid: window.pid, window_id: window.windowId,
      include_screenshot: true, include_accessibility_tree: false, max_image_dimension: options?.maxImageDimension ?? 0 });
    const frame = decodeCapture(result, window);
    return { png: frame.png, geometry: frame.geometry };
  };
  return {
    async listTargets(options) {
      if (closing || native.unavailable()) throw new ComputerDriverError('driver_unavailable');
      const result = await native.call('list_windows', { on_screen_only: true });
      if (result.isError) throw new ComputerDriverError(nativeRefusalCode(result));
      const windows = z.object({ windows: z.array(z.object({ pid: z.number().int().positive().nullable(), window_id: z.number().int().positive(), title: z.string(), app_name: z.string().optional() })) }).safeParse(result.structuredContent);
      if (!windows.success) throw new ComputerDriverError('driver_result_invalid');
      const targets = windows.data.windows.flatMap(window => window.pid === null ? [] : [{
        target: { kind: 'window' as const, displayId: params.displayId, pid: window.pid, windowId: window.window_id }, title: window.title,
        ...(window.app_name?.trim() ? { appName: window.app_name.trim() } : {}),
      }]);
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
    async checkPermissions() {
      const result = await native.call('check_permissions', {});
      const permissions = z.object({ x11: z.boolean(), xsend_event: z.boolean() }).safeParse(result.structuredContent);
      if (result.isError || !permissions.success) return { capture: 'unknown', input: 'unknown' };
      return { capture: permissions.data.x11 ? 'granted' : 'denied', input: permissions.data.xsend_event ? 'granted' : 'denied' };
    },
    capture,
    captureFrame,
    input(target, captureId, operation, context) {
      const input = performInput(target, captureId, operation, context);
      inputs.add(input);
      void input.finally(() => inputs.delete(input));
      return input;
    },
    close() {
      if (!closePromise) {
        closing = true;
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
