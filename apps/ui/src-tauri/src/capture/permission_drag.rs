//! The permission helper's native app-bundle drag source.
use happier_desktop_native::{capture::{CaptureError, permissions::PermissionSubject}, geometry::Rect};
use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "macos", test))]
use std::path::PathBuf;
use tauri::{AppHandle, WebviewWindow};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PermissionBundleTarget {
    App,
    ComputerDriver { #[serde(rename = "bundlePath")] bundle_path: String },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionBundleInfo {
    pub bundle_path: String,
    pub display_name: String,
}

#[cfg(any(target_os = "macos", test))]
fn selected_bundle(target: &PermissionBundleTarget, app_bundle: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
    let path = match target {
        PermissionBundleTarget::App => app_bundle()?,
        PermissionBundleTarget::ComputerDriver { bundle_path } => PathBuf::from(bundle_path),
    };
    (path.is_absolute() && path.is_dir() && path.extension().and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))).then_some(path)
}

#[tauri::command]
pub fn desktop_capture_permission_bundle_info(_app: AppHandle, target: PermissionBundleTarget)
    -> Result<Option<PermissionBundleInfo>, CaptureError> {
    #[cfg(target_os = "macos")]
    { Ok(native::bundle(&target).map(|path| PermissionBundleInfo {
        display_name: path.file_stem().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
        bundle_path: path.to_string_lossy().into_owned(),
    })) }
    #[cfg(not(target_os = "macos"))]
    { let _ = target; Ok(None) }
}

#[tauri::command]
pub fn desktop_capture_set_permission_bundle_drag_bounds(window: WebviewWindow, subject: PermissionSubject,
    target: PermissionBundleTarget, bounds: Option<Rect>) -> Result<(), CaptureError> {
    #[cfg(target_os = "macos")]
    { native::set_bounds(&window, subject, target, bounds) }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, subject, target, bounds); Err(CaptureError::UnsupportedPlatform) }
}

#[tauri::command]
pub fn desktop_capture_start_app_bundle_drag(window: WebviewWindow, subject: PermissionSubject,
    target: PermissionBundleTarget) -> Result<(), CaptureError> {
    #[cfg(target_os = "macos")]
    { native::start(&window, subject, target) }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, subject, target); Err(CaptureError::UnsupportedPlatform) }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use objc2::{define_class, msg_send, rc::Retained, runtime::ProtocolObject, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, Message};
    use objc2_app_kit::{NSApplication, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession,
        NSDraggingSource, NSEvent, NSEventType, NSImageScaling, NSImageView, NSPasteboard,
        NSPasteboardItem, NSPasteboardItemDataProvider, NSPasteboardType, NSPasteboardTypeFileURL, NSUserInterfaceItemIdentification, NSView, NSWorkspace};
    use objc2_foundation::{NSArray, NSBundle, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL};

    struct DragIvars { url: Retained<NSURL> }

    define_class!(
        #[unsafe(super(NSImageView))]
        #[name = "HappierPermissionBundleDragView"]
        #[thread_kind = MainThreadOnly]
        #[ivars = DragIvars]
        struct BundleDragView;

        impl BundleDragView {
            #[unsafe(method(acceptsFirstMouse:))]
            fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool { true }

            #[unsafe(method(mouseDownCanMoveWindow))]
            fn mouse_down_can_move_window(&self) -> bool { false }

            #[unsafe(method(mouseDown:))]
            fn mouse_down(&self, event: &NSEvent) { let _ = self.start(event); }
        }

        unsafe impl NSObjectProtocol for BundleDragView {}

        unsafe impl NSDraggingSource for BundleDragView {
            #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
            fn operation(&self, _session: &NSDraggingSession, _context: NSDraggingContext) -> NSDragOperation {
                NSDragOperation::Copy
            }
            #[unsafe(method(draggingSession:willBeginAtPoint:))]
            fn began(&self, _session: &NSDraggingSession, _point: NSPoint) { self.setHidden(true); }
            #[unsafe(method(draggingSession:endedAtPoint:operation:))]
            fn ended(&self, _session: &NSDraggingSession, _point: NSPoint, _operation: NSDragOperation) {
                // A detached view stays detached; unhiding cannot resurrect it.
                self.setHidden(false);
            }
        }

        unsafe impl NSPasteboardItemDataProvider for BundleDragView {
            #[unsafe(method(pasteboard:item:provideDataForType:))]
            fn provide(&self, _pasteboard: Option<&NSPasteboard>, item: &NSPasteboardItem, kind: &NSPasteboardType) {
                write_payload(&self.ivars().url, item, kind);
            }
        }
    );

    fn write_payload(url: &NSURL, item: &NSPasteboardItem, kind: &NSPasteboardType) {
        if kind == unsafe { NSPasteboardTypeFileURL } {
            item.setData_forType(&url.dataRepresentation(), kind);
        }
    }

    impl BundleDragView {
        fn new(path: &std::path::Path, frame: NSRect, identity: &NSString, mtm: MainThreadMarker) -> Retained<Self> {
            let path = NSString::from_str(&path.to_string_lossy());
            let this = Self::alloc(mtm).set_ivars(DragIvars { url: NSURL::fileURLWithPath_isDirectory(&path, true) });
            // SAFETY: initializing this newly allocated NSImageView subclass on main.
            let view: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: frame] };
            view.setIdentifier(Some(identity));
            view.setImage(Some(&NSWorkspace::sharedWorkspace().iconForFile(&path)));
            view.setImageScaling(NSImageScaling::ScaleProportionallyUpOrDown);
            view
        }

        fn start(&self, event: &NSEvent) -> Result<(), CaptureError> {
            let mtm = self.mtm();
            let window = self.window().ok_or(CaptureError::OperationUnavailable)?;
            let point = self.convertPoint_fromView(event.locationInWindow(), None);
            let bounds = self.bounds();
            if !window.isVisible() || self.isHiddenOrHasHiddenAncestor() || NSEvent::pressedMouseButtons() & 1 == 0
                || !matches!(event.r#type(), NSEventType::LeftMouseDown | NSEventType::LeftMouseDragged)
                || event.window(mtm).as_ref() != Some(&window)
                || point.x < bounds.origin.x || point.y < bounds.origin.y
                || point.x >= bounds.origin.x + bounds.size.width || point.y >= bounds.origin.y + bounds.size.height {
                return Err(CaptureError::OperationUnavailable);
            }
            let item = NSPasteboardItem::new();
            if !item.setDataProvider_forTypes(ProtocolObject::from_ref(self),
                &NSArray::from_slice(&[unsafe { NSPasteboardTypeFileURL }])) {
                return Err(CaptureError::NativeFailure);
            }
            let dragging = NSDraggingItem::initWithPasteboardWriter(NSDraggingItem::alloc(),
                ProtocolObject::from_ref(&*item));
            // SAFETY: the dragging contents are a real NSImage, with a view-local frame.
            unsafe { dragging.setDraggingFrame_contents(bounds, self.image().as_deref().map(|image| &***image)); }
            let session = self.beginDraggingSessionWithItems_event_source(&NSArray::from_slice(&[&*dragging]), event,
                ProtocolObject::from_ref(self));
            session.setAnimatesToStartingPositionsOnCancelOrFail(true);
            Ok(())
        }
    }

    pub(super) fn bundle(target: &PermissionBundleTarget) -> Option<PathBuf> {
        selected_bundle(target, || NSBundle::mainBundle().bundleURL().path().map(|path| PathBuf::from(path.to_string())))
    }

    fn identity(subject: PermissionSubject, target: &PermissionBundleTarget) -> String {
        let subject = match subject { PermissionSubject::Screen => "screen", PermissionSubject::WindowText => "windowText" };
        let target = match target { PermissionBundleTarget::App => "app", PermissionBundleTarget::ComputerDriver { .. } => "driver" };
        format!("happier.permission.bundle.{subject}.{target}")
    }

    fn with_host<T: Send + 'static>(window: &WebviewWindow,
        work: impl FnOnce(&NSView, MainThreadMarker) -> Result<T, CaptureError> + Send + 'static) -> Result<T, CaptureError> {
        let (tx, rx) = std::sync::mpsc::channel();
        window.with_webview(move |webview| {
            let result = MainThreadMarker::new().ok_or(CaptureError::NativeFailure).and_then(|mtm| {
                // SAFETY: Tauri supplies its live WKWebView on the native GUI thread.
                let host = unsafe { &*webview.inner().cast::<NSView>() };
                work(host, mtm)
            });
            let _ = tx.send(result);
        }).map_err(|_| CaptureError::NativeFailure)?;
        rx.recv().map_err(|_| CaptureError::NativeFailure)?
    }

    fn find(host: &NSView, identity: &str) -> Option<Retained<BundleDragView>> {
        host.subviews().iter().find_map(|view| {
            let view = view.downcast_ref::<BundleDragView>()?;
            (view.identifier().is_some_and(|identifier| identifier.to_string() == identity)).then(|| view.retain())
        })
    }

    pub(super) fn set_bounds(window: &WebviewWindow, subject: PermissionSubject, target: PermissionBundleTarget,
        bounds: Option<Rect>) -> Result<(), CaptureError> {
        if let Some(bounds) = bounds {
            if ![bounds.x, bounds.y, bounds.width, bounds.height].iter().all(|value| value.is_finite())
                || bounds.width <= 0. || bounds.height <= 0. { return Err(CaptureError::InvalidSelection); }
        }
        let identity = identity(subject, &target);
        with_host(window, move |host, mtm| {
            let existing = find(host, &identity);
            let Some(bounds) = bounds else {
                if let Some(view) = existing { view.removeFromSuperview(); }
                return Ok(());
            };
            let host_bounds = host.bounds();
            let y = if host.isFlipped() { host_bounds.origin.y + bounds.y }
                else { host_bounds.origin.y + host_bounds.size.height - bounds.y - bounds.height };
            let frame = NSRect::new(NSPoint::new(host_bounds.origin.x + bounds.x, y), NSSize::new(bounds.width, bounds.height));
            if let Some(view) = &existing {
                if matches_target(view, &target) {
                    view.setFrame(frame);
                    return Ok(());
                }
                view.removeFromSuperview();
            }
            let Some(path) = bundle(&target) else { return Ok(()); };
            let view = BundleDragView::new(&path, frame, &NSString::from_str(&identity), mtm);
            host.addSubview(&view);
            Ok(())
        })
    }

    pub(super) fn start(window: &WebviewWindow, subject: PermissionSubject, target: PermissionBundleTarget) -> Result<(), CaptureError> {
        let identity = identity(subject, &target);
        with_host(window, move |host, mtm| {
            let source = find(host, &identity).ok_or(CaptureError::OperationUnavailable)?;
            if !matches_target(&source, &target) {
                return Err(CaptureError::TargetUnavailable);
            }
            let event = NSApplication::sharedApplication(mtm).currentEvent().ok_or(CaptureError::OperationUnavailable)?;
            source.start(&event)
        })
    }

    fn matches_target(source: &BundleDragView, target: &PermissionBundleTarget) -> bool {
        match target {
            PermissionBundleTarget::App => true,
            PermissionBundleTarget::ComputerDriver { bundle_path } => source.ivars().url.path()
                .is_some_and(|path| std::path::Path::new(&path.to_string()) == std::path::Path::new(bundle_path)),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use objc2_foundation::NSObject;
        use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};

        struct ProviderIvars { url: Retained<NSURL>, drops: Arc<AtomicUsize> }
        impl Drop for ProviderIvars {
            fn drop(&mut self) { self.drops.fetch_add(1, Ordering::Relaxed); }
        }

        define_class!(
            #[unsafe(super(NSObject))]
            #[name = "HappierPermissionBundleProviderProbe"]
            #[ivars = ProviderIvars]
            struct Provider;
            unsafe impl NSObjectProtocol for Provider {}
            unsafe impl NSPasteboardItemDataProvider for Provider {
                #[unsafe(method(pasteboard:item:provideDataForType:))]
                fn provide(&self, _pasteboard: Option<&NSPasteboard>, item: &NSPasteboardItem, kind: &NSPasteboardType) {
                    write_payload(&self.ivars().url, item, kind);
                }
            }
        );

        #[test]
        fn permission_drag_native_file_url_payload_and_lazy_provider_release() {
            let drops = Arc::new(AtomicUsize::new(0));
            let path = NSString::from_str("/Applications/Computer Driver #1.app");
            let provider = Provider::alloc().set_ivars(ProviderIvars {
                url: NSURL::fileURLWithPath_isDirectory(&path, true), drops: drops.clone(),
            });
            let provider: Retained<Provider> = unsafe { msg_send![super(provider), init] };
            let item = NSPasteboardItem::new();
            let kind = unsafe { NSPasteboardTypeFileURL };
            assert!(item.setDataProvider_forTypes(ProtocolObject::from_ref(&*provider), &NSArray::from_slice(&[kind])));
            drop(provider);
            assert_eq!(drops.load(Ordering::Relaxed), 0, "AppKit must retain the registered native provider");
            let payload = item.dataForType(kind).expect("native lazy provider supplies the bundle URL");
            let url = NSURL::URLWithDataRepresentation_relativeToURL(&payload, None);
            assert!(url.isFileURL());
            assert_eq!(url.path().unwrap().to_string(), path.to_string());
            assert!(item.types().containsObject(kind), "the native pasteboard advertises the real file URL");
            drop(item);
            assert_eq!(drops.load(Ordering::Relaxed), 1, "fulfilled native pasteboard data does not leak its provider");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_bundle_target_uses_only_the_selected_existing_app_directory() {
        let directory = tempfile::tempdir().unwrap();
        let app = directory.path().join("Happier.app");
        let driver = directory.path().join("Computer Driver.app");
        std::fs::create_dir(&app).unwrap();
        std::fs::create_dir(&driver).unwrap();
        assert_eq!(selected_bundle(&PermissionBundleTarget::App, || Some(app.clone())), Some(app.clone()));
        assert_eq!(selected_bundle(&PermissionBundleTarget::ComputerDriver { bundle_path: driver.to_string_lossy().into_owned() },
            || panic!("driver selection must not inspect the UI process bundle")), Some(driver));
        for path in [directory.path().join("missing.app"), directory.path().to_path_buf()] {
            assert_eq!(selected_bundle(&PermissionBundleTarget::ComputerDriver { bundle_path: path.to_string_lossy().into_owned() }, || None), None);
        }
        assert_eq!(selected_bundle(&PermissionBundleTarget::App, || Some(directory.path().join("target/debug"))), None,
            "an unbundled development process has no tile");
        std::fs::write(directory.path().join("regular.app"), b"not a directory").unwrap();
        assert_eq!(selected_bundle(&PermissionBundleTarget::ComputerDriver { bundle_path: directory.path().join("regular.app").to_string_lossy().into_owned() }, || None), None);
    }
}
