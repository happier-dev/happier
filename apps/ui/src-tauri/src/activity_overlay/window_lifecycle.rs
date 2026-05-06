use super::host_window::resolve_macos_overlay_window_builder_defaults;
use super::monitor_resolution::resolve_parking_monitor_rect;
use super::{OVERLAY_PARK_OFFSCREEN_DISTANCE_PX, OVERLAY_WINDOW_LABEL, OVERLAY_WINDOW_ROUTE};
use tauri::{
    utils::config::Color, AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OverlayWindowShowStrategy {
    TauriShow,
    OrderFrontRegardless,
}

fn resolve_overlay_window_show_strategy(is_macos: bool) -> OverlayWindowShowStrategy {
    if is_macos {
        return OverlayWindowShowStrategy::OrderFrontRegardless;
    }

    OverlayWindowShowStrategy::TauriShow
}

fn resolve_overlay_window_background_color() -> Option<Color> {
    Some(Color(0, 0, 0, 0))
}

pub(crate) fn park_overlay_window_offscreen<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    let monitor_rect = resolve_parking_monitor_rect(app, window);
    let base_x = if monitor_rect.width > 0.0 {
        monitor_rect.x + monitor_rect.width
    } else {
        monitor_rect.x
    };
    let base_y = if monitor_rect.height > 0.0 {
        monitor_rect.y + monitor_rect.height
    } else {
        monitor_rect.y
    };

    window
        .set_size(LogicalSize::new(1.0, 1.0))
        .map_err(|error| error.to_string())?;
    window
        .set_position(LogicalPosition::new(
            base_x + OVERLAY_PARK_OFFSCREEN_DISTANCE_PX,
            base_y + OVERLAY_PARK_OFFSCREEN_DISTANCE_PX,
        ))
        .map_err(|error| error.to_string())?;
    show_overlay_window_without_activation(window)
}

pub(crate) fn ensure_overlay_window<R: Runtime>(
    app: &AppHandle<R>,
    always_on_top: bool,
) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        navigate_overlay_window_to_route(&window)?;
        return Ok(window);
    }

    let builder = WebviewWindowBuilder::new(
        app,
        OVERLAY_WINDOW_LABEL,
        WebviewUrl::App(OVERLAY_WINDOW_ROUTE.into()),
    )
    .title("Happier Activity Overlay")
    .decorations(false)
    .resizable(false)
    .always_on_top(always_on_top)
    .transparent(true)
    .visible(false)
    .skip_taskbar(true);

    #[cfg(target_os = "macos")]
    let builder = if let Some(defaults) = resolve_macos_overlay_window_builder_defaults(true) {
        builder
            .accept_first_mouse(defaults.accept_first_mouse)
            .title_bar_style(defaults.title_bar_style)
            .hidden_title(defaults.hidden_title)
            .shadow(defaults.shadow)
    } else {
        builder
    };

    let window = builder.build().map_err(|error| error.to_string())?;
    window
        .set_background_color(resolve_overlay_window_background_color())
        .map_err(|error| error.to_string())?;
    navigate_overlay_window_to_route(&window)?;
    Ok(window)
}

pub(crate) fn show_overlay_window_without_activation<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    match resolve_overlay_window_show_strategy(cfg!(target_os = "macos")) {
        OverlayWindowShowStrategy::OrderFrontRegardless => {
            show_macos_overlay_window_without_activation(window)
        }
        OverlayWindowShowStrategy::TauriShow => window.show().map_err(|error| error.to_string()),
    }
}

#[cfg(target_os = "macos")]
fn show_macos_overlay_window_without_activation<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    let ns_window_ptr = window.ns_window().map_err(|error| error.to_string())?;
    let ns_window: &objc2_app_kit::NSWindow = unsafe { &*ns_window_ptr.cast() };
    unsafe {
        let _: () = objc2::msg_send![ns_window, orderFrontRegardless];
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn show_macos_overlay_window_without_activation<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())
}

pub(crate) fn build_overlay_window_navigation_url(
    current_url: &tauri::Url,
) -> Result<tauri::Url, String> {
    let preserved_query_pairs: Vec<(String, String)> = current_url
        .query_pairs()
        .filter(|(key, _)| key != "desktopOverlayWindow")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    let mut next = current_url.clone();
    next.set_path("/desktop/activity-overlay");
    next.set_query(None);
    {
        let mut query = next.query_pairs_mut();
        query.append_pair("desktopOverlayWindow", "1");
        for (key, value) in preserved_query_pairs {
            query.append_pair(&key, &value);
        }
    }
    Ok(next)
}

pub(crate) fn navigate_overlay_window_to_route<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    let current_url = window.url().map_err(|error| error.to_string())?;
    let target_url = build_overlay_window_navigation_url(&current_url)?;
    if current_url.as_str() == target_url.as_str() {
        return Ok(());
    }

    window
        .navigate(target_url)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::utils::config::Color;

    #[test]
    fn macos_overlay_show_uses_nonactivating_order_front_strategy() {
        assert_eq!(
            resolve_overlay_window_show_strategy(true),
            OverlayWindowShowStrategy::OrderFrontRegardless,
        );
    }

    #[test]
    fn non_macos_overlay_show_uses_regular_tauri_show_strategy() {
        assert_eq!(
            resolve_overlay_window_show_strategy(false),
            OverlayWindowShowStrategy::TauriShow,
        );
    }

    #[test]
    fn overlay_window_background_color_is_fully_transparent() {
        assert_eq!(
            resolve_overlay_window_background_color(),
            Some(Color(0, 0, 0, 0)),
        );
    }
}
