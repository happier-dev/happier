//! Every menu id this app owns and the one id → action decision (pure: no tauri types).
//!
//! The tray menu and the macOS app menu share these ids; muda delivers both menus' events to one
//! global channel, so `crate::menu::handle_menu_event` routes them all through
//! [`resolve_desktop_menu_action`].

/// Reveals the main window (recreating it in menu-bar mode).
pub const SHOW_MAIN_WINDOW_MENU_ID: &str = "show-main-window";
/// Quits the app through `app.exit`, the only quit that reaches the shutdown handoff. With the
/// login-start setting on it leaves the tray and the background services running (R16 a).
pub const QUIT_APP_MENU_ID: &str = "quit-app";
/// Stops every desktop-managed background service, then quits (R16 c).
pub const STOP_SERVICES_AND_QUIT_MENU_ID: &str = "stop-services-and-quit";
/// Reveals the main window at Settings › Updates (the tray's optional "Updates" item).
pub const OPEN_UPDATES_MENU_ID: &str = "open-updates";
/// Reveals the main window at Settings.
pub const OPEN_SETTINGS_MENU_ID: &str = "open-settings";
/// Locks the current app window through the app-lock runtime.
pub const LOCK_NOW_MENU_ID: &str = "lock-now";
/// The tray's "Start at login" check item — the one login-start setting (R16 b).
pub const TOGGLE_START_AT_LOGIN_MENU_ID: &str = "toggle-start-at-login";

const SERVICE_MENU_ID_PREFIX: &str = "service:";

/// What a background-service row's submenu can ask for. Each runs an existing system task.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceMenuAction {
    Open,
    Start,
    Restart,
    Stop,
}

impl ServiceMenuAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Start => "start",
            Self::Restart => "restart",
            Self::Stop => "stop",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "open" => Some(Self::Open),
            "start" => Some(Self::Start),
            "restart" => Some(Self::Restart),
            "stop" => Some(Self::Stop),
            _ => None,
        }
    }
}

/// `service:<action>:<relay url>`. The relay URL is last, so its own `:` never splits it.
pub fn service_menu_id(action: ServiceMenuAction, relay_url: &str) -> String {
    format!("{SERVICE_MENU_ID_PREFIX}{}:{relay_url}", action.as_str())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DesktopMenuAction {
    ShowMainWindow,
    OpenUpdates,
    OpenSettings,
    LockNow,
    QuitApp,
    StopServicesAndQuit,
    ToggleStartAtLogin,
    Service {
        action: ServiceMenuAction,
        relay_url: String,
    },
}

/// `None` for every item this app does not own: predefined items act natively, and the router sees
/// every menu's events because muda's event channel is global.
pub fn resolve_desktop_menu_action(menu_item_id: &str) -> Option<DesktopMenuAction> {
    match menu_item_id {
        SHOW_MAIN_WINDOW_MENU_ID => Some(DesktopMenuAction::ShowMainWindow),
        OPEN_UPDATES_MENU_ID => Some(DesktopMenuAction::OpenUpdates),
        OPEN_SETTINGS_MENU_ID => Some(DesktopMenuAction::OpenSettings),
        LOCK_NOW_MENU_ID => Some(DesktopMenuAction::LockNow),
        QUIT_APP_MENU_ID => Some(DesktopMenuAction::QuitApp),
        STOP_SERVICES_AND_QUIT_MENU_ID => Some(DesktopMenuAction::StopServicesAndQuit),
        TOGGLE_START_AT_LOGIN_MENU_ID => Some(DesktopMenuAction::ToggleStartAtLogin),
        other => {
            let rest = other.strip_prefix(SERVICE_MENU_ID_PREFIX)?;
            let (action, relay_url) = rest.split_once(':')?;
            let action = ServiceMenuAction::parse(action)?;
            let relay_url = relay_url.trim();
            if relay_url.is_empty() {
                return None;
            }
            Some(DesktopMenuAction::Service {
                action,
                relay_url: relay_url.to_string(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_quit_item_both_menus_share_asks_the_app_to_exit() {
        // `app.exit` is the only quit that reaches the shutdown handoff, so this arm is what makes
        // the background-service preference reachable at all.
        assert_eq!(
            resolve_desktop_menu_action(QUIT_APP_MENU_ID),
            Some(DesktopMenuAction::QuitApp)
        );
        assert_eq!(
            resolve_desktop_menu_action(STOP_SERVICES_AND_QUIT_MENU_ID),
            Some(DesktopMenuAction::StopServicesAndQuit)
        );
    }

    #[test]
    fn the_show_item_reveals_the_window_that_close_only_hid() {
        assert_eq!(
            resolve_desktop_menu_action(SHOW_MAIN_WINDOW_MENU_ID),
            Some(DesktopMenuAction::ShowMainWindow)
        );
    }

    #[test]
    fn the_updates_and_settings_items_open_their_screens() {
        assert_eq!(
            resolve_desktop_menu_action(OPEN_UPDATES_MENU_ID),
            Some(DesktopMenuAction::OpenUpdates)
        );
        assert_eq!(
            resolve_desktop_menu_action(OPEN_SETTINGS_MENU_ID),
            Some(DesktopMenuAction::OpenSettings)
        );
        assert_eq!(
            resolve_desktop_menu_action(TOGGLE_START_AT_LOGIN_MENU_ID),
            Some(DesktopMenuAction::ToggleStartAtLogin)
        );
    }

    #[test]
    fn a_service_row_action_round_trips_its_relay_url_including_its_colons() {
        let id = service_menu_id(
            ServiceMenuAction::Restart,
            "https://relay.example.com:8443/x",
        );
        assert_eq!(
            resolve_desktop_menu_action(&id),
            Some(DesktopMenuAction::Service {
                action: ServiceMenuAction::Restart,
                relay_url: "https://relay.example.com:8443/x".to_string(),
            })
        );
        assert_eq!(
            resolve_desktop_menu_action("service:explode:https://x"),
            None
        );
        assert_eq!(resolve_desktop_menu_action("service:stop:"), None);
    }

    #[test]
    fn menu_items_this_app_does_not_own_are_left_to_act_natively() {
        // The router is global: it sees Edit, View and Window items too, and must not touch them.
        assert_eq!(resolve_desktop_menu_action("Paste"), None);
        assert_eq!(resolve_desktop_menu_action(""), None);
    }
}
