mod platform;
mod types;

pub(crate) use platform::{
    child_embedding_supported_for, resolve_current_desktop_browser_platform,
};
pub(crate) use types::DesktopBrowserPlatform;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};
#[cfg(test)]
use std::sync::Arc;
use std::sync::{Arc as StdArc, Mutex, Weak};
use tauri::{Manager, Runtime, State, Window};
use types::{
    DesktopBrowserAvailability, DesktopBrowserBoundsPayload, DesktopBrowserCaptureClipRect,
    DesktopBrowserCaptureErrorCode, DesktopBrowserCaptureRecordingFrameRequest,
    DesktopBrowserCaptureRecordingFrameResult, DesktopBrowserCaptureSnapshotRequest,
    DesktopBrowserCaptureSnapshotResult, DesktopBrowserCapturedRecordingFrame,
    DesktopBrowserCapturedSnapshot, DesktopBrowserCommandResult,
    DesktopBrowserDispatchNavigationRequest, DesktopBrowserDrainDiagnosticsResult,
    DesktopBrowserEvalScriptRequest, DesktopBrowserNavigationDispatchKind,
    DesktopBrowserOpenViewRequest, DesktopBrowserPageInfo, DesktopBrowserPageInfoResult,
    DesktopBrowserPageNavigationIssue, DesktopBrowserPointerPassthroughPayload,
    DesktopBrowserViewCommandRequest, DesktopBrowserViewLoadingState,
};
use url::Url;

/// Upper bound on buffered diagnostics batch envelopes per view. A chatty page can post
/// continuously; beyond this many unread entries we drop the oldest so the buffer can never grow
/// unbounded between drains.
const DESKTOP_BROWSER_DIAGNOSTICS_BUFFER_CAP: usize = 2000;

/// Upper bound on the total bytes of buffered diagnostics envelopes per view. The entry-count cap
/// alone cannot bound memory: a page can post a small number of multi-MB envelopes and stay under
/// the count cap while pinning unbounded heap. Once the running byte total exceeds this we evict the
/// oldest entries until back under budget (in addition to the count cap).
const DESKTOP_BROWSER_DIAGNOSTICS_BYTES_CAP: usize = 8 * 1024 * 1024;

/// Upper bound on a single buffered diagnostics envelope. A single post larger than this is dropped
/// outright rather than buffered — it can never fit under the aggregate budget and would force every
/// other queued envelope to be evicted. Mirrors the per-line ceiling the canonical bounded JSONL
/// reader enforces on the daemon side.
const DESKTOP_BROWSER_DIAGNOSTICS_MAX_MESSAGE_BYTES: usize = 1024 * 1024;

type NativeSnapshotCompletion =
    Box<dyn FnOnce(Result<DesktopBrowserCapturedSnapshot, String>) + Send>;
type NativeScriptCompletion = Box<dyn FnOnce(String) + Send>;
struct NativeCapturedSnapshot {
    snapshot: DesktopBrowserCapturedSnapshot,
    source: Weak<DesktopBrowserViewKey>,
}
type PendingNativeCapture =
    tokio::sync::oneshot::Receiver<Result<NativeCapturedSnapshot, DesktopBrowserCaptureErrorCode>>;

pub(crate) trait DesktopBrowserWebViewHandle {
    fn load_url(&self, url: &str) -> Result<(), String>;
    fn navigation_state(&self) -> Result<(bool, bool), String>;
    fn go_back(&self) -> Result<bool, String>;
    fn go_forward(&self) -> Result<bool, String>;
    fn set_bounds(
        &self,
        rect: types::DesktopBrowserBoundsRect,
        visible: bool,
    ) -> Result<(), String>;
    /// Toggle host-side hit-testing for the native child view. When `ignore` is true the view stops
    /// receiving pointer events so an overlapping host gesture (pane/sidebar resize drag) lands on
    /// the React/DOM layer instead of being swallowed by the embedded page. This governs only host
    /// compositing/hit-testing — it grants the page no IPC, script, or automation.
    fn set_pointer_passthrough(&self, ignore: bool) -> Result<(), String>;
    fn open_devtools(&self) -> Result<(), String>;
    fn capture_snapshot(&self, completion: NativeSnapshotCompletion) -> Result<(), String>;
    /// Push a script into the child webview for evaluation. Fire-and-forget: in the vendored Wry,
    /// `WebView::evaluate_script` returns no JS value, so any result the page wants to surface is
    /// posted back out-of-band via `window.ipc.postMessage(...)` and drained by
    /// `desktop_browser_drain_diagnostics`. This is the interactive in-page devtools primitive
    /// (eval REPL + element picker); it grants the host no privileged IPC beyond the existing
    /// diagnostics collector channel.
    fn eval_script(&self, script: &str) -> Result<(), String>;
    fn eval_script_with_callback(
        &self,
        script: &str,
        completion: NativeScriptCompletion,
    ) -> Result<(), String>;
}

pub(crate) trait DesktopBrowserWebViewHost: Send + Sync {
    fn create_webview(
        &self,
        view_id: &str,
        profile_dir: &Path,
        url: &str,
        page_info: DesktopBrowserPageInfoSink,
        diagnostics: DesktopBrowserDiagnosticsSink,
    ) -> Result<Box<dyn DesktopBrowserWebViewHandle>, String>;

    #[cfg(test)]
    fn supports_devtools(&self) -> bool;
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct DesktopBrowserViewKey {
    browser_session_id: String,
    view_id: String,
}

#[derive(Debug)]
struct DesktopBrowserViewState {
    profile_id: String,
    last_bounds: Option<types::DesktopBrowserBoundsRect>,
    visible: bool,
    requested_url: String,
    navigation_generation: u64,
    pending_generation_url: Option<String>,
    current_url: Option<String>,
    title: Option<String>,
    loading_state: DesktopBrowserViewLoadingState,
    last_error: Option<DesktopBrowserPageNavigationIssue>,
    last_rejected_navigation: Option<DesktopBrowserPageNavigationIssue>,
}

#[derive(Debug)]
struct DesktopBrowserProfileState {
    #[allow(dead_code)]
    profile_dir: PathBuf,
    view_keys: HashSet<DesktopBrowserViewKey>,
}

/// Thread-safe per-view buffer of raw diagnostics batch-envelope strings posted by the page's
/// injected devtools through `window.ipc.postMessage(...)`. The IPC handler closure clones this
/// `Arc` (mirroring how `DesktopBrowserPageInfoSink` clones the shared state `Arc`) and pushes the
/// posted strings into it; `desktop_browser_drain_diagnostics` swaps the contents out.
type DesktopBrowserDiagnosticsBuffer = StdArc<Mutex<VecDeque<String>>>;

#[derive(Debug, Default)]
struct DesktopBrowserStateInner {
    views: HashMap<DesktopBrowserViewKey, DesktopBrowserViewState>,
    profiles: HashMap<String, DesktopBrowserProfileState>,
    diagnostics: HashMap<DesktopBrowserViewKey, DesktopBrowserDiagnosticsBuffer>,
}

pub struct DesktopBrowserState {
    availability: DesktopBrowserAvailability,
    profile_root: Mutex<PathBuf>,
    inner: StdArc<Mutex<DesktopBrowserStateInner>>,
    #[cfg(test)]
    test_host: Option<Arc<dyn DesktopBrowserWebViewHost>>,
}

impl Default for DesktopBrowserState {
    fn default() -> Self {
        Self {
            availability: desktop_browser_get_availability(),
            profile_root: Mutex::new(default_profile_root()),
            inner: StdArc::new(Mutex::new(DesktopBrowserStateInner::default())),
            #[cfg(test)]
            test_host: None,
        }
    }
}

impl DesktopBrowserState {
    #[cfg(test)]
    fn for_test(
        availability: DesktopBrowserAvailability,
        profile_root: PathBuf,
        host: Box<dyn DesktopBrowserWebViewHost>,
    ) -> Self {
        Self {
            availability: availability_with_host_devtools(availability, host.supports_devtools()),
            profile_root: Mutex::new(profile_root),
            inner: StdArc::new(Mutex::new(DesktopBrowserStateInner::default())),
            test_host: Some(Arc::from(host)),
        }
    }

    #[cfg(test)]
    fn view_count(&self) -> usize {
        self.inner
            .lock()
            .expect("browser state lock poisoned")
            .views
            .len()
    }

    #[cfg(test)]
    fn profile_count(&self) -> usize {
        self.inner
            .lock()
            .expect("browser state lock poisoned")
            .profiles
            .len()
    }

    #[cfg(test)]
    fn open_view(&self, request: DesktopBrowserOpenViewRequest) -> DesktopBrowserCommandResult {
        let host = self.test_host.as_ref().expect("test host should be set");
        self.open_view_with_host(request, host.as_ref())
    }

    #[cfg(test)]
    fn navigate(&self, request: DesktopBrowserViewCommandRequest) -> DesktopBrowserCommandResult {
        self.navigate_view(request)
    }

    #[cfg(test)]
    fn set_bounds(&self, request: DesktopBrowserBoundsPayload) -> DesktopBrowserCommandResult {
        self.set_view_bounds(request)
    }

    #[cfg(test)]
    fn set_pointer_passthrough(
        &self,
        request: DesktopBrowserPointerPassthroughPayload,
    ) -> DesktopBrowserCommandResult {
        self.set_view_pointer_passthrough(request)
    }

    #[cfg(test)]
    fn close_view(&self, request: DesktopBrowserViewCommandRequest) -> DesktopBrowserCommandResult {
        self.close_view_by_id(request)
    }

    #[cfg(test)]
    fn open_devtools(
        &self,
        request: DesktopBrowserViewCommandRequest,
    ) -> DesktopBrowserCommandResult {
        self.open_view_devtools(request)
    }

    #[cfg(test)]
    fn get_page_info(
        &self,
        request: DesktopBrowserViewCommandRequest,
    ) -> DesktopBrowserPageInfoResult {
        self.read_view_page_info(request)
    }

    #[cfg(test)]
    fn capture_snapshot(
        &self,
        request: DesktopBrowserCaptureSnapshotRequest,
    ) -> DesktopBrowserCaptureSnapshotResult {
        let capture = self.start_view_capture(
            view_key(&request.browser_session_id, &request.view_id),
            request.navigation_generation,
        );
        self.finish_view_snapshot(
            request,
            tauri::async_runtime::block_on(await_native_capture(capture)),
        )
    }

    #[cfg(test)]
    fn capture_recording_frame(
        &self,
        request: DesktopBrowserCaptureRecordingFrameRequest,
    ) -> DesktopBrowserCaptureRecordingFrameResult {
        let capture = self.start_view_capture(
            view_key(&request.browser_session_id, &request.view_id),
            request.navigation_generation,
        );
        self.finish_view_recording_frame(
            request,
            tauri::async_runtime::block_on(await_native_capture(capture)),
        )
    }

    #[cfg(test)]
    fn drain_diagnostics(
        &self,
        request: DesktopBrowserViewCommandRequest,
    ) -> DesktopBrowserDrainDiagnosticsResult {
        self.drain_view_diagnostics(request)
    }

    #[cfg(test)]
    fn eval_script(&self, request: DesktopBrowserEvalScriptRequest) -> DesktopBrowserCommandResult {
        self.eval_view_script(request)
    }

    fn availability(&self) -> DesktopBrowserAvailability {
        self.availability.clone()
    }

    fn unavailable_result(&self) -> DesktopBrowserCommandResult {
        DesktopBrowserCommandResult::unavailable(self.availability())
    }

    fn unavailable_page_info_result(&self) -> DesktopBrowserPageInfoResult {
        DesktopBrowserPageInfoResult::unavailable(self.availability())
    }

    fn unavailable_drain_diagnostics_result(&self) -> DesktopBrowserDrainDiagnosticsResult {
        DesktopBrowserDrainDiagnosticsResult::unavailable(self.availability())
    }

    fn unavailable_capture_result(
        &self,
        error_code: DesktopBrowserCaptureErrorCode,
    ) -> DesktopBrowserCaptureSnapshotResult {
        DesktopBrowserCaptureSnapshotResult::unavailable(self.availability(), error_code)
    }

    fn success_result(&self) -> DesktopBrowserCommandResult {
        DesktopBrowserCommandResult::success(self.availability())
    }

    fn open_view_with_host(
        &self,
        request: DesktopBrowserOpenViewRequest,
        host: &dyn DesktopBrowserWebViewHost,
    ) -> DesktopBrowserCommandResult {
        if !self.availability.available {
            return self.unavailable_result();
        }

        if !is_allowed_external_url(&request.url) {
            return self.unavailable_result();
        }

        let key = view_key(&request.browser_session_id, &request.view_id);
        let profile_dir = self.profile_dir_for_id(&request.profile_id);

        // Only views opened with a non-empty diagnostics init script get a diagnostics buffer (and,
        // downstream, an IPC handler + init script). Absent/empty keeps full parity with today.
        let diagnostics_init_script = request
            .diagnostics_init_script
            .as_deref()
            .filter(|script| !script.trim().is_empty())
            .map(str::to_string);
        let diagnostics_buffer = diagnostics_init_script
            .as_ref()
            .map(|_| DesktopBrowserDiagnosticsBuffer::default());

        // Retire the original source before publishing replacement logical facts. Async capture
        // projection must not observe new generation-zero facts with the old native entry alive.
        remove_native_handle(&key);
        {
            let mut inner = self.inner.lock().expect("browser state lock poisoned");
            remove_view_from_state(&mut inner, &key);
            inner
                .profiles
                .entry(request.profile_id.clone())
                .or_insert_with(|| DesktopBrowserProfileState {
                    profile_dir: profile_dir.clone(),
                    view_keys: HashSet::new(),
                })
                .view_keys
                .insert(key.clone());

            inner.views.insert(
                key.clone(),
                DesktopBrowserViewState {
                    profile_id: request.profile_id,
                    last_bounds: None,
                    visible: true,
                    requested_url: request.url.clone(),
                    navigation_generation: 0,
                    pending_generation_url: None,
                    current_url: None,
                    title: None,
                    loading_state: DesktopBrowserViewLoadingState::Loading,
                    last_error: None,
                    last_rejected_navigation: None,
                },
            );

            if let Some(buffer) = &diagnostics_buffer {
                inner.diagnostics.insert(key.clone(), buffer.clone());
            }
        }
        let page_info = DesktopBrowserPageInfoSink::new(key.clone(), self.inner.clone());
        let diagnostics =
            DesktopBrowserDiagnosticsSink::new(diagnostics_init_script, diagnostics_buffer);
        let handle = match host.create_webview(
            &request.view_id,
            &profile_dir,
            &request.url,
            page_info,
            diagnostics,
        ) {
            Ok(handle) => handle,
            Err(error) => {
                DesktopBrowserPageInfoSink::new(key.clone(), self.inner.clone())
                    .record_error(request.url.clone(), error);
                let mut inner = self.inner.lock().expect("browser state lock poisoned");
                remove_view_from_state(&mut inner, &key);
                return self.unavailable_result();
            }
        };

        replace_native_handle(key, handle);

        self.success_result()
    }

    fn open_view_with_profile_root(
        &self,
        request: DesktopBrowserOpenViewRequest,
        host: &dyn DesktopBrowserWebViewHost,
        profile_root: PathBuf,
    ) -> DesktopBrowserCommandResult {
        *self
            .profile_root
            .lock()
            .expect("browser profile root lock poisoned") = profile_root;
        self.open_view_with_host(request, host)
    }

    fn navigate_view(
        &self,
        request: DesktopBrowserViewCommandRequest,
    ) -> DesktopBrowserCommandResult {
        let Some(url) = request.url else {
            return self.unavailable_result();
        };
        let key = view_key(&request.browser_session_id, &request.view_id);
        if !self.view_exists(&key) {
            return self.unavailable_result();
        }

        let page_info = DesktopBrowserPageInfoSink::new(key.clone(), self.inner.clone());
        if !is_allowed_external_url(&url) {
            page_info.record_rejected_navigation(url, "unsupported_url");
            return self.unavailable_result();
        }

        page_info.record_requested_navigation(url.clone());

        if with_native_handle(&key, |handle| handle.load_url(&url)).is_err() {
            page_info.record_error(
                url,
                "desktop browser native view failed to load requested URL".to_string(),
            );
            return self.unavailable_result();
        }

        self.success_result()
    }

    fn start_view_capture(
        &self,
        key: DesktopBrowserViewKey,
        navigation_generation: u64,
    ) -> Result<PendingNativeCapture, DesktopBrowserCaptureErrorCode> {
        if !self.availability.supports.capture {
            return Err(DesktopBrowserCaptureErrorCode::CaptureUnsupported);
        }
        match self.capture_generation_status(&key, navigation_generation) {
            CaptureGenerationStatus::Current => {}
            CaptureGenerationStatus::Missing => {
                return Err(DesktopBrowserCaptureErrorCode::ViewUnavailable);
            }
            CaptureGenerationStatus::Stale => {
                return Err(DesktopBrowserCaptureErrorCode::StaleNavigation);
            }
        }
        // The source owns this probe, not the capture caller: caller-supplied JavaScript could
        // claim `false` and bypass admission. Annotation and recording share the same policy.
        let privacy_script: String = serde_json::from_str(include_str!(
            "../../../../../packages/protocol/src/browser/context/sensitiveFieldsExpression.json"
        ))
        .map_err(|_| DesktopBrowserCaptureErrorCode::CaptureFailed)?;
        let source = native_capture_source(&key)
            .map_err(|_| DesktopBrowserCaptureErrorCode::CaptureFailed)?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let inner = self.inner.clone();
        let callback_key = key.clone();
        with_native_handle(&key, |handle| {
            handle.eval_script_with_callback(
                &privacy_script,
                Box::new(move |value| {
                    let error = match serde_json::from_str::<bool>(&value) {
                        Ok(false) if source.upgrade().is_none() => {
                            Some(DesktopBrowserCaptureErrorCode::ViewUnavailable)
                        }
                        Ok(false) => match capture_generation_status(
                            &inner,
                            &callback_key,
                            navigation_generation,
                        ) {
                            CaptureGenerationStatus::Current => None,
                            CaptureGenerationStatus::Missing => {
                                Some(DesktopBrowserCaptureErrorCode::ViewUnavailable)
                            }
                            CaptureGenerationStatus::Stale => {
                                Some(DesktopBrowserCaptureErrorCode::StaleNavigation)
                            }
                        },
                        Ok(true) => Some(DesktopBrowserCaptureErrorCode::SensitiveFieldsPresent),
                        Err(_) => Some(DesktopBrowserCaptureErrorCode::CaptureFailed),
                    };
                    if let Some(error) = error {
                        let _ = sender.send(Err(error));
                        return;
                    }
                    // WebKit invokes evaluation completion on the main thread. Re-check the existing
                    // navigation authority immediately before pixels, then let its callback settle the
                    // command. Failed scheduling or a dropped platform callback closes the sender.
                    let _ = with_native_handle(&callback_key, |handle| {
                        handle.capture_snapshot(Box::new(move |result| {
                            let result = if source.upgrade().is_none() {
                                Err(DesktopBrowserCaptureErrorCode::ViewUnavailable)
                            } else {
                                result
                                    .map(|snapshot| NativeCapturedSnapshot { snapshot, source })
                                    .map_err(|_| DesktopBrowserCaptureErrorCode::CaptureFailed)
                            };
                            let _ = sender.send(result);
                        }))
                    });
                }),
            )
        })
        .map_err(|_| DesktopBrowserCaptureErrorCode::CaptureFailed)?;
        Ok(receiver)
    }

    fn finish_view_snapshot(
        &self,
        request: DesktopBrowserCaptureSnapshotRequest,
        capture: Result<NativeCapturedSnapshot, DesktopBrowserCaptureErrorCode>,
    ) -> DesktopBrowserCaptureSnapshotResult {
        let key = view_key(&request.browser_session_id, &request.view_id);
        let captured = match capture {
            Ok(captured) => captured,
            Err(error) => {
                return self.unavailable_capture_result(error);
            }
        };
        let mut snapshot = captured.snapshot;

        if !is_valid_native_snapshot(&snapshot) {
            return self.unavailable_capture_result(DesktopBrowserCaptureErrorCode::CaptureFailed);
        }

        match self.capture_generation_status(&key, request.navigation_generation) {
            CaptureGenerationStatus::Current => {}
            CaptureGenerationStatus::Missing => {
                return self
                    .unavailable_capture_result(DesktopBrowserCaptureErrorCode::ViewUnavailable);
            }
            CaptureGenerationStatus::Stale => {
                return self
                    .unavailable_capture_result(DesktopBrowserCaptureErrorCode::StaleNavigation);
            }
        }

        // Check source liveness after the logical generation: a concurrent same-key replacement
        // may publish generation zero between those observations, but cannot revive this entry.
        if captured.source.upgrade().is_none() {
            return self
                .unavailable_capture_result(DesktopBrowserCaptureErrorCode::ViewUnavailable);
        }

        // ANNO-3: crop the full-frame capture to the union-of-targets clip (device px) when the
        // annotation editor supplies one, so the persisted media is the crop — not the whole page.
        // The crop is engine-agnostic (operates on the returned PNG) + clamps to the buffer bounds.
        if let Some(clip) = request.clip {
            snapshot = match crop_snapshot_png(snapshot, clip) {
                Ok(cropped) => cropped,
                Err(_) => {
                    return self
                        .unavailable_capture_result(DesktopBrowserCaptureErrorCode::CaptureFailed);
                }
            };
            if !is_valid_native_snapshot(&snapshot) {
                return self
                    .unavailable_capture_result(DesktopBrowserCaptureErrorCode::CaptureFailed);
            }
        }

        snapshot.browser_session_id = request.browser_session_id;
        snapshot.view_id = request.view_id;
        snapshot.navigation_generation = request.navigation_generation;
        snapshot.capture_request_id = request.capture_request_id;

        DesktopBrowserCaptureSnapshotResult::success(self.availability(), snapshot)
    }

    /// Reference-only recording-frame capture (BA-4 `nativeViewCapture` producer). Reuses the same
    /// native snapshot machinery + generation guards as annotation capture, but instead of
    /// returning inline base64 to the UI it enforces the daemon's recording byte cap and writes the
    /// PNG to the app-owned recording root using the daemon-provided root-relative artifact path.
    /// The daemon never receives the pixel buffer and cannot choose an arbitrary filesystem path.
    fn finish_view_recording_frame(
        &self,
        request: DesktopBrowserCaptureRecordingFrameRequest,
        capture: Result<NativeCapturedSnapshot, DesktopBrowserCaptureErrorCode>,
    ) -> DesktopBrowserCaptureRecordingFrameResult {
        let key = view_key(&request.browser_session_id, &request.view_id);
        let captured = match capture {
            Ok(captured) => captured,
            Err(error) => {
                return DesktopBrowserCaptureRecordingFrameResult::unavailable(
                    self.availability(),
                    error,
                );
            }
        };
        let snapshot = captured.snapshot;

        if !is_valid_native_snapshot(&snapshot) {
            return DesktopBrowserCaptureRecordingFrameResult::unavailable(
                self.availability(),
                DesktopBrowserCaptureErrorCode::CaptureFailed,
            );
        }

        // Re-check the generation AFTER the async snapshot, mirroring annotation capture — the
        // page may have navigated while the capture was in flight.
        match self.capture_generation_status(&key, request.navigation_generation) {
            CaptureGenerationStatus::Current => {}
            CaptureGenerationStatus::Missing => {
                return DesktopBrowserCaptureRecordingFrameResult::unavailable(
                    self.availability(),
                    DesktopBrowserCaptureErrorCode::ViewUnavailable,
                );
            }
            CaptureGenerationStatus::Stale => {
                return DesktopBrowserCaptureRecordingFrameResult::unavailable(
                    self.availability(),
                    DesktopBrowserCaptureErrorCode::StaleNavigation,
                );
            }
        }

        if captured.source.upgrade().is_none() {
            return DesktopBrowserCaptureRecordingFrameResult::unavailable(
                self.availability(),
                DesktopBrowserCaptureErrorCode::ViewUnavailable,
            );
        }

        if snapshot.size_bytes > request.max_bytes {
            return DesktopBrowserCaptureRecordingFrameResult::unavailable(
                self.availability(),
                DesktopBrowserCaptureErrorCode::CaptureTooLarge,
            );
        }

        let png_bytes = match decode_snapshot_png_bytes(&snapshot.bytes_base64) {
            Some(bytes) => bytes,
            None => {
                return DesktopBrowserCaptureRecordingFrameResult::unavailable(
                    self.availability(),
                    DesktopBrowserCaptureErrorCode::CaptureFailed,
                );
            }
        };

        // Defense-in-depth: the decoded length is the authoritative on-disk size; reject if it
        // somehow exceeds the cap even though the reported size_bytes did not.
        if png_bytes.len() > request.max_bytes {
            return DesktopBrowserCaptureRecordingFrameResult::unavailable(
                self.availability(),
                DesktopBrowserCaptureErrorCode::CaptureTooLarge,
            );
        }

        let recording_root = recording_frame_root(
            &self
                .profile_root
                .lock()
                .expect("browser profile root lock poisoned"),
        );
        let output_path =
            match write_recording_frame_file(&recording_root, &request.output_path, &png_bytes) {
                Ok(path) => path,
                Err(_) => {
                    return DesktopBrowserCaptureRecordingFrameResult::unavailable(
                        self.availability(),
                        DesktopBrowserCaptureErrorCode::CaptureWriteFailed,
                    );
                }
            };

        DesktopBrowserCaptureRecordingFrameResult::success(
            self.availability(),
            DesktopBrowserCapturedRecordingFrame {
                browser_session_id: request.browser_session_id,
                view_id: request.view_id,
                navigation_generation: request.navigation_generation,
                capture_request_id: request.capture_request_id,
                captured_at_ms: snapshot.captured_at_ms,
                mime_type: snapshot.mime_type,
                width: snapshot.width,
                height: snapshot.height,
                size_bytes: png_bytes.len(),
                path: output_path.to_string_lossy().to_string(),
            },
        )
    }

    fn view_exists(&self, key: &DesktopBrowserViewKey) -> bool {
        self.inner
            .lock()
            .expect("browser state lock poisoned")
            .views
            .contains_key(key)
    }

    fn capture_generation_status(
        &self,
        key: &DesktopBrowserViewKey,
        navigation_generation: u64,
    ) -> CaptureGenerationStatus {
        capture_generation_status(&self.inner, key, navigation_generation)
    }

    fn set_view_bounds(&self, request: DesktopBrowserBoundsPayload) -> DesktopBrowserCommandResult {
        let mut inner = self.inner.lock().expect("browser state lock poisoned");
        let key = view_key(&request.browser_session_id, &request.view_id);
        let Some(view) = inner.views.get_mut(&key) else {
            return self.unavailable_result();
        };

        if with_native_handle(&key, |handle| {
            handle.set_bounds(request.rect, request.visible)
        })
        .is_err()
        {
            return self.unavailable_result();
        }

        view.last_bounds = Some(request.rect);
        view.visible = request.visible;
        self.success_result()
    }

    fn set_view_pointer_passthrough(
        &self,
        request: DesktopBrowserPointerPassthroughPayload,
    ) -> DesktopBrowserCommandResult {
        let key = view_key(&request.browser_session_id, &request.view_id);
        if !self.view_exists(&key) {
            return self.unavailable_result();
        }

        if with_native_handle(&key, |handle| {
            handle.set_pointer_passthrough(request.ignore)
        })
        .is_err()
        {
            return self.unavailable_result();
        }

        self.success_result()
    }

    fn read_view_page_info(
        &self,
        request: DesktopBrowserViewCommandRequest,
    ) -> DesktopBrowserPageInfoResult {
        if !self.availability.supports.page_info_diagnostics {
            return self.unavailable_page_info_result();
        }

        let key = view_key(&request.browser_session_id, &request.view_id);
        // Read the native history authority on demand, including same-document history changes.
        let (can_go_back, can_go_forward) =
            match with_native_handle(&key, |handle| handle.navigation_state()) {
                Ok(state) => state,
                Err(_) => return self.unavailable_page_info_result(),
            };
        let inner = self.inner.lock().expect("browser state lock poisoned");
        let Some(view) = inner.views.get(&key) else {
            return self.unavailable_page_info_result();
        };

        DesktopBrowserPageInfoResult::success(
            self.availability(),
            DesktopBrowserPageInfo {
                browser_session_id: key.browser_session_id,
                view_id: key.view_id,
                requested_url: view.requested_url.clone(),
                current_url: view.current_url.clone(),
                title: view.title.clone(),
                loading_state: view.loading_state,
                can_go_back,
                can_go_forward,
                last_error: view.last_error.clone(),
                last_rejected_navigation: view.last_rejected_navigation.clone(),
            },
        )
    }

    fn drain_view_diagnostics(
        &self,
        request: DesktopBrowserViewCommandRequest,
    ) -> DesktopBrowserDrainDiagnosticsResult {
        if !self.availability.supports.page_info_diagnostics {
            return self.unavailable_drain_diagnostics_result();
        }

        let key = view_key(&request.browser_session_id, &request.view_id);
        let buffer = {
            let inner = self.inner.lock().expect("browser state lock poisoned");
            // A missing view (or a view opened without a diagnostics init script) is not an error:
            // return ok:false with empty messages so the bridge can poll uniformly.
            let Some(buffer) = inner.diagnostics.get(&key) else {
                return self.unavailable_drain_diagnostics_result();
            };
            buffer.clone()
        };

        let messages: Vec<String> = {
            let mut entries = buffer.lock().expect("browser diagnostics lock poisoned");
            entries.drain(..).collect()
        };

        DesktopBrowserDrainDiagnosticsResult::success(self.availability(), messages)
    }

    fn eval_view_script(
        &self,
        request: DesktopBrowserEvalScriptRequest,
    ) -> DesktopBrowserCommandResult {
        // Same parity gate as `drain_view_diagnostics`: the eval REPL/element-picker round-trips
        // through the diagnostics collector channel, so it is only meaningful where in-page
        // diagnostics are supported.
        if !self.availability.supports.page_info_diagnostics {
            return self.unavailable_result();
        }

        // An empty/blank script is a no-op request, not an error to surface: return ok:false
        // without dispatching anything to the webview.
        if request.script.trim().is_empty() {
            return self.unavailable_result();
        }

        let key = view_key(&request.browser_session_id, &request.view_id);
        if !self.view_exists(&key) {
            return self.unavailable_result();
        }

        if with_native_handle(&key, |handle| handle.eval_script(&request.script)).is_err() {
            return self.unavailable_result();
        }

        self.success_result()
    }

    fn dispatch_view_navigation(
        &self,
        request: DesktopBrowserDispatchNavigationRequest,
    ) -> DesktopBrowserCommandResult {
        // Trusted navigation-control seam: the injected script is DERIVED from the kind here, never
        // taken from the caller, so this can never become an arbitrary-eval surface. Unlike the eval
        // REPL it is NOT gated on `page_info_diagnostics` — reload/stop are page navigation controls
        // that must work regardless of whether in-page diagnostics are supported.
        let key = view_key(&request.browser_session_id, &request.view_id);
        if !self.view_exists(&key) {
            return self.unavailable_result();
        }

        let dispatched = with_native_handle(&key, |handle| match request.kind {
            DesktopBrowserNavigationDispatchKind::GoBack => handle.go_back(),
            DesktopBrowserNavigationDispatchKind::GoForward => handle.go_forward(),
            DesktopBrowserNavigationDispatchKind::Reload => {
                handle.eval_script("location.reload()").map(|()| true)
            }
            DesktopBrowserNavigationDispatchKind::Stop => {
                handle.eval_script("window.stop()").map(|()| true)
            }
        });
        if !matches!(dispatched, Ok(true)) {
            return self.unavailable_result();
        }

        self.success_result()
    }

    fn close_view_by_id(
        &self,
        request: DesktopBrowserViewCommandRequest,
    ) -> DesktopBrowserCommandResult {
        let mut inner = self.inner.lock().expect("browser state lock poisoned");
        let key = view_key(&request.browser_session_id, &request.view_id);
        if remove_view_from_state(&mut inner, &key).is_none() {
            return self.unavailable_result();
        }
        remove_native_handle(&key);
        self.success_result()
    }

    fn open_view_devtools(
        &self,
        request: DesktopBrowserViewCommandRequest,
    ) -> DesktopBrowserCommandResult {
        if !self.availability.supports.native_devtools {
            return self.unavailable_result();
        }

        let key = view_key(&request.browser_session_id, &request.view_id);
        if !self
            .inner
            .lock()
            .expect("browser state lock poisoned")
            .views
            .contains_key(&key)
        {
            return self.unavailable_result();
        }

        if with_native_handle(&key, |handle| handle.open_devtools()).is_err() {
            return self.unavailable_result();
        }

        self.success_result()
    }

    fn profile_dir_for_id(&self, profile_id: &str) -> PathBuf {
        self.profile_root
            .lock()
            .expect("browser profile root lock poisoned")
            .clone()
            .join("profiles")
            .join(stable_path_segment(profile_id))
    }
}

#[tauri::command]
pub fn desktop_browser_get_availability() -> DesktopBrowserAvailability {
    platform::resolve_current_desktop_browser_strategy()
}

#[tauri::command]
pub fn desktop_browser_open_view<R: Runtime>(
    window: Window<R>,
    state: State<'_, DesktopBrowserState>,
    request: DesktopBrowserOpenViewRequest,
) -> DesktopBrowserCommandResult {
    let host = TauriWryWebViewHost::new(window);
    let Ok(profile_root) = resolve_profile_root(&host.window) else {
        return state.unavailable_result();
    };
    state.open_view_with_profile_root(request, &host, profile_root)
}

#[tauri::command]
pub fn desktop_browser_navigate(
    state: State<'_, DesktopBrowserState>,
    request: DesktopBrowserViewCommandRequest,
) -> DesktopBrowserCommandResult {
    state.navigate_view(request)
}

#[tauri::command]
pub fn desktop_browser_set_bounds(
    state: State<'_, DesktopBrowserState>,
    request: DesktopBrowserBoundsPayload,
) -> DesktopBrowserCommandResult {
    state.set_view_bounds(request)
}

#[tauri::command]
pub fn desktop_browser_set_pointer_passthrough(
    state: State<'_, DesktopBrowserState>,
    request: DesktopBrowserPointerPassthroughPayload,
) -> DesktopBrowserCommandResult {
    state.set_view_pointer_passthrough(request)
}

#[tauri::command]
pub fn desktop_browser_close_view(
    state: State<'_, DesktopBrowserState>,
    request: DesktopBrowserViewCommandRequest,
) -> DesktopBrowserCommandResult {
    state.close_view_by_id(request)
}

#[tauri::command]
pub fn desktop_browser_open_devtools(
    state: State<'_, DesktopBrowserState>,
    request: DesktopBrowserViewCommandRequest,
) -> DesktopBrowserCommandResult {
    state.open_view_devtools(request)
}

#[tauri::command]
pub fn desktop_browser_get_page_info(
    state: State<'_, DesktopBrowserState>,
    request: DesktopBrowserViewCommandRequest,
) -> DesktopBrowserPageInfoResult {
    state.read_view_page_info(request)
}

#[tauri::command]
pub async fn desktop_browser_capture_snapshot<R: Runtime>(
    window: Window<R>,
    state: State<'_, DesktopBrowserState>,
    request: DesktopBrowserCaptureSnapshotRequest,
) -> Result<DesktopBrowserCaptureSnapshotResult, String> {
    let capture = capture_native_view_pixels(
        window,
        view_key(&request.browser_session_id, &request.view_id),
        request.navigation_generation,
    )
    .await;
    Ok(state.finish_view_snapshot(request, capture))
}

#[tauri::command]
pub async fn desktop_browser_capture_recording_frame<R: Runtime>(
    window: Window<R>,
    state: State<'_, DesktopBrowserState>,
    request: DesktopBrowserCaptureRecordingFrameRequest,
) -> Result<DesktopBrowserCaptureRecordingFrameResult, String> {
    let capture = capture_native_view_pixels(
        window,
        view_key(&request.browser_session_id, &request.view_id),
        request.navigation_generation,
    )
    .await;
    Ok(state.finish_view_recording_frame(request, capture))
}

async fn await_native_capture(
    capture: Result<PendingNativeCapture, DesktopBrowserCaptureErrorCode>,
) -> Result<NativeCapturedSnapshot, DesktopBrowserCaptureErrorCode> {
    capture?
        .await
        .map_err(|_| DesktopBrowserCaptureErrorCode::CaptureFailed)?
}

async fn capture_native_view_pixels<R: Runtime>(
    window: Window<R>,
    key: DesktopBrowserViewKey,
    navigation_generation: u64,
) -> Result<NativeCapturedSnapshot, DesktopBrowserCaptureErrorCode> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let app = window.app_handle().clone();
    // Native webviews are main-thread-owned. Only scheduling runs there: neither the command nor
    // the event loop waits synchronously for WebKit's eventual completion callback.
    window
        .run_on_main_thread(move || {
            let state = app.state::<DesktopBrowserState>();
            let _ = sender.send(state.start_view_capture(key, navigation_generation));
        })
        .map_err(|_| DesktopBrowserCaptureErrorCode::CaptureFailed)?;
    let capture = receiver
        .await
        .map_err(|_| DesktopBrowserCaptureErrorCode::CaptureFailed)?;
    await_native_capture(capture).await
}

#[tauri::command]
pub fn desktop_browser_drain_diagnostics(
    state: State<'_, DesktopBrowserState>,
    request: DesktopBrowserViewCommandRequest,
) -> DesktopBrowserDrainDiagnosticsResult {
    state.drain_view_diagnostics(request)
}

#[tauri::command]
pub fn desktop_browser_eval_script(
    state: State<'_, DesktopBrowserState>,
    request: DesktopBrowserEvalScriptRequest,
) -> DesktopBrowserCommandResult {
    state.eval_view_script(request)
}

#[tauri::command]
pub fn desktop_browser_dispatch_navigation(
    state: State<'_, DesktopBrowserState>,
    request: DesktopBrowserDispatchNavigationRequest,
) -> DesktopBrowserCommandResult {
    state.dispatch_view_navigation(request)
}

fn view_key(browser_session_id: &str, view_id: &str) -> DesktopBrowserViewKey {
    DesktopBrowserViewKey {
        browser_session_id: browser_session_id.to_string(),
        view_id: view_id.to_string(),
    }
}

fn remove_view_from_state(
    inner: &mut DesktopBrowserStateInner,
    key: &DesktopBrowserViewKey,
) -> Option<DesktopBrowserViewState> {
    let removed = inner.views.remove(key)?;
    inner.diagnostics.remove(key);
    let should_remove_profile = inner
        .profiles
        .get_mut(&removed.profile_id)
        .map(|profile| {
            profile.view_keys.remove(key);
            profile.view_keys.is_empty()
        })
        .unwrap_or(false);

    if should_remove_profile {
        inner.profiles.remove(&removed.profile_id);
    }

    Some(removed)
}

enum CaptureGenerationStatus {
    Current,
    Missing,
    Stale,
}

fn capture_generation_status(
    inner: &Mutex<DesktopBrowserStateInner>,
    key: &DesktopBrowserViewKey,
    navigation_generation: u64,
) -> CaptureGenerationStatus {
    let inner = inner.lock().expect("browser state lock poisoned");
    let Some(view) = inner.views.get(key) else {
        return CaptureGenerationStatus::Missing;
    };
    if view.navigation_generation == navigation_generation {
        CaptureGenerationStatus::Current
    } else {
        CaptureGenerationStatus::Stale
    }
}

fn decode_snapshot_png_bytes(bytes_base64: &str) -> Option<Vec<u8>> {
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
    BASE64_STANDARD.decode(bytes_base64).ok()
}

fn recording_frame_root(profile_root: &Path) -> PathBuf {
    profile_root
        .join(".happier")
        .join("tmp")
        .join("browser-recordings")
}

fn resolve_recording_frame_output_path(
    recording_root: &Path,
    output_path: &str,
) -> Result<PathBuf, String> {
    let relative_path = Path::new(output_path);
    if output_path.trim().is_empty() || relative_path.is_absolute() {
        return Err("recording frame output path must be relative".to_string());
    }
    if !relative_path
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err("recording frame output path must stay inside the recording root".to_string());
    }

    std::fs::create_dir_all(recording_root).map_err(|error| error.to_string())?;
    let canonical_root = recording_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let target = canonical_root.join(relative_path);
    let parent = target
        .parent()
        .ok_or_else(|| "recording frame output path requires a parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let canonical_parent = parent.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err("recording frame output path escapes the recording root".to_string());
    }
    let file_name = target
        .file_name()
        .ok_or_else(|| "recording frame output path requires a file name".to_string())?;
    let resolved = canonical_parent.join(file_name);
    if !resolved.starts_with(&canonical_root) {
        return Err("recording frame output path escapes the recording root".to_string());
    }
    Ok(resolved)
}

/// Atomically writes the captured recording frame under the app-owned recording root. The caller may
/// provide only a root-relative artifact path; traversal, absolute paths, and symlinked parent
/// escapes are rejected before the write. Never touches the diagnostics byte-cap buffers.
fn write_recording_frame_file(
    recording_root: &Path,
    output_path: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    use std::io::Write;

    let path = resolve_recording_frame_output_path(recording_root, output_path)?;
    let temp_path = path.with_extension("png.partial");
    let write_result = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error);
    }
    std::fs::rename(&temp_path, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temp_path);
        error.to_string()
    })?;
    Ok(path)
}

fn is_valid_native_snapshot(snapshot: &DesktopBrowserCapturedSnapshot) -> bool {
    snapshot.mime_type == "image/png"
        && snapshot.width > 0
        && snapshot.height > 0
        && snapshot.size_bytes > 0
        && !snapshot.bytes_base64.is_empty()
}

/// ANNO-3: crop a full-frame PNG snapshot to the device-pixel clip rect. Engine-agnostic — it
/// decodes the returned PNG (the producer always emits 8-bit RGBA), clamps the clip to the actual
/// buffer bounds (an off-screen / oversized marquee can never read outside the surface), crops, and
/// re-encodes. Returns an error (mapped to `CaptureFailed`) for a non-RGBA8 PNG or an empty/zero-area
/// clamped clip rather than fabricating a partial image. Not platform-gated: it operates purely on
/// the PNG bytes so the crop math is identical on every host and unit-testable without a real WebView.
fn crop_snapshot_png(
    snapshot: DesktopBrowserCapturedSnapshot,
    clip: DesktopBrowserCaptureClipRect,
) -> Result<DesktopBrowserCapturedSnapshot, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

    let raw = BASE64_STANDARD
        .decode(snapshot.bytes_base64.as_bytes())
        .map_err(|error| format!("snapshot crop base64 decode failed: {error}"))?;
    let decoder = png::Decoder::new(raw.as_slice());
    let mut reader = decoder
        .read_info()
        .map_err(|error| format!("snapshot crop PNG header read failed: {error}"))?;
    let mut buffer = vec![0u8; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|error| format!("snapshot crop PNG decode failed: {error}"))?;
    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
        return Err("snapshot crop requires an 8-bit RGBA PNG".to_string());
    }
    let source_width = info.width;
    let source_height = info.height;
    if source_width == 0 || source_height == 0 {
        return Err("snapshot crop source has zero dimensions".to_string());
    }

    // Clamp the clip to the captured buffer bounds.
    let x = clip.x.min(source_width);
    let y = clip.y.min(source_height);
    let width = clip.width.min(source_width - x);
    let height = clip.height.min(source_height - y);
    if width == 0 || height == 0 {
        return Err("snapshot crop clip has zero clamped area".to_string());
    }

    let source_stride = (source_width as usize)
        .checked_mul(4)
        .ok_or_else(|| "snapshot crop source stride overflowed".to_string())?;
    let crop_stride = (width as usize)
        .checked_mul(4)
        .ok_or_else(|| "snapshot crop stride overflowed".to_string())?;
    let crop_len = crop_stride
        .checked_mul(height as usize)
        .ok_or_else(|| "snapshot crop buffer size overflowed".to_string())?;
    let mut cropped = vec![0u8; crop_len];
    for row in 0..height as usize {
        let src_start = (y as usize + row)
            .checked_mul(source_stride)
            .and_then(|offset| offset.checked_add(x as usize * 4))
            .ok_or_else(|| "snapshot crop source offset overflowed".to_string())?;
        let dst_start = row * crop_stride;
        cropped[dst_start..dst_start + crop_stride]
            .copy_from_slice(&buffer[src_start..src_start + crop_stride]);
    }

    let bytes = encode_rgba8_png(width, height, &cropped)?;
    let size_bytes = bytes.len();
    Ok(DesktopBrowserCapturedSnapshot {
        width,
        height,
        size_bytes,
        bytes_base64: BASE64_STANDARD.encode(&bytes),
        ..snapshot
    })
}

/// Encodes an 8-bit RGBA buffer as PNG bytes. Platform-agnostic (the macOS capture path has its own
/// `encode_rgba_png` behind `cfg(target_os = "macos")`; this one is used by the host-side crop seam
/// so cropping works and is testable on every platform).
fn encode_rgba8_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|error| format!("snapshot crop PNG header write failed: {error}"))?;
    writer
        .write_image_data(rgba)
        .map_err(|error| format!("snapshot crop PNG data write failed: {error}"))?;
    drop(writer);
    if bytes.is_empty() {
        return Err("snapshot crop produced empty PNG data".to_string());
    }
    Ok(bytes)
}

#[derive(Clone, Debug)]
pub(crate) struct DesktopBrowserPageInfoSink {
    key: DesktopBrowserViewKey,
    inner: StdArc<Mutex<DesktopBrowserStateInner>>,
}

#[derive(Clone, Copy)]
enum DesktopBrowserPageLoadEvent {
    Started,
    Finished,
}

impl DesktopBrowserPageInfoSink {
    fn new(key: DesktopBrowserViewKey, inner: StdArc<Mutex<DesktopBrowserStateInner>>) -> Self {
        Self { key, inner }
    }

    fn record_requested_navigation(&self, url: String) {
        self.with_view(|view| {
            begin_document_navigation(view, &url);
            view.requested_url = url;
            view.loading_state = DesktopBrowserViewLoadingState::Loading;
            view.last_error = None;
        });
    }

    fn record_title(&self, title: String) {
        self.with_view(|view| {
            view.title = Some(title);
        });
    }

    fn record_page_load(&self, event: DesktopBrowserPageLoadEvent, url: String) {
        self.with_view(|view| match event {
            DesktopBrowserPageLoadEvent::Started => {
                begin_document_navigation(view, &url);
                view.requested_url = url;
                view.loading_state = DesktopBrowserViewLoadingState::Loading;
                view.last_error = None;
            }
            DesktopBrowserPageLoadEvent::Finished => {
                finish_document_navigation(view, &url);
                view.current_url = Some(url.clone());
                view.requested_url = url;
                view.loading_state = DesktopBrowserViewLoadingState::Finished;
                view.last_error = None;
            }
        });
    }

    fn record_rejected_navigation(&self, url: String, reason: &str) {
        self.with_view(|view| {
            view.last_rejected_navigation = Some(DesktopBrowserPageNavigationIssue {
                url,
                reason: reason.to_string(),
            });
        });
    }

    fn record_error(&self, url: String, reason: String) {
        self.with_view(|view| {
            view.last_error = Some(DesktopBrowserPageNavigationIssue { url, reason });
            view.loading_state = DesktopBrowserViewLoadingState::Failed;
        });
    }

    /// Records a render-process termination (macOS WebKit content-process crash) as a recoverable
    /// `Crashed` state, preserving the last good `current_url`/`requested_url` so the engine can
    /// reload the page in place. Sibling of `record_error`, driven by the native
    /// `with_on_web_content_process_terminate_handler` callback — never a JS/eval signal.
    fn record_crash(&self) {
        self.with_view(|view| {
            view.loading_state = DesktopBrowserViewLoadingState::Crashed;
        });
    }

    fn with_view(&self, update: impl FnOnce(&mut DesktopBrowserViewState)) {
        let mut inner = self.inner.lock().expect("browser state lock poisoned");
        if let Some(view) = inner.views.get_mut(&self.key) {
            update(view);
        }
    }
}

/// Native-side wiring the host applies when a view is opened with a diagnostics init script.
/// `Enabled` carries the document-start `init_script` (wires the page's injected devtools to
/// `window.ipc.postMessage(...)`) and the shared `buffer` the host clones into the Wry IPC handler
/// closure; every posted string is appended (oldest dropped past the cap). `Disabled` means no
/// diagnostics were requested, so the host attaches neither the init script nor the IPC handler —
/// full parity with the non-diagnostics path. Mirrors `DesktopBrowserPageInfoSink`'s
/// clone-the-Arc ownership/threading model.
#[derive(Clone, Debug)]
pub(crate) enum DesktopBrowserDiagnosticsSink {
    Disabled,
    Enabled {
        init_script: String,
        buffer: DesktopBrowserDiagnosticsBuffer,
    },
}

impl DesktopBrowserDiagnosticsSink {
    fn new(init_script: Option<String>, buffer: Option<DesktopBrowserDiagnosticsBuffer>) -> Self {
        match (init_script, buffer) {
            (Some(init_script), Some(buffer)) => Self::Enabled {
                init_script,
                buffer,
            },
            _ => Self::Disabled,
        }
    }

    /// The exact buffering the Wry IPC handler performs for one posted string: append it and drop
    /// the oldest entries once a per-view bound is exceeded. A `Disabled` sink ignores the post.
    /// Shared by the real IPC handler closure and the fake host so both exercise the same cap path.
    ///
    /// Three independent bounds keep the buffer from growing unbounded between drains:
    /// - `DESKTOP_BROWSER_DIAGNOSTICS_MAX_MESSAGE_BYTES`: a single oversized envelope is dropped
    ///   outright (it can never fit under the aggregate budget).
    /// - `DESKTOP_BROWSER_DIAGNOSTICS_BUFFER_CAP`: entry-count ceiling.
    /// - `DESKTOP_BROWSER_DIAGNOSTICS_BYTES_CAP`: aggregate byte budget across all buffered entries.
    fn record_message(&self, message: String) {
        let Self::Enabled { buffer, .. } = self else {
            return;
        };
        if message.len() > DESKTOP_BROWSER_DIAGNOSTICS_MAX_MESSAGE_BYTES {
            return;
        }
        let mut entries = buffer.lock().expect("browser diagnostics lock poisoned");
        entries.push_back(message);
        while entries.len() > DESKTOP_BROWSER_DIAGNOSTICS_BUFFER_CAP {
            entries.pop_front();
        }
        let mut buffered_bytes: usize = entries.iter().map(String::len).sum();
        while buffered_bytes > DESKTOP_BROWSER_DIAGNOSTICS_BYTES_CAP {
            match entries.pop_front() {
                Some(dropped) => buffered_bytes = buffered_bytes.saturating_sub(dropped.len()),
                None => break,
            }
        }
    }
}

fn is_initial_document_load(view: &DesktopBrowserViewState, url: &str) -> bool {
    view.navigation_generation == 0
        && view.current_url.is_none()
        && view.requested_url == url
        && view.pending_generation_url.is_none()
}

fn begin_document_navigation(view: &mut DesktopBrowserViewState, url: &str) {
    if is_initial_document_load(view, url) {
        return;
    }

    if view.pending_generation_url.as_deref() == Some(url) {
        return;
    }

    view.navigation_generation = view.navigation_generation.saturating_add(1);
    view.pending_generation_url = Some(url.to_string());
}

fn finish_document_navigation(view: &mut DesktopBrowserViewState, url: &str) {
    if is_initial_document_load(view, url) {
        return;
    }

    if view.pending_generation_url.as_deref() != Some(url) {
        view.navigation_generation = view.navigation_generation.saturating_add(1);
    }
    view.pending_generation_url = None;
}

thread_local! {
    static NATIVE_WEBVIEWS: RefCell<HashMap<StdArc<DesktopBrowserViewKey>, Box<dyn DesktopBrowserWebViewHandle>>> =
        RefCell::new(HashMap::new());
}

fn replace_native_handle(key: DesktopBrowserViewKey, handle: Box<dyn DesktopBrowserWebViewHandle>) {
    NATIVE_WEBVIEWS.with(|views| {
        let mut views = views.borrow_mut();
        // Equal-key insertion retains HashMap's old key. Retire it first so callbacks bound to
        // that original native entry cannot authorize a replacement with the same public ids.
        views.remove(&key);
        views.insert(StdArc::new(key), handle);
    });
}

fn remove_native_handle(key: &DesktopBrowserViewKey) {
    NATIVE_WEBVIEWS.with(|views| {
        views.borrow_mut().remove(key);
    });
}

fn native_capture_source(
    key: &DesktopBrowserViewKey,
) -> Result<Weak<DesktopBrowserViewKey>, String> {
    NATIVE_WEBVIEWS.with(|views| {
        let views = views.borrow();
        let Some((source, _)) = views.get_key_value(key) else {
            return Err("desktop browser native view is missing".to_string());
        };
        // Only the canonical native entry owns this key strongly. Pending work never extends
        // its lifetime: close/replacement invalidates the original source, even with reused ids.
        Ok(StdArc::downgrade(source))
    })
}

fn with_native_handle<T>(
    key: &DesktopBrowserViewKey,
    operation: impl FnOnce(&dyn DesktopBrowserWebViewHandle) -> Result<T, String>,
) -> Result<T, String> {
    NATIVE_WEBVIEWS.with(|views| {
        let views = views.borrow();
        let Some(handle) = views.get(key) else {
            return Err("desktop browser native view is missing".to_string());
        };
        operation(handle.as_ref())
    })
}

fn is_allowed_external_url(raw_url: &str) -> bool {
    let Ok(url) = Url::parse(raw_url) else {
        return false;
    };

    matches!(url.scheme(), "http" | "https") && url.has_host()
}

fn stable_path_segment(raw_id: &str) -> String {
    format!("{:016x}", stable_hash64(raw_id.as_bytes()))
}

fn stable_hash64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn hash128(bytes: &[u8]) -> [u8; 16] {
    let first = stable_hash64(bytes);
    let mut reversed = bytes.to_vec();
    reversed.reverse();
    let second = stable_hash64(&reversed);
    let mut output = [0u8; 16];
    output[..8].copy_from_slice(&first.to_be_bytes());
    output[8..].copy_from_slice(&second.to_be_bytes());
    output
}

fn default_profile_root() -> PathBuf {
    std::env::temp_dir().join("happier-desktop-browser")
}

fn resolve_profile_root<R: Runtime>(window: &Window<R>) -> tauri::Result<PathBuf> {
    Ok(window.app_handle().path().app_data_dir()?.join("browser"))
}

#[cfg(test)]
fn availability_with_host_devtools(
    mut availability: DesktopBrowserAvailability,
    native_devtools: bool,
) -> DesktopBrowserAvailability {
    if availability.available {
        availability.supports = types::DesktopBrowserSupport {
            native_devtools,
            ..availability.supports
        };
    }
    availability
}

struct TauriWryWebViewHost<R: Runtime> {
    window: Window<R>,
}

impl<R: Runtime> TauriWryWebViewHost<R> {
    fn new(window: Window<R>) -> Self {
        Self { window }
    }
}

impl<R: Runtime> DesktopBrowserWebViewHost for TauriWryWebViewHost<R> {
    fn create_webview(
        &self,
        view_id: &str,
        profile_dir: &Path,
        url: &str,
        page_info: DesktopBrowserPageInfoSink,
        diagnostics: DesktopBrowserDiagnosticsSink,
    ) -> Result<Box<dyn DesktopBrowserWebViewHandle>, String> {
        WryDesktopBrowserView::new(
            &self.window,
            view_id,
            profile_dir,
            url,
            page_info,
            diagnostics,
        )
        .map(|handle| Box::new(handle) as Box<dyn DesktopBrowserWebViewHandle>)
    }

    #[cfg(test)]
    fn supports_devtools(&self) -> bool {
        platform::native_devtools_supported()
    }
}

struct WryDesktopBrowserView {
    _context: wry::WebContext,
    webview: wry::WebView,
}

impl WryDesktopBrowserView {
    fn new<R: Runtime>(
        window: &Window<R>,
        view_id: &str,
        profile_dir: &Path,
        url: &str,
        page_info: DesktopBrowserPageInfoSink,
        diagnostics: DesktopBrowserDiagnosticsSink,
    ) -> Result<Self, String> {
        std::fs::create_dir_all(profile_dir).map_err(|error| error.to_string())?;

        let mut context = wry::WebContext::new(Some(profile_dir.to_path_buf()));
        context.set_allows_automation(false);

        let navigation_info = page_info.clone();
        let title_info = page_info.clone();
        #[cfg(target_os = "macos")]
        let crash_info = page_info.clone();
        let load_info = page_info;
        let mut builder = wry::WebViewBuilder::new_with_web_context(&mut context)
            .with_id(view_id)
            .with_url(url)
            .with_visible(false)
            .with_devtools(platform::native_devtools_supported())
            .with_navigation_handler(move |url| {
                if is_allowed_external_url(&url) {
                    navigation_info.record_requested_navigation(url);
                    true
                } else {
                    navigation_info.record_rejected_navigation(url, "unsupported_url");
                    false
                }
            })
            .with_document_title_changed_handler(move |title| {
                title_info.record_title(title);
            })
            .with_on_page_load_handler(move |event, url| {
                let event = match event {
                    wry::PageLoadEvent::Started => DesktopBrowserPageLoadEvent::Started,
                    wry::PageLoadEvent::Finished => DesktopBrowserPageLoadEvent::Finished,
                };
                load_info.record_page_load(event, url);
            })
            .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
            // This child browser intentionally renders arbitrary HTTP(S)
            // pages. The app shell owns Voice capture; remote content must not
            // inherit its process-wide microphone authorization.
            .with_media_capture_enabled(false)
            .with_download_started_handler(|_, _| false);

        // Injected in-page devtools: when the view was opened with a diagnostics init script, run it
        // at document-start on every navigation and buffer the page's `window.ipc.postMessage(...)`
        // batch envelopes for `desktop_browser_drain_diagnostics`. The IPC handler clones the shared
        // buffer Arc (mirroring how the page-info sink clones the shared state Arc) and forwards the
        // raw request body string verbatim — the native side never parses it. Without a diagnostics
        // script we attach neither, preserving parity with the non-diagnostics path.
        if let DesktopBrowserDiagnosticsSink::Enabled { init_script, .. } = &diagnostics {
            let init_script = init_script.clone();
            let ipc_sink = diagnostics.clone();
            builder = builder
                .with_initialization_script(init_script)
                .with_ipc_handler(move |request| {
                    ipc_sink.record_message(request.into_body());
                });
        }

        #[cfg(target_os = "macos")]
        {
            use wry::WebViewBuilderExtDarwin;
            // Native render-process crash recovery: WebKit's content-process termination is the only
            // crash signal the vendored Wry exposes (macOS/iOS only). On terminate we record a
            // recoverable `Crashed` state on the same page-info sink the engine already polls, so a
            // single tab crash surfaces a reloadable surface instead of wedging on a dead page. This
            // is a trusted native callback — no IPC, script, or automation is granted to the page.
            builder = builder
                .with_data_store_identifier(hash128(profile_dir.to_string_lossy().as_bytes()))
                .with_on_web_content_process_terminate_handler(move || {
                    crash_info.record_crash();
                });
        }

        let webview = builder
            .build_as_child(window)
            .map_err(|error| error.to_string())?;

        Ok(Self {
            _context: context,
            webview,
        })
    }
}

impl DesktopBrowserWebViewHandle for WryDesktopBrowserView {
    fn navigation_state(&self) -> Result<(bool, bool), String> {
        Ok((
            self.webview
                .can_go_back()
                .map_err(|error| error.to_string())?,
            self.webview
                .can_go_forward()
                .map_err(|error| error.to_string())?,
        ))
    }

    fn go_back(&self) -> Result<bool, String> {
        self.webview.go_back().map_err(|error| error.to_string())
    }

    fn go_forward(&self) -> Result<bool, String> {
        self.webview.go_forward().map_err(|error| error.to_string())
    }

    fn load_url(&self, url: &str) -> Result<(), String> {
        self.webview
            .load_url(url)
            .map_err(|error| error.to_string())
    }

    fn set_bounds(
        &self,
        rect: types::DesktopBrowserBoundsRect,
        visible: bool,
    ) -> Result<(), String> {
        let bounds = wry::Rect {
            position: wry::dpi::LogicalPosition::new(rect.x, rect.y).into(),
            size: wry::dpi::LogicalSize::new(rect.width, rect.height).into(),
        };
        self.webview
            .set_bounds(bounds)
            .map_err(|error| error.to_string())?;
        self.webview
            .set_visible(visible)
            .map_err(|error| error.to_string())
    }

    fn set_pointer_passthrough(&self, ignore: bool) -> Result<(), String> {
        // The vendored Wry child-webview handle exposes no per-view hit-test/ignore-cursor primitive
        // on any platform (only `set_visible`). Per FP-BRW-DESKTOP-UX-1 §6 we fall closed to the
        // hide-during-drag strategy: when the host needs the gesture to pass through (`ignore`), we
        // hide the native view so the pointer lands on the React/DOM layer instead of being swallowed
        // by the embedded page; when the gesture ends, the host re-issues `set_bounds(visible:true)`
        // through the bounds path to restore it. This never grants the page IPC/script/automation and
        // does not over-claim a per-view passthrough capability that the fork lacks.
        self.webview
            .set_visible(!ignore)
            .map_err(|error| error.to_string())
    }

    fn open_devtools(&self) -> Result<(), String> {
        #[cfg(any(debug_assertions, feature = "devtools"))]
        {
            self.webview.open_devtools();
            return Ok(());
        }

        #[cfg(not(any(debug_assertions, feature = "devtools")))]
        {
            Err("desktop browser devtools are unavailable in this build".to_string())
        }
    }

    fn capture_snapshot(&self, completion: NativeSnapshotCompletion) -> Result<(), String> {
        capture_wry_webview_snapshot(&self.webview, completion)
    }

    fn eval_script(&self, script: &str) -> Result<(), String> {
        // Fire-and-forget: `evaluate_script` returns no JS value. The page surfaces any result
        // back through the diagnostics collector channel (`window.ipc.postMessage(...)`), drained
        // by `desktop_browser_drain_diagnostics`.
        self.webview
            .evaluate_script(script)
            .map_err(|error| error.to_string())
    }

    fn eval_script_with_callback(
        &self,
        script: &str,
        completion: NativeScriptCompletion,
    ) -> Result<(), String> {
        // Wry exposes an Fn callback although a JavaScript evaluation completes once.
        let completion = Mutex::new(Some(completion));
        self.webview
            .evaluate_script_with_callback(script, move |value| {
                if let Some(completion) = completion
                    .lock()
                    .expect("evaluation completion lock")
                    .take()
                {
                    completion(value);
                }
            })
            .map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "macos")]
fn capture_wry_webview_snapshot(
    webview: &wry::WebView,
    completion: NativeSnapshotCompletion,
) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
    use objc2::{rc::Retained, ClassType, MainThreadMarker};
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSError;
    use objc2_web_kit::WKSnapshotConfiguration;
    use std::time::{SystemTime, UNIX_EPOCH};
    use wry::WebViewExtMacOS;

    let main_thread = MainThreadMarker::new()
        .ok_or_else(|| "desktop browser capture must run on the main thread".to_string())?;
    let configuration = unsafe { WKSnapshotConfiguration::new(main_thread) };
    unsafe {
        configuration.setAfterScreenUpdates(true);
    }

    let native_webview = webview.webview();
    let completion = RefCell::new(Some(completion));
    let completion = block2::RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
        let Some(completion) = completion.borrow_mut().take() else {
            return;
        };
        let result = (|| {
            if let Some(error) = unsafe { error.as_ref() } {
                return Err(format!("native WKWebView snapshot failed: {}", error));
            }
            let image = unsafe { Retained::retain(image) }
                .ok_or_else(|| "native WKWebView snapshot did not return an image".to_string())?;
            let size = unsafe { image.size() };
            if size.width <= 0.0 || size.height <= 0.0 {
                return Err("native WKWebView snapshot returned an empty image".to_string());
            }
            let encoded = encode_macos_snapshot_image_as_png(&image)?;
            let size_bytes = encoded.bytes.len();
            let captured_at_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_millis() as u64;
            Ok(DesktopBrowserCapturedSnapshot {
                browser_session_id: String::new(),
                view_id: String::new(),
                navigation_generation: 0,
                capture_request_id: String::new(),
                captured_at_ms,
                mime_type: "image/png".to_string(),
                width: encoded.width,
                height: encoded.height,
                size_bytes,
                bytes_base64: BASE64_STANDARD.encode(encoded.bytes),
            })
        })();
        completion(result);
    });

    unsafe {
        native_webview
            .as_super()
            .takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &completion);
    }

    Ok(())
}

#[cfg(target_os = "macos")]
struct MacOsSnapshotPng {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
}

#[cfg(target_os = "macos")]
fn encode_macos_snapshot_image_as_png(
    image: &objc2_app_kit::NSImage,
) -> Result<MacOsSnapshotPng, String> {
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGBitmapInfo, CGColorSpace, CGContext, CGImageAlphaInfo,
    };
    use objc2_foundation::{NSPoint, NSRect};
    use std::ffi::c_void;

    let size = unsafe { image.size() };
    let mut proposed_rect = NSRect::new(NSPoint::new(0.0, 0.0), size);
    let cg_image =
        unsafe { image.CGImageForProposedRect_context_hints(&mut proposed_rect, None, None) }
            .ok_or_else(|| {
                "native WKWebView snapshot could not produce CGImage data".to_string()
            })?;
    let width = unsafe { objc2_core_graphics::CGImage::width(Some(&cg_image)) };
    let height = unsafe { objc2_core_graphics::CGImage::height(Some(&cg_image)) };
    if width == 0 || height == 0 {
        return Err("native WKWebView snapshot returned an empty CGImage".to_string());
    }

    let bytes_per_pixel = 4usize;
    let bytes_per_row = width
        .checked_mul(bytes_per_pixel)
        .ok_or_else(|| "native WKWebView snapshot row size overflowed".to_string())?;
    let buffer_len = bytes_per_row
        .checked_mul(height)
        .ok_or_else(|| "native WKWebView snapshot buffer size overflowed".to_string())?;
    let mut rgba = vec![0u8; buffer_len];
    let color_space = unsafe { CGColorSpace::new_device_rgb() }.ok_or_else(|| {
        "native WKWebView snapshot could not allocate RGB color space".to_string()
    })?;
    let bitmap_info = CGBitmapInfo::ByteOrder32Big.0 | CGImageAlphaInfo::PremultipliedLast.0;
    let context = unsafe {
        CGBitmapContextCreate(
            rgba.as_mut_ptr().cast::<c_void>(),
            width,
            height,
            8,
            bytes_per_row,
            Some(&color_space),
            bitmap_info,
        )
    }
    .ok_or_else(|| "native WKWebView snapshot could not allocate bitmap context".to_string())?;
    let draw_rect = NSRect::new(
        NSPoint::new(0.0, 0.0),
        objc2_foundation::NSSize::new(width as f64, height as f64),
    );
    unsafe {
        CGContext::draw_image(Some(&context), draw_rect, Some(&cg_image));
    }

    Ok(MacOsSnapshotPng {
        bytes: encode_rgba_png(width, height, &rgba)?,
        width: png_dimension(width, "width")?,
        height: png_dimension(height, "height")?,
    })
}

#[cfg(target_os = "macos")]
fn encode_rgba_png(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(
        &mut bytes,
        png_dimension(width, "width")?,
        png_dimension(height, "height")?,
    );
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|error| format!("native WKWebView snapshot PNG header failed: {error}"))?;
    writer
        .write_image_data(rgba)
        .map_err(|error| format!("native WKWebView snapshot PNG data failed: {error}"))?;
    drop(writer);
    if bytes.is_empty() {
        return Err("native WKWebView snapshot returned empty PNG data".to_string());
    }

    Ok(bytes)
}

#[cfg(target_os = "macos")]
fn png_dimension(value: usize, label: &str) -> Result<u32, String> {
    u32::try_from(value).map_err(|_| format!("native WKWebView snapshot PNG {label} exceeded u32"))
}

#[cfg(not(target_os = "macos"))]
fn capture_wry_webview_snapshot(
    _webview: &wry::WebView,
    _completion: NativeSnapshotCompletion,
) -> Result<(), String> {
    Err("desktop browser capture is unsupported on this platform".to_string())
}

#[cfg(test)]
mod tests;
