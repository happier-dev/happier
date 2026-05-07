use super::{PET_OVERLAY_WINDOW_LABEL, PET_OVERLAY_WINDOW_ROUTE};
use crate::pet_overlay::placement::{
    resolve_pet_overlay_parking_position, DesktopPetOverlayPosition, Rect,
};
use tauri::utils::config::Color;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DesktopPetOverlayWindowSpec {
    pub label: &'static str,
    pub route: &'static str,
    pub title: &'static str,
    pub transparent: bool,
    pub visible: bool,
    pub decorations: bool,
    pub resizable: bool,
    pub skip_taskbar: bool,
    pub always_on_top: bool,
    pub background_color: Option<Color>,
}

pub(crate) fn build_pet_overlay_window_spec(always_on_top: bool) -> DesktopPetOverlayWindowSpec {
    DesktopPetOverlayWindowSpec {
        label: PET_OVERLAY_WINDOW_LABEL,
        route: PET_OVERLAY_WINDOW_ROUTE,
        title: "Happier Pet Overlay",
        transparent: true,
        visible: false,
        decorations: false,
        resizable: false,
        skip_taskbar: true,
        always_on_top,
        background_color: Some(Color(0, 0, 0, 0)),
    }
}

pub(crate) fn build_pet_overlay_window_navigation_url(
    current_url: &tauri::Url,
) -> Result<tauri::Url, String> {
    let preserved_query_pairs: Vec<(String, String)> = current_url
        .query_pairs()
        .filter(|(key, _)| key != "desktopPetOverlayWindow")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    let mut next = current_url.clone();
    next.set_path("/desktop/pet-overlay");
    next.set_query(None);
    {
        let mut query = next.query_pairs_mut();
        query.append_pair("desktopPetOverlayWindow", "1");
        for (key, value) in preserved_query_pairs {
            query.append_pair(&key, &value);
        }
    }
    Ok(next)
}

pub(crate) fn resolve_pet_overlay_ignore_cursor_events(input_locked: bool) -> bool {
    input_locked
}

pub(crate) fn monitor_to_logical_rect(
    monitor: &tauri::Monitor,
    fallback_scale_factor: f64,
) -> Rect {
    let scale_factor = if monitor.scale_factor().is_finite() && monitor.scale_factor() > 0.000_1 {
        monitor.scale_factor()
    } else {
        fallback_scale_factor.max(0.000_1)
    };
    Rect {
        x: monitor.position().x as f64 / scale_factor,
        y: monitor.position().y as f64 / scale_factor,
        width: monitor.size().width as f64 / scale_factor,
        height: monitor.size().height as f64 / scale_factor,
    }
}

pub(crate) fn resolve_pet_overlay_monitor_rect<R: Runtime>(
    app: &AppHandle<R>,
    overlay_window: &WebviewWindow<R>,
) -> Rect {
    let overlay_scale_factor = overlay_window.scale_factor().unwrap_or(1.0).max(0.000_1);
    let from_overlay_current = overlay_window
        .current_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor_to_logical_rect(&monitor, overlay_scale_factor));
    let from_overlay_primary = overlay_window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor_to_logical_rect(&monitor, overlay_scale_factor));

    let from_main = app.get_webview_window("main").and_then(|main| {
        let main_scale_factor = main
            .scale_factor()
            .unwrap_or(overlay_scale_factor)
            .max(0.000_1);
        main.current_monitor()
            .ok()
            .flatten()
            .map(|monitor| monitor_to_logical_rect(&monitor, main_scale_factor))
    });
    let from_main_primary = app.get_webview_window("main").and_then(|main| {
        let main_scale_factor = main
            .scale_factor()
            .unwrap_or(overlay_scale_factor)
            .max(0.000_1);
        main.primary_monitor()
            .ok()
            .flatten()
            .map(|monitor| monitor_to_logical_rect(&monitor, main_scale_factor))
    });

    from_overlay_current
        .or(from_main)
        .or(from_overlay_primary)
        .or(from_main_primary)
        .unwrap_or(Rect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        })
}

pub(crate) fn ensure_pet_overlay_window<R: Runtime>(
    app: &AppHandle<R>,
    always_on_top: bool,
) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(PET_OVERLAY_WINDOW_LABEL) {
        let _ = window.set_always_on_top(always_on_top);
        navigate_pet_overlay_window_to_route(&window)?;
        return Ok(window);
    }

    let spec = build_pet_overlay_window_spec(always_on_top);
    let window = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::App(spec.route.into()))
        .title(spec.title)
        .decorations(spec.decorations)
        .resizable(spec.resizable)
        .always_on_top(spec.always_on_top)
        .transparent(spec.transparent)
        .visible(spec.visible)
        .skip_taskbar(spec.skip_taskbar)
        .build()
        .map_err(|error| error.to_string())?;

    window
        .set_background_color(spec.background_color)
        .map_err(|error| error.to_string())?;
    navigate_pet_overlay_window_to_route(&window)?;
    Ok(window)
}

pub(crate) fn park_pet_overlay_window_offscreen<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    let parking =
        resolve_pet_overlay_parking_position(resolve_pet_overlay_monitor_rect(app, window));
    set_pet_overlay_window_frame(
        window,
        DesktopPetOverlayPosition {
            x: parking.x,
            y: parking.y,
        },
        1.0,
        1.0,
    )?;
    window.show().map_err(|error| error.to_string())
}

pub(crate) fn set_pet_overlay_window_frame<R: Runtime>(
    window: &WebviewWindow<R>,
    position: DesktopPetOverlayPosition,
    width: f64,
    height: f64,
) -> Result<(), String> {
    window
        .set_size(LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|error| error.to_string())?;
    window
        .set_position(LogicalPosition::new(position.x, position.y))
        .map_err(|error| error.to_string())
}

pub(crate) fn navigate_pet_overlay_window_to_route<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    let current_url = window.url().map_err(|error| error.to_string())?;
    let target_url = build_pet_overlay_window_navigation_url(&current_url)?;
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
    use std::{fs, path::PathBuf};

    #[test]
    fn pet_overlay_window_spec_is_hidden_transparent_and_taskbarless() {
        let spec = build_pet_overlay_window_spec(true);

        assert_eq!(spec.label, "pet_overlay");
        assert_eq!(spec.route, "/desktop/pet-overlay?desktopPetOverlayWindow=1",);
        assert!(spec.transparent);
        assert!(!spec.visible);
        assert!(!spec.decorations);
        assert!(!spec.resizable);
        assert!(spec.skip_taskbar);
        assert!(spec.always_on_top);
        assert_eq!(spec.background_color, Some(Color(0, 0, 0, 0)));
    }

    #[test]
    fn pet_overlay_navigation_url_preserves_existing_query_and_targets_overlay_route() {
        let current_url =
            tauri::Url::parse("http://localhost:8081/sessions?serverId=srv-1").expect("valid URL");

        let target_url = build_pet_overlay_window_navigation_url(&current_url)
            .expect("navigation URL should build");

        assert_eq!(target_url.path(), "/desktop/pet-overlay");
        assert_eq!(
            target_url.query(),
            Some("desktopPetOverlayWindow=1&serverId=srv-1"),
        );
    }

    #[test]
    fn input_locked_overlay_ignores_cursor_events_for_click_through() {
        assert!(resolve_pet_overlay_ignore_cursor_events(true));
        assert!(!resolve_pet_overlay_ignore_cursor_events(false));
    }

    #[test]
    fn monitor_resolution_prefers_current_monitor_before_primary_monitor_fallback() {
        let source_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("pet_overlay")
            .join("window_lifecycle.rs");
        let source = fs::read_to_string(&source_path).unwrap_or_else(|error| {
            panic!(
                "failed to read monitor lifecycle source {}: {error}",
                source_path.display()
            )
        });

        let overlay_current = source
            .find("overlay_window\n        .current_monitor()")
            .expect("overlay current monitor lookup should exist");
        let main_current = source
            .find("main.current_monitor()")
            .expect("main current monitor lookup should exist");
        let overlay_primary = source
            .find("overlay_window.primary_monitor()")
            .expect("overlay primary monitor fallback should exist");
        let main_primary = source
            .find("main.primary_monitor()")
            .expect("main primary monitor fallback should exist");

        assert!(
            overlay_current < overlay_primary,
            "overlay current monitor should be consulted before overlay primary monitor fallback",
        );
        assert!(
            main_current < main_primary,
            "main current monitor should be consulted before main primary monitor fallback",
        );
        assert!(
            overlay_current < main_primary,
            "overlay current monitor should be part of the first resolution tier before primary fallback",
        );
    }
}
