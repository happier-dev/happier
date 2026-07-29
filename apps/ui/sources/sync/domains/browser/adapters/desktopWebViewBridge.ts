import { readCanonicalPaddedBase64DecodedLength } from '@happier-dev/protocol';

import { invokeTauri, isTauriDesktop } from '@/utils/platform/tauri';

import {
    desktopWebViewAvailabilitySupportsBrowsing,
    normalizeDesktopWebViewNativeAvailability,
    unavailableDesktopWebViewNativeAvailability,
    type DesktopWebViewNativeAvailability,
} from './desktopWebView';

export const DESKTOP_BROWSER_GET_AVAILABILITY_COMMAND = 'desktop_browser_get_availability';
export const DESKTOP_BROWSER_OPEN_VIEW_COMMAND = 'desktop_browser_open_view';
export const DESKTOP_BROWSER_NAVIGATE_COMMAND = 'desktop_browser_navigate';
export const DESKTOP_BROWSER_SET_BOUNDS_COMMAND = 'desktop_browser_set_bounds';
export const DESKTOP_BROWSER_SET_POINTER_PASSTHROUGH_COMMAND = 'desktop_browser_set_pointer_passthrough';
export const DESKTOP_BROWSER_CLOSE_VIEW_COMMAND = 'desktop_browser_close_view';
export const DESKTOP_BROWSER_OPEN_DEVTOOLS_COMMAND = 'desktop_browser_open_devtools';
export const DESKTOP_BROWSER_GET_PAGE_INFO_COMMAND = 'desktop_browser_get_page_info';
export const DESKTOP_BROWSER_CAPTURE_SNAPSHOT_COMMAND = 'desktop_browser_capture_snapshot';
export const DESKTOP_BROWSER_CAPTURE_RECORDING_FRAME_COMMAND = 'desktop_browser_capture_recording_frame';
export const DESKTOP_BROWSER_DRAIN_DIAGNOSTICS_COMMAND = 'desktop_browser_drain_diagnostics';
export const DESKTOP_BROWSER_EVAL_SCRIPT_COMMAND = 'desktop_browser_eval_script';
export const DESKTOP_BROWSER_DISPATCH_NAVIGATION_COMMAND = 'desktop_browser_dispatch_navigation';

export type DesktopBrowserOpenViewRequest = Readonly<{
    browserSessionId: string;
    viewId: string;
    profileId: string;
    url: string;
    /**
     * Canonical injected browser-diagnostics collector script. When provided, the native host runs
     * it as a document-start initialization script and attaches a Wry `ipc_handler` that buffers the
     * collector's `window.ipc.postMessage` envelopes for `drainDesktopBrowserDiagnostics`. This is
     * how the desktop engine gets full in-page console/network/resource diagnostics (no CDP needed).
     */
    diagnosticsInitScript?: string;
}>;

export type DesktopBrowserViewCommandRequest = Readonly<{
    browserSessionId: string;
    viewId: string;
    url?: string;
}>;

export type DesktopBrowserEvalScriptRequest = Readonly<{
    browserSessionId: string;
    viewId: string;
    /** A canonical injected diagnostics COMMAND script (eval/getProperties/release/element-picker). */
    script: string;
}>;

/**
 * Trusted reload/stop navigation dispatch. The Rust command DERIVES the injected script from `kind`,
 * so `script` is advisory only (the native seam never evaluates a caller-provided string). Routed
 * through the canonical `invokeDesktopBrowserCommand` normalizer so the real
 * `DesktopBrowserCommandResult` (availability + disabledReasons) is surfaced — never a blanket
 * ok:true that masks a native command failure.
 */
export type DesktopBrowserNavigationDispatchPayload = Readonly<{
    browserSessionId: string;
    viewId: string;
    kind: 'reload' | 'stop';
    script: string;
}>;

export type DesktopBrowserBoundsRect = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
    scaleFactor: number;
}>;

export type DesktopBrowserBoundsPayload = Readonly<{
    browserSessionId: string;
    viewId: string;
    visible: boolean;
    rect: DesktopBrowserBoundsRect;
}>;

export type DesktopBrowserPointerPassthroughPayload = Readonly<{
    browserSessionId: string;
    viewId: string;
    ignore: boolean;
}>;

export type DesktopBrowserCommandResult = Readonly<{
    ok: boolean;
    availability: DesktopWebViewNativeAvailability;
}>;

export type DesktopBrowserViewLoadingState = 'idle' | 'loading' | 'finished' | 'failed' | 'crashed';

export type DesktopBrowserPageNavigationIssue = Readonly<{
    url: string;
    reason: string;
}>;

export type DesktopBrowserPageInfo = Readonly<{
    browserSessionId: string;
    viewId: string;
    requestedUrl: string;
    currentUrl?: string;
    title?: string;
    loadingState: DesktopBrowserViewLoadingState;
    lastError?: DesktopBrowserPageNavigationIssue;
    lastRejectedNavigation?: DesktopBrowserPageNavigationIssue;
}>;

export type DesktopBrowserPageInfoResult = Readonly<{
    ok: boolean;
    availability: DesktopWebViewNativeAvailability;
    pageInfo?: DesktopBrowserPageInfo;
}>;

export type DesktopBrowserDrainDiagnosticsResult = Readonly<{
    ok: boolean;
    availability: DesktopWebViewNativeAvailability;
    /** Raw collector envelopes the injected page posted via `window.ipc.postMessage` (each is a JSON batch). */
    messages: readonly string[];
}>;

export type DesktopBrowserCaptureErrorCode =
    | 'captureUnsupported'
    | 'viewUnavailable'
    | 'staleNavigation'
    | 'captureFailed';

/**
 * ANNO-3 crop clip in **device pixels** of the captured surface's own space — the union-of-targets
 * rect the in-app annotation editor resolves via the canonical `resolveAnnotationCropClip`
 * (`devicePageRect`). DPR conversion happens here (UI side); the native seam clamps to the buffer
 * bounds and crops. Absent ⇒ full-frame capture (unchanged behavior).
 */
export type DesktopBrowserCaptureClipRect = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>;

export type DesktopBrowserCaptureSnapshotRequest = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    captureRequestId: string;
    /** ANNO-3 union-of-targets crop (device px). Absent ⇒ full-frame capture. */
    clip?: DesktopBrowserCaptureClipRect;
}>;

export type DesktopBrowserCapturedSnapshot = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    captureRequestId: string;
    capturedAtMs: number;
    mimeType: 'image/png';
    width: number;
    height: number;
    sizeBytes: number;
    bytesBase64: string;
}>;

export type DesktopBrowserCaptureSnapshotResult = Readonly<{
    ok: boolean;
    availability: DesktopWebViewNativeAvailability;
    snapshot?: DesktopBrowserCapturedSnapshot;
    errorCode?: DesktopBrowserCaptureErrorCode;
}>;

/**
 * Recording-frame capture (BA-4 `nativeViewCapture` producer) extends the snapshot error set with the
 * reference-only write/cap failures the native side can report (`captureTooLarge`, `captureWriteFailed`).
 */
export type DesktopBrowserRecordingFrameErrorCode =
    | DesktopBrowserCaptureErrorCode
    | 'captureTooLarge'
    | 'captureWriteFailed';

/**
 * Reference-only recording-frame capture request. Unlike a snapshot (inline base64 for an interactive
 * screenshot), the recording-frame command writes the PNG to the daemon-owned `outputPath` and enforces
 * the daemon-negotiated `maxBytes` cap — the pixel bytes never cross back over IPC.
 */
export type DesktopBrowserCaptureRecordingFrameRequest = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    captureRequestId: string;
    outputPath: string;
    maxBytes: number;
}>;

export type DesktopBrowserCapturedRecordingFrame = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    captureRequestId: string;
    capturedAtMs: number;
    mimeType: 'image/png';
    width: number;
    height: number;
    sizeBytes: number;
    /** Local filesystem path the native side wrote the captured PNG to (reference-only). */
    path: string;
}>;

export type DesktopBrowserCaptureRecordingFrameResult = Readonly<{
    ok: boolean;
    availability: DesktopWebViewNativeAvailability;
    frame?: DesktopBrowserCapturedRecordingFrame;
    errorCode?: DesktopBrowserRecordingFrameErrorCode;
}>;

function unavailableDesktopBrowserCommandResult(
    reason: Parameters<typeof unavailableDesktopWebViewNativeAvailability>[0],
): DesktopBrowserCommandResult {
    return {
        ok: false,
        availability: unavailableDesktopWebViewNativeAvailability(reason),
    };
}

function normalizeDesktopBrowserCommandResult(payload: unknown): DesktopBrowserCommandResult {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return unavailableDesktopBrowserCommandResult('desktop_webview_native_contract_invalid');
    }

    const record = payload as Readonly<Record<string, unknown>>;
    const availability = normalizeDesktopWebViewNativeAvailability(record.availability);
    if (record.ok !== true) {
        return {
            ok: false,
            availability,
        };
    }

    if (!desktopWebViewAvailabilitySupportsBrowsing(availability)) {
        return unavailableDesktopBrowserCommandResult('desktop_webview_native_contract_invalid');
    }

    return {
        ok: true,
        availability,
    };
}

const DESKTOP_BROWSER_LOADING_STATES = new Set<string>(['idle', 'loading', 'finished', 'failed', 'crashed']);
const DESKTOP_BROWSER_CAPTURE_ERROR_CODES = new Set<string>([
    'captureUnsupported',
    'viewUnavailable',
    'staleNavigation',
    'captureFailed',
]);

const DESKTOP_BROWSER_RECORDING_FRAME_ERROR_CODES = new Set<string>([
    'captureUnsupported',
    'viewUnavailable',
    'staleNavigation',
    'captureFailed',
    'captureTooLarge',
    'captureWriteFailed',
]);

type NormalizedDesktopBrowserCapturedSnapshot =
    | Readonly<{ ok: true; snapshot: DesktopBrowserCapturedSnapshot }>
    | Readonly<{ ok: false; errorCode: DesktopBrowserCaptureErrorCode }>;

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
}

function readOptionalString(value: unknown): string | undefined {
    if (value == null) {
        return undefined;
    }
    return readString(value) ?? undefined;
}

function readNonNegativeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value
        : null;
}

function readPositiveInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? value
        : null;
}

function readCanonicalRawBase64DecodedLength(value: string): number | null {
    const decodedLength = readCanonicalPaddedBase64DecodedLength(value);
    return decodedLength != null && decodedLength > 0
        ? decodedLength
        : null;
}

function normalizePageNavigationIssue(payload: unknown): DesktopBrowserPageNavigationIssue | undefined {
    if (payload == null) {
        return undefined;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return undefined;
    }
    const record = payload as Readonly<Record<string, unknown>>;
    const url = readString(record.url);
    const reason = readString(record.reason);
    return url && reason
        ? { url, reason }
        : undefined;
}

function normalizeDesktopBrowserPageInfo(payload: unknown): DesktopBrowserPageInfo | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null;
    }

    const record = payload as Readonly<Record<string, unknown>>;
    const browserSessionId = readString(record.browserSessionId);
    const viewId = readString(record.viewId);
    const requestedUrl = readString(record.requestedUrl);
    const loadingState = readString(record.loadingState);
    if (!browserSessionId || !viewId || !requestedUrl || !loadingState || !DESKTOP_BROWSER_LOADING_STATES.has(loadingState)) {
        return null;
    }

    return {
        browserSessionId,
        viewId,
        requestedUrl,
        currentUrl: readOptionalString(record.currentUrl),
        title: readOptionalString(record.title),
        loadingState: loadingState as DesktopBrowserViewLoadingState,
        lastError: normalizePageNavigationIssue(record.lastError),
        lastRejectedNavigation: normalizePageNavigationIssue(record.lastRejectedNavigation),
    };
}

function normalizeDesktopBrowserPageInfoResult(payload: unknown): DesktopBrowserPageInfoResult {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return unavailableDesktopBrowserPageInfoResult('desktop_webview_native_contract_invalid');
    }

    const record = payload as Readonly<Record<string, unknown>>;
    const availability = normalizeDesktopWebViewNativeAvailability(record.availability);
    if (record.ok !== true) {
        return {
            ok: false,
            availability,
        };
    }

    if (
        !desktopWebViewAvailabilitySupportsBrowsing(availability)
        || availability.supports.pageInfoDiagnostics !== true
    ) {
        return unavailableDesktopBrowserPageInfoResult('desktop_webview_native_contract_invalid');
    }

    const pageInfo = normalizeDesktopBrowserPageInfo(record.pageInfo);
    if (!pageInfo) {
        return unavailableDesktopBrowserPageInfoResult('desktop_webview_native_contract_invalid');
    }

    return {
        ok: true,
        availability,
        pageInfo,
    };
}

function readCaptureErrorCode(value: unknown): DesktopBrowserCaptureErrorCode | null {
    const code = readString(value);
    return code && DESKTOP_BROWSER_CAPTURE_ERROR_CODES.has(code)
        ? code as DesktopBrowserCaptureErrorCode
        : null;
}

function normalizeDesktopBrowserCapturedSnapshot(
    payload: unknown,
    request: DesktopBrowserCaptureSnapshotRequest,
): NormalizedDesktopBrowserCapturedSnapshot {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { ok: false, errorCode: 'captureFailed' };
    }

    const record = payload as Readonly<Record<string, unknown>>;
    const browserSessionId = readString(record.browserSessionId);
    const viewId = readString(record.viewId);
    const navigationGeneration = readNonNegativeInteger(record.navigationGeneration);
    const captureRequestId = readString(record.captureRequestId);
    const capturedAtMs = readNonNegativeInteger(record.capturedAtMs);
    const width = readPositiveInteger(record.width);
    const height = readPositiveInteger(record.height);
    const sizeBytes = readPositiveInteger(record.sizeBytes);
    const bytesBase64 = readString(record.bytesBase64);
    const decodedSizeBytes = bytesBase64
        ? readCanonicalRawBase64DecodedLength(bytesBase64)
        : null;

    if (
        browserSessionId !== request.browserSessionId
        || viewId !== request.viewId
        || navigationGeneration !== request.navigationGeneration
        || captureRequestId !== request.captureRequestId
    ) {
        return { ok: false, errorCode: 'staleNavigation' };
    }

    if (
        capturedAtMs == null
        || record.mimeType !== 'image/png'
        || width == null
        || height == null
        || sizeBytes == null
        || !bytesBase64
        || decodedSizeBytes !== sizeBytes
    ) {
        return { ok: false, errorCode: 'captureFailed' };
    }

    return {
        ok: true,
        snapshot: {
            browserSessionId,
            viewId,
            navigationGeneration,
            captureRequestId,
            capturedAtMs,
            mimeType: 'image/png',
            width,
            height,
            sizeBytes,
            bytesBase64,
        },
    };
}

function normalizeDesktopBrowserCaptureSnapshotResult(
    payload: unknown,
    request: DesktopBrowserCaptureSnapshotRequest,
): DesktopBrowserCaptureSnapshotResult {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return unavailableDesktopBrowserCaptureSnapshotResult(
            'desktop_webview_native_contract_invalid',
            'captureFailed',
        );
    }

    const record = payload as Readonly<Record<string, unknown>>;
    const availability = normalizeDesktopWebViewNativeAvailability(record.availability);
    if (record.ok !== true) {
        return {
            ok: false,
            availability,
            errorCode: readCaptureErrorCode(record.errorCode) ?? 'captureFailed',
        };
    }

    if (
        !desktopWebViewAvailabilitySupportsBrowsing(availability)
        || availability.supports.capture !== true
    ) {
        return unavailableDesktopBrowserCaptureSnapshotResult(
            'desktop_webview_native_contract_invalid',
            'captureUnsupported',
        );
    }

    const snapshot = normalizeDesktopBrowserCapturedSnapshot(record.snapshot, request);
    if (!snapshot.ok) {
        return unavailableDesktopBrowserCaptureSnapshotResultForAvailability(availability, snapshot.errorCode);
    }

    return {
        ok: true,
        availability,
        snapshot: snapshot.snapshot,
    };
}

function unavailableDesktopBrowserPageInfoResult(
    reason: Parameters<typeof unavailableDesktopWebViewNativeAvailability>[0],
): DesktopBrowserPageInfoResult {
    return {
        ok: false,
        availability: unavailableDesktopWebViewNativeAvailability(reason),
    };
}

function unavailableDesktopBrowserCaptureSnapshotResult(
    reason: Parameters<typeof unavailableDesktopWebViewNativeAvailability>[0],
    errorCode: DesktopBrowserCaptureErrorCode,
): DesktopBrowserCaptureSnapshotResult {
    return {
        ok: false,
        availability: unavailableDesktopWebViewNativeAvailability(reason),
        errorCode,
    };
}

function unavailableDesktopBrowserCaptureSnapshotResultForAvailability(
    availability: DesktopWebViewNativeAvailability,
    errorCode: DesktopBrowserCaptureErrorCode,
): DesktopBrowserCaptureSnapshotResult {
    return {
        ok: false,
        availability,
        errorCode,
    };
}

export async function readDesktopWebViewNativeAvailability(): Promise<DesktopWebViewNativeAvailability> {
    if (!isTauriDesktop()) {
        return unavailableDesktopWebViewNativeAvailability('tauri_host_unavailable');
    }

    try {
        const payload = await invokeTauri<unknown>(DESKTOP_BROWSER_GET_AVAILABILITY_COMMAND);
        return normalizeDesktopWebViewNativeAvailability(payload);
    } catch {
        return unavailableDesktopWebViewNativeAvailability('desktop_webview_native_command_unavailable');
    }
}

async function invokeDesktopBrowserCommand(
    command: string,
    request:
        | DesktopBrowserOpenViewRequest
        | DesktopBrowserViewCommandRequest
        | DesktopBrowserEvalScriptRequest
        | DesktopBrowserNavigationDispatchPayload
        | DesktopBrowserBoundsPayload
        | DesktopBrowserPointerPassthroughPayload,
): Promise<DesktopBrowserCommandResult> {
    if (!isTauriDesktop()) {
        return unavailableDesktopBrowserCommandResult('tauri_host_unavailable');
    }

    try {
        const payload = await invokeTauri<unknown>(command, { request });
        return normalizeDesktopBrowserCommandResult(payload);
    } catch {
        return unavailableDesktopBrowserCommandResult('desktop_webview_native_command_unavailable');
    }
}

export function openDesktopBrowserView(
    request: DesktopBrowserOpenViewRequest,
): Promise<DesktopBrowserCommandResult> {
    return invokeDesktopBrowserCommand(DESKTOP_BROWSER_OPEN_VIEW_COMMAND, request);
}

export function navigateDesktopBrowserView(
    request: Required<DesktopBrowserViewCommandRequest>,
): Promise<DesktopBrowserCommandResult> {
    return invokeDesktopBrowserCommand(DESKTOP_BROWSER_NAVIGATE_COMMAND, request);
}

export function dispatchDesktopBrowserNavigation(
    request: DesktopBrowserNavigationDispatchPayload,
): Promise<DesktopBrowserCommandResult> {
    return invokeDesktopBrowserCommand(DESKTOP_BROWSER_DISPATCH_NAVIGATION_COMMAND, request);
}

export function setDesktopBrowserViewBounds(
    request: DesktopBrowserBoundsPayload,
): Promise<DesktopBrowserCommandResult> {
    return invokeDesktopBrowserCommand(DESKTOP_BROWSER_SET_BOUNDS_COMMAND, request);
}

export function setDesktopBrowserPointerPassthrough(
    request: DesktopBrowserPointerPassthroughPayload,
): Promise<DesktopBrowserCommandResult> {
    return invokeDesktopBrowserCommand(DESKTOP_BROWSER_SET_POINTER_PASSTHROUGH_COMMAND, request);
}

export function closeDesktopBrowserView(
    request: Omit<DesktopBrowserViewCommandRequest, 'url'>,
): Promise<DesktopBrowserCommandResult> {
    return invokeDesktopBrowserCommand(DESKTOP_BROWSER_CLOSE_VIEW_COMMAND, request);
}

export function openDesktopBrowserDevtools(
    request: Omit<DesktopBrowserViewCommandRequest, 'url'>,
): Promise<DesktopBrowserCommandResult> {
    return invokeDesktopBrowserCommand(DESKTOP_BROWSER_OPEN_DEVTOOLS_COMMAND, request);
}

export function evalDesktopBrowserScript(
    request: DesktopBrowserEvalScriptRequest,
): Promise<DesktopBrowserCommandResult> {
    return invokeDesktopBrowserCommand(DESKTOP_BROWSER_EVAL_SCRIPT_COMMAND, request);
}

export async function readDesktopBrowserPageInfo(
    request: Omit<DesktopBrowserViewCommandRequest, 'url'>,
): Promise<DesktopBrowserPageInfoResult> {
    if (!isTauriDesktop()) {
        return unavailableDesktopBrowserPageInfoResult('tauri_host_unavailable');
    }

    try {
        const payload = await invokeTauri<unknown>(DESKTOP_BROWSER_GET_PAGE_INFO_COMMAND, { request });
        return normalizeDesktopBrowserPageInfoResult(payload);
    } catch {
        return unavailableDesktopBrowserPageInfoResult('desktop_webview_native_command_unavailable');
    }
}

function unavailableDesktopBrowserDrainDiagnosticsResult(
    reason: Parameters<typeof unavailableDesktopWebViewNativeAvailability>[0],
): DesktopBrowserDrainDiagnosticsResult {
    return {
        ok: false,
        availability: unavailableDesktopWebViewNativeAvailability(reason),
        messages: [],
    };
}

function normalizeDesktopBrowserDrainDiagnosticsResult(payload: unknown): DesktopBrowserDrainDiagnosticsResult {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return unavailableDesktopBrowserDrainDiagnosticsResult('desktop_webview_native_contract_invalid');
    }
    const record = payload as Record<string, unknown>;
    const availability = normalizeDesktopWebViewNativeAvailability(record.availability);
    const rawMessages = Array.isArray(record.messages) ? record.messages : [];
    const messages = rawMessages.filter((message): message is string => typeof message === 'string');
    return {
        ok: record.ok === true,
        availability,
        messages,
    };
}

export async function drainDesktopBrowserDiagnostics(
    request: Omit<DesktopBrowserViewCommandRequest, 'url'>,
): Promise<DesktopBrowserDrainDiagnosticsResult> {
    if (!isTauriDesktop()) {
        return unavailableDesktopBrowserDrainDiagnosticsResult('tauri_host_unavailable');
    }

    try {
        const payload = await invokeTauri<unknown>(DESKTOP_BROWSER_DRAIN_DIAGNOSTICS_COMMAND, { request });
        return normalizeDesktopBrowserDrainDiagnosticsResult(payload);
    } catch {
        return unavailableDesktopBrowserDrainDiagnosticsResult('desktop_webview_native_command_unavailable');
    }
}

/**
 * Integer-normalizes a device-pixel clip for the native command (the Rust `clip` is `u32`): the
 * origin is floored and the extent ceiled so the marked union is fully covered, then dropped if the
 * area is non-positive (native clamps to the real buffer bounds). Keeps a fractional Retina/zoom clip
 * from failing serde deserialization.
 */
function normalizeCaptureClip(
    clip: DesktopBrowserCaptureClipRect | undefined,
): DesktopBrowserCaptureClipRect | undefined {
    if (!clip) return undefined;
    const x = Math.max(0, Math.floor(clip.x));
    const y = Math.max(0, Math.floor(clip.y));
    const width = Math.ceil(clip.width);
    const height = Math.ceil(clip.height);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(width > 0) || !(height > 0)) {
        return undefined;
    }
    return { x, y, width, height };
}

export async function captureDesktopBrowserSnapshot(
    request: DesktopBrowserCaptureSnapshotRequest,
): Promise<DesktopBrowserCaptureSnapshotResult> {
    if (!isTauriDesktop()) {
        return unavailableDesktopBrowserCaptureSnapshotResult('tauri_host_unavailable', 'captureUnsupported');
    }

    const clip = normalizeCaptureClip(request.clip);
    const nativeRequest: DesktopBrowserCaptureSnapshotRequest = {
        browserSessionId: request.browserSessionId,
        viewId: request.viewId,
        navigationGeneration: request.navigationGeneration,
        captureRequestId: request.captureRequestId,
        ...(clip ? { clip } : {}),
    };

    try {
        const payload = await invokeTauri<unknown>(DESKTOP_BROWSER_CAPTURE_SNAPSHOT_COMMAND, { request: nativeRequest });
        return normalizeDesktopBrowserCaptureSnapshotResult(payload, nativeRequest);
    } catch {
        return unavailableDesktopBrowserCaptureSnapshotResult(
            'desktop_webview_native_command_unavailable',
            'captureUnsupported',
        );
    }
}

function readRecordingFrameErrorCode(value: unknown): DesktopBrowserRecordingFrameErrorCode | null {
    const code = readString(value);
    return code && DESKTOP_BROWSER_RECORDING_FRAME_ERROR_CODES.has(code)
        ? code as DesktopBrowserRecordingFrameErrorCode
        : null;
}

function unavailableDesktopBrowserCaptureRecordingFrameResult(
    reason: Parameters<typeof unavailableDesktopWebViewNativeAvailability>[0],
    errorCode: DesktopBrowserRecordingFrameErrorCode,
): DesktopBrowserCaptureRecordingFrameResult {
    return {
        ok: false,
        availability: unavailableDesktopWebViewNativeAvailability(reason),
        errorCode,
    };
}

function unavailableDesktopBrowserCaptureRecordingFrameResultForAvailability(
    availability: DesktopWebViewNativeAvailability,
    errorCode: DesktopBrowserRecordingFrameErrorCode,
): DesktopBrowserCaptureRecordingFrameResult {
    return {
        ok: false,
        availability,
        errorCode,
    };
}

function normalizeDesktopBrowserCapturedRecordingFrame(
    payload: unknown,
    request: DesktopBrowserCaptureRecordingFrameRequest,
): DesktopBrowserCapturedRecordingFrame | { errorCode: DesktopBrowserRecordingFrameErrorCode } {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { errorCode: 'captureFailed' };
    }

    const record = payload as Readonly<Record<string, unknown>>;
    const browserSessionId = readString(record.browserSessionId);
    const viewId = readString(record.viewId);
    const navigationGeneration = readNonNegativeInteger(record.navigationGeneration);
    const captureRequestId = readString(record.captureRequestId);
    const capturedAtMs = readNonNegativeInteger(record.capturedAtMs);
    const width = readPositiveInteger(record.width);
    const height = readPositiveInteger(record.height);
    const sizeBytes = readPositiveInteger(record.sizeBytes);
    const path = readString(record.path);

    if (
        browserSessionId !== request.browserSessionId
        || viewId !== request.viewId
        || navigationGeneration !== request.navigationGeneration
        || captureRequestId !== request.captureRequestId
    ) {
        return { errorCode: 'staleNavigation' };
    }

    if (
        capturedAtMs == null
        || record.mimeType !== 'image/png'
        || width == null
        || height == null
        || sizeBytes == null
        || !path
    ) {
        return { errorCode: 'captureFailed' };
    }

    // Reference-only + bounded: the native side must honor the daemon byte cap; reject an over-cap
    // frame even if it somehow returned ok (defense-in-depth alongside the native + daemon bounds).
    if (sizeBytes > request.maxBytes) {
        return { errorCode: 'captureTooLarge' };
    }

    return {
        browserSessionId,
        viewId,
        navigationGeneration,
        captureRequestId,
        capturedAtMs,
        mimeType: 'image/png',
        width,
        height,
        sizeBytes,
        path,
    };
}

function normalizeDesktopBrowserCaptureRecordingFrameResult(
    payload: unknown,
    request: DesktopBrowserCaptureRecordingFrameRequest,
): DesktopBrowserCaptureRecordingFrameResult {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return unavailableDesktopBrowserCaptureRecordingFrameResult(
            'desktop_webview_native_contract_invalid',
            'captureFailed',
        );
    }

    const record = payload as Readonly<Record<string, unknown>>;
    const availability = normalizeDesktopWebViewNativeAvailability(record.availability);
    if (record.ok !== true) {
        return {
            ok: false,
            availability,
            errorCode: readRecordingFrameErrorCode(record.errorCode) ?? 'captureFailed',
        };
    }

    if (
        !desktopWebViewAvailabilitySupportsBrowsing(availability)
        || availability.supports.capture !== true
    ) {
        return unavailableDesktopBrowserCaptureRecordingFrameResult(
            'desktop_webview_native_contract_invalid',
            'captureUnsupported',
        );
    }

    const frame = normalizeDesktopBrowserCapturedRecordingFrame(record.frame, request);
    if ('errorCode' in frame) {
        return unavailableDesktopBrowserCaptureRecordingFrameResultForAvailability(availability, frame.errorCode);
    }

    return {
        ok: true,
        availability,
        frame,
    };
}

/**
 * Reference-only recording-frame capture over the canonical desktop invoke path (BA-4 `nativeViewCapture`
 * producer). The native `desktop_browser_capture_recording_frame` command writes the captured PNG to the
 * daemon-provided `outputPath`, enforcing the daemon's `maxBytes` cap, and returns ONLY a path + metadata.
 * This is the UI half of the daemon→native (Wry) capture IPC; the daemon owns the path + cap and the
 * resulting session-media artifact.
 */
export async function captureDesktopBrowserRecordingFrame(
    request: DesktopBrowserCaptureRecordingFrameRequest,
): Promise<DesktopBrowserCaptureRecordingFrameResult> {
    if (!isTauriDesktop()) {
        return unavailableDesktopBrowserCaptureRecordingFrameResult('tauri_host_unavailable', 'captureUnsupported');
    }

    try {
        const payload = await invokeTauri<unknown>(DESKTOP_BROWSER_CAPTURE_RECORDING_FRAME_COMMAND, { request });
        return normalizeDesktopBrowserCaptureRecordingFrameResult(payload, request);
    } catch {
        return unavailableDesktopBrowserCaptureRecordingFrameResult(
            'desktop_webview_native_command_unavailable',
            'captureUnsupported',
        );
    }
}
