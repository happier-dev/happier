use super::host_window::resolve_macos_overlay_window_builder_defaults;
use super::{
    availability_for_failure, dock, panel_host, pointer, displays,
    ActivityOverlayState, DesktopActivityOverlayPlacementDiagnosticsPayload,
    DesktopActivityOverlaySurface, DesktopActivityOverlayWindowStatePayload, FrameInput,
    FramePresentation, OverlayPlacementRect, Rect, MAIN_WINDOW_LABEL, OVERLAY_POINTER_EVENT,
    OVERLAY_STATE_EVENT,
};
use super::{OVERLAY_WINDOW_LABEL, OVERLAY_WINDOW_ROUTE};
use tauri::Emitter;
use tauri::{
    utils::config::Color, AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub(super) fn publish_overlay_state<R: Runtime>(
    app: &AppHandle<R>,
    state: &ActivityOverlayState,
) -> Result<(), String> {
    let (frame, diagnostics) = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        (
            guard
                .last_window_state
                .as_ref()
                .and_then(|value| value.frame),
            guard
                .last_window_state
                .as_ref()
                .and_then(|value| value.placement_diagnostics.clone()),
        )
    };
    publish_projection(app, state, frame, diagnostics)
}

fn publish_projection<R: Runtime>(
    app: &AppHandle<R>,
    state: &ActivityOverlayState,
    frame: Option<FramePresentation>,
    diagnostics: Option<DesktopActivityOverlayPlacementDiagnosticsPayload>,
) -> Result<(), String> {
    let Some(window_state) = update_projection(state, frame, diagnostics)? else {
        return Ok(());
    };
    app.emit_to(OVERLAY_WINDOW_LABEL, OVERLAY_STATE_EVENT, &window_state)
        .map_err(|error| error.to_string())?;
    app.emit_to(MAIN_WINDOW_LABEL, OVERLAY_STATE_EVENT, &window_state)
        .map_err(|error| error.to_string())
}

fn update_projection(
    state: &ActivityOverlayState,
    frame: Option<FramePresentation>,
    diagnostics: Option<DesktopActivityOverlayPlacementDiagnosticsPayload>,
) -> Result<Option<DesktopActivityOverlayWindowStatePayload>, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
    let Some(payload) = guard.last_sync_payload.as_ref() else {
        return Ok(None);
    };
    let result = DesktopActivityOverlayWindowStatePayload {
        visible: payload.visible,
        model: payload.model.clone(),
        policy: payload.policy.clone(),
        surface: guard.present.map(|value| value.surface).unwrap_or_default(),
        engaged: guard.present.is_some_and(|value| value.engaged),
        availability: serde_json::json!({"activity": availability_for_failure(guard.host_failure.as_deref())}),
        frame,
        frame_rect: guard.envelope,
        placement_diagnostics: diagnostics,
    };
    if guard.last_window_state.as_ref() == Some(&result) {
        return Ok(None);
    }
    guard.last_window_state = Some(result.clone());
    Ok(Some(result))
}

fn hide_unavailable_host<R: Runtime>(
    app: &AppHandle<R>,
    state: &ActivityOverlayState,
) -> Result<(), String> {
    if let Err(error) = pointer::set_visible(app, OVERLAY_WINDOW_LABEL, false) {
        log::warn!("Overlay pointer teardown failed: {error}");
    }
    if let Some(window) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        let _ = set_keyboard_wanted(&window, false);
        #[cfg(target_os = "windows")]
        let _ = super::windows_fullscreen::configure(&window, false, false);
        let _ = window.hide();
    }
    publish_overlay_state(app, state)
}

fn settle_host_application(
    state: &ActivityOverlayState,
    result: Result<(), String>,
) -> Result<(), String> {
    if let Err(reason) = &result {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        guard.host_failure = Some(reason.clone());
        guard.last_host_settings = None;
        guard.native_visible = false;
    }
    result
}

pub(super) fn apply_overlay_state<R: Runtime>(
    app: &AppHandle<R>,
    state: &ActivityOverlayState,
) -> Result<(), String> {
    match settle_host_application(state, apply_overlay_state_inner(app, state)) {
        Ok(()) => Ok(()),
        Err(reason) => {
            log::warn!("Overlay host unavailable: {reason}");
            hide_unavailable_host(app, state)
        }
    }
}

fn apply_overlay_state_inner<R: Runtime>(
    app: &AppHandle<R>,
    state: &ActivityOverlayState,
) -> Result<(), String> {
    if crate::menu_bar::is_active(app) {
        return Ok(());
    }
    let (
        payload,
        present,
        rest_extent,
        previous_envelope,
        previous_host,
        native_visible,
    ) = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        (
            guard.last_sync_payload.clone(),
            guard.present,
            guard.rest_extent,
            guard.envelope,
            guard.last_host_settings,
            guard.native_visible,
        )
    };
    let Some(payload) = payload else {
        return Ok(());
    };
    if !should_materialize(&payload, present) {
        #[cfg(target_os = "windows")]
        if let Some(window) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
            super::windows_fullscreen::configure(&window, false, payload.policy.always_on_top)?;
        }
        pointer::set_visible(app, OVERLAY_WINDOW_LABEL, false)?;
        if native_visible {
            if let Some(window) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
                window.hide().map_err(|error| error.to_string())?;
            }
        }
        state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?
            .native_visible = false;
        return publish_overlay_state(app, state);
    }
    let existed = app.get_webview_window(OVERLAY_WINDOW_LABEL).is_some();
    let window = ensure_overlay_window(app, payload.policy.always_on_top)?;
    if present.is_none() {
        return publish_overlay_state(app, state);
    }
    let present = present.expect("a visible frame has a renderer presentation");
    let (selected,choice,visible) = displays::placement(app,state,&payload.policy.display_mode)?;
    let monitor = selected.rect;
    let display = selected.display_context.clone();
    let rest = rest_extent.unwrap_or(present.extent);
    let input={
        let guard=state.0.lock().map_err(|e|e.to_string())?;
        frame_input(&payload.policy,present,rest,&selected,visible,&guard.notch_positions)
    };
    let target = dock::frame_plan(input);
    let same_display=state.0.lock().map_err(|e|e.to_string())?.resolved_display_key.as_ref()==Some(&selected.storage_key);
    let rect = dock::envelope(target.rect, previous_envelope.filter(|_|same_display), present.settled);
    let frame = target.presentation_in(rect, selected.scale);
    let previous_scale = state.0.lock().map_err(|e| e.to_string())?.last_window_state.as_ref()
        .and_then(|value| value.frame).and_then(|value| value.screen_origin).map(|origin| origin.scale_factor);
    let settings = (
        payload.policy.dock,
        present.surface.is_open(),
        payload.policy.always_on_top,
    );
    if previous_host != Some(settings) {
        panel_host::apply_overlay_host(&window, settings.0, settings.1, settings.2)
            .map_err(|_| "panel_host_apply_failed".to_string())?;
    }
    let mut native_frame = state
        .0
        .lock()
        .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?
        .last_window_state
        .as_ref()
        .and_then(|value| value.placement_diagnostics.as_ref())
        .and_then(|value| value.applied_native_frame);
    pointer::install(app, &window, OVERLAY_POINTER_EVENT)
        .map_err(|_| "pointer_unavailable".to_string())?;
    let layer_policy_changed = cfg!(target_os = "linux")
        && previous_host.map(|value| (value.0, value.2)) != Some((settings.0, settings.2));
    if previous_envelope != Some(rect) || previous_scale != Some(selected.scale) || !native_visible || !existed || layer_policy_changed {
        native_frame = panel_host::apply_overlay_frame(&window, rect, monitor, display.as_ref(), selected.scale, settings.0, settings.2)
            .map_err(|_| "panel_position_unavailable".to_string())?;
        pointer::geometry_changed(app, OVERLAY_WINDOW_LABEL)?;
    }
    #[cfg(target_os = "macos")]
    {
        // Flight layers and previous animation frames are paint bounds, not input bounds.
        let island = dock::frame_plan(FrameInput { screen_bounds: None, ..input }).rect;
        super::macos_pointer::set_hit_rect(&window,
            (island.x - rect.x, island.y - rect.y, island.width, island.height))?;
    }
    #[cfg(target_os = "windows")]
    let show = super::windows_fullscreen::configure(&window, true, payload.policy.always_on_top)?;
    #[cfg(not(target_os = "windows"))]
    let show = true;
    pointer::set_visible(app, OVERLAY_WINDOW_LABEL, show)?;
    pointer::set_engaged(app, OVERLAY_WINDOW_LABEL, show && present.engaged)?;
    pointer::set_outside_press(app, OVERLAY_WINDOW_LABEL,
        show && matches!(present.surface, DesktopActivityOverlaySurface::Expanded | DesktopActivityOverlaySurface::Pinned))?;
    if previous_host.is_some_and(|(_, was_open, _)| was_open) && (!show || !present.surface.is_open()) {
        set_keyboard_wanted(&window, false)?;
    }
    if show && (!native_visible || !existed) {
        show_overlay_window_without_activation(&window)?;
    } else if !show && native_visible {
        window.hide().map_err(|error| error.to_string())?;
    }
    let diagnostics = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        guard.resolved_display_key = Some(selected.storage_key.clone());
        guard.last_display_context = display.clone();
        guard.envelope = Some(rect);
        guard.last_host_settings = Some(settings);
        guard.native_visible = show;
        guard.host_failure = None;
        DesktopActivityOverlayPlacementDiagnosticsPayload {
            dock: payload.policy.dock,
            surface: present.surface,
            engaged: present.engaged,
            monitor_source: match choice.source {
                "built_in" => super::placement::DesktopActivityOverlayMonitorSource::BuiltIn,
                "main" => super::placement::DesktopActivityOverlayMonitorSource::MainWindow,
                "named" => super::placement::DesktopActivityOverlayMonitorSource::Named,
                _ => super::placement::DesktopActivityOverlayMonitorSource::Primary,
            },
            display: Some(displays::resolution(&selected, choice, &payload.policy.display_mode, &guard.notch_positions)),
            effective_monitor: monitor,
            display_context: display,
            computed_position: OverlayPlacementRect {
                x: rect.x,
                y: rect.y,
            },
            native_host_path: if cfg!(target_os = "macos") {
                "panel".into()
            } else {
                "window".into()
            },
            applied_native_frame: native_frame,
        }
    };
    publish_projection(app, state, Some(frame), Some(diagnostics))
}

pub(super) fn frame_input(
    policy:&super::DesktopActivityOverlayPolicyPayload,
    present:super::DesktopActivityOverlayPresentPayload,
    rest:super::DesktopActivityOverlayExtent,
    selected:&super::monitor_resolution::MonitorFacts,
    visible:Rect,
    positions:&super::storage::NotchPositions,
) -> FrameInput {
    FrameInput {
        dock:policy.dock,visible,
        top:if cfg!(target_os="macos") {selected.rect.y} else {visible.y},
        position:super::storage::position_for_dock(positions.get(&selected.storage_key),policy.dock),
        extent:(present.extent.width,present.extent.height),
        screen_bounds:present.extent.screen_bounds,
        rest_extent:(rest.width,rest.height),surface:present.surface,
        camera_center:selected.display_context.as_ref().filter(|d|d.has_physical_notch && d.is_builtin_display)
            .map(|_|selected.rect.x+selected.rect.width/2.),
        camera_offset:present.extent.camera_offset,
    }
}

fn should_materialize(
    payload: &super::DesktopActivityOverlaySyncPayload,
    present: Option<super::DesktopActivityOverlayPresentPayload>,
) -> bool {
    payload.policy.enabled
        && match present {
            Some(value) => value.surface != DesktopActivityOverlaySurface::Hidden,
            None => {
                payload.visible || payload.policy.idle != super::DesktopActivityOverlayIdle::Hidden
            }
        }
}

/// Re-apply the renderer's current surface at the target display scale; never choose a surface.
#[cfg(target_os = "windows")]
pub(super) fn reframe_after_display_change<R: Runtime>(
    app: &AppHandle<R>,
    state: &ActivityOverlayState,
) -> Result<(), String> {
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        if !guard.native_visible {
            return Ok(());
        }
        displays::invalidate_projection(&mut guard);
    }
    apply_overlay_state(app, state)
}

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

pub(crate) fn ensure_overlay_window<R: Runtime>(
    app: &AppHandle<R>,
    always_on_top: bool,
) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        #[cfg(target_os = "linux")]
        super::linux_layer::initialize(&window)?;
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
    .focused(false)
    .skip_taskbar(true);

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.focusable(false);

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
    #[cfg(target_os = "linux")]
    super::linux_layer::initialize(&window)?;
    window
        .set_background_color(resolve_overlay_window_background_color())
        .map_err(|error| error.to_string())?;
    navigate_overlay_window_to_route(&window)?;
    #[cfg(target_os = "windows")]
    super::native_display::watch_window(&window)?;
    Ok(window)
}

/// One keyboard lever for the composer and keyboard-initiated opens. Pointer controls stay non-key.
pub(crate) fn set_keyboard_wanted<R: Runtime>(window: &WebviewWindow<R>, wanted: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let native_window = window.clone();
        return crate::desktop_panel::run_on_main_thread(window.app_handle(), move || {
            let panel = crate::desktop_panel::ensure_panel(&native_window)?;
            crate::desktop_panel::set_keyboard_wanted(panel.as_panel(), wanted);
            Ok(())
        }, "Overlay keyboard request did not return")?;
    }
    #[cfg(target_os = "windows")]
    {
        use std::{cell::Cell, ffi::c_void};
        use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow}};
        thread_local! { static PREVIOUS_FOREGROUND: Cell<isize> = const { Cell::new(0) }; }
        let native_window = window.clone();
        return super::windows_pointer::on_window_thread(window, move || {
                let hwnd = native_window.hwnd().map_err(|error| error.to_string())?;
                let foreground = unsafe { GetForegroundWindow() };
                if wanted && foreground != hwnd {
                    PREVIOUS_FOREGROUND.with(|previous| previous.set(foreground.0 as isize));
                }
                native_window.set_focusable(wanted).map_err(|error| error.to_string())?;
                if wanted { native_window.set_focus().map_err(|error| error.to_string())?; }
                else {
                    let previous = PREVIOUS_FOREGROUND.with(|value| value.replace(0));
                    if previous != 0 && foreground == hwnd {
                        let _ = unsafe { SetForegroundWindow(HWND(previous as *mut c_void)) };
                    }
                }
                Ok(())
        });
    }
    #[cfg(target_os = "linux")]
    {
        let native_window = window.clone();
        return crate::desktop_panel::run_on_main_thread(window.app_handle(), move || {
            let native = native_window.gtk_window().map_err(|error| error.to_string())?;
            super::linux_layer::keyboard_native(&native, wanted);
            native_window.set_focusable(wanted).map_err(|error| error.to_string())?;
            if wanted { native_window.set_focus().map_err(|error| error.to_string())?; }
            Ok(())
        }, "Overlay keyboard request did not return")?;
    }
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
    crate::desktop_panel::show_without_activation(window)
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

    fn payload(visible: bool, idle: &str) -> super::super::DesktopActivityOverlaySyncPayload {
        serde_json::from_value(serde_json::json!({"visible":visible,"model":{},
            "policy":{"enabled":true,"alwaysOnTop":true,"dock":"top","idle":idle}}))
        .unwrap()
    }

    #[test]
    fn hidden_does_not_materialize_and_tip_bootstraps_without_content() {
        let hidden = super::super::DesktopActivityOverlayPresentPayload {
            surface: DesktopActivityOverlaySurface::Hidden,
            engaged: false,
            extent: super::super::DesktopActivityOverlayExtent {
                width: 0.,
                height: 0.,
                camera_offset: 0.,
                screen_bounds: None,
            },
            settled: true,
        };
        assert!(!should_materialize(&payload(false, "hidden"), None));
        assert!(!should_materialize(&payload(true, "tip"), Some(hidden)));
        assert!(should_materialize(&payload(false, "tip"), None));
        assert!(should_materialize(&payload(false, "full"), None));
        let mut disabled = payload(true, "full");
        disabled.policy.enabled = false;
        assert!(!should_materialize(&disabled, None));
    }

    #[test]
    fn unchanged_native_projection_produces_no_publications() {
        let state = ActivityOverlayState::default();
        state.0.lock().unwrap().last_sync_payload = Some(payload(false, "tip"));
        let mut publications = 0;
        for _ in 0..1000 {
            publications += usize::from(update_projection(&state, None, None).unwrap().is_some());
        }
        assert_eq!(publications, 1);
        state
            .0
            .lock()
            .unwrap()
            .last_sync_payload
            .as_mut()
            .unwrap()
            .model = serde_json::json!({"word":"Working"});
        assert!(update_projection(&state, None, None).unwrap().is_some());
        assert!(update_projection(&state, None, None).unwrap().is_none());
        state.0.lock().unwrap().host_failure = Some("panel_host_apply_failed".into());
        let failure = update_projection(&state, None, None).unwrap().unwrap();
        assert_eq!(
            failure.availability["activity"],
            serde_json::json!({"kind":"unavailable","reason":"panel_host_apply_failed"})
        );
        assert!(!failure.visible);
        assert!(update_projection(&state, None, None).unwrap().is_none());
    }

    #[test]
    fn flight_extent_covers_the_screen_target_then_settles_to_the_island() {
        let policy = payload(true, "tip").policy;
        let present = serde_json::from_value(serde_json::json!({
            "surface":"pinned", "engaged":true,
            "extent":{"width":400.,"height":300.,
                "screenBounds":{"x":-200.,"y":-100.,"width":1400.,"height":1000.}}
        })).unwrap();
        let monitor = super::super::monitor_resolution::MonitorFacts {
            storage_key: "display".into(), name: "Display".into(), built_in: None,
            primary: true, native_name: None,
            rect: Rect { x:0., y:0., width:1000., height:800. },
            work_area: Rect { x:0., y:30., width:1000., height:770. },
            scale: 2., display_context: None,
        };
        let rest = serde_json::from_value(serde_json::json!({"width":100.,"height":40.})).unwrap();
        let positions = super::super::storage::NotchPositions::default();
        let input = frame_input(&policy, present, rest, &monitor, monitor.work_area, &positions);
        let flight = dock::frame_plan(input);
        assert_eq!(flight.rect, Rect { x:-200., y:-100., width:1400., height:1000. });
        let resting = serde_json::from_value(serde_json::json!({
            "surface":"collapsed", "engaged":false,
            "extent":{"width":100.,"height":40.}, "settled":true
        })).unwrap();
        let target = dock::frame_plan(frame_input(&policy, resting, rest, &monitor, monitor.work_area, &positions));
        assert_eq!(dock::envelope(target.rect, Some(flight.rect), false), flight.rect);
        assert_eq!(dock::envelope(target.rect, Some(flight.rect), true), target.rect);
    }

    #[test]
    fn applied_screen_origin_publishes_once_per_geometry_change() {
        let state = ActivityOverlayState::default();
        state.0.lock().unwrap().last_sync_payload = Some(payload(true, "tip"));
        let frame = |x, scale| serde_json::from_value::<FramePresentation>(serde_json::json!({
            "dock":"top", "growth":{"x":null,"y":"down"},
            "anchorOffset":{"x":0.,"y":0.},
            "screenOrigin":{"x":x,"y":-100.,"scaleFactor":scale}
        })).unwrap();
        let initial = update_projection(&state, Some(frame(-200., 2.)), None).unwrap().unwrap();
        let json = serde_json::to_value(initial).unwrap();
        assert_eq!(json["frame"]["screenOrigin"], serde_json::json!({"x":-200.,"y":-100.,"scaleFactor":2.}));
        for _ in 0..50 {
            assert!(update_projection(&state, Some(frame(-200., 2.)), None).unwrap().is_none());
        }
        assert!(update_projection(&state, Some(frame(-150., 2.)), None).unwrap().is_some());
        assert!(update_projection(&state, Some(frame(-150., 1.5)), None).unwrap().is_some());
        assert!(update_projection(&state, Some(frame(-150., 1.5)), None).unwrap().is_none());
    }

    #[test]
    fn failed_host_bootstrap_and_application_settle_unavailable_without_losing_content() {
        for reason in ["native_bootstrap_failed", "native_show_failed"] {
            let state = ActivityOverlayState::default();
            {
                let mut guard = state.0.lock().unwrap();
                guard.last_sync_payload = Some(payload(true, "tip"));
                guard.native_visible = true;
                guard.last_host_settings = Some((dock::Dock::Top, false, true));
            }
            assert_eq!(
                settle_host_application(&state, Err(reason.into())),
                Err(reason.into())
            );
            let guard = state.0.lock().unwrap();
            assert!(!guard.native_visible);
            assert!(guard.last_host_settings.is_none());
            drop(guard);
            let projection = update_projection(&state, None, None).unwrap().unwrap();
            assert!(projection.visible);
            assert_eq!(
                projection.availability["activity"],
                serde_json::json!({"kind":"unavailable","reason":reason})
            );
        }
    }

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
