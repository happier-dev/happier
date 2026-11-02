#![cfg(feature = "capture")]
use happier_desktop_native::{capture::{acquire_still, CancelSignal, CaptureBackend, CaptureError,
    CaptureTarget, DisplayDescriptor, Inventory, RgbaFrame, WindowDescriptor}, geometry::Rect};
use std::sync::atomic::{AtomicUsize, Ordering};

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect { Rect { x, y, width, height } }
fn inventory() -> Inventory {
    Inventory::from_os(vec![
        DisplayDescriptor { display_id: 7, frame: rect(-4., 0., 4., 2.), scale: 2., desktop_scale: 1.,
            storage_key: None, localized_name: None, safe_area_top: 0., physical_notch_size: None },
        DisplayDescriptor { display_id: 8, frame: rect(0., 0., 6., 4.), scale: 1., desktop_scale: 1.,
            storage_key: None, localized_name: None, safe_area_top: 0., physical_notch_size: None },
    ], vec![
        WindowDescriptor { window_id: 10, process_id: 99, frame: rect(-4., 0., 4., 2.),
            app_name: None, title: None, z_order: 0 },
        WindowDescriptor { window_id: 12, process_id: 23, frame: rect(-3., 0., 2., 1.),
            app_name: Some("Editor".into()), title: Some("Behind".into()), z_order: 2 },
        WindowDescriptor { window_id: 11, process_id: 23, frame: rect(-4., 0., 5., 2.),
            app_name: Some("Editor".into()), title: Some("Chosen".into()), z_order: 1 },
    ], 99)
}

struct Os {
    display_reads: AtomicUsize, window_reads: AtomicUsize,
    last_window_id: AtomicUsize, shadow_reads: AtomicUsize,
    discoveries: AtomicUsize, foreground_reads: AtomicUsize, cancel_during_read: bool,
}
impl CaptureBackend for Os {
    fn discover(&self) -> Result<Inventory, CaptureError> {
        self.discoveries.fetch_add(1, Ordering::Relaxed); Ok(inventory())
    }
    fn foreground(&self) -> Result<Inventory, CaptureError> {
        self.foreground_reads.fetch_add(1, Ordering::Relaxed);
        Ok(Inventory { displays: vec![], windows: vec![inventory().windows[1].clone()] })
    }
    fn capture_display(&self, id: u32, cancel: &CancelSignal) -> Result<RgbaFrame, CaptureError> {
        self.display_reads.fetch_add(1, Ordering::Relaxed);
        let (width, height) = if id == 7 { (8, 4) } else { (6, 4) };
        let rgba = (0..height).flat_map(|y| (0..width).flat_map(move |x| [id as u8, x as u8, y as u8, 255])).collect();
        if self.cancel_during_read { cancel.cancel(); }
        Ok(RgbaFrame { width, height, rgba })
    }
    fn capture_window(&self, id: u32, include_shadow: bool, _: &CancelSignal) -> Result<RgbaFrame, CaptureError> {
        self.window_reads.fetch_add(1, Ordering::Relaxed);
        if include_shadow { self.shadow_reads.fetch_add(1, Ordering::Relaxed); }
        self.last_window_id.store(id as usize, Ordering::Relaxed);
        Ok(RgbaFrame { width: 10, height: 4, rgba: vec![64; 10 * 4 * 4] })
    }
}
fn os(cancel_during_read: bool) -> Os {
    Os { display_reads: AtomicUsize::new(0), window_reads: AtomicUsize::new(0), last_window_id: AtomicUsize::new(0), shadow_reads: AtomicUsize::new(0),
        discoveries: AtomicUsize::new(0), foreground_reads: AtomicUsize::new(0), cancel_during_read }
}

#[test]
fn admitted_shadow_preference_reaches_selected_and_frontmost_windows_only() {
    for target in [CaptureTarget::Window { window_id: 11 }, CaptureTarget::Frontmost] {
        for include_shadow in [false, true] {
            let os = os(false);
            acquire_still(&os, &inventory(), &target, include_shadow, &CancelSignal::default()).unwrap();
            assert_eq!(os.shadow_reads.load(Ordering::Relaxed), usize::from(include_shadow));
            assert_eq!(os.window_reads.load(Ordering::Relaxed), 1);
            assert_eq!(os.display_reads.load(Ordering::Relaxed), 0);
        }
    }
    for target in [CaptureTarget::Display { display_id: 7 }, CaptureTarget::Rect {
        display_id: 7, rect: rect(0., 0., 2., 1.),
    }] {
        let os = os(false);
        acquire_still(&os, &inventory(), &target, true, &CancelSignal::default()).unwrap();
        assert_eq!(os.shadow_reads.load(Ordering::Relaxed), 0);
        assert_eq!(os.window_reads.load(Ordering::Relaxed), 0);
        assert_eq!(os.display_reads.load(Ordering::Relaxed), 1);
    }
}

#[test]
fn area_uses_starting_display_scale_and_marker_positions_even_beyond_display_edge() {
    let os = os(false);
    let acquired = acquire_still(&os, &inventory(), &CaptureTarget::Rect {
        display_id: 7, rect: rect(1., 0.5, 99., 99.),
    }, false, &CancelSignal::default()).unwrap();
    assert_eq!((acquired.frame.width, acquired.frame.height), (6, 3));
    assert_eq!(&acquired.frame.rgba[..4], &[7, 2, 1, 255]);
    assert_eq!(&acquired.frame.rgba[acquired.frame.rgba.len()-4..], &[7, 7, 3, 255]);
    assert_eq!(acquired.origin.unwrap().rect, rect(1., 0.5, 3., 1.5));
    assert_eq!(os.display_reads.load(Ordering::Relaxed), 1);
    assert_eq!(os.window_reads.load(Ordering::Relaxed), 0);
}

#[test]
fn own_windows_are_excluded_and_native_order_selects_top_external_window() {
    let inventory = inventory();
    assert_eq!(inventory.windows.len(), 2);
    assert_eq!(inventory.hit_test(-2., 0.5).unwrap().window_id, 11);
    let os = os(false);
    let acquired = acquire_still(&os, &inventory, &CaptureTarget::Window { window_id: 11 }, false, &CancelSignal::default()).unwrap();
    assert_eq!((acquired.frame.width, acquired.frame.height), (10, 4));
    assert_eq!(acquired.source.unwrap().window_title.as_deref(), Some("Chosen"));
    assert!(acquired.origin.is_none()); // It spans displays; do not invent a single-display origin.
    assert_eq!(os.window_reads.load(Ordering::Relaxed), 1);
    assert_eq!(os.display_reads.load(Ordering::Relaxed), 0);
    assert_eq!(acquire_still(&os, &inventory, &CaptureTarget::Window { window_id: 10 }, false, &CancelSignal::default()).unwrap_err(), CaptureError::TargetUnavailable);
}

#[test]
fn cancellation_has_no_media_and_no_substitution_for_a_missing_target() {
    let cancel = CancelSignal::default();
    cancel.cancel();
    let os = os(false);
    assert_eq!(acquire_still(&os, &inventory(), &CaptureTarget::Display { display_id: 7 }, false, &cancel).unwrap_err(), CaptureError::Cancelled);
    assert_eq!(os.display_reads.load(Ordering::Relaxed), 0);
    assert_eq!(acquire_still(&os, &inventory(), &CaptureTarget::Window { window_id: 404 }, false, &CancelSignal::default()).unwrap_err(), CaptureError::TargetUnavailable);
    assert_eq!(os.window_reads.load(Ordering::Relaxed), 0);
    let os = super_os_cancel();
    assert_eq!(acquire_still(&os, &inventory(), &CaptureTarget::Display { display_id: 7 }, false, &CancelSignal::default()).unwrap_err(), CaptureError::Cancelled);
}
fn super_os_cancel() -> Os { os(true) }

#[test]
fn reverse_drag_binds_text_provenance_at_the_drag_start_not_the_normalized_corner() {
    let mut targets = inventory();
    targets.windows = vec![
        WindowDescriptor { window_id: 21, process_id: 23, frame: rect(-4., 0., 2., 2.),
            app_name: None, title: Some("Left".into()), z_order: 0 },
        WindowDescriptor { window_id: 22, process_id: 23, frame: rect(-2., 0., 2., 2.),
            app_name: None, title: Some("Right".into()), z_order: 1 },
    ];
    let acquired = acquire_still(&os(false), &targets, &CaptureTarget::Rect {
        display_id: 7, rect: rect(3., 1., -3., -1.),
    }, false, &CancelSignal::default()).unwrap();
    assert_eq!(acquired.source.unwrap().window_id, Some(22));
    assert_eq!(acquired.origin.unwrap().rect, rect(0., 0., 3., 1.));
}

#[test]
fn windows_selection_uses_monitor_physical_origin_plus_its_own_scaled_delta() {
    let mut targets = inventory();
    targets.displays[0].desktop_scale = 2.;
    targets.displays[0].frame.x = -8.;
    targets.windows = vec![WindowDescriptor { window_id: 31, process_id: 23,
        frame: rect(-4., 1., 4., 3.), app_name: None, title: None, z_order: 0 }];
    assert_eq!(targets.selection_facts(7).unwrap().windows[0].frame, rect(2., 0.5, 2., 1.5));
    assert_eq!(targets.hit_test_local(7, 2., 0.5).unwrap().unwrap().frame, rect(2., 0.5, 2., 1.5));
    let os = os(false);
    let acquired = acquire_still(&os, &targets, &CaptureTarget::Rect {
        display_id: 7, rect: rect(2., 0.5, 4., 4.),
    }, false, &CancelSignal::default()).unwrap();
    assert_eq!(acquired.source.unwrap().window_id, Some(31));
    assert_eq!((acquired.frame.width, acquired.frame.height), (4, 3));
    assert_eq!(&acquired.frame.rgba[..4], &[7, 4, 1, 255]);
    assert_eq!(acquired.origin.unwrap().rect, rect(2., 0.5, 2., 1.5));
    assert_eq!(os.display_reads.load(Ordering::Relaxed), 1);
}

#[test]
fn macos_full_window_sample_keeps_titlebar_in_outline_and_click_target() {
    // Observed on macOS 26.6.2: a 650x400 titled content view at AppKit (100,200)
    // has full frame 650x432; SCK reports (99,350,652,432) on a 1512x982 display.
    let frame = rect(99., 350., 652., 432.);
    for (x, y) in [(0., 0.), (-1512., -982.)] {
        let targets = Inventory {
            displays: vec![DisplayDescriptor { display_id: 7, frame: rect(x, y, 1512., 982.),
                scale: 2., desktop_scale: 1., storage_key: None, localized_name: None,
                safe_area_top: 32., physical_notch_size: None }],
            windows: vec![WindowDescriptor { window_id: 31, process_id: 23,
                frame: rect(x + frame.x, y + frame.y, frame.width, frame.height),
                app_name: None, title: None, z_order: 0 }],
        };
        assert_eq!(targets.selection_facts(7).unwrap().windows[0].frame, frame);
        // A click in the title-bar band must choose the same complete frame as the outline.
        let clicked = targets.hit_test_local(7, 120., 351.).unwrap().unwrap();
        assert_eq!((clicked.window_id, clicked.frame), (31, frame));
        assert!(targets.hit_test_local(7, 120., 349.).unwrap().is_none());
        assert!(targets.hit_test_local(7, 120., 781.).unwrap().is_some());
        assert!(targets.hit_test_local(7, 120., 782.).unwrap().is_none());
        let os = os(false);
        let image = acquire_still(&os, &targets, &CaptureTarget::Window { window_id: clicked.window_id }, false,
            &CancelSignal::default()).unwrap();
        assert_eq!(image.source.unwrap().window_id, Some(31));
        assert_eq!(os.last_window_id.load(Ordering::Relaxed), 31);
        assert_eq!(image.origin.unwrap().rect, frame);
        assert_eq!(os.window_reads.load(Ordering::Relaxed), 1);
        assert_eq!(os.display_reads.load(Ordering::Relaxed), 0);
    }
}

#[test]
fn frontmost_uses_the_foreground_target_without_full_discovery_or_a_selector() {
    let os = os(false);
    let chosen = os.discover_target(&CaptureTarget::Frontmost).unwrap();
    assert_eq!(chosen.windows.len(), 1);
    assert!(chosen.displays.is_empty());
    assert_eq!(chosen.windows[0].window_id, 12);
    let image = acquire_still(&os, &chosen, &CaptureTarget::Frontmost, false, &CancelSignal::default()).unwrap();
    assert_eq!(image.source.unwrap().window_id, Some(12));
    assert_eq!(os.window_reads.load(Ordering::Relaxed), 1);
    assert_eq!(os.display_reads.load(Ordering::Relaxed), 0);
    assert_eq!(os.discoveries.load(Ordering::Relaxed), 0);
    assert_eq!(os.foreground_reads.load(Ordering::Relaxed), 1);
}

#[test]
fn a_spanning_native_window_uses_its_selected_monitors_scale_without_inventing_origin() {
    let mut targets = inventory();
    targets.displays.truncate(1);
    targets.displays[0].desktop_scale = 2.;
    targets.displays[0].frame.x = -8.;
    targets.windows = vec![WindowDescriptor { window_id: 31, process_id: 23,
        frame: rect(-10., 0., 10., 4.), app_name: None, title: None, z_order: 0 }];
    let image = acquire_still(&os(false), &targets, &CaptureTarget::Window { window_id: 31 }, false, &CancelSignal::default()).unwrap();
    assert_eq!(image.scale, 2.);
    assert!(image.origin.is_none());
    assert_eq!((image.frame.width, image.frame.height), (10, 4));
}
