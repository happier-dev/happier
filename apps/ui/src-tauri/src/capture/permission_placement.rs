//! One explicit permission-helper placement. No follow loop or grant polling.
use happier_desktop_native::capture::CaptureError;
#[cfg(any(target_os = "macos", test))]
use happier_desktop_native::geometry::Rect;
#[cfg(target_os = "macos")]
use tauri::Manager;

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy)]
struct Screen {
    frame: Rect,
    visible: Rect,
}

#[cfg(any(target_os = "macos", test))]
struct NativeWindow {
    process_id: i32,
    layer: i64,
    /// Core Graphics screen space, top-left origin of the primary display.
    frame: Rect,
}

#[cfg(any(target_os = "macos", test))]
fn position_beside(
    helper: Rect,
    screens: &[Screen],
    settings_processes: &[i32],
    snapshot: impl FnOnce() -> Result<Vec<NativeWindow>, CaptureError>,
) -> Result<Option<Rect>, CaptureError> {
    let windows = snapshot()?;
    // CGWindowList is front-to-back. Choose the first real normal-level
    // Settings window, not a localized title, menu or guessed minimum size.
    let Some(window) = windows.into_iter().find(|window| {
        settings_processes.contains(&window.process_id)
            && window.layer == 0
            && window.frame.width > 0.
            && window.frame.height > 0.
    }) else {
        return Ok(None);
    };
    let Some(primary) = screens.first() else {
        return Ok(None);
    };
    // Window Server bounds start at the primary display's top-left; AppKit
    // window/screen frames are bottom-left. Preserve the real virtual origin.
    let settings = Rect {
        y: primary.frame.y + primary.frame.height - window.frame.y - window.frame.height,
        ..window.frame
    };
    let overlap = |screen: &Screen| {
        ((settings.x + settings.width).min(screen.frame.x + screen.frame.width)
            - settings.x.max(screen.frame.x))
        .max(0.)
            * ((settings.y + settings.height).min(screen.frame.y + screen.frame.height)
                - settings.y.max(screen.frame.y))
            .max(0.)
    };
    let Some(screen) = screens
        .iter()
        .filter(|screen| overlap(screen) > 0.)
        .max_by(|a, b| overlap(a).total_cmp(&overlap(b)))
    else {
        return Ok(None);
    };
    let visible = screen.visible;
    let right = settings.x + settings.width;
    let left = settings.x - helper.width;
    let right_space = visible.x + visible.width - right;
    let left_space = settings.x - visible.x;
    let x = if right_space >= helper.width {
        right
    } else if left_space >= helper.width {
        left
    } else if right_space >= left_space {
        right
    } else {
        left
    };
    Ok(Some(Rect {
        x: x.clamp(
            visible.x,
            (visible.x + visible.width - helper.width).max(visible.x),
        ),
        y: (settings.y + (settings.height - helper.height) / 2.).clamp(
            visible.y,
            (visible.y + visible.height - helper.height).max(visible.y),
        ),
        ..helper
    }))
}

pub(super) fn beside_system_settings(window: &tauri::WebviewWindow) -> Result<bool, CaptureError> {
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle().clone();
        let window = window.clone();
        crate::desktop_panel::run_on_main_thread(
            &app,
            move || native::place(&window),
            "Permission helper placement did not return",
        )
        .map_err(|_| CaptureError::NativeFailure)?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use objc2::{
        msg_send,
        rc::Retained,
        runtime::{AnyClass, AnyObject},
        MainThreadMarker,
    };
    use objc2_app_kit::{NSNormalWindowLevel, NSScreen, NSWindow};
    use objc2_foundation::{NSPoint, NSRect, NSString};
    use tauri_nspanel::ManagerExt;

    fn rectangle(frame: NSRect) -> Rect {
        Rect {
            x: frame.origin.x,
            y: frame.origin.y,
            width: frame.size.width,
            height: frame.size.height,
        }
    }
    fn settings_processes() -> Vec<i32> {
        let Some(class) = AnyClass::get(c"NSRunningApplication") else {
            return Vec::new();
        };
        let identifier = NSString::from_str("com.apple.systempreferences");
        // Public AppKit lookup by bundle identity, never owner/window names.
        let applications: *mut AnyObject =
            unsafe { msg_send![class, runningApplicationsWithBundleIdentifier: &*identifier] };
        if applications.is_null() {
            return Vec::new();
        }
        let count: usize = unsafe { msg_send![applications, count] };
        (0..count)
            .filter_map(|index| {
                let application: *mut AnyObject =
                    unsafe { msg_send![applications, objectAtIndex: index] };
                let pid: i32 = unsafe { msg_send![application, processIdentifier] };
                (pid > 0).then_some(pid)
            })
            .collect()
    }
    fn value(dictionary: *mut AnyObject, key: &NSString) -> Option<*mut AnyObject> {
        if dictionary.is_null() {
            return None;
        }
        let value: *mut AnyObject = unsafe { msg_send![dictionary, objectForKey: key] };
        (!value.is_null()).then_some(value)
    }
    fn number(dictionary: *mut AnyObject, key: &NSString) -> Option<f64> {
        let value = value(dictionary, key)?;
        Some(unsafe { msg_send![value, doubleValue] })
    }
    fn integer(dictionary: *mut AnyObject, key: &NSString) -> Option<i64> {
        let value = value(dictionary, key)?;
        Some(unsafe { msg_send![value, longLongValue] })
    }
    fn window_snapshot() -> Result<Vec<NativeWindow>, CaptureError> {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGWindowListCopyWindowInfo(options: u32, relative: u32) -> *mut AnyObject;
        }
        const ON_SCREEN_ONLY: u32 = 1;
        const EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
        // A single +1 CFArray, toll-free bridged to NSArray and released by
        // Retained. PID/layer/bounds require no Screen Recording grant; names
        // and capture pixels are deliberately never requested/read here.
        let windows = unsafe {
            Retained::from_raw(CGWindowListCopyWindowInfo(
                ON_SCREEN_ONLY | EXCLUDE_DESKTOP_ELEMENTS,
                0,
            ))
        }
        .ok_or(CaptureError::NativeFailure)?;
        let pid = NSString::from_str("kCGWindowOwnerPID");
        let layer = NSString::from_str("kCGWindowLayer");
        let bounds = NSString::from_str("kCGWindowBounds");
        let x = NSString::from_str("X");
        let y = NSString::from_str("Y");
        let width = NSString::from_str("Width");
        let height = NSString::from_str("Height");
        let count: usize = unsafe { msg_send![&*windows, count] };
        Ok((0..count)
            .filter_map(|index| {
                let dictionary: *mut AnyObject =
                    unsafe { msg_send![&*windows, objectAtIndex: index] };
                let frame = value(dictionary, &bounds)?;
                Some(NativeWindow {
                    process_id: integer(dictionary, &pid)?.try_into().ok()?,
                    layer: integer(dictionary, &layer)?,
                    frame: Rect {
                        x: number(frame, &x)?,
                        y: number(frame, &y)?,
                        width: number(frame, &width)?,
                        height: number(frame, &height)?,
                    },
                })
            })
            .collect())
    }
    pub(super) fn place(window: &tauri::WebviewWindow) -> Result<bool, CaptureError> {
        let mtm = MainThreadMarker::new().ok_or(CaptureError::NativeFailure)?;
        let pointer = window
            .ns_window()
            .map_err(|_| CaptureError::NativeFailure)?;
        // SAFETY: Tauri owns this live window and the caller hopped to main.
        let native: &NSWindow = unsafe { &*pointer.cast() };
        if let Ok(panel) = window.app_handle().get_webview_panel(window.label()) {
            panel.set_floating_panel(false);
        }
        native.setLevel(NSNormalWindowLevel);
        native.setMovable(true);
        let screens: Vec<_> = NSScreen::screens(mtm)
            .iter()
            .map(|screen| Screen {
                frame: rectangle(screen.frame()),
                visible: rectangle(screen.visibleFrame()),
            })
            .collect();
        let position = position_beside(
            rectangle(native.frame()),
            &screens,
            &settings_processes(),
            window_snapshot,
        )?;
        let Some(position) = position else {
            return Ok(false);
        };
        native.setFrameOrigin(NSPoint::new(position.x, position.y));
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }
    fn screens() -> Vec<Screen> {
        vec![
            Screen {
                frame: rect(0., 0., 1440., 900.),
                visible: rect(0., 0., 1440., 878.),
            },
            Screen {
                frame: rect(-1280., 0., 1280., 1024.),
                visible: rect(-1280., 20., 1280., 1004.),
            },
        ]
    }

    #[test]
    fn explicit_placement_uses_one_onscreen_snapshot_and_native_settings_pid_not_titles() {
        let reads = AtomicUsize::new(0);
        let placed = position_beside(rect(0., 0., 320., 200.), &screens(), &[77], || {
            reads.fetch_add(1, Ordering::Relaxed);
            Ok(vec![
                NativeWindow {
                    process_id: 88,
                    layer: 0,
                    frame: rect(0., 0., 1440., 900.),
                },
                NativeWindow {
                    process_id: 77,
                    layer: 1,
                    frame: rect(0., 0., 1440., 900.),
                },
                NativeWindow {
                    process_id: 77,
                    layer: 0,
                    frame: rect(300., 100., 700., 600.),
                },
            ])
        })
        .unwrap();
        assert_eq!(placed, Some(rect(1000., 400., 320., 200.)));
        assert_eq!(reads.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn left_display_and_visible_frame_clamp_use_real_bounds_without_a_gap_or_size_threshold() {
        let placed = position_beside(rect(0., 0., 320., 200.), &screens(), &[77], || {
            Ok(vec![NativeWindow {
                process_id: 77,
                layer: 0,
                frame: rect(-900., 0., 900., 800.),
            }])
        })
        .unwrap();
        assert_eq!(placed, Some(rect(-1220., 400., 320., 200.)));
        let placed = position_beside(rect(0., 0., 320., 200.), &screens(), &[77], || {
            Ok(vec![NativeWindow {
                process_id: 77,
                layer: 0,
                frame: rect(1300., 0., 100., 40.),
            }])
        })
        .unwrap();
        assert_eq!(
            placed,
            Some(rect(980., 678., 320., 200.)),
            "small real Settings frames remain eligible and helper stays below menu bar"
        );
    }

    #[test]
    fn fresh_settings_launch_without_a_window_returns_once_without_waiting() {
        let reads = AtomicUsize::new(0);
        assert_eq!(
            position_beside(rect(0., 0., 320., 200.), &screens(), &[77], || {
                reads.fetch_add(1, Ordering::Relaxed);
                Ok(Vec::new())
            })
            .unwrap(),
            None
        );
        assert_eq!(reads.load(Ordering::Relaxed), 1);
    }
}
