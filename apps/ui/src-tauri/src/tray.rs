#[cfg(desktop)]
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuEvent, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager, Runtime,
};

#[cfg(desktop)]
use serde::Deserialize;
#[cfg(desktop)]
use serde::Serialize;

#[cfg(desktop)]
const SHOW_MAIN_WINDOW_MENU_ID: &str = "tray-show-main-window";
#[cfg(desktop)]
const OPEN_SETUP_MENU_ID: &str = "tray-open-setup";
#[cfg(desktop)]
const OPEN_SETTINGS_MENU_ID: &str = "tray-open-settings";
#[cfg(desktop)]
const RESOLVE_SETUP_MENU_ID: &str = "tray-resolve-setup";
#[cfg(desktop)]
const START_DAEMON_SERVICE_MENU_ID: &str = "tray-start-daemon-service";
#[cfg(desktop)]
const STOP_DAEMON_SERVICE_MENU_ID: &str = "tray-stop-daemon-service";
#[cfg(desktop)]
const RESTART_DAEMON_SERVICE_MENU_ID: &str = "tray-restart-daemon-service";
#[cfg(desktop)]
const QUIT_APP_MENU_ID: &str = "tray-quit-app";
#[cfg(desktop)]
const TRAY_ICON_ID: &str = "main";
#[cfg(desktop)]
const TRAY_ICON_SIZE: u32 = 18;
#[cfg(desktop)]
const TRAY_DAEMON_SERVICE_ACTION_EVENT: &str = "tray://daemon-service/action";

#[cfg(desktop)]
pub fn register<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
    let initial_state = DesktopTrayStatePayload {
        status: DesktopTrayStatus::Connecting,
        label: "Happier".to_string(),
        detail: "Checking connection".to_string(),
    };

    TrayIconBuilder::with_id(TRAY_ICON_ID)
        .icon(build_status_icon(initial_state.status))
        .tooltip(format!(
            "{} · {}",
            initial_state.label, initial_state.detail
        ))
        .menu(&build_menu(app, &initial_state)?)
        .show_menu_on_left_click(false)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                let _ = crate::window_chrome::show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg(desktop)]
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopTrayStatus {
    Healthy,
    AttentionRequired,
    Connecting,
    ServerUnreachable,
    AuthRequired,
    ServerError,
    NoMachine,
    MachineOffline,
}

#[cfg(desktop)]
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrayStatePayload {
    pub status: DesktopTrayStatus,
    pub label: String,
    pub detail: String,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum TrayDaemonServiceAction {
    Start,
    Stop,
    Restart,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TrayMenuEntry {
    StatusLabel,
    DetailLabel,
    Separator,
    ResolveSetup,
    DaemonServiceAction(TrayDaemonServiceAction),
    OpenSetup,
    OpenSettings,
    OpenHappier,
    Quit,
}

#[cfg(desktop)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayDaemonServiceActionPayload {
    action: TrayDaemonServiceAction,
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_set_tray_state<R: Runtime>(
    app: AppHandle<R>,
    state: DesktopTrayStatePayload,
) -> Result<(), String> {
    apply_tray_state(&app, &state).map_err(|error| error.to_string())
}

#[cfg(desktop)]
fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().0.as_str() {
        SHOW_MAIN_WINDOW_MENU_ID => {
            let _ = crate::window_chrome::show_main_window(app);
        }
        OPEN_SETUP_MENU_ID => {
            let _ = navigate_main_window_to_path(app, "/setup/wizard");
        }
        OPEN_SETTINGS_MENU_ID => {
            let _ = navigate_main_window_to_path(app, "/settings");
        }
        RESOLVE_SETUP_MENU_ID => {
            let _ = navigate_main_window_to_path(app, "/setup");
        }
        START_DAEMON_SERVICE_MENU_ID => {
            let _ = emit_daemon_service_action(app, TrayDaemonServiceAction::Start);
        }
        STOP_DAEMON_SERVICE_MENU_ID => {
            let _ = emit_daemon_service_action(app, TrayDaemonServiceAction::Stop);
        }
        RESTART_DAEMON_SERVICE_MENU_ID => {
            let _ = emit_daemon_service_action(app, TrayDaemonServiceAction::Restart);
        }
        QUIT_APP_MENU_ID => {
            app.exit(0);
        }
        _ => {}
    }
}

#[cfg(desktop)]
fn navigate_main_window_to_path<R: Runtime>(app: &AppHandle<R>, path: &str) -> tauri::Result<()> {
    crate::window_chrome::show_main_window(app)?;
    if let Some(window) = app.get_webview_window("main") {
        let script = build_navigation_script(path);
        window.eval(&script)?;
    }
    Ok(())
}

#[cfg(desktop)]
fn build_navigation_script(path: &str) -> String {
    let target_json = serde_json::to_string(path).unwrap_or_else(|_| "\"/\"".to_string());
    format!(
        r#"(function(){{try{{const target={target_json}; if(typeof target!=="string"||!target){{return;}} if(window.location&&window.location.pathname===target){{return;}} if(window.history&&window.history.pushState){{window.history.pushState(null,"",target); const evt=(typeof PopStateEvent==="function")?new PopStateEvent("popstate"):new Event("popstate"); window.dispatchEvent(evt); }} else {{ window.location.href=target; }} }}catch(_e){{}}}})();"#,
    )
}

#[cfg(desktop)]
fn should_include_resolve_setup_action(status: DesktopTrayStatus) -> bool {
    !matches!(
        status,
        DesktopTrayStatus::Healthy | DesktopTrayStatus::Connecting
    )
}

#[cfg(desktop)]
fn desktop_tray_menu_bar_title() -> Option<String> {
    None
}

#[cfg(test)]
fn build_menu_entries(state: &DesktopTrayStatePayload) -> Vec<TrayMenuEntry> {
    let mut entries = vec![
        TrayMenuEntry::StatusLabel,
        TrayMenuEntry::DetailLabel,
        TrayMenuEntry::Separator,
    ];

    if should_include_resolve_setup_action(state.status) {
        entries.push(TrayMenuEntry::ResolveSetup);
        entries.push(TrayMenuEntry::Separator);
    }

    entries.extend([
        TrayMenuEntry::DaemonServiceAction(TrayDaemonServiceAction::Start),
        TrayMenuEntry::DaemonServiceAction(TrayDaemonServiceAction::Stop),
        TrayMenuEntry::DaemonServiceAction(TrayDaemonServiceAction::Restart),
        TrayMenuEntry::Separator,
        TrayMenuEntry::OpenSetup,
        TrayMenuEntry::OpenSettings,
        TrayMenuEntry::OpenHappier,
        TrayMenuEntry::Separator,
        TrayMenuEntry::Quit,
    ]);

    entries
}

#[cfg(desktop)]
fn apply_tray_state<R: Runtime>(
    app: &AppHandle<R>,
    state: &DesktopTrayStatePayload,
) -> tauri::Result<()> {
    let tray = app
        .tray_by_id(TRAY_ICON_ID)
        .ok_or_else(|| tauri::Error::AssetNotFound("tray icon".into()))?;

    tray.set_icon(Some(build_status_icon(state.status)))?;
    tray.set_title(desktop_tray_menu_bar_title())?;
    tray.set_tooltip(Some(format!("{} · {}", state.label, state.detail)))?;
    tray.set_menu(Some(build_menu(app, state)?))?;
    Ok(())
}

#[cfg(desktop)]
fn emit_daemon_service_action<R: Runtime>(
    app: &AppHandle<R>,
    action: TrayDaemonServiceAction,
) -> tauri::Result<()> {
    app.emit(
        TRAY_DAEMON_SERVICE_ACTION_EVENT,
        TrayDaemonServiceActionPayload { action },
    )
}

#[cfg(desktop)]
fn build_menu<R: Runtime>(
    app: &impl Manager<R>,
    state: &DesktopTrayStatePayload,
) -> tauri::Result<tauri::menu::Menu<R>> {
    let status_item = MenuItemBuilder::new(state.label.clone())
        .enabled(false)
        .build(app)?;
    let detail_item = MenuItemBuilder::new(state.detail.clone())
        .enabled(false)
        .build(app)?;
    let resolve_setup_item =
        MenuItemBuilder::with_id(RESOLVE_SETUP_MENU_ID, "Resolve setup…").build(app)?;
    let start_daemon_service_item =
        MenuItemBuilder::with_id(START_DAEMON_SERVICE_MENU_ID, "Start background service")
            .build(app)?;
    let stop_daemon_service_item =
        MenuItemBuilder::with_id(STOP_DAEMON_SERVICE_MENU_ID, "Stop background service")
            .build(app)?;
    let restart_daemon_service_item =
        MenuItemBuilder::with_id(RESTART_DAEMON_SERVICE_MENU_ID, "Restart background service")
            .build(app)?;
    let show_main_window_item =
        MenuItemBuilder::with_id(SHOW_MAIN_WINDOW_MENU_ID, "Open Happier").build(app)?;
    let open_setup_item = MenuItemBuilder::with_id(OPEN_SETUP_MENU_ID, "Open Setup").build(app)?;
    let open_settings_item =
        MenuItemBuilder::with_id(OPEN_SETTINGS_MENU_ID, "Open Settings").build(app)?;
    let quit_app = MenuItemBuilder::with_id(QUIT_APP_MENU_ID, "Quit Happier").build(app)?;

    let mut builder = MenuBuilder::new(app)
        .item(&status_item)
        .item(&detail_item)
        .separator();

    if should_include_resolve_setup_action(state.status) {
        builder = builder.item(&resolve_setup_item).separator();
    }

    builder
        .item(&start_daemon_service_item)
        .item(&stop_daemon_service_item)
        .item(&restart_daemon_service_item)
        .separator()
        .item(&open_setup_item)
        .item(&open_settings_item)
        .item(&show_main_window_item)
        .separator()
        .item(&quit_app)
        .build()
}

#[cfg(desktop)]
fn build_status_icon(status: DesktopTrayStatus) -> Image<'static> {
    let [red, green, blue] = match status {
        DesktopTrayStatus::Healthy => [52, 199, 89],
        DesktopTrayStatus::Connecting => [10, 132, 255],
        DesktopTrayStatus::AttentionRequired
        | DesktopTrayStatus::AuthRequired
        | DesktopTrayStatus::NoMachine
        | DesktopTrayStatus::MachineOffline => [255, 159, 10],
        DesktopTrayStatus::ServerUnreachable | DesktopTrayStatus::ServerError => [255, 69, 58],
    };

    let mut rgba = vec![0_u8; (TRAY_ICON_SIZE * TRAY_ICON_SIZE * 4) as usize];
    let center = (TRAY_ICON_SIZE as f32 - 1.0) / 2.0;
    let radius = center - 1.5;

    for y in 0..TRAY_ICON_SIZE {
        for x in 0..TRAY_ICON_SIZE {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let distance = (dx * dx + dy * dy).sqrt();
            if distance > radius + 1.0 {
                continue;
            }

            let alpha = if distance > radius {
                ((1.0 - (distance - radius)).clamp(0.0, 1.0) * 255.0) as u8
            } else {
                255
            };
            let index = ((y * TRAY_ICON_SIZE + x) * 4) as usize;
            rgba[index] = red;
            rgba[index + 1] = green;
            rgba[index + 2] = blue;
            rgba[index + 3] = alpha;
        }
    }

    Image::new_owned(rgba, TRAY_ICON_SIZE, TRAY_ICON_SIZE)
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    #[test]
    fn resolve_setup_action_is_enabled_for_all_nonhealthy_statuses() {
        assert!(!should_include_resolve_setup_action(
            DesktopTrayStatus::Healthy
        ));
        assert!(!should_include_resolve_setup_action(
            DesktopTrayStatus::Connecting
        ));
        assert!(should_include_resolve_setup_action(
            DesktopTrayStatus::AttentionRequired
        ));
        assert!(should_include_resolve_setup_action(
            DesktopTrayStatus::ServerUnreachable
        ));
        assert!(should_include_resolve_setup_action(
            DesktopTrayStatus::AuthRequired
        ));
        assert!(should_include_resolve_setup_action(
            DesktopTrayStatus::ServerError
        ));
        assert!(should_include_resolve_setup_action(
            DesktopTrayStatus::NoMachine
        ));
        assert!(should_include_resolve_setup_action(
            DesktopTrayStatus::MachineOffline
        ));
    }

    #[test]
    fn navigation_script_uses_history_pushstate_instead_of_reload() {
        let script = build_navigation_script("/setup/wizard");
        assert!(script.contains("history.pushState"));
        assert!(script.contains("/setup/wizard"));
        assert!(!script.contains("location.assign"));
        assert!(!script.contains("location.replace"));
    }

    #[test]
    fn build_menu_entries_include_daemon_service_controls() {
        let state = DesktopTrayStatePayload {
            status: DesktopTrayStatus::AttentionRequired,
            label: "Action required".to_string(),
            detail: "Server offline".to_string(),
        };

        let entries = build_menu_entries(&state);
        assert!(entries.contains(&TrayMenuEntry::DaemonServiceAction(
            TrayDaemonServiceAction::Start
        )));
        assert!(entries.contains(&TrayMenuEntry::DaemonServiceAction(
            TrayDaemonServiceAction::Stop
        )));
        assert!(entries.contains(&TrayMenuEntry::DaemonServiceAction(
            TrayDaemonServiceAction::Restart
        )));
        assert!(entries.contains(&TrayMenuEntry::ResolveSetup));
    }

    #[test]
    fn build_menu_entries_skip_resolve_setup_when_connection_is_healthy() {
        let state = DesktopTrayStatePayload {
            status: DesktopTrayStatus::Healthy,
            label: "Connected".to_string(),
            detail: "Ready".to_string(),
        };

        let entries = build_menu_entries(&state);
        assert!(!entries.contains(&TrayMenuEntry::ResolveSetup));
    }

    #[test]
    fn desktop_tray_menu_bar_title_is_suppressed() {
        assert_eq!(desktop_tray_menu_bar_title(), None);
    }
}
