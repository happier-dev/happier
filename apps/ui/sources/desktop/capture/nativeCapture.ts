import { desktopHostKind, invokeDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';
import type { RecordingDocument } from '@/components/screenCapture/recording/recordingDocument';

export type CaptureRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type NativeCaptureTarget =
    | { kind: 'window'; windowId: number }
    | { kind: 'display'; displayId: number }
    | { kind: 'rect'; displayId: number; rect: CaptureRect }
    | { kind: 'frontmost' };
export type NativeCaptureInventory = Readonly<{
    displays: readonly Readonly<{ displayId: number; frame: CaptureRect; scale: number; desktopScale: number;
        storageKey: string | null; localizedName: string | null; safeAreaTop: number;
        physicalNotchSize: Readonly<{ width: number; height: number }> | null }>[];
    windows: readonly Readonly<{ windowId: number; processId: number; frame: CaptureRect;
        appName: string | null; title: string | null; zOrder: number }>[];
}>;
export type NativeCaptureResult = Readonly<{
    captureRef: string;
    kind: 'still' | 'video';
    path: string;
    mimeType: string;
    byteSize: number;
    pixelSize: Readonly<{ width: number; height: number }>;
    scale: number | null;
    origin: Readonly<{ displayId: number; rect: CaptureRect }> | null;
    source: Readonly<{ appName: string | null; windowTitle: string | null; windowId: number | null }> | null;
    windowTextRef: string | null;
}>;
export type NativePreparedPng = Pick<NativeCaptureResult, 'captureRef' | 'path' | 'mimeType' | 'byteSize' | 'pixelSize'>;
export type NativeCaptureDisclosure = Readonly<{ hasMarks: boolean; includeWindowText: boolean }>;
export type NativeWindowShadowPreference = Readonly<{ enabled: boolean; supported: boolean }>;
export const readNativeWindowShadowPreference = (): Promise<NativeWindowShadowPreference> => invoke('desktop_capture_window_shadow');
export const setNativeWindowShadowPreference = (enabled: boolean): Promise<NativeWindowShadowPreference> =>
    invoke('desktop_capture_window_shadow', { enabled });
export function subscribeNativeWindowShadowPreference(handler: (value: NativeWindowShadowPreference) => void): Promise<() => void> {
    requireTauri();
    return listenDesktopHostEvent('desktopCapture://preference/includeWindowShadow', handler);
}
export type NativePreparedRecordingFrame = Readonly<{
    frameRef: string; timeMs: number; note: string | null; byteSize: number;
    pixelSize: NativeCaptureResult['pixelSize'];
}>;
export type NativePreparedRecording = Readonly<{
    captureRef: string; frames: readonly NativePreparedRecordingFrame[];
    videoRef: string | null; includeVideo: boolean; byteSize: number;
}>;
export type NativeRecordingFrameInput = Readonly<{ timeMs: number; bytes: Uint8Array; note?: string }>;
export type NativeCaptureDeliveryState = Readonly<{
    inUse: boolean;
    disclosure: NativeCaptureDisclosure | null;
    windowText: NativeCaptureWindowText | null;
    preparedRecording: NativePreparedRecording | null;
}>;
export type NativeCaptureSessionTarget = Readonly<{ serverId: string; accountId: string; sessionId: string }>;
export type NativeCaptureMode = 'still' | 'recording';
export type NativeCapturePermissionState = 'granted' | 'request_required' | 'denied' | 'restart_required'
    | 'unknown' | 'not_required' | 'per_request' | 'unavailable';
export type NativeCapturePermissionSubject = 'screen' | 'window_text';
export type NativePermissionBundleDragSubject = 'screen' | 'windowText';
export type NativePermissionBundleInfo = Readonly<{ bundlePath: string; displayName: string }>;
/** Bundle path comes from the computer driver owner; locality comes from the local daemon owner. */
export type ComputerDriverPermissionBundleSource = Readonly<{ isLocal: boolean; bundlePath: string | null }>;
type PermissionBundleTarget = Readonly<{ kind: 'app' }> | Readonly<{ kind: 'computerDriver'; bundlePath: string }>;
export type NativeCapturePermissionRecoveryAction = 'reopen' | 'open_settings';
export type NativeCapturePermissions = Readonly<{
    screen: NativeCapturePermissionState;
    windowText: NativeCapturePermissionState;
    recoveryActions: Readonly<{
        screen: readonly NativeCapturePermissionRecoveryAction[];
        windowText: readonly NativeCapturePermissionRecoveryAction[];
    }>;
}>;
export type NativeCapturePermissionRequest = Readonly<{
    snapshot: NativeCapturePermissions;
    recovery: 'none' | NativeCapturePermissionRecoveryAction;
}>;
export type NativeCaptureWindowTextFailure = 'permission_required' | 'provider_unavailable' | 'cancelled';
export type NativeCaptureWindowText = Readonly<{ scope?: 'whole_frontmost_window' }> & (
    Readonly<{ status: 'ready'; text: string; source: NativeCaptureResult['source'] }>
    | Readonly<{ status: 'empty'; source: NativeCaptureResult['source'] }>
    | Readonly<{ status: 'partial'; text: string; reason: NativeCaptureWindowTextFailure; source: NativeCaptureResult['source'] }>
    | Readonly<{ status: 'unavailable'; reason: NativeCaptureWindowTextFailure | 'no_window_context' | 'target_unavailable' | 'ambiguous_target';
        source: NativeCaptureResult['source'] }>);
const errorCodes = ['desktop_only', 'unsupported_platform', 'screen_permission_required',
    'target_unavailable', 'invalid_selection', 'cancelled', 'invalid_png', 'invalid_media', 'unknown_capture',
    'prepared_missing', 'blurred_capture', 'capture_in_use', 'file_io', 'native_failure', 'operation_unavailable',
    'portal_unavailable', 'portal_denied', 'unsupported_target', 'invalid_portal_uri',
    'pipewire_unavailable', 'video_encoder_unavailable', 'video_muxer_unavailable',
    'video_decoder_unavailable', 'cursor_unavailable', 'video_pipeline_unavailable'] as const;
export type NativeCaptureErrorCode = typeof errorCodes[number];
export type NativeRecordingTiming = Readonly<{ durationMs: number; activeSinceMs: number | null }>;
export type NativeRecordingSnapshot = Readonly<{
    phase: 'preparing' | 'recording' | 'paused' | 'finalizing' | 'ready' | 'failed';
    timing: NativeRecordingTiming;
    /** Retained library allocation; it is not a playable result until finalization succeeds. */
    sourceRef: string | null;
    result: NativeCaptureResult | null;
    error: NativeCaptureErrorCode | null;
}>;
export type NativeCaptureSnapshot =
    | { status: 'idle' | 'cancelled' }
    | { status: 'selecting'; operationRef: number; mode: NativeCaptureMode; inventory: NativeCaptureInventory }
    | { status: 'system_selection'; operationRef: number; mode: NativeCaptureMode }
    | { status: 'acquiring'; operationRef: number }
    | { status: 'selected'; operationRef: number; target: NativeCaptureTarget; inventory: NativeCaptureInventory }
    | { status: 'recording'; operationRef: number; recording: NativeRecordingSnapshot; origin?: NativeCaptureResult['origin'] }
    | { status: 'completed'; operationRef: number; result: NativeCaptureResult; targetSession?: NativeCaptureSessionTarget }
    | { status: 'unavailable' | 'failed'; reason: NativeCaptureErrorCode };
export type NativeCaptureDisplayFacts = NativeCaptureInventory['displays'][number];
/** Placement monitors need not identify an admitted capture source. */
export type NativeCaptureWindowDisplay = Omit<NativeCaptureDisplayFacts, 'displayId'> & Readonly<{ displayId: number | null }>;
export type NativeRecentCaptureEntry = Readonly<{
    path: string;
    name: string;
    kind: 'still' | 'video';
    byteSize: number;
    modifiedAt: number | null;
    /** Exact native mtime; visible thumbnails can use it without losing nanosecond precision. */
    modifiedAtNanos: string | null;
}>;
export type NativeRecentCaptureFolder = Readonly<{
    path: string;
    issue: 'missing' | 'denied' | 'read_failed' | 'watch_unavailable' | null;
}>;
export type NativeRecentCapturesSnapshot = Readonly<{
    entries: readonly NativeRecentCaptureEntry[];
    folders: readonly NativeRecentCaptureFolder[];
}>;
export type NativeRecentCaptureChanges = Readonly<{
    upserted: readonly NativeRecentCaptureEntry[];
    removed: readonly string[];
    folders: readonly NativeRecentCaptureFolder[] | null;
    reconciled: boolean;
}>;

export class NativeCaptureError extends Error {
    constructor(readonly code: NativeCaptureErrorCode) { super(code); this.name = 'NativeCaptureError'; }
}
export function readNativeCaptureErrorCode(error: unknown): NativeCaptureErrorCode {
    return error instanceof NativeCaptureError ? error.code : errorCodes.find(code => code === error) ?? 'native_failure';
}
function requireTauri(): void {
    if (desktopHostKind() !== 'tauri') throw new NativeCaptureError('desktop_only');
}
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    requireTauri();
    try { return await invokeDesktopHost<T>(command, args); }
    catch (error) {
        // Rust returns a closed, bodyless code; preserve it without logging native content.
        throw new NativeCaptureError(readNativeCaptureErrorCode(error));
    }
}

export const readCaptureResult = (captureRef: string): Promise<NativeCaptureResult> =>
    invoke('desktop_capture_read_result', { captureRef });
export async function readCaptureSourcePng(captureRef: string): Promise<Uint8Array> {
    return new Uint8Array(await invoke<number[]>('desktop_capture_read_source_png', { captureRef }));
}
/** The existing capture source reader also serves owned video bytes. */
export const readCaptureSource = readCaptureSourcePng;
export const writePreparedCapturePng = (captureRef: string, bytes: Uint8Array, disclosure: NativeCaptureDisclosure): Promise<NativePreparedPng> =>
    invoke('desktop_capture_write_prepared_png', { captureRef, bytes: Array.from(bytes), disclosure });
export const retainPreparedCapturePng = (captureRef: string): Promise<NativeCaptureResult> =>
    invoke('desktop_capture_retain_prepared_png', { captureRef });
export async function readPreparedCapturePng(captureRef: string): Promise<Uint8Array> {
    return new Uint8Array(await invoke<number[]>('desktop_capture_read_prepared_png', { captureRef }));
}
export const importCapturePng = (path: string): Promise<NativeCaptureResult> => invoke('desktop_capture_import_png', { path });
export const openLibraryCapturePng = (path: string): Promise<NativeCaptureResult> => invoke('desktop_capture_open_library_png', { path });
/** Called only by P3's settled discard owner, after its Undo outcome. */
export const discardCapture = (captureRef: string): Promise<void> => invoke('desktop_capture_discard', { captureRef });
export const showCaptureInFolder = (captureRef: string): Promise<void> => invoke('desktop_capture_show_in_folder', { captureRef });
export const readNativeCaptureState = (captureRef?: string): Promise<NativeCaptureSnapshot> =>
    captureRef ? invoke('desktop_capture_read_state', { captureRef }) : invoke('desktop_capture_read_state');
export const openNativeCapture = (captureRef: string, targetSession?: NativeCaptureSessionTarget): Promise<NativeCaptureSnapshot> =>
    invoke('desktop_capture_open', { captureRef, targetSession: targetSession ?? null });
export const settleNativeCapture = (captureRef: string): Promise<NativeCaptureSnapshot> =>
    invoke('desktop_capture_settle', { captureRef });
export const readCaptureDeliveryState = (captureRef: string): Promise<NativeCaptureDeliveryState> =>
    invoke('desktop_capture_read_delivery_state', { captureRef });
export const startNativeCapture = (input: { mode: NativeCaptureMode; target?: NativeCaptureTarget;
    targetSession?: NativeCaptureSessionTarget; presentCaptureWindow?: boolean }): Promise<NativeCaptureSnapshot> =>
    invoke('desktop_capture_start', { mode: input.mode, target: input.target ?? null,
        ...(input.targetSession ? { targetSession: input.targetSession } : {}),
        ...(input.presentCaptureWindow === false ? { presentCaptureWindow: false } : {}) });
/** Explicit person recovery consumes the request retained by the native owner. */
export const retryNativeCapture = (): Promise<NativeCaptureSnapshot> => invoke('desktop_capture_retry');
export const setNativeCaptureMode = (operationRef: number, mode: NativeCaptureMode): Promise<NativeCaptureSnapshot> =>
    invoke('desktop_capture_set_mode', { operationRef, mode });
export const commitNativeCapture = (operationRef: number, target?: NativeCaptureTarget): Promise<NativeCaptureSnapshot> =>
    invoke('desktop_capture_commit', { operationRef, target: target ?? null });
export const cancelNativeCapture = (operationRef: number): Promise<NativeCaptureSnapshot> =>
    invoke('desktop_capture_cancel', { operationRef });
export const readNativeRecordingStatus = (operationRef: number): Promise<NativeRecordingSnapshot> =>
    invoke('desktop_recording_status', { operationRef });
export const pauseNativeRecording = (operationRef: number): Promise<NativeRecordingSnapshot> =>
    invoke('desktop_recording_pause', { operationRef });
export const resumeNativeRecording = (operationRef: number): Promise<NativeRecordingSnapshot> =>
    invoke('desktop_recording_resume', { operationRef });
export const stopNativeRecording = (operationRef: number): Promise<NativeRecordingSnapshot> =>
    invoke('desktop_recording_stop', { operationRef });
export async function trimNativeRecording(captureRef: string, startMs: number, endMs: number,
    signal?: AbortSignal): Promise<NativeCaptureResult> {
    signal?.throwIfAborted();
    let cancelling: Promise<void> | undefined;
    const abort = () => {
        // The native export still settles below if its cancel IPC is unavailable.
        cancelling = invoke<void>('desktop_recording_trim_cancel', { captureRef }).catch(() => undefined);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        const result = await invoke<NativeCaptureResult>('desktop_recording_trim', { captureRef, startMs, endMs });
        signal?.throwIfAborted();
        return result;
    } catch (error) {
        signal?.throwIfAborted();
        throw error;
    } finally {
        signal?.removeEventListener('abort', abort);
        // A retry cannot race an older cancel that is still crossing the webview boundary.
        await cancelling;
    }
}
export const readNativeRecordingDocument = (captureRef: string): Promise<RecordingDocument | null> =>
    invoke('desktop_recording_document_read', { captureRef });
type RecordingDocumentWriteOptions = Readonly<{ initializeOnly: true; expectedDocument?: never }>
    | Readonly<{ initializeOnly?: false; expectedDocument: RecordingDocument }>;
export const writeNativeRecordingDocument = (captureRef: string, document: RecordingDocument,
    options: RecordingDocumentWriteOptions): Promise<RecordingDocument> =>
    invoke('desktop_recording_document_write', { captureRef, document, initializeOnly: options.initializeOnly ?? false,
        expectedDocument: options.initializeOnly ? null : options.expectedDocument });
export async function loadNativeRecordingDocument(captureRef: string): Promise<RecordingDocument> {
    const current = await readNativeRecordingDocument(captureRef);
    if (current) return current;
    const [{ createRecordingDocument }, { loadLocalSettings }, timing] = await Promise.all([
        import('@/components/screenCapture/recording/recordingDocument'),
        import('@/sync/domains/state/settingsPersistence'),
        readNativeRecordingTiming(captureRef),
    ]);
    const document = createRecordingDocument({ sourceCaptureRef: captureRef, ...timing,
        includeWindowText: loadLocalSettings().screenCaptureIncludeWindowText });
    // The native operation atomically keeps any document initialized/edited by another renderer.
    return writeNativeRecordingDocument(captureRef, document, { initializeOnly: true });
}
export const readNativeRecordingTiming = (captureRef: string): Promise<Readonly<{ durationMs: number; frameDurationMs: number }>> =>
    invoke('desktop_recording_timing', { captureRef });
export const prepareNativeRecording = (input: Readonly<{
    captureRef: string; frames: readonly NativeRecordingFrameInput[]; videoRef?: string;
    includeVideo: boolean; hasMarks: boolean; includeWindowText: boolean;
}>): Promise<NativePreparedRecording> => invoke('desktop_recording_prepare', {
    ...input, videoRef: input.videoRef ?? null,
    frames: input.frames.map(frame => ({ timeMs: frame.timeMs, bytes: Array.from(frame.bytes), note: frame.note ?? null })),
});
export const hitTestNativeCapture = (operationRef: number, displayId: number, localX: number, localY: number): Promise<NativeCaptureInventory['windows'][number] | null> =>
    invoke('desktop_capture_hit_test', { operationRef, displayId, localX, localY });
/** Native geometry is projected once; the rendered selector needs no OS branches. */
export const readNativeSelectionFacts = (operationRef: number, displayId: number): Promise<Readonly<{
    display: NativeCaptureDisplayFacts; windows: NativeCaptureInventory['windows'];
    initialPointer: Readonly<{ x: number; y: number }> | null;
}>> => invoke('desktop_capture_selection_facts', { operationRef, displayId });
export const listNativeCaptureTargets = (): Promise<NativeCaptureInventory> => invoke('desktop_capture_targets');
export const readNativeCaptureDisplayFacts = (): Promise<readonly NativeCaptureWindowDisplay[]> => invoke('desktop_capture_display_facts');
export const readCaptureLibraryFolder = (): Promise<string> => invoke('desktop_capture_library_folder');
export const setCaptureLibraryFolder = (path: string | null): Promise<void> => invoke('desktop_capture_set_library_folder', { path });
export const relaunchForCapturePermission = (): Promise<void> => invoke('desktop_capture_relaunch');
export const showCaptureLibraryFolder = (): Promise<void> => invoke('desktop_capture_show_library_folder');
export const pickCaptureLibraryFolder = (): Promise<string | null> => invoke('desktop_pick_folder');
export const readNativeScreenPermission = (): Promise<NativeCapturePermissionState> =>
    invoke('desktop_capture_screen_permission');
export const requestNativeScreenPermission = (): Promise<NativeCapturePermissionState> =>
    invoke('desktop_capture_request_screen_permission');
export const readNativeCapturePermissions = (): Promise<NativeCapturePermissions> => invoke('desktop_capture_permissions');
export const requestNativeCapturePermission = (subject: NativeCapturePermissionSubject): Promise<NativeCapturePermissionRequest> =>
    invoke('desktop_capture_request_permission', { subject });
export async function openNativeCapturePermissionSettings(subject: NativeCapturePermissionSubject,
    options?: Readonly<{ permissionHelper?: boolean }>): Promise<void> {
    await invoke('desktop_capture_open_permission_settings', { subject });
    if (options?.permissionHelper) await placePermissionHelperBesideSettings();
}
export const placePermissionHelperBesideSettings = (): Promise<boolean> => invoke('desktop_capture_place_permission_helper');
export const readAppBundleDragInfo = (): Promise<NativePermissionBundleInfo | null> =>
    invoke('desktop_capture_permission_bundle_info', { target: { kind: 'app' } });
export function readComputerDriverBundleDragInfo(source: ComputerDriverPermissionBundleSource | null): Promise<NativePermissionBundleInfo | null> {
    if (!source?.isLocal || !source.bundlePath) return Promise.resolve(null);
    return invoke('desktop_capture_permission_bundle_info', { target: { kind: 'computerDriver', bundlePath: source.bundlePath } });
}

const bundleDragSubject = (subject: NativePermissionBundleDragSubject): NativeCapturePermissionSubject =>
    subject === 'windowText' ? 'window_text' : subject;
const setPermissionBundleDragBounds = (subject: NativePermissionBundleDragSubject, target: PermissionBundleTarget,
    bounds: CaptureRect | null): Promise<void> => invoke('desktop_capture_set_permission_bundle_drag_bounds', {
    subject: bundleDragSubject(subject), target, bounds,
});
/** Bounds are webview-local logical points. Null retires the native icon view on unmount. */
export const setAppBundleDragBounds = (subject: NativePermissionBundleDragSubject, bounds: CaptureRect | null): Promise<void> =>
    setPermissionBundleDragBounds(subject, { kind: 'app' }, bounds);
export const startAppBundleDrag = (subject: NativePermissionBundleDragSubject): Promise<void> =>
    invoke('desktop_capture_start_app_bundle_drag', { subject: bundleDragSubject(subject), target: { kind: 'app' } });
/** Consume the local target admitted by readComputerDriverBundleDragInfo, without another owner lookup. */
export const setComputerDriverBundleDragBounds = (subject: NativePermissionBundleDragSubject, info: NativePermissionBundleInfo,
    bounds: CaptureRect | null): Promise<void> => setPermissionBundleDragBounds(subject, { kind: 'computerDriver', bundlePath: info.bundlePath }, bounds);
export const startComputerDriverBundleDrag = (subject: NativePermissionBundleDragSubject, info: NativePermissionBundleInfo): Promise<void> =>
    invoke('desktop_capture_start_app_bundle_drag', { subject: bundleDragSubject(subject), target: { kind: 'computerDriver', bundlePath: info.bundlePath } });
export const readNativeCaptureWindowText = (captureRef: string): Promise<NativeCaptureWindowText> =>
    invoke('desktop_capture_window_text', { captureRef });

let permissionSubscriptionRef = 0;
/** Demand starts with a presenter and ends with its subscription, including while another is open. */
export async function subscribeNativeCapturePermissions(handler: (snapshot: NativeCapturePermissions) => void,
    signal?: AbortSignal): Promise<() => void> {
    requireTauri();
    if (signal?.aborted) return () => {};
    const subscriptionRef = ++permissionSubscriptionRef;
    let retired = false;
    const stop = await listenDesktopHostEvent<NativeCapturePermissions>('desktopCapture://permissions', snapshot => {
        if (!retired && !signal?.aborted) handler(snapshot);
    });
    if (signal?.aborted) { stop(); return () => {}; }
    const retire = () => {
        if (retired) return;
        retired = true;
        signal?.removeEventListener('abort', retire);
        stop();
        void invoke('desktop_capture_permissions_watch', { subscriptionRef, consumed: false }).catch(() => undefined);
    };
    signal?.addEventListener('abort', retire, { once: true });
    try {
        const snapshot = await invoke<NativeCapturePermissions | null>('desktop_capture_permissions_watch', {
            subscriptionRef, consumed: true,
        });
        if (snapshot && !retired) handler(snapshot);
    } catch (error) {
        retire();
        // The native watch may already be admitted when a presenter rejects its
        // initial result. Release that same demand before propagating failure.
        throw error;
    }
    return retire;
}
export function subscribeNativeCapture(handler: (state: NativeCaptureSnapshot) => void): Promise<() => void> {
    requireTauri();
    return listenDesktopHostEvent('desktopCapture://state', handler);
}

export type NativeCaptureBindingKey = 'captureShortcut' | 'instantWindowShortcut' | 'recordingShortcut';
export type NativeCapturePreferenceKey = NativeCaptureBindingKey | 'libraryFolder';
export type NativeCaptureShortcutSnapshot = Readonly<{
    backend: 'native' | 'portal';
    availability: 'pending' | 'ready' | 'unavailable' | 'closed';
    configureSupported: boolean;
    editing: boolean;
    bindings: readonly Readonly<{ key: NativeCaptureBindingKey; requested: string | null; active: string | null;
        failure: 'invalid' | 'conflict' | 'unavailable' | 'desktop_settings_required' | null }>[];
}>;
/** This reads the native record, including an unset library override; it resolves no folders. */
export const readNativeCapturePreference = (key: NativeCapturePreferenceKey): Promise<string | null> =>
    invoke('desktop_capture_preference', { key });
export const readNativeCaptureShortcuts = (): Promise<NativeCaptureShortcutSnapshot> => invoke('desktop_capture_shortcuts');
export const setNativeCaptureShortcut = (key: NativeCaptureBindingKey, binding: string | null): Promise<NativeCaptureShortcutSnapshot> =>
    invoke('desktop_capture_set_shortcut', { key, binding });
export const setNativeCaptureShortcutEditing = (editing: boolean): Promise<void> =>
    invoke('desktop_capture_shortcut_editing', { editing });
export const configureNativeCaptureShortcuts = (): Promise<NativeCaptureShortcutSnapshot> => invoke('desktop_capture_configure_shortcuts');
export function subscribeNativeCapturePreference(key: NativeCapturePreferenceKey, handler: (value: string | null) => void): Promise<() => void> {
    requireTauri();
    return listenDesktopHostEvent(`desktopCapture://preference/${key}`, handler);
}
export function subscribeNativeCaptureShortcuts(handler: (snapshot: NativeCaptureShortcutSnapshot) => void): Promise<() => void> {
    requireTauri();
    return listenDesktopHostEvent('desktopCapture://shortcuts', handler);
}

/** One-shot Action read. It retains no filesystem watcher. */
export const listRecentCaptures = (): Promise<NativeRecentCapturesSnapshot> => invoke('desktop_capture_recent_list');
export const chooseRecentCaptureFile = (): Promise<Readonly<{ path: string; folder: string }> | null> => invoke('desktop_capture_recent_choose_file');
/** Subscribe before opening; close when the picker leaves the screen. */
export const openRecentCaptures = (input: { folder?: string } = {}): Promise<NativeRecentCapturesSnapshot> =>
    invoke('desktop_capture_recent_open', { selectedFolder: input.folder ?? null });
export const refreshRecentCaptures = (): Promise<NativeRecentCapturesSnapshot> => invoke('desktop_capture_recent_refresh');
export const closeRecentCaptures = (): Promise<void> => invoke('desktop_capture_recent_close');
export const openRecentCapture = (path: string): Promise<NativeCaptureResult> => invoke('desktop_capture_recent_open_media', { path });
/** A visible tile's bytes; native refuses anything the recents don't list. */
export const readRecentCapture = async (path: string): Promise<Uint8Array> =>
    new Uint8Array(await invoke<ArrayBuffer>('desktop_capture_recent_read', { path }));
export function subscribeRecentCaptures(handler: (changes: NativeRecentCaptureChanges) => void): Promise<() => void> {
    requireTauri();
    return listenDesktopHostEvent('desktopCapture://recents', handler);
}
