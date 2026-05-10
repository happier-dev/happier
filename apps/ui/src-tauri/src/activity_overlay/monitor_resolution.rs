#[cfg(target_os = "macos")]
use super::macos_display_context::resolve_overlay_display_context_for_monitor;
use super::placement::{
    resolve_overlay_anchor_monitor_resolution, DesktopActivityOverlayDisplayMode, Rect,
    ResolvedOverlayAnchorMonitorRect,
};
use super::{DesktopActivityOverlayPlacementMode, MAIN_WINDOW_LABEL};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

pub(crate) fn resolve_monitor_logical_scale_factor(
    monitor_scale_factor: f64,
    fallback_scale_factor: f64,
) -> f64 {
    let monitor_scale_factor = if monitor_scale_factor.is_finite() && monitor_scale_factor > 0.000_1
    {
        monitor_scale_factor
    } else {
        fallback_scale_factor
    };
    monitor_scale_factor.max(0.000_1)
}

pub(crate) fn logical_rect_from_physical_bounds(
    position_x: i32,
    position_y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
) -> Rect {
    Rect {
        x: position_x as f64 / scale_factor,
        y: position_y as f64 / scale_factor,
        width: width as f64 / scale_factor,
        height: height as f64 / scale_factor,
    }
}

pub(crate) fn monitor_to_logical_rect(
    monitor: &tauri::Monitor,
    fallback_scale_factor: f64,
) -> Rect {
    logical_rect_from_physical_bounds(
        monitor.position().x,
        monitor.position().y,
        monitor.size().width,
        monitor.size().height,
        resolve_monitor_logical_scale_factor(monitor.scale_factor(), fallback_scale_factor),
    )
}

pub(crate) fn resolve_anchor_monitor_resolution<R: Runtime>(
    app: &AppHandle<R>,
    overlay_window: &WebviewWindow<R>,
    placement_mode: DesktopActivityOverlayPlacementMode,
    display_mode: DesktopActivityOverlayDisplayMode,
) -> Result<ResolvedOverlayAnchorMonitorRect, String> {
    let overlay_scale_factor = overlay_window.scale_factor().unwrap_or(1.0).max(0.000_1);
    let main_window = app.get_webview_window(MAIN_WINDOW_LABEL);
    let main_scale_factor = main_window
        .as_ref()
        .and_then(|window| window.scale_factor().ok())
        .unwrap_or(overlay_scale_factor)
        .max(0.000_1);

    let main_window_monitor = main_window
        .as_ref()
        .and_then(|window| window.current_monitor().ok().flatten())
        .map(|monitor| monitor_to_logical_rect(&monitor, main_scale_factor));
    let overlay_window_monitor = overlay_window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .map(|monitor| monitor_to_logical_rect(&monitor, overlay_scale_factor));
    let primary_monitor = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|window| {
            let scale_factor = window
                .scale_factor()
                .unwrap_or(overlay_scale_factor)
                .max(0.000_1);
            window
                .primary_monitor()
                .ok()
                .flatten()
                .map(|monitor| monitor_to_logical_rect(&monitor, scale_factor))
        })
        .or_else(|| {
            overlay_window
                .primary_monitor()
                .ok()
                .flatten()
                .map(|monitor| monitor_to_logical_rect(&monitor, overlay_scale_factor))
        });
    let focused_monitor = main_window.as_ref().and_then(|window| {
        if !window.is_focused().unwrap_or(false) {
            return None;
        }
        let scale_factor = window
            .scale_factor()
            .unwrap_or(overlay_scale_factor)
            .max(0.000_1);
        window
            .current_monitor()
            .ok()
            .flatten()
            .map(|monitor| monitor_to_logical_rect(&monitor, scale_factor))
    });
    #[cfg(target_os = "macos")]
    let built_in_monitor = resolve_builtin_monitor_rect(app, overlay_scale_factor);
    #[cfg(not(target_os = "macos"))]
    let built_in_monitor = None;

    resolve_overlay_anchor_monitor_resolution(
        display_mode,
        placement_mode,
        main_window_monitor,
        overlay_window_monitor,
        primary_monitor,
        built_in_monitor,
        focused_monitor,
    )
}

pub(crate) fn resolve_available_monitor_rects<R: Runtime>(
    app: &AppHandle<R>,
    overlay_window: &WebviewWindow<R>,
) -> Vec<Rect> {
    let overlay_scale_factor = overlay_window.scale_factor().unwrap_or(1.0).max(0.000_1);
    overlay_window
        .available_monitors()
        .or_else(|_| app.available_monitors())
        .unwrap_or_default()
        .into_iter()
        .map(|monitor| monitor_to_logical_rect(&monitor, overlay_scale_factor))
        .collect()
}

#[cfg(target_os = "macos")]
fn resolve_builtin_monitor_rect<R: Runtime>(
    app: &AppHandle<R>,
    fallback_scale_factor: f64,
) -> Option<Rect> {
    app.available_monitors()
        .ok()?
        .into_iter()
        .find_map(|monitor| {
            let rect = monitor_to_logical_rect(&monitor, fallback_scale_factor);
            resolve_overlay_display_context_for_monitor(app, rect)
                .filter(|context| context.is_macos && context.is_builtin_display)
                .map(|_| rect)
        })
}

pub(crate) fn resolve_parking_monitor_rect<R: Runtime>(
    app: &AppHandle<R>,
    overlay_window: &WebviewWindow<R>,
) -> Rect {
    let overlay_scale_factor = overlay_window.scale_factor().unwrap_or(1.0).max(0.000_1);

    let from_overlay = overlay_window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor_to_logical_rect(&monitor, overlay_scale_factor));

    let from_main = app.get_webview_window(MAIN_WINDOW_LABEL).and_then(|main| {
        let main_scale_factor = main
            .scale_factor()
            .unwrap_or(overlay_scale_factor)
            .max(0.000_1);
        main.primary_monitor()
            .ok()
            .flatten()
            .map(|monitor| monitor_to_logical_rect(&monitor, main_scale_factor))
    });

    from_main.or(from_overlay).unwrap_or(Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    })
}
