use super::dock::Dock;
use super::host_mode::DesktopActivityOverlayDisplayContext;
use super::placement::Rect;
#[cfg(target_os = "linux")]
use tauri::Manager;

#[cfg(any(not(target_os = "macos"), test))]
fn physical_frame(rect: Rect, scale: f64) -> Rect {
    Rect {
        x: (rect.x * scale).round(),
        y: (rect.y * scale).round(),
        width: (rect.width * scale).round(),
        height: (rect.height * scale).round(),
    }
}

#[cfg(any(target_os = "macos", test))]
fn appkit_frame(rect: Rect, monitor: Rect, display: &DesktopActivityOverlayDisplayContext) -> Rect {
    Rect {
        x: display.screen_frame.x + rect.x - monitor.x,
        y: display.screen_frame.y + display.screen_frame.height
            - (rect.y - monitor.y)
            - rect.height,
        width: rect.width,
        height: rect.height,
    }
}

pub(crate) fn visible_frame(
    monitor: Rect,
    work_area: Rect,
    display: Option<&DesktopActivityOverlayDisplayContext>,
) -> Result<Rect, String> {
    if let Some(display) = display {
        // AppKit coordinates have their origin at the bottom of each screen.
        return Ok(Rect {
            x: monitor.x + display.visible_frame.x - display.screen_frame.x,
            y: monitor.y + display.screen_frame.height
                - (display.visible_frame.y - display.screen_frame.y)
                - display.visible_frame.height,
            width: display.visible_frame.width,
            height: display.visible_frame.height,
        });
    }
    Ok(work_area)
}

#[cfg(target_os = "macos")]
fn panel_level(dock: Dock, open: bool) -> i64 {
    use objc2_app_kit::{NSFloatingWindowLevel, NSMainMenuWindowLevel, NSPopUpMenuWindowLevel};
    match dock {
        Dock::Floating => NSFloatingWindowLevel as i64,
        _ if open => NSPopUpMenuWindowLevel as i64,
        _ => NSMainMenuWindowLevel as i64 + 3,
    }
}

pub(crate) fn apply_overlay_host<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    dock: Dock,
    open: bool,
    always_on_top: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut behavior = CollectionBehavior::new()
            .can_join_all_spaces()
            .stationary()
            .ignores_cycle();
        if always_on_top {
            behavior = behavior.full_screen_auxiliary();
        }
        crate::desktop_panel::apply(
            window,
            crate::desktop_panel::PanelOptions {
                shadow: false,
                opaque: false,
                movable: false,
                movable_by_window_background: false,
                accepts_mouse_moved_events: true,
                ignores_mouse_events: false,
                nonactivating: true,
                keyboard_on_request: true,
                level: Some(panel_level(dock, open)),
                collection_behavior: behavior,
            },
        )
    }
    #[cfg(target_os = "windows")]
    {
        let _ = (dock, open, always_on_top);
        window
            .set_always_on_top(true)
            .map_err(|error| error.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let _ = (open, always_on_top);
        let native_window = window.clone();
        crate::desktop_panel::run_on_main_thread(
            window.app_handle(),
            move || {
                let native = native_window
                    .gtk_window()
                    .map_err(|error| error.to_string())?;
                if native.display().type_().name() == "GdkX11Display" {
                    native.set_type_hint(if dock == Dock::Floating {
                        gtk::gdk::WindowTypeHint::Normal
                    } else {
                        gtk::gdk::WindowTypeHint::Dock
                    });
                    native.stick();
                    native.set_keep_above(true);
                }
                Ok::<_, String>(())
            },
            "Overlay X11 window policy did not return",
        )?
    }
}

pub(crate) fn apply_overlay_frame<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    rect: Rect,
    monitor: Rect,
    display: Option<&DesktopActivityOverlayDisplayContext>,
    target_scale: f64,
    dock: Dock,
    always_on_top: bool,
) -> Result<Option<Rect>, String> {
    #[cfg(target_os = "linux")]
    if super::linux_layer::apply(window, dock, rect, monitor, always_on_top)? {
        return Ok(Some(physical_frame(rect, target_scale)));
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (dock, always_on_top);
    #[cfg(target_os = "macos")]
    {
        let display = display.ok_or("Panel positioning requires a resolved display context")?;
        let native = appkit_frame(rect, monitor, display);
        crate::desktop_panel::set_content_frame(
            window,
            objc2_foundation::NSRect::new(
                objc2_foundation::NSPoint::new(native.x, native.y),
                objc2_foundation::NSSize::new(native.width, native.height),
            ),
        )
        .map(rect_from_ns_rect)
        .map(Some)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = display;
        let scale = target_scale;
        let native = physical_frame(rect, scale);
        window
            .set_position(tauri::PhysicalPosition::new(
                native.x as i32,
                native.y as i32,
            ))
            .map_err(|error| error.to_string())?;
        window
            .set_size(tauri::PhysicalSize::new(
                native.width as u32,
                native.height as u32,
            ))
            .map_err(|error| error.to_string())?;
        Ok(Some(native))
    }
}

#[cfg(target_os = "macos")]
use tauri_nspanel::CollectionBehavior;

#[cfg(target_os = "macos")]
fn rect_from_ns_rect(rect: objc2_foundation::NSRect) -> Rect {
    Rect {
        x: rect.origin.x,
        y: rect.origin.y,
        width: rect.size.width,
        height: rect.size.height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_table_preserves_visible_island_and_target_monitor_pixels() {
        use super::super::dock::{frame_plan, Dock, FrameInput};
        for dock in [Dock::Top, Dock::Left, Dock::Right, Dock::Floating] {
            for camera in [false, true] {
                for taskbar_left in [false, true] {
                    for scale in [1., 2.] {
                        let visible = if taskbar_left {
                            Rect {
                                x: -680.,
                                y: 0.,
                                width: 680.,
                                height: 500.,
                            }
                        } else {
                            Rect {
                                x: -720.,
                                y: 30.,
                                width: 720.,
                                height: 470.,
                            }
                        };
                        let top = if camera { 0. } else { visible.y };
                        let input = FrameInput {
                            dock,
                            visible,
                            top,
                            position: (0.9, 0.9),
                            extent: (480., 300.),
                            screen_bounds: None,
                            rest_extent: (100., 36.),
                            surface: super::super::DesktopActivityOverlaySurface::Expanded,
                            camera_center: camera.then_some(-360.),
                            camera_offset: 18.,
                        };
                        let frame = frame_plan(input);
                        let bounds_top = if dock == Dock::Top { top } else { visible.y };
                        assert!(
                            frame.rect.x >= visible.x
                                && frame.rect.x + frame.rect.width <= visible.x + visible.width
                        );
                        assert!(
                            frame.rect.y >= bounds_top
                                && frame.rect.y + frame.rect.height <= visible.y + visible.height
                        );
                        let centre = (
                            frame.rect.x
                                + frame.rect.width / 2.
                                + frame.presentation.anchor_offset.x,
                            frame.rect.y
                                + frame.rect.height / 2.
                                + frame.presentation.anchor_offset.y,
                        );
                        assert!(
                            centre.0 - 50. >= visible.x
                                && centre.0 + 50. <= visible.x + visible.width
                        );
                        assert!(
                            centre.1 - 18. >= bounds_top
                                && centre.1 + 18. <= visible.y + visible.height
                        );
                        let physical = physical_frame(frame.rect, scale);
                        assert_eq!(
                            physical,
                            Rect {
                                x: (frame.rect.x * scale).round(),
                                y: (frame.rect.y * scale).round(),
                                width: (frame.rect.width * scale).round(),
                                height: (frame.rect.height * scale).round()
                            }
                        );
                    }
                }
            }
        }
    }
    #[test]
    fn appkit_frame_respects_secondary_display_origin_and_top_edge() {
        let screen = Rect {
            x: 1512.,
            y: 120.,
            width: 1728.,
            height: 1117.,
        };
        let display = DesktopActivityOverlayDisplayContext {
            is_macos: true,
            is_builtin_display: false,
            has_physical_notch: false,
            safe_area_top: 0.,
            physical_notch_size: None,
            display_identity: None,
            screen_frame: screen,
            visible_frame: screen,
        };
        let monitor = Rect {
            x: 1512.,
            y: -255.,
            width: 1728.,
            height: 1117.,
        };
        assert_eq!(
            appkit_frame(
                Rect {
                    x: 1888.,
                    y: -237.,
                    width: 344.,
                    height: 68.
                },
                monitor,
                &display
            ),
            Rect {
                x: 1888.,
                y: 1151.,
                width: 344.,
                height: 68.
            }
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn one_level_mapper_covers_every_dock_and_surface_phase() {
        for open in [false, true] {
            assert_eq!(
                panel_level(Dock::Floating, open),
                objc2_app_kit::NSFloatingWindowLevel as i64
            );
        }
        for dock in [Dock::Top, Dock::Left, Dock::Right] {
            assert_eq!(
                panel_level(dock, false),
                objc2_app_kit::NSMainMenuWindowLevel as i64 + 3
            );
            assert_eq!(
                panel_level(dock, true),
                objc2_app_kit::NSPopUpMenuWindowLevel as i64
            );
        }
    }
}
