use super::platform::{
    child_embedding_verified_for,
    native_devtools_supported, resolve_desktop_browser_strategy,
    resolve_desktop_browser_strategy_for_runtime, DesktopBrowserRuntimeSupport,
};
use super::types::{
    DesktopBrowserAvailability, DesktopBrowserBoundsPayload, DesktopBrowserBoundsRect,
    DesktopBrowserCaptureClipRect,
    DesktopBrowserCaptureErrorCode, DesktopBrowserCaptureRecordingFrameRequest,
    DesktopBrowserCaptureSnapshotRequest,
    DesktopBrowserCapturedSnapshot, DesktopBrowserDisabledReason,
    DesktopBrowserDispatchNavigationRequest, DesktopBrowserEvalScriptRequest,
    DesktopBrowserNavigationDispatchKind, DesktopBrowserOpenViewRequest, DesktopBrowserPlatform,
    DesktopBrowserPrimitive,
    DesktopBrowserProducer, DesktopBrowserRenderEngine, DesktopBrowserSupport,
    DesktopBrowserViewCommandRequest, DesktopBrowserViewLoadingState,
};
use super::{
    write_recording_frame_file, DesktopBrowserPageLoadEvent, DesktopBrowserState, DesktopBrowserWebViewHandle,
    DesktopBrowserWebViewHost,
};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

const DESKTOP_BROWSER_COMMANDS: &[&str] = &[
    "desktop_browser_get_availability",
    "desktop_browser_open_view",
    "desktop_browser_navigate",
    "desktop_browser_set_bounds",
    "desktop_browser_set_pointer_passthrough",
    "desktop_browser_close_view",
    "desktop_browser_open_devtools",
    "desktop_browser_get_page_info",
    "desktop_browser_capture_snapshot",
    "desktop_browser_capture_recording_frame",
    "desktop_browser_drain_diagnostics",
    "desktop_browser_eval_script",
    "desktop_browser_dispatch_navigation",
];

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn repo_root() -> PathBuf {
    manifest_dir()
        .ancestors()
        .nth(3)
        .expect("src-tauri should live under apps/ui")
        .to_path_buf()
}

fn read_capability_file(name: &str) -> Value {
    let path = manifest_dir().join("capabilities").join(name);
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
    serde_json::from_str(&raw)
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", path.display()))
}

fn read_manifest_file(relative_path: &str) -> String {
    let path = manifest_dir().join(relative_path);
    fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()))
}

fn repo_path_is_ignored(relative_path: &str) -> bool {
    let status = Command::new("git")
        .arg("-C")
        .arg(repo_root())
        .arg("check-ignore")
        .arg("--quiet")
        .arg(relative_path)
        .status()
        .expect("git check-ignore should run");

    status.success()
}

fn open_request(view_id: &str, profile_id: &str, url: &str) -> DesktopBrowserOpenViewRequest {
    DesktopBrowserOpenViewRequest {
        browser_session_id: "browser_session_1".to_string(),
        view_id: view_id.to_string(),
        profile_id: profile_id.to_string(),
        url: url.to_string(),
        diagnostics_init_script: None,
    }
}

fn open_request_with_diagnostics(
    view_id: &str,
    profile_id: &str,
    url: &str,
    diagnostics_init_script: &str,
) -> DesktopBrowserOpenViewRequest {
    DesktopBrowserOpenViewRequest {
        diagnostics_init_script: Some(diagnostics_init_script.to_string()),
        ..open_request(view_id, profile_id, url)
    }
}

fn view_request(view_id: &str) -> DesktopBrowserViewCommandRequest {
    DesktopBrowserViewCommandRequest {
        browser_session_id: "browser_session_1".to_string(),
        view_id: view_id.to_string(),
        url: None,
    }
}

fn eval_request(view_id: &str, script: &str) -> DesktopBrowserEvalScriptRequest {
    DesktopBrowserEvalScriptRequest {
        browser_session_id: "browser_session_1".to_string(),
        view_id: view_id.to_string(),
        script: script.to_string(),
    }
}

fn dispatch_navigation_request(
    view_id: &str,
    kind: DesktopBrowserNavigationDispatchKind,
) -> DesktopBrowserDispatchNavigationRequest {
    DesktopBrowserDispatchNavigationRequest {
        browser_session_id: "browser_session_1".to_string(),
        view_id: view_id.to_string(),
        kind,
    }
}

fn capture_request(
    view_id: &str,
    navigation_generation: u64,
) -> DesktopBrowserCaptureSnapshotRequest {
    DesktopBrowserCaptureSnapshotRequest {
        browser_session_id: "browser_session_1".to_string(),
        view_id: view_id.to_string(),
        navigation_generation,
        capture_request_id: "capture_request_1".to_string(),
        clip: None,
    }
}

/// Encodes a deterministic 8-bit RGBA PNG where pixel (x,y) carries `R = x`, `G = y`, `B = 0`,
/// `A = 255`, so a crop test can assert the cropped pixels came from the requested sub-rectangle.
fn encode_test_rgba_png(width: u32, height: u32) -> String {
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
    let mut rgba = vec![0u8; (width * height * 4) as usize];
    for y in 0..height {
        for x in 0..width {
            let i = ((y * width + x) * 4) as usize;
            rgba[i] = x as u8;
            rgba[i + 1] = y as u8;
            rgba[i + 2] = 0;
            rgba[i + 3] = 255;
        }
    }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("png header");
        writer.write_image_data(&rgba).expect("png data");
    }
    BASE64_STANDARD.encode(&bytes)
}

/// Decodes a base64 PNG into (width, height, rgba8) for crop assertions.
fn decode_rgba_png(bytes_base64: &str) -> (u32, u32, Vec<u8>) {
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
    let raw = BASE64_STANDARD.decode(bytes_base64).expect("base64");
    let decoder = png::Decoder::new(raw.as_slice());
    let mut reader = decoder.read_info().expect("png info");
    let mut buffer = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buffer).expect("png frame");
    buffer.truncate(info.buffer_size());
    (info.width, info.height, buffer)
}

fn recording_frame_request(
    view_id: &str,
    navigation_generation: u64,
    output_path: &str,
    max_bytes: usize,
) -> DesktopBrowserCaptureRecordingFrameRequest {
    DesktopBrowserCaptureRecordingFrameRequest {
        browser_session_id: "browser_session_1".to_string(),
        view_id: view_id.to_string(),
        navigation_generation,
        capture_request_id: "capture_request_1".to_string(),
        output_path: output_path.to_string(),
        max_bytes,
    }
}

#[cfg(target_os = "macos")]
fn read_png_dimensions(bytes: &[u8]) -> (u32, u32) {
    assert!(
        bytes.len() >= 24,
        "PNG fixture should include IHDR dimensions"
    );
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    let width = u32::from_be_bytes(bytes[16..20].try_into().expect("PNG width bytes"));
    let height = u32::from_be_bytes(bytes[20..24].try_into().expect("PNG height bytes"));
    (width, height)
}

fn navigate_request(view_id: &str, url: &str) -> DesktopBrowserViewCommandRequest {
    DesktopBrowserViewCommandRequest {
        url: Some(url.to_string()),
        ..view_request(view_id)
    }
}

fn bounds_request(view_id: &str, visible: bool) -> DesktopBrowserBoundsPayload {
    DesktopBrowserBoundsPayload {
        browser_session_id: "browser_session_1".to_string(),
        view_id: view_id.to_string(),
        visible,
        rect: DesktopBrowserBoundsRect {
            x: 12.0,
            y: 24.0,
            width: 320.0,
            height: 180.0,
            scale_factor: 2.0,
        },
    }
}

fn passthrough_request(
    view_id: &str,
    ignore: bool,
) -> super::DesktopBrowserPointerPassthroughPayload {
    super::DesktopBrowserPointerPassthroughPayload {
        browser_session_id: "browser_session_1".to_string(),
        view_id: view_id.to_string(),
        ignore,
    }
}

fn available_test_availability() -> DesktopBrowserAvailability {
    DesktopBrowserAvailability::available(
        DesktopBrowserPlatform::Windows,
        DesktopBrowserPrimitive::WindowsHwndWebView2,
        DesktopBrowserSupport {
            navigation: true,
            page_info_diagnostics: true,
            ..DesktopBrowserSupport::default()
        },
    )
}

fn assert_native_child_view_available(
    availability: &DesktopBrowserAvailability,
    platform: DesktopBrowserPlatform,
    primitive: DesktopBrowserPrimitive,
    capture_supported: bool,
) {
    assert_eq!(availability.platform, platform);
    assert_eq!(availability.primitive, primitive);
    assert!(availability.available);
    assert_eq!(
        availability.render_engine,
        DesktopBrowserRenderEngine::DesktopWebView
    );
    assert_eq!(
        availability.producer,
        DesktopBrowserProducer::TauriWryNativeChildView
    );
    assert!(!availability.privileged_ipc);
    assert!(availability.supports.navigation);
    assert_eq!(
        availability.supports.native_devtools,
        native_devtools_supported()
    );
    assert!(!availability.supports.go_back_forward);
    assert!(!availability.supports.reload);
    assert!(!availability.supports.stop);
    assert!(availability.supports.page_info_diagnostics);
    assert_eq!(availability.supports.capture, capture_supported);
    assert!(!availability.supports.recording);
    assert!(!availability.supports.automation);
    assert!(availability.disabled_reasons.is_empty());
}

#[derive(Clone, Debug, PartialEq)]
enum FakeWebViewEvent {
    Created {
        view_id: String,
        profile_dir: PathBuf,
        url: String,
    },
    Navigated {
        view_id: String,
        url: String,
    },
    Bounds {
        view_id: String,
        rect: DesktopBrowserBoundsRect,
        visible: bool,
    },
    PointerPassthrough {
        view_id: String,
        ignore: bool,
    },
    Devtools {
        view_id: String,
    },
    Captured {
        view_id: String,
    },
    EvalScript {
        view_id: String,
        script: String,
    },
    Dropped {
        view_id: String,
    },
}

#[derive(Clone, Debug)]
struct FakeWebViewLog {
    events: Arc<Mutex<Vec<FakeWebViewEvent>>>,
}

impl FakeWebViewLog {
    fn new() -> Self {
        Self {
            events: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn push(&self, event: FakeWebViewEvent) {
        self.events
            .lock()
            .expect("fake log lock poisoned")
            .push(event);
    }

    fn events(&self) -> Vec<FakeWebViewEvent> {
        self.events.lock().expect("fake log lock poisoned").clone()
    }
}

#[derive(Clone)]
struct FakeWebViewHost {
    log: FakeWebViewLog,
    devtools_supported: bool,
    capture_result: Arc<Mutex<Result<DesktopBrowserCapturedSnapshot, String>>>,
    on_capture: Option<Arc<dyn Fn() + Send + Sync>>,
    page_info_by_view_id: Arc<Mutex<HashMap<String, super::DesktopBrowserPageInfoSink>>>,
    diagnostics_by_view_id: Arc<Mutex<HashMap<String, super::DesktopBrowserDiagnosticsSink>>>,
    /// Last script each view received via `eval_script`, recorded by the fake handle so an eval
    /// test can assert the exact JS that reached the webview.
    last_script_by_view_id: Arc<Mutex<HashMap<String, String>>>,
}

impl FakeWebViewHost {
    fn new(devtools_supported: bool) -> Self {
        Self {
            log: FakeWebViewLog::new(),
            devtools_supported,
            capture_result: Arc::new(Mutex::new(Ok(DesktopBrowserCapturedSnapshot {
                browser_session_id: "native_placeholder".to_string(),
                view_id: "native_placeholder".to_string(),
                navigation_generation: 999,
                capture_request_id: "native_placeholder".to_string(),
                captured_at_ms: 123_456,
                mime_type: "image/png".to_string(),
                width: 4,
                height: 3,
                size_bytes: 4,
                bytes_base64: "AQIDBA==".to_string(),
            }))),
            on_capture: None,
            page_info_by_view_id: Arc::new(Mutex::new(HashMap::new())),
            diagnostics_by_view_id: Arc::new(Mutex::new(HashMap::new())),
            last_script_by_view_id: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn last_script(&self, view_id: &str) -> Option<String> {
        self.last_script_by_view_id
            .lock()
            .expect("fake eval-script lock poisoned")
            .get(view_id)
            .cloned()
    }

    /// Mirror the Wry IPC handler: drive the captured diagnostics sink for a view the same way a
    /// page's `window.ipc.postMessage(string)` would, so the buffering + drain path is exercised
    /// end-to-end without a real WebView.
    fn simulate_diagnostics_post(&self, view_id: &str, message: &str) {
        let sink = self
            .diagnostics_by_view_id
            .lock()
            .expect("fake diagnostics lock poisoned")
            .get(view_id)
            .unwrap_or_else(|| panic!("missing fake diagnostics sink for {view_id}"))
            .clone();
        sink.record_message(message.to_string());
    }

    fn with_capture_hook(on_capture: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            on_capture: Some(Arc::new(on_capture)),
            ..Self::new(false)
        }
    }

    fn simulate_native_navigation(&self, view_id: &str, url: &str) {
        let page_info = self
            .page_info_by_view_id
            .lock()
            .expect("fake page-info lock poisoned")
            .get(view_id)
            .unwrap_or_else(|| panic!("missing fake page-info sink for {view_id}"))
            .clone();
        page_info.record_requested_navigation(url.to_string());
        page_info.record_page_load(DesktopBrowserPageLoadEvent::Started, url.to_string());
        page_info.record_title(format!("Loaded {url}"));
        page_info.record_page_load(DesktopBrowserPageLoadEvent::Finished, url.to_string());
    }

    /// Mirror the macOS `with_on_web_content_process_terminate_handler` callback (the only
    /// platform with a native crash signal in the vendored Wry) so the crashed loading-state
    /// can be exercised without a real WebKit content-process kill.
    fn simulate_native_render_process_crash(&self, view_id: &str) {
        let page_info = self
            .page_info_by_view_id
            .lock()
            .expect("fake page-info lock poisoned")
            .get(view_id)
            .unwrap_or_else(|| panic!("missing fake page-info sink for {view_id}"))
            .clone();
        page_info.record_crash();
    }
}

impl DesktopBrowserWebViewHost for FakeWebViewHost {
    fn create_webview(
        &self,
        view_id: &str,
        profile_dir: &Path,
        url: &str,
        page_info: super::DesktopBrowserPageInfoSink,
        diagnostics: super::DesktopBrowserDiagnosticsSink,
    ) -> Result<Box<dyn DesktopBrowserWebViewHandle>, String> {
        self.log.push(FakeWebViewEvent::Created {
            view_id: view_id.to_string(),
            profile_dir: profile_dir.to_path_buf(),
            url: url.to_string(),
        });
        self.diagnostics_by_view_id
            .lock()
            .expect("fake diagnostics lock poisoned")
            .insert(view_id.to_string(), diagnostics);
        self.page_info_by_view_id
            .lock()
            .expect("fake page-info lock poisoned")
            .insert(view_id.to_string(), page_info.clone());
        page_info.record_page_load(DesktopBrowserPageLoadEvent::Started, url.to_string());
        page_info.record_title(format!("Loaded {url}"));
        page_info.record_page_load(DesktopBrowserPageLoadEvent::Finished, url.to_string());
        Ok(Box::new(FakeWebViewHandle {
            view_id: view_id.to_string(),
            log: self.log.clone(),
            page_info,
            capture_result: self.capture_result.clone(),
            on_capture: self.on_capture.clone(),
            last_script_by_view_id: self.last_script_by_view_id.clone(),
        }))
    }

    fn supports_devtools(&self) -> bool {
        self.devtools_supported
    }
}

struct FakeWebViewHandle {
    view_id: String,
    log: FakeWebViewLog,
    page_info: super::DesktopBrowserPageInfoSink,
    capture_result: Arc<Mutex<Result<DesktopBrowserCapturedSnapshot, String>>>,
    on_capture: Option<Arc<dyn Fn() + Send + Sync>>,
    last_script_by_view_id: Arc<Mutex<HashMap<String, String>>>,
}

impl DesktopBrowserWebViewHandle for FakeWebViewHandle {
    fn load_url(&self, url: &str) -> Result<(), String> {
        self.log.push(FakeWebViewEvent::Navigated {
            view_id: self.view_id.clone(),
            url: url.to_string(),
        });
        self.page_info
            .record_page_load(DesktopBrowserPageLoadEvent::Started, url.to_string());
        self.page_info.record_title(format!("Loaded {url}"));
        self.page_info
            .record_page_load(DesktopBrowserPageLoadEvent::Finished, url.to_string());
        Ok(())
    }

    fn set_bounds(&self, rect: DesktopBrowserBoundsRect, visible: bool) -> Result<(), String> {
        self.log.push(FakeWebViewEvent::Bounds {
            view_id: self.view_id.clone(),
            rect,
            visible,
        });
        Ok(())
    }

    fn set_pointer_passthrough(&self, ignore: bool) -> Result<(), String> {
        self.log.push(FakeWebViewEvent::PointerPassthrough {
            view_id: self.view_id.clone(),
            ignore,
        });
        Ok(())
    }

    fn open_devtools(&self) -> Result<(), String> {
        self.log.push(FakeWebViewEvent::Devtools {
            view_id: self.view_id.clone(),
        });
        Ok(())
    }

    fn capture_snapshot(&self) -> Result<DesktopBrowserCapturedSnapshot, String> {
        self.log.push(FakeWebViewEvent::Captured {
            view_id: self.view_id.clone(),
        });
        if let Some(on_capture) = &self.on_capture {
            on_capture();
        }
        self.capture_result
            .lock()
            .expect("fake capture lock poisoned")
            .clone()
    }

    fn eval_script(&self, script: &str) -> Result<(), String> {
        self.log.push(FakeWebViewEvent::EvalScript {
            view_id: self.view_id.clone(),
            script: script.to_string(),
        });
        self.last_script_by_view_id
            .lock()
            .expect("fake eval-script lock poisoned")
            .insert(self.view_id.clone(), script.to_string());
        Ok(())
    }
}

impl Drop for FakeWebViewHandle {
    fn drop(&mut self) {
        self.log.push(FakeWebViewEvent::Dropped {
            view_id: self.view_id.clone(),
        });
    }
}

fn permission_name_for_command(command: &str) -> String {
    format!("allow-{}", command.replace('_', "-"))
}

fn verified_child_embedding_runtime_support() -> DesktopBrowserRuntimeSupport {
    DesktopBrowserRuntimeSupport {
        macos_custom_data_store_identifiers: true,
        child_embedding_verified: true,
    }
}

#[test]
fn platform_strategy_advertises_verified_native_child_views_without_privileged_ipc() {
    // With recorded child-embedding verification these platforms advertise the native child view
    // (the post-flip state). The unverified/fail-closed state is covered separately.
    assert_native_child_view_available(
        &resolve_desktop_browser_strategy_for_runtime(
            DesktopBrowserPlatform::Windows,
            verified_child_embedding_runtime_support(),
        ),
        DesktopBrowserPlatform::Windows,
        DesktopBrowserPrimitive::WindowsHwndWebView2,
        false,
    );

    assert_native_child_view_available(
        &resolve_desktop_browser_strategy_for_runtime(
            DesktopBrowserPlatform::LinuxX11,
            verified_child_embedding_runtime_support(),
        ),
        DesktopBrowserPlatform::LinuxX11,
        DesktopBrowserPrimitive::LinuxX11ChildEmbedding,
        false,
    );
}

#[test]
fn windows_and_x11_availability_is_gated_behind_verified_child_embedding() {
    // Pre-verification (no recorded manual-QA evidence): both platforms must fall closed to an
    // honest typed-unavailable rather than advertise an enabled browser that dies at
    // `build_as_child`. This is the capability-truth flip the packet exists to make.
    for (platform, primitive, reason) in [
        (
            DesktopBrowserPlatform::Windows,
            DesktopBrowserPrimitive::WindowsHwndWebView2,
            DesktopBrowserDisabledReason::NativeChildViewUnimplemented,
        ),
        (
            DesktopBrowserPlatform::LinuxX11,
            DesktopBrowserPrimitive::LinuxX11ChildEmbedding,
            DesktopBrowserDisabledReason::LinuxX11ChildEmbeddingUnimplemented,
        ),
    ] {
        let unverified = resolve_desktop_browser_strategy_for_runtime(
            platform,
            DesktopBrowserRuntimeSupport {
                macos_custom_data_store_identifiers: false,
                child_embedding_verified: false,
            },
        );
        assert!(
            !unverified.available,
            "{platform:?} must be unavailable until child-embedding is verified",
        );
        assert_eq!(unverified.platform, platform);
        assert_eq!(unverified.primitive, primitive);
        assert_eq!(unverified.disabled_reasons, vec![reason]);
        assert!(!unverified.supports.navigation);
        assert!(!unverified.privileged_ipc);

        let verified = resolve_desktop_browser_strategy_for_runtime(
            platform,
            DesktopBrowserRuntimeSupport {
                macos_custom_data_store_identifiers: false,
                child_embedding_verified: true,
            },
        );
        assert_native_child_view_available(&verified, platform, primitive, false);
    }
}

#[test]
fn child_embedding_verification_defaults_pin_windows_and_x11_to_false() {
    assert!(!child_embedding_verified_for(DesktopBrowserPlatform::Windows));
    assert!(!child_embedding_verified_for(DesktopBrowserPlatform::LinuxX11));
}

#[test]
fn unverified_platform_can_never_report_available() {
    // Capability-truth regression guard: a future accidental flip that leaves
    // `child_embedding_verified: false` must never produce `available: true` for the
    // embedding-gated platforms. macOS rides its own WK-data-store gate and is exempt here.
    for platform in [
        DesktopBrowserPlatform::Windows,
        DesktopBrowserPlatform::LinuxX11,
    ] {
        let availability = resolve_desktop_browser_strategy_for_runtime(
            platform,
            DesktopBrowserRuntimeSupport {
                macos_custom_data_store_identifiers: true,
                child_embedding_verified: false,
            },
        );
        assert!(
            !availability.available,
            "{platform:?} must stay unavailable while child-embedding is unverified",
        );
    }
}

#[test]
fn macos_strategy_requires_custom_wk_data_store_identifier_support() {
    let available = resolve_desktop_browser_strategy_for_runtime(
        DesktopBrowserPlatform::MacOs,
        DesktopBrowserRuntimeSupport {
            macos_custom_data_store_identifiers: true,
            child_embedding_verified: false,
        },
    );
    assert_native_child_view_available(
        &available,
        DesktopBrowserPlatform::MacOs,
        DesktopBrowserPrimitive::MacOsNsViewWebKit,
        true,
    );

    let unavailable = resolve_desktop_browser_strategy_for_runtime(
        DesktopBrowserPlatform::MacOs,
        DesktopBrowserRuntimeSupport {
            macos_custom_data_store_identifiers: false,
            child_embedding_verified: false,
        },
    );
    assert!(!unavailable.available);
    assert_eq!(
        unavailable.disabled_reasons,
        vec![DesktopBrowserDisabledReason::NativeChildViewUnimplemented]
    );
    assert!(!unavailable.supports.navigation);
    assert!(!unavailable.privileged_ipc);
}

#[test]
fn macos_strategy_advertises_capture_only_when_wk_snapshot_is_backed() {
    let macos = resolve_desktop_browser_strategy_for_runtime(
        DesktopBrowserPlatform::MacOs,
        DesktopBrowserRuntimeSupport {
            macos_custom_data_store_identifiers: true,
            child_embedding_verified: false,
        },
    );
    assert!(macos.available);
    assert!(macos.supports.capture);
    assert!(!macos.supports.recording);

    for availability in [
        resolve_desktop_browser_strategy_for_runtime(
            DesktopBrowserPlatform::Windows,
            verified_child_embedding_runtime_support(),
        ),
        resolve_desktop_browser_strategy_for_runtime(
            DesktopBrowserPlatform::LinuxX11,
            verified_child_embedding_runtime_support(),
        ),
        resolve_desktop_browser_strategy(DesktopBrowserPlatform::LinuxWayland),
    ] {
        assert!(!availability.supports.capture);
        assert!(!availability.supports.recording);
    }
}

#[test]
fn linux_strategy_keeps_wayland_unavailable_until_gtk_container_embedding_is_proven() {
    let x11 = resolve_desktop_browser_strategy_for_runtime(
        DesktopBrowserPlatform::LinuxX11,
        verified_child_embedding_runtime_support(),
    );
    assert_native_child_view_available(
        &x11,
        DesktopBrowserPlatform::LinuxX11,
        DesktopBrowserPrimitive::LinuxX11ChildEmbedding,
        false,
    );

    let wayland = resolve_desktop_browser_strategy(DesktopBrowserPlatform::LinuxWayland);
    assert_eq!(
        wayland.primitive,
        DesktopBrowserPrimitive::LinuxWaylandGtkEmbedding
    );
    assert!(!wayland.available);
    assert_eq!(
        wayland.disabled_reasons,
        vec![DesktopBrowserDisabledReason::LinuxWaylandGtkEmbeddingUnimplemented]
    );
    assert_ne!(x11.primitive, wayland.primitive);
}

#[test]
fn native_state_calls_host_when_platform_strategy_is_available() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        resolve_desktop_browser_strategy_for_runtime(
            DesktopBrowserPlatform::Windows,
            verified_child_embedding_runtime_support(),
        ),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    let result = state.open_view(open_request(
        "view_1",
        "profile_1",
        "https://example.test/start",
    ));

    assert!(result.ok);
    let events = host.log.events();
    assert_eq!(events.len(), 1);
    let FakeWebViewEvent::Created {
        view_id,
        profile_dir,
        url,
    } = &events[0]
    else {
        panic!("expected created event");
    };
    assert_eq!(view_id, "view_1");
    assert_eq!(url, "https://example.test/start");
    assert!(profile_dir.starts_with(temp_dir.path().join("profiles")));
    assert!(!profile_dir.ends_with("profile_1"));
}

#[test]
fn native_state_does_not_call_host_for_unavailable_platform_strategy() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        resolve_desktop_browser_strategy(DesktopBrowserPlatform::LinuxWayland),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    let result = state.open_view(open_request(
        "view_1",
        "profile_1",
        "https://example.test/start",
    ));

    assert!(!result.ok);
    assert!(host.log.events().is_empty());
}

#[test]
fn desktop_browser_commands_have_generated_tauri_acl_permissions() {
    for command in DESKTOP_BROWSER_COMMANDS {
        let path = manifest_dir()
            .join("permissions")
            .join("autogenerated")
            .join(format!("{command}.toml"));
        let raw = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));

        assert!(
            raw.contains(&format!(
                "identifier = \"{}\"",
                permission_name_for_command(command)
            )),
            "{} should declare allow permission",
            path.display(),
        );
        assert!(
            raw.contains(&format!("commands.allow = [\"{command}\"]")),
            "{} should allow the command",
            path.display(),
        );
    }
}

#[test]
fn default_capability_allows_desktop_browser_bridge_commands_for_main_window() {
    let default_capability = read_capability_file("default.json");
    assert_eq!(default_capability["windows"], serde_json::json!(["main"]));

    let permissions = default_capability["permissions"]
        .as_array()
        .expect("default capability permissions should be an array");

    for command in DESKTOP_BROWSER_COMMANDS {
        let permission = permission_name_for_command(command);
        assert!(
            permissions.contains(&Value::String(permission.clone())),
            "default capability should include {permission}",
        );
    }
}

#[test]
fn build_manifest_generates_acl_permissions_for_registered_desktop_browser_commands() {
    let build_rs = read_manifest_file("build.rs");

    for command in DESKTOP_BROWSER_COMMANDS {
        assert!(
            build_rs.contains(&format!("\"{command}\"")),
            "build.rs APP_TAURI_COMMANDS should include {command}",
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn macos_snapshot_encoder_outputs_canonical_png_bytes_for_appkit_image() {
    use super::encode_macos_snapshot_image_as_png;
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
    use objc2::AnyThread;
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSData;
    use std::ffi::c_void;

    let source_png = BASE64_STANDARD
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=")
        .expect("fixture PNG should decode");
    let data = unsafe {
        NSData::dataWithBytes_length(source_png.as_ptr().cast::<c_void>(), source_png.len())
    };
    let image = NSImage::initWithData(NSImage::alloc(), &data).expect("fixture PNG should load");

    let encoded =
        encode_macos_snapshot_image_as_png(&image).expect("AppKit image should encode as PNG");

    assert_eq!(&encoded.bytes[..8], b"\x89PNG\r\n\x1a\n");
    assert!(encoded.bytes.len() > 8);
}

#[cfg(target_os = "macos")]
#[test]
fn macos_snapshot_encoder_reports_encoded_pixel_dimensions_not_point_size() {
    use super::{encode_macos_snapshot_image_as_png, encode_rgba_png};
    use objc2::AnyThread;
    use objc2_app_kit::NSImage;
    use objc2_foundation::{NSData, NSSize};
    use std::ffi::c_void;

    let source_png = encode_rgba_png(
        2,
        2,
        &[
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ],
    )
    .expect("fixture PNG should encode");
    let data = unsafe {
        NSData::dataWithBytes_length(source_png.as_ptr().cast::<c_void>(), source_png.len())
    };
    let image = NSImage::initWithData(NSImage::alloc(), &data).expect("fixture PNG should load");
    unsafe {
        image.setSize(NSSize::new(1.0, 1.0));
    }

    let encoded =
        encode_macos_snapshot_image_as_png(&image).expect("AppKit image should encode as PNG");

    assert_eq!(encoded.width, 2);
    assert_eq!(encoded.height, 2);
    assert_eq!(read_png_dimensions(&encoded.bytes), (2, 2));
}

#[test]
fn wry_path_patch_exposes_only_the_small_durable_fork() {
    let cargo_toml = read_manifest_file("Cargo.toml");
    assert!(cargo_toml.contains(r#"wry = { path = "vendor/wry" }"#));

    for path in [
        "apps/ui/src-tauri/vendor/wry/Cargo.toml",
        "apps/ui/src-tauri/vendor/wry/src/wkwebview/mod.rs",
        "apps/ui/src-tauri/vendor/wry/src/webview2/mod.rs",
        "apps/ui/src-tauri/vendor/wry/src/webkitgtk/mod.rs",
    ] {
        assert!(!repo_path_is_ignored(path), "{path} must be repo-visible");
    }

    assert!(
        repo_path_is_ignored("apps/ui/src-tauri/vendor/tauri-plugin-mcp-bridge/Cargo.toml"),
        "the huge MCP bridge vendor tree must stay ignored"
    );
}

#[test]
fn vendored_wry_ipc_bridge_is_only_registered_when_a_handler_exists() {
    let webview2 = read_manifest_file("vendor/wry/src/webview2/mod.rs");
    assert!(webview2.contains(
        "if attributes.ipc_handler.is_some() {\n      unsafe { Self::attach_ipc_handler"
    ));

    let webkitgtk = read_manifest_file("vendor/wry/src/webkitgtk/mod.rs");
    assert!(
        webkitgtk.contains("if attributes.ipc_handler.is_some() {\n      Self::attach_ipc_handler")
    );

    let wkwebview = read_manifest_file("vendor/wry/src/wkwebview/mod.rs");
    assert!(wkwebview.contains("let should_initialize_ipc = ipc_handler_delegate.is_some();"));
    assert!(wkwebview.contains("if should_initialize_ipc {\n        w.init("));
}

#[test]
fn native_state_opens_views_with_isolated_sanitized_profile_directories() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    let result = state.open_view(open_request(
        "view/../../raw",
        "profile/../../secret",
        "https://example.test/start",
    ));

    assert!(result.ok);
    assert_eq!(state.view_count(), 1);
    assert_eq!(state.profile_count(), 1);

    let events = host.log.events();
    let FakeWebViewEvent::Created {
        profile_dir, url, ..
    } = &events[0]
    else {
        panic!("expected created event");
    };
    assert_eq!(url, "https://example.test/start");
    assert!(profile_dir.starts_with(temp_dir.path()));
    assert!(!profile_dir.components().any(|component| {
        component.as_os_str() == "profile"
            || component.as_os_str() == ".."
            || component.as_os_str() == "secret"
    }));
}

#[test]
fn native_state_rejects_invalid_and_privileged_url_schemes() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    for url in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "happier://internal",
        "nota url",
    ] {
        let result = state.open_view(open_request("view_1", "profile_1", url));
        assert!(!result.ok, "{url} should be rejected");
    }

    assert_eq!(state.view_count(), 0);
    assert!(host.log.events().is_empty());
}

#[test]
fn native_state_navigates_and_updates_bounds_for_existing_view() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );
    assert!(
        state
            .navigate(navigate_request("view_1", "https://example.test/next"))
            .ok
    );
    assert!(state.set_bounds(bounds_request("view_1", true)).ok);

    assert!(host.log.events().contains(&FakeWebViewEvent::Navigated {
        view_id: "view_1".to_string(),
        url: "https://example.test/next".to_string(),
    }));
    assert!(host.log.events().contains(&FakeWebViewEvent::Bounds {
        view_id: "view_1".to_string(),
        rect: bounds_request("view_1", true).rect,
        visible: true,
    }));
}

#[test]
fn native_state_toggles_pointer_passthrough_for_existing_view() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );

    assert!(
        state
            .set_pointer_passthrough(passthrough_request("view_1", true))
            .ok
    );
    assert!(
        state
            .set_pointer_passthrough(passthrough_request("view_1", false))
            .ok
    );

    let events = host.log.events();
    assert!(events.contains(&FakeWebViewEvent::PointerPassthrough {
        view_id: "view_1".to_string(),
        ignore: true,
    }));
    assert!(events.contains(&FakeWebViewEvent::PointerPassthrough {
        view_id: "view_1".to_string(),
        ignore: false,
    }));
}

#[test]
fn native_state_rejects_pointer_passthrough_for_unknown_view() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    let result = state.set_pointer_passthrough(passthrough_request("missing_view", true));

    assert!(!result.ok);
    assert!(host
        .log
        .events()
        .iter()
        .all(|event| !matches!(event, FakeWebViewEvent::PointerPassthrough { .. })));
}

#[test]
fn native_state_dispatches_reload_navigation_with_derived_script_for_existing_view() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );

    let reload = state
        .dispatch_view_navigation(dispatch_navigation_request(
            "view_1",
            DesktopBrowserNavigationDispatchKind::Reload,
        ));
    assert!(reload.ok);

    let stop = state.dispatch_view_navigation(dispatch_navigation_request(
        "view_1",
        DesktopBrowserNavigationDispatchKind::Stop,
    ));
    assert!(stop.ok);

    let events = host.log.events();
    // The injected script is derived from the kind, never an arbitrary caller-provided string.
    assert!(events.contains(&FakeWebViewEvent::EvalScript {
        view_id: "view_1".to_string(),
        script: "location.reload()".to_string(),
    }));
    assert!(events.contains(&FakeWebViewEvent::EvalScript {
        view_id: "view_1".to_string(),
        script: "window.stop()".to_string(),
    }));
}

#[test]
fn native_state_rejects_navigation_dispatch_for_unknown_view() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    let result = state.dispatch_view_navigation(dispatch_navigation_request(
        "missing_view",
        DesktopBrowserNavigationDispatchKind::Reload,
    ));

    assert!(!result.ok);
    assert!(host
        .log
        .events()
        .iter()
        .all(|event| !matches!(event, FakeWebViewEvent::EvalScript { .. })));
}

#[test]
fn native_state_tracks_page_info_from_native_callbacks() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );

    let opened = state.get_page_info(view_request("view_1"));
    assert!(opened.ok);
    assert_eq!(
        opened
            .page_info
            .as_ref()
            .map(|page| page.requested_url.as_str()),
        Some("https://example.test")
    );
    assert_eq!(
        opened
            .page_info
            .as_ref()
            .map(|page| page.current_url.as_deref()),
        Some(Some("https://example.test"))
    );
    assert_eq!(
        opened.page_info.as_ref().map(|page| page.loading_state),
        Some(DesktopBrowserViewLoadingState::Finished)
    );

    assert!(
        state
            .navigate(navigate_request("view_1", "https://example.test/next"))
            .ok
    );
    let navigated = state.get_page_info(view_request("view_1"));
    let page = navigated.page_info.expect("page info should be available");
    assert_eq!(page.requested_url, "https://example.test/next");
    assert_eq!(
        page.current_url.as_deref(),
        Some("https://example.test/next")
    );
    assert_eq!(
        page.title.as_deref(),
        Some("Loaded https://example.test/next")
    );
    assert_eq!(page.loading_state, DesktopBrowserViewLoadingState::Finished);
    assert!(page.last_error.is_none());
    assert!(page.last_rejected_navigation.is_none());
}

#[test]
fn native_state_records_render_process_crash_as_recoverable_crashed_state() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );
    let opened = state.get_page_info(view_request("view_1"));
    assert_eq!(
        opened.page_info.as_ref().map(|page| page.loading_state),
        Some(DesktopBrowserViewLoadingState::Finished)
    );

    host.simulate_native_render_process_crash("view_1");

    let crashed = state.get_page_info(view_request("view_1"));
    let page = crashed.page_info.expect("page info should survive a crash");
    // Crash surfaces a recoverable Crashed state; the last good URL is preserved so the engine can
    // reload it in place rather than freezing on a dead page.
    assert_eq!(page.loading_state, DesktopBrowserViewLoadingState::Crashed);
    assert_eq!(page.current_url.as_deref(), Some("https://example.test"));
    assert_eq!(page.requested_url, "https://example.test");

    // Reloading the last good URL clears the crashed state and the view becomes interactive again.
    assert!(
        state
            .navigate(navigate_request("view_1", "https://example.test"))
            .ok
    );
    let reloaded = state
        .get_page_info(view_request("view_1"))
        .page_info
        .expect("page info should remain readable after reload");
    assert_eq!(
        reloaded.loading_state,
        DesktopBrowserViewLoadingState::Finished
    );
}

#[test]
fn native_state_captures_snapshot_for_matching_view_generation() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        DesktopBrowserAvailability::available(
            DesktopBrowserPlatform::MacOs,
            DesktopBrowserPrimitive::MacOsNsViewWebKit,
            DesktopBrowserSupport {
                navigation: true,
                page_info_diagnostics: true,
                capture: true,
                ..DesktopBrowserSupport::default()
            },
        ),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );

    let result = state.capture_snapshot(capture_request("view_1", 0));

    assert!(result.ok);
    let snapshot = result.snapshot.expect("snapshot should be present");
    assert_eq!(snapshot.browser_session_id, "browser_session_1");
    assert_eq!(snapshot.view_id, "view_1");
    assert_eq!(snapshot.navigation_generation, 0);
    assert_eq!(snapshot.capture_request_id, "capture_request_1");
    assert_eq!(snapshot.mime_type, "image/png");
    assert_eq!(snapshot.width, 4);
    assert_eq!(snapshot.height, 3);
    assert_eq!(snapshot.size_bytes, 4);
    assert_eq!(snapshot.bytes_base64, "AQIDBA==");
    assert!(result.error_code.is_none());
    assert!(host.log.events().contains(&FakeWebViewEvent::Captured {
        view_id: "view_1".to_string(),
    }));
}

#[test]
fn native_state_crops_capture_snapshot_to_union_of_targets_clip() {
    // ANNO-3: a clip (the union-of-targets device-pixel rect resolved by the in-app editor) must
    // crop the captured media to that sub-rectangle — never return the full frame. Mirrors the
    // `resolveAnnotationCropClip` devicePageRect contract: device px, clamped to the buffer bounds.
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    // Replace the fake's placeholder bytes with a real 8x6 RGBA PNG so the crop can decode it.
    *host.capture_result.lock().expect("capture lock") = Ok(DesktopBrowserCapturedSnapshot {
        browser_session_id: "native_placeholder".to_string(),
        view_id: "native_placeholder".to_string(),
        navigation_generation: 999,
        capture_request_id: "native_placeholder".to_string(),
        captured_at_ms: 123_456,
        mime_type: "image/png".to_string(),
        width: 8,
        height: 6,
        size_bytes: 1,
        bytes_base64: encode_test_rgba_png(8, 6),
    });
    let state = DesktopBrowserState::for_test(
        DesktopBrowserAvailability::available(
            DesktopBrowserPlatform::MacOs,
            DesktopBrowserPrimitive::MacOsNsViewWebKit,
            DesktopBrowserSupport {
                navigation: true,
                page_info_diagnostics: true,
                capture: true,
                ..DesktopBrowserSupport::default()
            },
        ),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );
    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );

    // Union-of-targets clip: x=2,y=1,w=3,h=2 (device px).
    let mut request = capture_request("view_1", 0);
    request.clip = Some(DesktopBrowserCaptureClipRect {
        x: 2,
        y: 1,
        width: 3,
        height: 2,
    });
    let result = state.capture_snapshot(request);

    assert!(result.ok);
    let snapshot = result.snapshot.expect("snapshot present");
    // Media dimensions match the CROP, not the 8x6 page.
    assert_eq!(snapshot.width, 3);
    assert_eq!(snapshot.height, 2);
    assert!(snapshot.size_bytes > 0);

    // The cropped pixels came from the requested sub-rectangle: top-left pixel of the crop is the
    // source pixel at (x=2, y=1) which the test encoder colored R=2, G=1.
    let (cw, ch, rgba) = decode_rgba_png(&snapshot.bytes_base64);
    assert_eq!((cw, ch), (3, 2));
    assert_eq!(rgba[0], 2, "crop top-left R == source x origin");
    assert_eq!(rgba[1], 1, "crop top-left G == source y origin");
    // Bottom-right pixel of the crop is source (x=4, y=2): R=4, G=2.
    let last = (((ch - 1) * cw + (cw - 1)) * 4) as usize;
    assert_eq!(rgba[last], 4);
    assert_eq!(rgba[last + 1], 2);
}

#[test]
fn native_state_clamps_capture_snapshot_clip_to_buffer_bounds() {
    // An oversized / off-origin clip is clamped to the captured buffer rather than reading outside it.
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    *host.capture_result.lock().expect("capture lock") = Ok(DesktopBrowserCapturedSnapshot {
        browser_session_id: "native_placeholder".to_string(),
        view_id: "native_placeholder".to_string(),
        navigation_generation: 999,
        capture_request_id: "native_placeholder".to_string(),
        captured_at_ms: 123_456,
        mime_type: "image/png".to_string(),
        width: 8,
        height: 6,
        size_bytes: 1,
        bytes_base64: encode_test_rgba_png(8, 6),
    });
    let state = DesktopBrowserState::for_test(
        DesktopBrowserAvailability::available(
            DesktopBrowserPlatform::MacOs,
            DesktopBrowserPrimitive::MacOsNsViewWebKit,
            DesktopBrowserSupport {
                navigation: true,
                page_info_diagnostics: true,
                capture: true,
                ..DesktopBrowserSupport::default()
            },
        ),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );
    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );

    let mut request = capture_request("view_1", 0);
    request.clip = Some(DesktopBrowserCaptureClipRect {
        x: 6,
        y: 4,
        width: 100,
        height: 100,
    });
    let result = state.capture_snapshot(request);
    assert!(result.ok);
    let snapshot = result.snapshot.expect("snapshot present");
    // Clamped to the remaining 2x2 region (8-6, 6-4).
    assert_eq!(snapshot.width, 2);
    assert_eq!(snapshot.height, 2);
}

#[test]
fn native_state_writes_recording_frame_reference_only() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let output_path = "recordings/frame_1.png";
    let expected_output_path = temp_dir
        .path()
        .join(".happier")
        .join("tmp")
        .join("browser-recordings")
        .join(output_path);
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        DesktopBrowserAvailability::available(
            DesktopBrowserPlatform::MacOs,
            DesktopBrowserPrimitive::MacOsNsViewWebKit,
            DesktopBrowserSupport {
                navigation: true,
                page_info_diagnostics: true,
                capture: true,
                ..DesktopBrowserSupport::default()
            },
        ),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );

    let result =
        state.capture_recording_frame(recording_frame_request("view_1", 0, output_path, 16_000_000));

    assert!(result.ok);
    let frame = result.frame.expect("frame should be present");
    let expected_output_path = expected_output_path
        .canonicalize()
        .expect("recording frame output path should exist");
    assert_eq!(frame.mime_type, "image/png");
    assert_eq!(frame.size_bytes, 4);
    assert_eq!(frame.path, expected_output_path.to_string_lossy().to_string());
    assert!(result.error_code.is_none());
    // Reference-only: the captured bytes live on disk, never inline in the result.
    let written = fs::read(&expected_output_path).expect("recording frame should be written to disk");
    assert_eq!(written, vec![0x01, 0x02, 0x03, 0x04]);
    // No leftover partial file.
    assert!(!expected_output_path.with_extension("png.partial").exists());
}

#[test]
fn recording_frame_writer_rejects_traversal_out_of_recording_root() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let recording_root = temp_dir.path().join("recording-root");
    fs::create_dir_all(&recording_root).expect("recording root");
    let outside_path = temp_dir.path().join("escape.png");

    let result = write_recording_frame_file(&recording_root, "../escape.png", &[1, 2, 3, 4]);

    assert!(result.is_err());
    assert!(!outside_path.exists());
}

#[cfg(unix)]
#[test]
fn recording_frame_writer_rejects_symlink_escape_out_of_recording_root() {
    use std::os::unix::fs as unix_fs;

    let temp_dir = tempfile::tempdir().expect("tempdir");
    let recording_root = temp_dir.path().join("recording-root");
    let outside_dir = temp_dir.path().join("outside");
    fs::create_dir_all(&recording_root).expect("recording root");
    fs::create_dir_all(&outside_dir).expect("outside dir");
    unix_fs::symlink(&outside_dir, recording_root.join("linked-out")).expect("symlink");

    let result =
        write_recording_frame_file(&recording_root, "linked-out/frame.png", &[1, 2, 3, 4]);

    assert!(result.is_err());
    assert!(!outside_dir.join("frame.png").exists());
}

#[test]
fn recording_frame_writer_rejects_absolute_paths_outside_recording_root() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let recording_root = temp_dir.path().join("recording-root");
    let outside_path = temp_dir.path().join("outside.png");
    fs::create_dir_all(&recording_root).expect("recording root");

    let result = write_recording_frame_file(
        &recording_root,
        outside_path.to_string_lossy().as_ref(),
        &[1, 2, 3, 4],
    );

    assert!(result.is_err());
    assert!(!outside_path.exists());
}

#[test]
fn recording_frame_writer_writes_valid_relative_artifacts_inside_recording_root() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let recording_root = temp_dir.path().join("recording-root");
    fs::create_dir_all(&recording_root).expect("recording root");

    let output_path = write_recording_frame_file(
        &recording_root,
        "nested/frame.png",
        &[1, 2, 3, 4],
    )
    .expect("valid in-root write");

    let canonical_root = recording_root.canonicalize().expect("canonical root");
    assert!(output_path.starts_with(&canonical_root));
    assert_eq!(fs::read(&output_path).expect("written frame"), vec![1, 2, 3, 4]);
    assert!(!output_path.with_extension("png.partial").exists());
}

#[test]
fn native_state_rejects_recording_frame_over_byte_cap() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let output_path = "frame_oversized.png";
    let expected_output_path = temp_dir
        .path()
        .join(".happier")
        .join("tmp")
        .join("browser-recordings")
        .join(output_path);
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        DesktopBrowserAvailability::available(
            DesktopBrowserPlatform::MacOs,
            DesktopBrowserPrimitive::MacOsNsViewWebKit,
            DesktopBrowserSupport {
                navigation: true,
                capture: true,
                ..DesktopBrowserSupport::default()
            },
        ),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );
    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );

    // The fake capture yields a 4-byte frame; a 3-byte cap must reject without writing the file.
    let result =
        state.capture_recording_frame(recording_frame_request("view_1", 0, output_path, 3));

    assert!(!result.ok);
    assert_eq!(
        result.error_code,
        Some(DesktopBrowserCaptureErrorCode::CaptureTooLarge)
    );
    assert!(result.frame.is_none());
    assert!(!expected_output_path.exists());
}

#[test]
fn native_state_rejects_recording_frame_when_capture_unsupported() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let output_path = "frame_unsupported.png";
    let expected_output_path = temp_dir
        .path()
        .join(".happier")
        .join("tmp")
        .join("browser-recordings")
        .join(output_path);
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        DesktopBrowserAvailability::available(
            DesktopBrowserPlatform::MacOs,
            DesktopBrowserPrimitive::MacOsNsViewWebKit,
            DesktopBrowserSupport {
                navigation: true,
                capture: false,
                ..DesktopBrowserSupport::default()
            },
        ),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    let result =
        state.capture_recording_frame(recording_frame_request("view_1", 0, output_path, 16_000_000));

    assert!(!result.ok);
    assert_eq!(
        result.error_code,
        Some(DesktopBrowserCaptureErrorCode::CaptureUnsupported)
    );
    assert!(!expected_output_path.exists());
}

#[test]
fn native_state_rejects_capture_for_closed_view() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        DesktopBrowserAvailability::available(
            DesktopBrowserPlatform::MacOs,
            DesktopBrowserPrimitive::MacOsNsViewWebKit,
            DesktopBrowserSupport {
                navigation: true,
                capture: true,
                ..DesktopBrowserSupport::default()
            },
        ),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    let result = state.capture_snapshot(capture_request("missing_view", 0));

    assert!(!result.ok);
    assert_eq!(
        result.error_code,
        Some(DesktopBrowserCaptureErrorCode::ViewUnavailable)
    );
    assert!(result.snapshot.is_none());
    assert!(host.log.events().is_empty());
}

#[test]
fn native_state_rejects_capture_when_navigation_generation_is_stale() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        DesktopBrowserAvailability::available(
            DesktopBrowserPlatform::MacOs,
            DesktopBrowserPrimitive::MacOsNsViewWebKit,
            DesktopBrowserSupport {
                navigation: true,
                capture: true,
                ..DesktopBrowserSupport::default()
            },
        ),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );
    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );
    assert!(
        state
            .navigate(navigate_request("view_1", "https://example.test/next"))
            .ok
    );

    let result = state.capture_snapshot(capture_request("view_1", 0));

    assert!(!result.ok);
    assert_eq!(
        result.error_code,
        Some(DesktopBrowserCaptureErrorCode::StaleNavigation)
    );
    assert!(result.snapshot.is_none());
    assert!(host
        .log
        .events()
        .iter()
        .all(|event| !matches!(event, FakeWebViewEvent::Captured { .. })));
}

#[test]
fn native_state_rejects_capture_when_native_callbacks_change_page_before_capture() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        DesktopBrowserAvailability::available(
            DesktopBrowserPlatform::MacOs,
            DesktopBrowserPrimitive::MacOsNsViewWebKit,
            DesktopBrowserSupport {
                navigation: true,
                capture: true,
                ..DesktopBrowserSupport::default()
            },
        ),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );
    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );

    host.simulate_native_navigation("view_1", "https://example.test/native-link");
    let result = state.capture_snapshot(capture_request("view_1", 0));

    assert!(!result.ok);
    assert_eq!(
        result.error_code,
        Some(DesktopBrowserCaptureErrorCode::StaleNavigation)
    );
    assert!(result.snapshot.is_none());
    assert!(host
        .log
        .events()
        .iter()
        .all(|event| !matches!(event, FakeWebViewEvent::Captured { .. })));
}

#[test]
fn native_state_rejects_capture_when_view_navigates_while_capture_is_pending() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let state_holder: Arc<Mutex<Option<Arc<DesktopBrowserState>>>> = Arc::new(Mutex::new(None));
    let state_for_hook = state_holder.clone();
    let host = FakeWebViewHost::with_capture_hook(move || {
        let state = state_for_hook
            .lock()
            .expect("state holder lock poisoned")
            .as_ref()
            .expect("state should be installed before capture")
            .clone();
        assert!(
            state
                .navigate(navigate_request(
                    "view_1",
                    "https://example.test/during-capture"
                ))
                .ok
        );
    });
    let state = Arc::new(DesktopBrowserState::for_test(
        DesktopBrowserAvailability::available(
            DesktopBrowserPlatform::MacOs,
            DesktopBrowserPrimitive::MacOsNsViewWebKit,
            DesktopBrowserSupport {
                navigation: true,
                capture: true,
                ..DesktopBrowserSupport::default()
            },
        ),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    ));
    *state_holder.lock().expect("state holder lock poisoned") = Some(state.clone());
    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );

    let result = state.capture_snapshot(capture_request("view_1", 0));

    assert!(!result.ok);
    assert_eq!(
        result.error_code,
        Some(DesktopBrowserCaptureErrorCode::StaleNavigation)
    );
    assert!(result.snapshot.is_none());
    assert!(host.log.events().contains(&FakeWebViewEvent::Captured {
        view_id: "view_1".to_string(),
    }));
}

#[test]
fn native_state_rejects_capture_when_native_callbacks_change_page_during_capture() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host_holder: Arc<Mutex<Option<FakeWebViewHost>>> = Arc::new(Mutex::new(None));
    let host_for_hook = host_holder.clone();
    let host = FakeWebViewHost::with_capture_hook(move || {
        let host = host_for_hook
            .lock()
            .expect("host holder lock poisoned")
            .as_ref()
            .expect("host should be installed before capture")
            .clone();
        host.simulate_native_navigation("view_1", "https://example.test/native-during-capture");
    });
    *host_holder.lock().expect("host holder lock poisoned") = Some(host.clone());
    let state = DesktopBrowserState::for_test(
        DesktopBrowserAvailability::available(
            DesktopBrowserPlatform::MacOs,
            DesktopBrowserPrimitive::MacOsNsViewWebKit,
            DesktopBrowserSupport {
                navigation: true,
                capture: true,
                ..DesktopBrowserSupport::default()
            },
        ),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );
    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );

    let result = state.capture_snapshot(capture_request("view_1", 0));

    assert!(!result.ok);
    assert_eq!(
        result.error_code,
        Some(DesktopBrowserCaptureErrorCode::StaleNavigation)
    );
    assert!(result.snapshot.is_none());
    assert!(host.log.events().contains(&FakeWebViewEvent::Captured {
        view_id: "view_1".to_string(),
    }));
}

#[test]
fn native_state_records_rejected_navigation_without_loading_privileged_url() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );

    let result = state.navigate(navigate_request("view_1", "file:///etc/passwd"));

    assert!(!result.ok);
    let page = state
        .get_page_info(view_request("view_1"))
        .page_info
        .expect("page info should remain readable for existing view");
    assert_eq!(page.requested_url, "https://example.test");
    assert_eq!(page.current_url.as_deref(), Some("https://example.test"));
    assert_eq!(
        page.last_rejected_navigation
            .as_ref()
            .map(|event| event.url.as_str()),
        Some("file:///etc/passwd")
    );
    assert!(host
        .log
        .events()
        .iter()
        .all(|event| !matches!(event, FakeWebViewEvent::Navigated { url, .. } if url == "file:///etc/passwd")));
}

#[test]
fn native_state_closes_views_and_releases_unused_profiles() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );
    assert!(state.close_view(view_request("view_1")).ok);

    assert_eq!(state.view_count(), 0);
    assert_eq!(state.profile_count(), 0);
    assert!(host.log.events().contains(&FakeWebViewEvent::Dropped {
        view_id: "view_1".to_string(),
    }));
}

#[test]
fn duplicate_open_replaces_the_existing_view_deterministically() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request(
                "view_1",
                "profile_1",
                "https://example.test/one"
            ))
            .ok
    );
    assert!(
        state
            .open_view(open_request(
                "view_1",
                "profile_2",
                "https://example.test/two"
            ))
            .ok
    );

    assert_eq!(state.view_count(), 1);
    assert_eq!(state.profile_count(), 1);
    let events = host.log.events();
    assert_eq!(events.len(), 3);
    assert!(matches!(
        events[0],
        FakeWebViewEvent::Created {
            ref view_id,
            ref url,
            ..
        } if view_id == "view_1" && url == "https://example.test/one"
    ));
    assert_eq!(
        events[1],
        FakeWebViewEvent::Dropped {
            view_id: "view_1".to_string(),
        }
    );
    assert!(matches!(
        events[2],
        FakeWebViewEvent::Created {
            ref view_id,
            ref url,
            ..
        } if view_id == "view_1" && url == "https://example.test/two"
    ));
    let first_profile_dir = match &events[0] {
        FakeWebViewEvent::Created { profile_dir, .. } => profile_dir,
        _ => panic!("expected created event"),
    };
    let second_profile_dir = match &events[2] {
        FakeWebViewEvent::Created { profile_dir, .. } => profile_dir,
        _ => panic!("expected created event"),
    };
    assert_ne!(first_profile_dir, second_profile_dir);
    assert!(!first_profile_dir.ends_with("profile_1"));
    assert!(!second_profile_dir.ends_with("profile_2"));
}

#[test]
fn native_state_keeps_devtools_fail_closed_when_unsupported() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );

    let result = state.open_devtools(view_request("view_1"));

    assert!(!result.ok);
    assert!(!host
        .log
        .events()
        .iter()
        .any(|event| matches!(event, FakeWebViewEvent::Devtools { .. })));
}

#[test]
fn availability_for_native_platforms_advertises_only_implemented_browser_families() {
    for (availability, capture_supported) in [
        (
            resolve_desktop_browser_strategy_for_runtime(
                DesktopBrowserPlatform::MacOs,
                DesktopBrowserRuntimeSupport {
                    macos_custom_data_store_identifiers: true,
                    child_embedding_verified: false,
                },
            ),
            true,
        ),
        (
            resolve_desktop_browser_strategy_for_runtime(
                DesktopBrowserPlatform::Windows,
                verified_child_embedding_runtime_support(),
            ),
            false,
        ),
        (
            resolve_desktop_browser_strategy_for_runtime(
                DesktopBrowserPlatform::LinuxX11,
                verified_child_embedding_runtime_support(),
            ),
            false,
        ),
    ] {
        assert!(availability.available);
        assert!(availability.supports.navigation);
        assert!(!availability.privileged_ipc);
        assert_eq!(availability.supports.capture, capture_supported);
        assert!(!availability.supports.recording);
        assert!(!availability.supports.automation);
        assert!(!availability.supports.go_back_forward);
        assert!(!availability.supports.reload);
        assert!(!availability.supports.stop);
    }

    let wayland = resolve_desktop_browser_strategy(DesktopBrowserPlatform::LinuxWayland);
    assert!(!wayland.available);
    assert_eq!(
        wayland.disabled_reasons,
        vec![DesktopBrowserDisabledReason::LinuxWaylandGtkEmbeddingUnimplemented]
    );
}

#[test]
fn native_state_buffers_and_drains_injected_diagnostics_messages() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request_with_diagnostics(
                "view_1",
                "profile_1",
                "https://example.test",
                "window.__happierDiagnostics__ = true;",
            ))
            .ok
    );

    host.simulate_diagnostics_post("view_1", "{\"batch\":1}");
    host.simulate_diagnostics_post("view_1", "{\"batch\":2}");

    let drained = state.drain_diagnostics(view_request("view_1"));
    assert!(drained.ok);
    // The native side forwards the raw posted strings verbatim, in order, without parsing them.
    assert_eq!(drained.messages, vec!["{\"batch\":1}", "{\"batch\":2}"]);

    // Drain clears the buffer: a second drain on an idle view returns no messages but stays ok.
    let drained_again = state.drain_diagnostics(view_request("view_1"));
    assert!(drained_again.ok);
    assert!(drained_again.messages.is_empty());
}

#[test]
fn native_state_drain_diagnostics_reports_not_found_for_views_without_diagnostics() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    // A view opened without a diagnostics init script has no buffer: drain returns ok:false with no
    // messages rather than erroring, so the bridge can poll uniformly. Parity with today's path.
    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );
    let no_diagnostics = state.drain_diagnostics(view_request("view_1"));
    assert!(!no_diagnostics.ok);
    assert!(no_diagnostics.messages.is_empty());

    // An entirely unknown view is likewise a non-erroring ok:false with empty messages.
    let missing = state.drain_diagnostics(view_request("missing_view"));
    assert!(!missing.ok);
    assert!(missing.messages.is_empty());
}

#[test]
fn native_state_treats_blank_diagnostics_init_script_as_disabled() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    // A whitespace-only script is treated as absent, so no diagnostics wiring is attached.
    assert!(
        state
            .open_view(open_request_with_diagnostics(
                "view_1",
                "profile_1",
                "https://example.test",
                "   \n  ",
            ))
            .ok
    );

    let drained = state.drain_diagnostics(view_request("view_1"));
    assert!(!drained.ok);
    assert!(drained.messages.is_empty());
}

#[test]
fn native_state_caps_buffered_diagnostics_by_dropping_oldest() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request_with_diagnostics(
                "view_1",
                "profile_1",
                "https://example.test",
                "window.__happierDiagnostics__ = true;",
            ))
            .ok
    );

    let overflow = super::DESKTOP_BROWSER_DIAGNOSTICS_BUFFER_CAP + 5;
    for index in 0..overflow {
        host.simulate_diagnostics_post("view_1", &format!("msg-{index}"));
    }

    let drained = state.drain_diagnostics(view_request("view_1"));
    assert!(drained.ok);
    assert_eq!(
        drained.messages.len(),
        super::DESKTOP_BROWSER_DIAGNOSTICS_BUFFER_CAP
    );
    // The oldest 5 were dropped; the buffer retains the most recent cap entries in order.
    assert_eq!(drained.messages.first().map(String::as_str), Some("msg-5"));
    assert_eq!(
        drained.messages.last().map(String::as_str),
        Some(format!("msg-{}", overflow - 1).as_str())
    );
}

#[test]
fn native_state_caps_buffered_diagnostics_by_aggregate_bytes() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request_with_diagnostics(
                "view_1",
                "profile_1",
                "https://example.test",
                "window.__happierDiagnostics__ = true;",
            ))
            .ok
    );

    // Each envelope is 512 KiB; the aggregate byte cap is 8 MiB. Posting 32 of them is 16 MiB of
    // raw payload, double the budget, while staying far under the 2000-entry count cap. The byte
    // budget must do the bounding here, not the count cap.
    let envelope_bytes = 512 * 1024;
    let envelope = "a".repeat(envelope_bytes);
    let posts = 32;
    for _ in 0..posts {
        host.simulate_diagnostics_post("view_1", &envelope);
    }

    let drained = state.drain_diagnostics(view_request("view_1"));
    assert!(drained.ok);
    let buffered_bytes: usize = drained.messages.iter().map(String::len).sum();
    assert!(
        buffered_bytes <= super::DESKTOP_BROWSER_DIAGNOSTICS_BYTES_CAP,
        "buffered diagnostics ({buffered_bytes} bytes) must stay under the aggregate byte cap",
    );
    // The count cap was never the binding constraint: far fewer than the count cap survive once the
    // byte budget evicts the oldest envelopes.
    assert!(drained.messages.len() < posts);
}

#[test]
fn native_state_drops_oversized_diagnostics_envelope() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request_with_diagnostics(
                "view_1",
                "profile_1",
                "https://example.test",
                "window.__happierDiagnostics__ = true;",
            ))
            .ok
    );

    // A single multi-MB envelope exceeds the per-message ceiling and is dropped outright so it can
    // never evict the rest of the buffer or pin unbounded heap.
    let oversized = "b".repeat(super::DESKTOP_BROWSER_DIAGNOSTICS_MAX_MESSAGE_BYTES + 1);
    host.simulate_diagnostics_post("view_1", &oversized);
    host.simulate_diagnostics_post("view_1", "{\"kept\":true}");

    let drained = state.drain_diagnostics(view_request("view_1"));
    assert!(drained.ok);
    assert_eq!(drained.messages.len(), 1);
    assert_eq!(
        drained.messages.first().map(String::as_str),
        Some("{\"kept\":true}")
    );
}

#[test]
fn native_state_drops_diagnostics_buffer_when_view_closes() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request_with_diagnostics(
                "view_1",
                "profile_1",
                "https://example.test",
                "window.__happierDiagnostics__ = true;",
            ))
            .ok
    );
    host.simulate_diagnostics_post("view_1", "{\"batch\":1}");
    assert!(state.close_view(view_request("view_1")).ok);

    // After close the buffer is gone, so drain falls back to the non-erroring not-found result.
    let drained = state.drain_diagnostics(view_request("view_1"));
    assert!(!drained.ok);
    assert!(drained.messages.is_empty());
}

#[test]
fn native_state_eval_script_pushes_script_to_known_view() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );

    let result = state.eval_script(eval_request("view_1", "window.__happierEval__(1 + 1);"));
    assert!(result.ok);

    // The exact JS reached the webview fire-and-forget; the fake handle recorded it.
    assert_eq!(
        host.last_script("view_1").as_deref(),
        Some("window.__happierEval__(1 + 1);")
    );
}

#[test]
fn native_state_eval_script_reports_not_found_for_unknown_view() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    // Eval on a view that was never opened is a non-erroring ok:false; nothing is dispatched.
    let result = state.eval_script(eval_request("missing_view", "window.noop();"));
    assert!(!result.ok);
    assert!(host.last_script("missing_view").is_none());
}

#[test]
fn native_state_eval_script_reports_not_found_for_blank_script() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    let state = DesktopBrowserState::for_test(
        available_test_availability(),
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );

    // A whitespace-only script is a no-op request: ok:false without reaching the webview.
    let result = state.eval_script(eval_request("view_1", "   \n  "));
    assert!(!result.ok);
    assert!(host.last_script("view_1").is_none());
}

#[test]
fn native_state_eval_script_gated_off_when_diagnostics_unsupported() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let host = FakeWebViewHost::new(false);
    // Diagnostics-channel support is the parity gate: without it, eval returns ok:false even for a
    // known view because the result round-trip has nowhere to land.
    let availability = DesktopBrowserAvailability::available(
        DesktopBrowserPlatform::Windows,
        DesktopBrowserPrimitive::WindowsHwndWebView2,
        DesktopBrowserSupport {
            navigation: true,
            page_info_diagnostics: false,
            ..DesktopBrowserSupport::default()
        },
    );
    let state = DesktopBrowserState::for_test(
        availability,
        temp_dir.path().to_path_buf(),
        Box::new(host.clone()),
    );

    assert!(
        state
            .open_view(open_request("view_1", "profile_1", "https://example.test"))
            .ok
    );

    let result = state.eval_script(eval_request("view_1", "window.noop();"));
    assert!(!result.ok);
    assert!(host.last_script("view_1").is_none());
}
