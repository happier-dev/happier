use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum DesktopBrowserPlatform {
    #[serde(rename = "macos")]
    MacOs,
    #[serde(rename = "windows")]
    Windows,
    #[serde(rename = "linuxX11")]
    LinuxX11,
    #[serde(rename = "linuxWayland")]
    LinuxWayland,
    #[serde(rename = "linuxUnknown")]
    LinuxUnknown,
    #[serde(rename = "unsupported")]
    Unsupported,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum DesktopBrowserPrimitive {
    #[serde(rename = "macosNsViewWebKit")]
    MacOsNsViewWebKit,
    #[serde(rename = "windowsHwndWebView2")]
    WindowsHwndWebView2,
    #[serde(rename = "linuxX11ChildEmbedding")]
    LinuxX11ChildEmbedding,
    #[serde(rename = "linuxWaylandGtkEmbedding")]
    LinuxWaylandGtkEmbedding,
    #[serde(rename = "disabled")]
    Disabled,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum DesktopBrowserRenderEngine {
    #[serde(rename = "desktopWebView")]
    DesktopWebView,
    #[serde(rename = "unavailable")]
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum DesktopBrowserProducer {
    #[serde(rename = "tauriWryNativeChildView")]
    TauriWryNativeChildView,
    #[serde(rename = "none")]
    None,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum DesktopBrowserDisabledReason {
    #[serde(rename = "desktop_webview_child_view_unimplemented")]
    NativeChildViewUnimplemented,
    /// X11 child-embedding is spec-permitted by Wry but unproven for our Tauri-window child handle
    /// and has no recorded manual-QA evidence. Until that verification lands (see the BRW-12 spike
    /// docs) X11 stays honestly unavailable with this reason rather than over-claiming `available`.
    #[serde(rename = "desktop_webview_x11_child_unimplemented")]
    LinuxX11ChildEmbeddingUnimplemented,
    #[serde(rename = "desktop_webview_wayland_gtk_unimplemented")]
    LinuxWaylandGtkEmbeddingUnimplemented,
    #[serde(rename = "desktop_webview_linux_display_unavailable")]
    LinuxDisplayUnavailable,
    #[serde(rename = "desktop_webview_unsupported_platform")]
    UnsupportedPlatform,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserSupport {
    pub navigation: bool,
    pub go_back_forward: bool,
    pub reload: bool,
    pub stop: bool,
    pub page_info_diagnostics: bool,
    pub native_devtools: bool,
    pub capture: bool,
    pub recording: bool,
    pub automation: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserAvailability {
    pub available: bool,
    pub platform: DesktopBrowserPlatform,
    pub primitive: DesktopBrowserPrimitive,
    pub render_engine: DesktopBrowserRenderEngine,
    pub producer: DesktopBrowserProducer,
    pub privileged_ipc: bool,
    pub supports: DesktopBrowserSupport,
    pub disabled_reasons: Vec<DesktopBrowserDisabledReason>,
}

impl DesktopBrowserAvailability {
    pub(crate) fn available(
        platform: DesktopBrowserPlatform,
        primitive: DesktopBrowserPrimitive,
        supports: DesktopBrowserSupport,
    ) -> Self {
        Self {
            available: true,
            platform,
            primitive,
            render_engine: DesktopBrowserRenderEngine::DesktopWebView,
            producer: DesktopBrowserProducer::TauriWryNativeChildView,
            privileged_ipc: false,
            supports,
            disabled_reasons: Vec::new(),
        }
    }

    pub(crate) fn unavailable(
        platform: DesktopBrowserPlatform,
        primitive: DesktopBrowserPrimitive,
        reason: DesktopBrowserDisabledReason,
    ) -> Self {
        Self {
            available: false,
            platform,
            primitive,
            render_engine: DesktopBrowserRenderEngine::Unavailable,
            producer: DesktopBrowserProducer::None,
            privileged_ipc: false,
            supports: DesktopBrowserSupport::default(),
            disabled_reasons: vec![reason],
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserOpenViewRequest {
    pub browser_session_id: String,
    pub view_id: String,
    pub profile_id: String,
    pub url: String,
    /// Optional document-start init script that wires the page's injected devtools to the native
    /// IPC channel (`window.ipc.postMessage(...)`). When present and non-empty the native view is
    /// built with this script and an IPC handler that buffers the posted batch envelopes for
    /// `desktop_browser_drain_diagnostics`. When absent/empty the view is built exactly as before
    /// (no init script, no IPC handler) for parity with the non-diagnostics path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics_init_script: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserViewCommandRequest {
    pub browser_session_id: String,
    pub view_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Request for `desktop_browser_eval_script`. Dedicated (not the optional-`url`
/// `DesktopBrowserViewCommandRequest`) so the required `script` field is never overloaded onto an
/// unrelated optional. The script is pushed into the Wry child webview fire-and-forget; any result
/// the page wants to return travels back out-of-band via `window.ipc.postMessage(...)` and is
/// surfaced by `desktop_browser_drain_diagnostics`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserEvalScriptRequest {
    pub browser_session_id: String,
    pub view_id: String,
    pub script: String,
}

/// Trusted navigation-control kind for `desktop_browser_dispatch_navigation`. The injected script
/// is DERIVED from this kind in the command (never taken from the caller), so this seam can only
/// ever issue `location.reload()` / `window.stop()` and can never become an arbitrary-eval surface.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DesktopBrowserNavigationDispatchKind {
    Reload,
    Stop,
}

/// Request for `desktop_browser_dispatch_navigation`. The optional `script` the UI sends is
/// intentionally NOT modeled here (serde ignores it): the Rust side derives the script from `kind`
/// so the command is a fixed, trusted reload/stop seam rather than a user-eval channel.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserDispatchNavigationRequest {
    pub browser_session_id: String,
    pub view_id: String,
    pub kind: DesktopBrowserNavigationDispatchKind,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserBoundsRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserBoundsPayload {
    pub browser_session_id: String,
    pub view_id: String,
    pub visible: bool,
    pub rect: DesktopBrowserBoundsRect,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserPointerPassthroughPayload {
    pub browser_session_id: String,
    pub view_id: String,
    pub ignore: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum DesktopBrowserViewLoadingState {
    #[serde(rename = "idle")]
    Idle,
    #[serde(rename = "loading")]
    Loading,
    #[serde(rename = "finished")]
    Finished,
    #[serde(rename = "failed")]
    Failed,
    /// The view's render process terminated (macOS WebKit content-process crash). Distinct from
    /// `Failed` (a load error): the page is dead and must be reloaded to recover. Native crash
    /// detection only exists on macOS in the vendored Wry; Win/Linux have no upstream signal.
    #[serde(rename = "crashed")]
    Crashed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserPageNavigationIssue {
    pub url: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserPageInfo {
    pub browser_session_id: String,
    pub view_id: String,
    pub requested_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub loading_state: DesktopBrowserViewLoadingState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<DesktopBrowserPageNavigationIssue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_rejected_navigation: Option<DesktopBrowserPageNavigationIssue>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserCommandResult {
    pub ok: bool,
    pub availability: DesktopBrowserAvailability,
}

impl DesktopBrowserCommandResult {
    pub(crate) fn success(availability: DesktopBrowserAvailability) -> Self {
        Self {
            ok: true,
            availability,
        }
    }

    pub(crate) fn unavailable(availability: DesktopBrowserAvailability) -> Self {
        Self {
            ok: false,
            availability,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserPageInfoResult {
    pub ok: bool,
    pub availability: DesktopBrowserAvailability,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_info: Option<DesktopBrowserPageInfo>,
}

impl DesktopBrowserPageInfoResult {
    pub(crate) fn success(
        availability: DesktopBrowserAvailability,
        page_info: DesktopBrowserPageInfo,
    ) -> Self {
        Self {
            ok: true,
            availability,
            page_info: Some(page_info),
        }
    }

    pub(crate) fn unavailable(availability: DesktopBrowserAvailability) -> Self {
        Self {
            ok: false,
            availability,
            page_info: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum DesktopBrowserCaptureErrorCode {
    #[serde(rename = "captureUnsupported")]
    CaptureUnsupported,
    #[serde(rename = "viewUnavailable")]
    ViewUnavailable,
    #[serde(rename = "staleNavigation")]
    StaleNavigation,
    #[serde(rename = "captureFailed")]
    CaptureFailed,
    /// The captured frame exceeded the recording byte cap the daemon negotiated. The native side
    /// rejects rather than writing an oversized artifact, mirroring the daemon-side bound in
    /// `nativeViewCommand.ts` (BA-4 bounded-per-recording-caps invariant).
    #[serde(rename = "captureTooLarge")]
    CaptureTooLarge,
    /// The captured frame could not be written to the daemon-provided reference path.
    #[serde(rename = "captureWriteFailed")]
    CaptureWriteFailed,
}

/// ANNO-3 crop clip for `desktop_browser_capture_snapshot`. Coordinates are **device pixels** in the
/// captured surface's own space (the union-of-targets rect the in-app annotation editor resolves via
/// the canonical `resolveAnnotationCropClip` helper — CSS px × devicePixelRatio, viewport-relative).
/// DPR conversion happens UI-side so the native seam consumes the physical-pixel rect directly; the
/// native side only clamps the clip to the captured buffer bounds and crops. Absent ⇒ full-frame
/// capture (unchanged behavior).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserCaptureClipRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserCaptureSnapshotRequest {
    pub browser_session_id: String,
    pub view_id: String,
    pub navigation_generation: u64,
    pub capture_request_id: String,
    /// ANNO-3 union-of-targets crop (device px). Absent ⇒ full-frame capture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip: Option<DesktopBrowserCaptureClipRect>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserCapturedSnapshot {
    pub browser_session_id: String,
    pub view_id: String,
    pub navigation_generation: u64,
    pub capture_request_id: String,
    pub captured_at_ms: u64,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: usize,
    pub bytes_base64: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserCaptureSnapshotResult {
    pub ok: bool,
    pub availability: DesktopBrowserAvailability,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<DesktopBrowserCapturedSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<DesktopBrowserCaptureErrorCode>,
}

impl DesktopBrowserCaptureSnapshotResult {
    pub(crate) fn success(
        availability: DesktopBrowserAvailability,
        snapshot: DesktopBrowserCapturedSnapshot,
    ) -> Self {
        Self {
            ok: true,
            availability,
            snapshot: Some(snapshot),
            error_code: None,
        }
    }

    pub(crate) fn unavailable(
        availability: DesktopBrowserAvailability,
        error_code: DesktopBrowserCaptureErrorCode,
    ) -> Self {
        Self {
            ok: false,
            availability,
            snapshot: None,
            error_code: Some(error_code),
        }
    }
}

/// Request for `desktop_browser_capture_recording_frame` (BA-4 `nativeViewCapture` producer). Unlike
/// `desktop_browser_capture_snapshot` — which returns inline base64 to the UI for an interactive
/// screenshot — the recording-frame command writes the captured PNG under the app-owned recording
/// root using the daemon-provided relative `output_path` artifact and returns ONLY a reference +
/// metadata (never inline bytes). `max_bytes` is the recording byte cap the daemon negotiated; an
/// over-cap capture is rejected, not written.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserCaptureRecordingFrameRequest {
    pub browser_session_id: String,
    pub view_id: String,
    pub navigation_generation: u64,
    pub capture_request_id: String,
    /// Recording-root-relative artifact path; absolute paths and traversal are rejected natively.
    pub output_path: String,
    /// Recording byte cap. A capture larger than this is rejected with `CaptureTooLarge`.
    pub max_bytes: usize,
}

/// Reference-only result of a captured recording frame: the path the PNG was written to plus
/// metadata. The pixel bytes never cross the IPC boundary (BRW-15 reference-only invariant).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserCapturedRecordingFrame {
    pub browser_session_id: String,
    pub view_id: String,
    pub navigation_generation: u64,
    pub capture_request_id: String,
    pub captured_at_ms: u64,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: usize,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserCaptureRecordingFrameResult {
    pub ok: bool,
    pub availability: DesktopBrowserAvailability,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<DesktopBrowserCapturedRecordingFrame>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<DesktopBrowserCaptureErrorCode>,
}

impl DesktopBrowserCaptureRecordingFrameResult {
    pub(crate) fn success(
        availability: DesktopBrowserAvailability,
        frame: DesktopBrowserCapturedRecordingFrame,
    ) -> Self {
        Self {
            ok: true,
            availability,
            frame: Some(frame),
            error_code: None,
        }
    }

    pub(crate) fn unavailable(
        availability: DesktopBrowserAvailability,
        error_code: DesktopBrowserCaptureErrorCode,
    ) -> Self {
        Self {
            ok: false,
            availability,
            frame: None,
            error_code: Some(error_code),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserDrainDiagnosticsResult {
    pub ok: bool,
    pub availability: DesktopBrowserAvailability,
    /// Raw batch-envelope strings the page posted via `window.ipc.postMessage(...)`. The native
    /// side does not parse these — it forwards them verbatim and the TS bridge parses each entry.
    pub messages: Vec<String>,
}

impl DesktopBrowserDrainDiagnosticsResult {
    pub(crate) fn success(availability: DesktopBrowserAvailability, messages: Vec<String>) -> Self {
        Self {
            ok: true,
            availability,
            messages,
        }
    }

    pub(crate) fn unavailable(availability: DesktopBrowserAvailability) -> Self {
        Self {
            ok: false,
            availability,
            messages: Vec::new(),
        }
    }
}
