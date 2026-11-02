use crate::{capture::{CaptureError, CaptureTarget, DisplayDescriptor, Inventory, WindowDescriptor}, geometry::Rect};
use std::collections::HashMap;

/// ScreenCaptureKit properties and the native identity/order lookups are OS boundaries.
pub(super) trait Window {
    fn window_id(&self) -> u32;
    fn window_layer(&self) -> i32;
    fn is_on_screen(&self) -> bool;
    fn process_id(&self) -> Option<u32>;
    fn frame(&self) -> Rect;
    fn app_name(&self) -> Option<String>;
    fn title(&self) -> Option<String>;
}

pub(super) trait Source {
    type Window: Window;
    fn windows(&self) -> Vec<Self::Window>;
    fn window_order(&self) -> Result<HashMap<u32, usize>, CaptureError>;
    fn frontmost_process_id(&self) -> Result<u32, CaptureError>;
}

pub(super) struct Metadata<S> {
    pub(super) source: S,
    pub(super) displays: Vec<DisplayDescriptor>,
}

impl<S: Source> Metadata<S> {
    pub(super) fn new(source: S, displays: Vec<DisplayDescriptor>) -> Self {
        Self { source, displays }
    }

    fn descriptor(window: &S::Window, process_id: u32, z_order: usize) -> WindowDescriptor {
        WindowDescriptor { window_id: window.window_id(), process_id, frame: window.frame(),
            app_name: window.app_name(), title: window.title(), z_order }
    }

    pub(super) fn discover(&self) -> Result<Inventory, CaptureError> {
        let order = self.source.window_order()?;
        let windows = self.source.windows().iter().filter_map(|window| {
            if window.window_layer() != 0 || !window.is_on_screen() { return None; }
            let z_order = *order.get(&window.window_id())?;
            Some(Self::descriptor(window, window.process_id()?, z_order))
        }).collect();
        Ok(Inventory::from_os(self.displays.clone(), windows, std::process::id()))
    }

    pub(super) fn foreground(&self) -> Result<Inventory, CaptureError> {
        let pid = self.source.frontmost_process_id()?;
        let order = self.source.window_order()?;
        let windows = self.source.windows();
        let (window, z_order) = windows.iter().filter_map(|window| {
            if window.window_layer() != 0 || !window.is_on_screen() || window.process_id()? != pid { return None; }
            Some((window, *order.get(&window.window_id())?))
        }).min_by_key(|(_, z_order)| *z_order).ok_or(CaptureError::TargetUnavailable)?;
        let window = Self::descriptor(window, pid, z_order);
        let displays = super::super::display_for_window_frame(&self.displays, &window.frame).cloned().into_iter().collect();
        let inventory = Inventory::from_os(displays, vec![window], std::process::id());
        if inventory.windows.is_empty() { Err(CaptureError::TargetUnavailable) } else { Ok(inventory) }
    }

    pub(super) fn discover_target(&self, target: &CaptureTarget) -> Result<Inventory, CaptureError> {
        match target {
            CaptureTarget::Frontmost => self.foreground(),
            CaptureTarget::Window { window_id } => {
                let windows = self.source.windows();
                let window = windows.iter().find(|window| window.window_id() == *window_id)
                    .filter(|window| window.window_layer() == 0 && window.is_on_screen())
                    .ok_or(CaptureError::TargetUnavailable)?;
                let process_id = window.process_id().ok_or(CaptureError::TargetUnavailable)?;
                let window = Self::descriptor(window, process_id, 0);
                let displays = super::super::display_for_window_frame(&self.displays, &window.frame).cloned().into_iter().collect();
                Ok(Inventory::from_os(displays, vec![window], std::process::id()))
            },
            CaptureTarget::Display { display_id } | CaptureTarget::Rect { display_id, .. } => {
                let display = self.displays.iter().find(|display| display.display_id == *display_id)
                    .ok_or(CaptureError::TargetUnavailable)?.clone();
                // Whole-window context is optional; its absence cannot block valid pixels.
                let windows = match self.foreground() {
                    Ok(inventory) => inventory.windows,
                    Err(_) => Vec::new(),
                };
                Ok(Inventory { displays: vec![display], windows })
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};

    #[derive(Default, Debug, PartialEq)]
    struct Reads { windows: usize, order: usize, foreground: usize, descriptors: Vec<(u32, &'static str)> }
    #[derive(Clone)]
    struct NativeWindow { id: u32, pid: u32, layer: i32, on_screen: bool, reads: Rc<RefCell<Reads>> }
    impl NativeWindow {
        fn read(&self, property: &'static str) { self.reads.borrow_mut().descriptors.push((self.id, property)); }
    }
    impl Window for NativeWindow {
        fn window_id(&self) -> u32 { self.id }
        fn window_layer(&self) -> i32 { self.layer }
        fn is_on_screen(&self) -> bool { self.on_screen }
        fn process_id(&self) -> Option<u32> { Some(self.pid) }
        fn frame(&self) -> Rect { self.read("frame"); Rect { x: 10., y: 10., width: 30., height: 30. } }
        fn app_name(&self) -> Option<String> { self.read("app"); Some(format!("application-{}", self.pid)) }
        fn title(&self) -> Option<String> { self.read("title"); Some(format!("window-{}", self.id)) }
    }
    struct NativeSource { windows: Vec<NativeWindow>, frontmost_pid: Option<u32>, order_error: Option<CaptureError>, reads: Rc<RefCell<Reads>> }
    impl Source for NativeSource {
        type Window = NativeWindow;
        fn windows(&self) -> Vec<NativeWindow> { self.reads.borrow_mut().windows += 1; self.windows.clone() }
        fn window_order(&self) -> Result<HashMap<u32, usize>, CaptureError> {
            self.reads.borrow_mut().order += 1;
            if let Some(error) = self.order_error { return Err(error); }
            Ok([(9, 0), (7, 1), (8, 2), (10, 3), (11, 4)].into())
        }
        fn frontmost_process_id(&self) -> Result<u32, CaptureError> {
            self.reads.borrow_mut().foreground += 1;
            self.frontmost_pid.ok_or(CaptureError::TargetUnavailable)
        }
    }
    fn fixture() -> (Metadata<NativeSource>, Rc<RefCell<Reads>>) {
        let reads = Rc::new(RefCell::new(Reads::default()));
        let window = |id, pid, layer, on_screen| NativeWindow { id, pid, layer, on_screen, reads: reads.clone() };
        let source = NativeSource { frontmost_pid: Some(42), order_error: None, windows: vec![window(8, 42, 0, true), window(7, 42, 0, true),
            window(9, 99, 0, true), window(10, std::process::id(), 0, true), window(11, 55, 1, true)], reads: reads.clone() };
        let display = DisplayDescriptor { display_id: 1, frame: Rect { x: 0., y: 0., width: 100., height: 100. },
            scale: 2., desktop_scale: 1., storage_key: None, localized_name: None, safe_area_top: 0., physical_notch_size: None };
        (Metadata::new(source, vec![display]), reads)
    }
    fn assert_chosen(reads: &Reads, id: u32) {
        assert_eq!(reads.descriptors, vec![(id, "frame"), (id, "app"), (id, "title")]);
    }

    #[test]
    fn constructor_and_explicit_window_read_only_the_chosen_descriptor() {
        let (metadata, reads) = fixture();
        assert_eq!(*reads.borrow(), Reads::default(), "construction must retain native references without projecting metadata");
        let inventory = metadata.discover_target(&CaptureTarget::Window { window_id: 8 }).unwrap();
        assert_eq!(inventory.windows.iter().map(|window| window.window_id).collect::<Vec<_>>(), vec![8]);
        assert_eq!(inventory.windows[0].title.as_deref(), Some("window-8"));
        assert_chosen(&reads.borrow(), 8);
        assert_eq!(reads.borrow().windows, 1);
        assert_eq!(reads.borrow().order, 0);
        assert_eq!(reads.borrow().foreground, 0);
    }

    #[test]
    fn foreground_reads_order_and_identity_but_only_projects_the_frontmost_matching_window() {
        let (metadata, reads) = fixture();
        let inventory = metadata.foreground().unwrap();
        assert_eq!(inventory.windows[0].window_id, 7);
        assert_chosen(&reads.borrow(), 7);
        assert_eq!(reads.borrow().foreground, 1);
        assert_eq!(reads.borrow().order, 1);
        assert_eq!(reads.borrow().windows, 1);
    }

    #[test]
    fn display_and_rect_read_only_requested_display_and_optional_frontmost_context() {
        for target in [CaptureTarget::Display { display_id: 1 }, CaptureTarget::Rect { display_id: 1,
            rect: Rect { x: 10., y: 10., width: 20., height: 20. } }] {
            let (metadata, reads) = fixture();
            let inventory = metadata.discover_target(&target).unwrap();
            assert_eq!(inventory.displays.len(), 1);
            assert_eq!(inventory.windows.iter().map(|window| window.window_id).collect::<Vec<_>>(), vec![7]);
            assert_chosen(&reads.borrow(), 7);
            assert_eq!(reads.borrow().foreground, 1);
        }
    }

    #[test]
    fn picker_projects_eligible_windows_in_native_order_and_excludes_own_process() {
        let (metadata, reads) = fixture();
        let inventory = metadata.discover().unwrap();
        assert_eq!(inventory.windows.iter().map(|window| window.window_id).collect::<Vec<_>>(), vec![9, 7, 8]);
        assert_eq!(reads.borrow().descriptors.len(), 12);
        assert_eq!(reads.borrow().foreground, 0);
        assert_eq!(reads.borrow().order, 1);
        assert_eq!(reads.borrow().windows, 1);
    }

    #[test]
    fn display_without_frontmost_context_remains_capturable_without_window_metadata() {
        let (mut metadata, reads) = fixture();
        metadata.source.frontmost_pid = None;
        let inventory = metadata.discover_target(&CaptureTarget::Display { display_id: 1 }).unwrap();
        assert_eq!(inventory.displays.len(), 1);
        assert!(inventory.windows.is_empty());
        assert!(reads.borrow().descriptors.is_empty());
        assert_eq!(reads.borrow().foreground, 1);
        assert_eq!(reads.borrow().order, 0);
        assert_eq!(reads.borrow().windows, 0);
    }

    #[test]
    fn failed_native_order_only_withdraws_optional_display_context() {
        for target in [CaptureTarget::Display { display_id: 1 }, CaptureTarget::Rect { display_id: 1,
            rect: Rect { x: 10., y: 10., width: 20., height: 20. } }] {
            let (mut metadata, reads) = fixture();
            // CGWindowListCopyWindowInfo can return null; the native order boundary reports NativeFailure.
            metadata.source.order_error = Some(CaptureError::NativeFailure);
            let inventory = metadata.discover_target(&target).expect("optional context must not block valid display pixels");
            assert_eq!(inventory.displays.len(), 1);
            assert!(inventory.windows.is_empty());
            assert!(reads.borrow().descriptors.is_empty());
            assert_eq!(reads.borrow().foreground, 1);
            assert_eq!(reads.borrow().order, 1);
            assert_eq!(reads.borrow().windows, 0);
        }
        let (mut metadata, _) = fixture();
        metadata.source.order_error = Some(CaptureError::NativeFailure);
        assert_eq!(metadata.foreground(), Err(CaptureError::NativeFailure));
    }
}
