use super::host_window::{
    DesktopActivityOverlayMacWindowHostSettings, DesktopActivityOverlayMacWindowLevelOverride,
};
use super::host_mode::{DesktopActivityOverlayDisplayContext, DesktopActivityOverlayHostMode};
use super::placement::{OverlayPlacementRect, Rect};

#[cfg(target_os = "macos")]
use tauri::{Manager, Runtime, WebviewWindow};
#[cfg(target_os = "macos")]
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt, StyleMask, WebviewWindowExt,
};

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(DesktopActivityOverlayPanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            hides_on_deactivate: false
        }
    })
}

#[cfg(target_os = "macos")]
fn resolve_panel_level_override(
    settings: DesktopActivityOverlayMacWindowHostSettings,
) -> Option<i64> {
    match settings.window_level_override {
        Some(DesktopActivityOverlayMacWindowLevelOverride::NotchPanel) => Some(27),
        None => None,
    }
}

#[cfg(target_os = "macos")]
fn resolve_panel_collection_behavior(
    settings: DesktopActivityOverlayMacWindowHostSettings,
) -> CollectionBehavior {
    let mut behavior = CollectionBehavior::new();

    if settings.visible_on_all_workspaces {
        behavior = behavior.can_join_all_spaces();
    }
    if settings.full_screen_auxiliary {
        behavior = behavior.full_screen_auxiliary();
    }
    if settings.stationary {
        behavior = behavior.stationary();
    }
    if settings.ignores_cycle {
        behavior = behavior.ignores_cycle();
    }

    behavior
}

#[cfg(target_os = "macos")]
fn resolve_panel_style_mask(
    settings: DesktopActivityOverlayMacWindowHostSettings,
) -> StyleMask {
    let mut style_mask = StyleMask::empty().borderless();

    if settings.nonactivating_panel {
        style_mask = style_mask.nonactivating_panel();
    }

    style_mask
}

#[cfg(target_os = "macos")]
pub(crate) fn apply_macos_overlay_panel_host<R: Runtime>(
    window: &WebviewWindow<R>,
    settings: DesktopActivityOverlayMacWindowHostSettings,
) -> Result<(), String> {
    if !settings.prefer_panel_host {
        return Ok(());
    }

    let label = window.label().to_string();
    let panel = match window.app_handle().get_webview_panel(&label) {
        Ok(panel) => panel,
        Err(_) => window
            .to_panel::<DesktopActivityOverlayPanel<R>>()
            .map_err(|error| error.to_string())?,
    };

    panel.set_has_shadow(settings.shadow);
    panel.set_opaque(settings.opaque);
    panel.set_transparent(true);
    panel.set_hides_on_deactivate(false);
    panel.set_movable_by_window_background(false);
    panel.set_becomes_key_only_if_needed(settings.nonactivating_panel);
    panel.set_floating_panel(settings.window_level_override.is_some());
    panel.set_collection_behavior(resolve_panel_collection_behavior(settings).into());
    panel.set_style_mask(resolve_panel_style_mask(settings).into());

    if let Some(level_override) = resolve_panel_level_override(settings) {
        panel.set_level(level_override);
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn rect_from_ns_rect(rect: objc2_foundation::NSRect) -> Rect {
    Rect {
        x: rect.origin.x,
        y: rect.origin.y,
        width: rect.size.width,
        height: rect.size.height,
    }
}

#[cfg(target_os = "macos")]
fn resolve_macos_overlay_panel_top_left_point(
    placement: OverlayPlacementRect,
    display_context: DesktopActivityOverlayDisplayContext,
) -> OverlayPlacementRect {
    OverlayPlacementRect {
        x: placement.x,
        y: display_context.screen_frame.y + display_context.screen_frame.height - placement.y,
    }
}

#[cfg(target_os = "macos")]
fn resolve_macos_overlay_panel_content_rect(
    top_left: OverlayPlacementRect,
    width: f64,
    height: f64,
) -> Rect {
    Rect {
        x: top_left.x,
        y: top_left.y - height,
        width,
        height,
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn apply_macos_overlay_panel_position<R: Runtime>(
    window: &WebviewWindow<R>,
    host_mode: DesktopActivityOverlayHostMode,
    display_context: Option<DesktopActivityOverlayDisplayContext>,
    placement: OverlayPlacementRect,
    width: f64,
    height: f64,
) -> Result<Option<Rect>, String> {
    if !matches!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated) {
        return Ok(None);
    }

    let Some(display_context) = display_context else {
        return Ok(None);
    };

    let panel = match window.app_handle().get_webview_panel(window.label()) {
        Ok(panel) => panel,
        Err(_) => return Ok(None),
    };
    let top_left = resolve_macos_overlay_panel_top_left_point(placement, display_context);
    let content_rect = resolve_macos_overlay_panel_content_rect(top_left, width, height);
    let (tx, rx) = std::sync::mpsc::channel();

    window
        .app_handle()
        .run_on_main_thread(move || {
            let ns_panel = panel.as_panel();
            let style_mask = ns_panel.styleMask();
            let content_frame = objc2_foundation::NSRect::new(
                objc2_foundation::NSPoint::new(content_rect.x, content_rect.y),
                objc2_foundation::NSSize::new(content_rect.width, content_rect.height),
            );
            let frame_rect = unsafe {
                objc2_app_kit::NSWindow::frameRectForContentRect_styleMask(
                    content_frame,
                    style_mask,
                    objc2::MainThreadMarker::new()
                        .expect("expected panel frame conversion to run on the main thread"),
                )
            };
            ns_panel.setFrame_display(frame_rect, false);
            let _ = tx.send(rect_from_ns_rect(ns_panel.frame()));
        })
        .map_err(|error| error.to_string())?;

    Ok(rx.recv().ok())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn apply_macos_overlay_panel_host<R: tauri::Runtime>(
    _window: &tauri::WebviewWindow<R>,
    _settings: DesktopActivityOverlayMacWindowHostSettings,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn apply_macos_overlay_panel_position<R: tauri::Runtime>(
    _window: &tauri::WebviewWindow<R>,
    _host_mode: DesktopActivityOverlayHostMode,
    _display_context: Option<DesktopActivityOverlayDisplayContext>,
    _placement: OverlayPlacementRect,
    _width: f64,
    _height: f64,
) -> Result<Option<Rect>, String> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity_overlay::host_mode::DesktopActivityOverlayDisplayContext;
    use crate::activity_overlay::placement::{OverlayPlacementRect, Rect};

    fn display_context(screen_frame: Rect) -> DesktopActivityOverlayDisplayContext {
        DesktopActivityOverlayDisplayContext {
            is_macos: true,
            is_builtin_display: true,
            has_physical_notch: true,
            safe_area_top: 74.0,
            screen_frame,
            visible_frame: screen_frame,
        }
    }

    #[test]
    fn notch_integrated_panel_style_mask_is_borderless_and_nonactivating() {
        let style_mask = resolve_panel_style_mask(DesktopActivityOverlayMacWindowHostSettings {
            prefer_panel_host: true,
            prefer_accessory_activation_policy: true,
            visible_on_all_workspaces: true,
            shadow: false,
            full_screen_auxiliary: true,
            stationary: true,
            ignores_cycle: true,
            nonactivating_panel: true,
            opaque: false,
            window_level_override: Some(DesktopActivityOverlayMacWindowLevelOverride::NotchPanel),
        });

        assert_eq!(
            style_mask,
            StyleMask::empty().borderless().nonactivating_panel(),
        );
    }

    #[test]
    fn panel_top_left_point_hugs_the_top_screen_edge_for_notch_mode() {
        let point = resolve_macos_overlay_panel_top_left_point(
            OverlayPlacementRect { x: 576.0, y: 0.0 },
            display_context(Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            }),
        );

        assert!((point.x - 576.0).abs() < 0.001);
        assert!((point.y - 982.0).abs() < 0.001);
    }

    #[test]
    fn panel_top_left_point_respects_secondary_display_offsets() {
        let point = resolve_macos_overlay_panel_top_left_point(
            OverlayPlacementRect { x: 1888.0, y: 18.0 },
            display_context(Rect {
                x: 1512.0,
                y: 120.0,
                width: 1728.0,
                height: 1117.0,
            }),
        );

        assert!((point.x - 1888.0).abs() < 0.001);
        assert!((point.y - 1219.0).abs() < 0.001);
    }

    #[test]
    fn panel_content_rect_can_be_converted_to_a_top_edge_aligned_borderless_frame() {
        let top_left = resolve_macos_overlay_panel_top_left_point(
            OverlayPlacementRect { x: 576.0, y: 0.0 },
            display_context(Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            }),
        );
        let content_rect = resolve_macos_overlay_panel_content_rect(top_left, 344.0, 68.0);

        let frame_rect = Rect {
            x: content_rect.x,
            y: content_rect.y,
            width: content_rect.width,
            height: content_rect.height,
        };

        assert!((frame_rect.x - 576.0).abs() < 0.001);
        assert!((frame_rect.y - 914.0).abs() < 0.001);
        assert!((frame_rect.height - 68.0).abs() < 0.001);
    }
}
