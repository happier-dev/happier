#![cfg(feature = "capture")]
use happier_desktop_native::{
    capture::{window_text::*, CancelSignal, CaptureSource, WindowDescriptor},
    geometry::Rect,
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use xa11y_core::{ElementData, Role};

fn target() -> WindowDescriptor {
    WindowDescriptor {
        window_id: 6,
        process_id: 80,
        frame: Rect {
            x: -200.,
            y: 0.,
            width: 200.,
            height: 200.,
        },
        app_name: Some("Editor".into()),
        title: Some("Chosen".into()),
        z_order: 1,
    }
}
fn source() -> Option<CaptureSource> {
    Some(CaptureSource {
        app_name: Some("Editor".into()),
        window_title: Some("Chosen".into()),
        window_id: Some(6),
    })
}
fn node(handle: u64, role: Role, name: &str, value: Option<&str>) -> ElementData {
    let mut node = ElementData::for_role(role);
    node.handle = handle;
    node.pid = Some(80);
    node.name = Some(name.into());
    node.value = value.map(str::to_owned);
    node
}
fn root(handle: u64, name: &str) -> ElementData {
    let mut node = node(handle, Role::Window, name, None);
    node.bounds = Some(xa11y_core::Rect {
        x: -200,
        y: 0,
        width: 200,
        height: 200,
    });
    node
}
#[derive(Clone)]
struct Os {
    roots: Vec<ElementData>,
    children: HashMap<u64, Result<Vec<ElementData>, WindowTextFailure>>,
    connects: Arc<AtomicUsize>,
    window_reads: Arc<AtomicUsize>,
    visited: Arc<Mutex<Vec<u64>>>,
    cancel_on_child: Option<(u64, CancelSignal)>,
}
impl WindowAccessibility for Os {
    fn windows(&self, process_id: u32) -> Result<Vec<ElementData>, WindowTextUnavailable> {
        assert_eq!(process_id, 80);
        self.window_reads.fetch_add(1, Ordering::Relaxed);
        Ok(self.roots.clone())
    }
    fn children(&self, element: &ElementData) -> Result<Vec<ElementData>, WindowTextFailure> {
        self.visited.lock().unwrap().push(element.handle);
        if let Some((handle, cancel)) = &self.cancel_on_child {
            if *handle == element.handle {
                cancel.cancel();
            }
        }
        assert_ne!(
            element.handle, 7,
            "a same-PID sibling must never be traversed"
        );
        self.children
            .get(&element.handle)
            .cloned()
            .unwrap_or(Ok(Vec::new()))
    }
}
impl Os {
    fn fixture() -> Self {
        Self {
            roots: vec![root(7, "Sibling"), root(6, "Chosen")],
            children: HashMap::new(),
            connects: Arc::new(AtomicUsize::new(0)),
            window_reads: Arc::new(AtomicUsize::new(0)),
            visited: Arc::default(),
            cancel_on_child: None,
        }
    }
    fn connect(&self) -> Result<Box<dyn WindowAccessibility>, WindowTextUnavailable> {
        self.connects.fetch_add(1, Ordering::Relaxed);
        Ok(Box::new(self.clone()))
    }
}

#[test]
fn off_is_metadata_only_then_selected_subtree_is_sanitized_and_traversed_once_per_capture() {
    let mut os = Os::fixture();
    let mut secure = node(
        11,
        Role::TextField,
        "password-sentinel",
        Some("password-sentinel"),
    );
    secure
        .raw
        .insert("ax_subrole".into(), "AXSecureTextField".into());
    let mut atspi = node(
        12,
        Role::TextField,
        "password-sentinel",
        Some("password-sentinel"),
    );
    atspi
        .raw
        .insert("atspi_role".into(), "password text".into());
    let mut uia = node(
        13,
        Role::TextField,
        "password-sentinel",
        Some("password-sentinel"),
    );
    uia.raw.insert("IsPassword".into(), true.into());
    os.children.insert(
        6,
        Ok(vec![
            node(
                8,
                Role::Group,
                "aggregate password-sentinel",
                Some("aggregate password-sentinel"),
            ),
            secure,
            atspi,
            uia,
            node(14, Role::TextField, "masked secret", Some("••••")),
        ]),
    );
    os.children.insert(
        8,
        Ok(vec![
            node(
                9,
                Role::StaticText,
                "Visible content",
                Some("Visible content"),
            ),
            node(10, Role::TextArea, "Editor", Some("Selected body")),
        ]),
    );
    let mut capture = WindowText::new(Some(target()), source(), CancelSignal::default());
    assert!(capture.settled().is_none());
    assert_eq!(
        os.connects.load(Ordering::Relaxed),
        0,
        "off captures never construct a provider"
    );
    let expected = WindowTextOutcome::Ready {
        text: "Visible content\nSelected body".into(),
        source: source(),
        scope: None,
    };
    assert_eq!(capture.read_with(|| os.connect()), expected);
    for _ in 0..20 {
        assert_eq!(
            capture.read_with(|| panic!("View/toggles/Action reads reuse settled text")),
            expected
        );
    }
    assert_eq!(os.connects.load(Ordering::Relaxed), 1);
    assert_eq!(os.window_reads.load(Ordering::Relaxed), 1);
    assert_eq!(*os.visited.lock().unwrap(), vec![6, 8, 9, 10]);
}

#[test]
fn ambiguous_same_process_windows_are_unavailable_and_native_identity_wins_over_changed_titles() {
    let mut os = Os::fixture();
    os.roots.push(root(20, "Chosen"));
    let mut capture = WindowText::new(Some(target()), source(), CancelSignal::default());
    assert_eq!(
        capture.read_with(|| os.connect()),
        WindowTextOutcome::Unavailable {
            reason: WindowTextUnavailable::AmbiguousTarget,
            source: source(),
            scope: None
        }
    );
    assert!(os.visited.lock().unwrap().is_empty());
    os.roots[0].stable_id = Some("hwnd:0x7".into());
    os.roots[1].stable_id = Some("hwnd:0x6".into());
    os.roots[1].name = Some("Changed after capture".into());
    os.roots.pop();
    os.children.insert(
        6,
        Ok(vec![node(
            8,
            Role::TextArea,
            "Editor",
            Some("Chosen content"),
        )]),
    );
    let mut capture = WindowText::new(Some(target()), source(), CancelSignal::default());
    assert_eq!(
        capture.read_with(|| os.connect()),
        WindowTextOutcome::Ready {
            text: "Chosen content".into(),
            source: source(),
            scope: None
        }
    );
}

#[test]
fn a_pretraversal_denial_can_recover_but_a_partial_traversal_is_not_refreshed() {
    let mut capture = WindowText::new(Some(target()), source(), CancelSignal::default());
    assert_eq!(
        capture.read_with(|| Err(WindowTextUnavailable::PermissionRequired)),
        WindowTextOutcome::Unavailable {
            reason: WindowTextUnavailable::PermissionRequired,
            source: source(),
            scope: None
        }
    );
    assert!(capture.settled().is_none());
    let mut os = Os::fixture();
    os.children.insert(
        6,
        Ok(vec![
            node(8, Role::StaticText, "Safe text", None),
            node(9, Role::Group, "Unreachable", None),
        ]),
    );
    os.children
        .insert(9, Err(WindowTextFailure::ProviderUnavailable));
    let expected = WindowTextOutcome::Partial {
        text: "Safe text".into(),
        reason: WindowTextFailure::ProviderUnavailable,
        source: source(),
        scope: None,
    };
    assert_eq!(capture.read_with(|| os.connect()), expected);
    assert_eq!(
        capture.read_with(|| panic!("partial is this capture's settled output")),
        expected
    );
}

#[test]
fn absent_context_never_borrows_foreground_text_and_cancelled_capture_does_not_start_a_provider() {
    let mut capture = WindowText::new(None, None, CancelSignal::default());
    assert_eq!(
        capture.read_with(|| panic!("no native identity means no lookup")),
        WindowTextOutcome::Unavailable {
            reason: WindowTextUnavailable::NoWindowContext,
            source: None,
            scope: None
        }
    );
    let cancel = CancelSignal::default();
    cancel.cancel();
    let mut capture = WindowText::new(Some(target()), source(), cancel);
    assert_eq!(
        capture.read_with(|| panic!("cancelled read must not initialize AX")),
        WindowTextOutcome::Unavailable {
            reason: WindowTextUnavailable::Cancelled,
            source: source(),
            scope: None
        }
    );
}

#[test]
fn capture_reference_owns_its_sanitized_result_across_prepared_image_writes() {
    use happier_desktop_native::capture::{files::CaptureFiles, RgbaFrame};
    let folder = tempfile::tempdir().unwrap();
    let mut files = CaptureFiles::default();
    let png = RgbaFrame {
        width: 1,
        height: 1,
        rgba: vec![1, 2, 3, 255],
    }
    .png()
    .unwrap();
    let mut capture = files.write_png(folder.path(), &png).unwrap();
    capture.source = source();
    files.set_context(capture.clone()).unwrap();
    let capture = files
        .bind_window_text(
            &capture.capture_ref,
            Some(target()),
            CancelSignal::default(),
        )
        .unwrap();
    assert_eq!(
        capture.window_text_ref.as_deref(),
        Some(capture.capture_ref.as_str())
    );
    let mut os = Os::fixture();
    os.children.insert(
        6,
        Ok(vec![node(8, Role::StaticText, "Retained text", None)]),
    );
    let expected = WindowTextOutcome::Ready {
        text: "Retained text".into(),
        source: source(),
        scope: None,
    };
    assert_eq!(
        files
            .window_text(&capture.capture_ref)
            .unwrap()
            .lock()
            .unwrap()
            .read_with(|| os.connect()),
        expected
    );
    files
        .write_prepared_png(
            &capture.capture_ref,
            &png,
            happier_desktop_native::capture::CaptureDisclosure {
                has_marks: false,
                include_window_text: true,
            },
        )
        .unwrap();
    assert_eq!(
        files
            .open_library_png(folder.path(), &capture.path)
            .unwrap(),
        capture
    );
    assert_eq!(
        files.open_media(folder.path(), &capture.path).unwrap(),
        capture
    );
    assert_eq!(
        files.disclosure(&capture.capture_ref).unwrap(),
        Some(happier_desktop_native::capture::CaptureDisclosure {
            has_marks: false,
            include_window_text: true
        })
    );
    assert_eq!(
        files
            .window_text(&capture.capture_ref)
            .unwrap()
            .lock()
            .unwrap()
            .read_with(|| panic!("prepared image edits do not repeat text extraction")),
        expected
    );
    assert_eq!(os.connects.load(Ordering::Relaxed), 1);
}

#[test]
fn pending_video_reopen_cannot_replace_its_nonplayable_owner() {
    use happier_desktop_native::capture::{files::CaptureFiles, CaptureError};
    let folder = tempfile::tempdir().unwrap();
    let mut files = CaptureFiles::default();
    let (capture_ref, path) = files
        .allocate_video(
            folder.path(),
            happier_desktop_native::capture::recording::Format::Mp4,
        )
        .unwrap();
    // Native writer has opened its reserved destination but not finalized it.
    std::fs::write(&path, b"incomplete native writer bytes").unwrap();
    assert_eq!(
        files.open_media(folder.path(), &path),
        Err(CaptureError::OperationUnavailable)
    );
    assert_eq!(
        files.describe(&capture_ref),
        Err(CaptureError::OperationUnavailable)
    );
}

#[test]
fn native_role_fallbacks_omit_protected_controls_and_their_aggregate_ancestors() {
    let mut os = Os::fixture();
    let mut ax = node(
        9,
        Role::TextField,
        "protected sentinel",
        Some("protected sentinel"),
    );
    ax.raw.insert("ax_role".into(), "AXSecureTextField".into());
    let mut atspi = node(
        10,
        Role::TextField,
        "protected sentinel",
        Some("protected sentinel"),
    );
    // xa11y-linux uses this raw fallback when GetRoleName is absent.
    atspi.raw.insert("atspi_role".into(), "role_num:40".into());
    os.children.insert(
        6,
        Ok(vec![node(
            8,
            Role::TextArea,
            "Aggregate",
            Some("protected sentinel"),
        )]),
    );
    os.children.insert(8, Ok(vec![ax, atspi]));
    let mut capture = WindowText::new(Some(target()), source(), CancelSignal::default());
    assert_eq!(
        capture.read_with(|| os.connect()),
        WindowTextOutcome::Empty {
            source: source(),
            scope: None
        }
    );
    assert_eq!(*os.visited.lock().unwrap(), vec![6, 8]);
}

#[test]
fn consumer_close_during_traversal_stops_before_later_siblings() {
    let cancel = CancelSignal::default();
    let mut os = Os::fixture();
    os.children.insert(
        6,
        Ok(vec![
            node(8, Role::StaticText, "Safe text", None),
            node(9, Role::Group, "Closing", None),
            node(10, Role::StaticText, "Must not visit", None),
        ]),
    );
    os.cancel_on_child = Some((9, cancel.clone()));
    let mut capture = WindowText::new(Some(target()), source(), cancel);
    let expected = WindowTextOutcome::Partial {
        text: "Safe text".into(),
        reason: WindowTextFailure::Cancelled,
        source: source(),
        scope: None,
    };
    assert_eq!(capture.read_with(|| os.connect()), expected);
    assert_eq!(*os.visited.lock().unwrap(), vec![6, 8, 9]);
    assert_eq!(
        capture.read_with(|| panic!("cancelled traversal settles once")),
        expected
    );
}

#[test]
fn chosen_subtree_has_no_owner_imposed_depth_limit() {
    let mut os = Os::fixture();
    // Deliberately deeper than xa11y tree()'s default50; direct child reads
    // must retain valid content beyond that external convenience default.
    let depth = 80;
    os.children
        .insert(6, Ok(vec![node(100, Role::Group, "", None)]));
    for handle in 100..100 + depth {
        os.children
            .insert(handle, Ok(vec![node(handle + 1, Role::Group, "", None)]));
    }
    os.children.insert(
        100 + depth,
        Ok(vec![node(
            100 + depth + 1,
            Role::StaticText,
            "Deep content",
            None,
        )]),
    );
    let mut capture = WindowText::new(Some(target()), source(), CancelSignal::default());
    assert_eq!(
        capture.read_with(|| os.connect()),
        WindowTextOutcome::Ready {
            text: "Deep content".into(),
            source: source(),
            scope: None
        }
    );
}

#[test]
fn reopening_off_capture_rearms_work_without_refreshing_settled_text() {
    let cancel = CancelSignal::default();
    let mut capture = WindowText::new(Some(target()), source(), cancel.clone());
    cancel.cancel();
    capture.resume(CancelSignal::default());
    let mut os = Os::fixture();
    os.children.insert(
        6,
        Ok(vec![node(
            8,
            Role::StaticText,
            "Retained capture text",
            None,
        )]),
    );
    let expected = WindowTextOutcome::Ready {
        text: "Retained capture text".into(),
        source: source(),
        scope: None,
    };
    assert_eq!(capture.read_with(|| os.connect()), expected);
    capture.resume(CancelSignal::default());
    assert_eq!(
        capture.read_with(|| panic!("reopening retains sanitized settled text")),
        expected
    );
    assert_eq!(os.connects.load(Ordering::Relaxed), 1);
}

fn atspi_id(path: &str) -> AtspiWindowIdentity {
    AtspiWindowIdentity {
        bus_name: ":1.80".into(),
        object_path: path.into(),
    }
}
#[test]
fn preportal_active_context_is_metadata_only_then_toggle_resolves_its_exact_identity_once() {
    let context = FrontmostWindowContext {
        process_id: 80,
        identity: atspi_id("/chosen"),
        app_name: Some("Native Wayland app".into()),
        window_title: Some("Before portal".into()),
    };
    let mut os = Os::fixture();
    // After the portal Happier may be focused; resolve the captured AT-SPI
    // identity, not current ACTIVE state, title/bounds or the first same PID.
    os.roots[0].stable_id = Some("/chosen".into());
    os.roots[0]
        .raw
        .insert("bus_name".into(), ":1.sibling".into());
    os.roots[0]
        .raw
        .insert("object_path".into(), "/chosen".into());
    os.roots[1].name = Some("Changed after portal".into());
    os.roots[1].stable_id = Some("/chosen".into());
    os.roots[1].raw.insert("bus_name".into(), ":1.80".into());
    os.roots[1]
        .raw
        .insert("object_path".into(), "/chosen".into());
    os.children.insert(
        6,
        Ok(vec![node(
            8,
            Role::StaticText,
            "Whole frontmost content",
            None,
        )]),
    );
    let mut text = WindowText::from_frontmost(Some(context), CancelSignal::default());
    assert_eq!(os.connects.load(Ordering::Relaxed), 0);
    assert!(text.settled().is_none());
    let expected = WindowTextOutcome::Ready {
        text: "Whole frontmost content".into(),
        source: Some(CaptureSource {
            app_name: Some("Native Wayland app".into()),
            window_title: Some("Before portal".into()),
            window_id: None,
        }),
        scope: Some(WindowTextScope::WholeFrontmostWindow),
    };
    assert_eq!(text.read_with(|| os.connect()), expected);
    assert_eq!(
        text.read_with(|| panic!("second toggle reuses this capture's sanitized output")),
        expected
    );
    assert_eq!(*os.visited.lock().unwrap(), vec![6, 8]);
    assert_eq!(os.connects.load(Ordering::Relaxed), 1);
    assert_eq!(
        serde_json::to_value(expected).unwrap()["scope"],
        "whole_frontmost_window"
    );
}

#[test]
fn absent_preportal_context_is_scoped_unavailable_without_a_postportal_probe() {
    let mut text = WindowText::from_frontmost(None, CancelSignal::default());
    assert_eq!(
        text.read_with(|| panic!("missing context never borrows foreground after portal")),
        WindowTextOutcome::Unavailable {
            reason: WindowTextUnavailable::NoWindowContext,
            source: None,
            scope: Some(WindowTextScope::WholeFrontmostWindow)
        }
    );
}
