//! The tray menu as data (pure: std + serde only, no tauri types), so every decision about what
//! the menu shows is testable without a menu. `crate::tray` turns [`build_menu_entries`] into the
//! native menu — one builder, whichever source the model came from:
//!
//! - while the web UI runs, it pushes the model's facts (`desktop_set_tray_state`): its localized
//!   labels (U14), its status line, the Updates item, and the executor's service rows
//!   (`listThisComputerRelayRows`: the status task's rows, the app relay judged by the app);
//! - in menu-bar mode there is no web UI, so the rows come from the existing status system task
//!   (`daemon.service.status.v1`, run through hsetup) via [`read_service_status`], with the
//!   labels the web UI last persisted and English where it never did.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::menu::ids::{
    resolve_desktop_menu_action, service_menu_id, DesktopMenuAction, ServiceMenuAction,
    OPEN_SETTINGS_MENU_ID, OPEN_UPDATES_MENU_ID, QUIT_APP_MENU_ID, SHOW_MAIN_WINDOW_MENU_ID,
    STOP_SERVICES_AND_QUIT_MENU_ID, TOGGLE_START_AT_LOGIN_MENU_ID,
};

/// The tray's platform theme; macOS instead uses AppKit's template tint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayThemeSignal {
    /// Windows system/taskbar mode, independent of AppsUseLightTheme; None is unknown.
    WindowsSystemUsesLightTheme(Option<u32>),
    /// Freedesktop portal color-scheme: 1 dark, 2 light, anything else unknown.
    FreedesktopColorScheme(Option<u32>),
}

/// Unknown tray themes use the existing white silhouette.
pub fn tray_is_light(signal: TrayThemeSignal) -> bool {
    match signal {
        TrayThemeSignal::WindowsSystemUsesLightTheme(value) => {
            value.is_some_and(|value| value != 0)
        }
        TrayThemeSignal::FreedesktopColorScheme(value) => value == Some(2),
    }
}

/// Windows loses its window-owned theme events while tray-only. Sample on existing demand.
pub fn sample_tray_theme_on_pointer(
    platform: MenuPlatform,
    main_webview_exists: bool,
    sample: impl FnOnce() -> TrayThemeSignal,
) -> Option<TrayThemeSignal> {
    (platform == MenuPlatform::Windows && !main_webview_exists).then(sample)
}

#[cfg(test)]
mod theme_tests {
    use super::*;

    #[test]
    fn tray_only_windows_pointer_samples_current_theme_without_a_window_observer() {
        // The sampler substitutes only the Windows registry boundary, including changed/unknown mode.
        let system_theme = std::cell::Cell::new(Some(1));
        for (mode, expected_light) in [(Some(1), true), (Some(0), false), (None, false)] {
            system_theme.set(mode);
            let sampled = sample_tray_theme_on_pointer(MenuPlatform::Windows, false, || {
                TrayThemeSignal::WindowsSystemUsesLightTheme(system_theme.get())
            });
            assert_eq!(sampled.map(tray_is_light), Some(expected_light));
        }
    }

    #[test]
    fn pointer_keeps_window_and_non_windows_theme_observers() {
        for (platform, main_exists) in [
            (MenuPlatform::Windows, true),
            (MenuPlatform::MacOs, false),
            (MenuPlatform::Linux, false),
        ] {
            assert_eq!(
                sample_tray_theme_on_pointer(platform, main_exists, || {
                    panic!("the existing observer owns theme here")
                }),
                None
            );
        }
    }

    #[test]
    fn tray_icon_follows_the_tray_theme_and_unknown_means_a_dark_tray() {
        use TrayThemeSignal::*;
        assert!(tray_is_light(WindowsSystemUsesLightTheme(Some(1))));
        assert!(!tray_is_light(WindowsSystemUsesLightTheme(Some(0))));
        assert!(!tray_is_light(WindowsSystemUsesLightTheme(None)));
        assert!(tray_is_light(FreedesktopColorScheme(Some(2))));
        assert!(!tray_is_light(FreedesktopColorScheme(Some(1))));
        assert!(!tray_is_light(FreedesktopColorScheme(Some(0))));
        assert!(!tray_is_light(FreedesktopColorScheme(Some(7))));
        assert!(!tray_is_light(FreedesktopColorScheme(None)));
    }
}

/// How a background service here stands for its relay — the web UI's `ThisComputerRelayState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceState {
    Connected,
    Offline,
    NeedsAttention,
}

/// What a row lets the app do to its service — decided by the executor, rendered here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceAction {
    Start,
    Restart,
    Stop,
}

/// One background service on this computer, one relay, exactly as the one owner of these rows
/// produced it — the shared inventory projection in the `daemon.service.status.v1` result,
/// which the web UI pushes (its own relay re-judged against the app's account) and which menu-bar
/// mode reads directly. The tray decides no state and no action.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRow {
    pub relay_url: String,
    /// The web UI's name for the relay; absent in menu-bar mode reads, where the persisted name
    /// (or the URL's host) stands in.
    #[serde(default)]
    pub name: Option<String>,
    pub state: ServiceState,
    /// R15 — the desktop manages it (default-following, or `managedBy: desktop`). A service the
    /// user set up is shown read-only.
    pub app_managed: bool,
    /// The actions offered for it (none for a service the user set up).
    #[serde(default)]
    pub actions: Vec<ServiceAction>,
    /// Omitted when the web UI cannot prove session visibility for this service.
    #[serde(default)]
    pub active_session_count: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServiceList {
    /// Nothing has been read yet.
    Unread,
    /// The last read failed; nothing is claimed about the services.
    Failed,
    Listed {
        rows: Vec<ServiceRow>,
        /// `false` when some service could not be read: a relay may have a service the tray
        /// cannot see, and the menu says so rather than implying there is none.
        complete: bool,
    },
}

/// The one login-start setting, in the CLI's vocabulary (`service.autostart`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutostartMode {
    AtLogin,
    OnDemand,
}

impl AutostartMode {
    pub fn parse(value: &Value) -> Option<Self> {
        match value.as_str() {
            Some("at-login") => Some(Self::AtLogin),
            Some("on-demand") => Some(Self::OnDemand),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::AtLogin => "at-login",
            Self::OnDemand => "on-demand",
        }
    }
}

/// The tray's own strings, localized by the web UI (U14) and persisted for menu-bar mode. Every
/// field falls back to English on its own, so a missing or empty label never blanks an item.
/// `{relay}` in a template is replaced natively.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayLabels {
    pub title: String,
    pub open: String,
    pub open_in_happier: String,
    pub settings: String,
    pub start_at_login: String,
    pub quit: String,
    pub stop_services_and_quit: String,
    pub connected: String,
    pub offline: String,
    pub needs_attention: String,
    pub sessions: String,
    pub start: String,
    pub restart: String,
    pub stop: String,
    pub user_owned: String,
    pub checking: String,
    pub read_failed: String,
    pub incomplete: String,
    pub no_services: String,
    pub working: String,
    pub stop_confirm_title: String,
    pub stop_confirm_body: String,
    pub stop_all_confirm_title: String,
    pub stop_all_confirm_body: String,
    pub stop_confirm_action: String,
    pub cancel: String,
    pub action_failed_title: String,
    pub login_item_failed: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            title: "Happier".into(),
            open: "Open Happier".into(),
            open_in_happier: "Open in Happier".into(),
            settings: "Settings…".into(),
            start_at_login: "Start at login".into(),
            quit: "Quit Happier".into(),
            stop_services_and_quit: "Stop background services and quit…".into(),
            connected: "Connected".into(),
            offline: "Offline".into(),
            needs_attention: "Needs attention".into(),
            sessions: "Sessions: {count}".into(),
            start: "Start".into(),
            restart: "Restart".into(),
            stop: "Stop…".into(),
            user_owned: "Managed outside Happier".into(),
            checking: "Checking background services…".into(),
            read_failed: "Couldn’t check background services".into(),
            incomplete: "Some background services couldn’t be checked".into(),
            no_services: "This computer isn’t set up yet".into(),
            working: "Working…".into(),
            stop_confirm_title: "Stop Happier’s background service for {relay}?".into(),
            stop_confirm_body:
                "Agent sessions running on this computer for {relay} will end, and your phone and browser can’t reach it there until it starts again."
                    .into(),
            stop_all_confirm_title: "Stop Happier’s background services and quit?".into(),
            stop_all_confirm_body:
                "Agent sessions running on this computer will end, and your phone and browser can’t reach it until you open Happier again."
                    .into(),
            stop_confirm_action: "Stop".into(),
            cancel: "Cancel".into(),
            action_failed_title: "That didn’t go through".into(),
            login_item_failed: "Couldn’t update Happier’s login item".into(),
        }
    }
}

impl TrayLabels {
    /// Replaces every blank label with its English default.
    pub fn with_fallbacks(mut self) -> Self {
        let english = Self::default();
        let pairs: [(&mut String, String); 28] = [
            (&mut self.title, english.title),
            (&mut self.open, english.open),
            (&mut self.open_in_happier, english.open_in_happier),
            (&mut self.settings, english.settings),
            (&mut self.start_at_login, english.start_at_login),
            (&mut self.quit, english.quit),
            (
                &mut self.stop_services_and_quit,
                english.stop_services_and_quit,
            ),
            (&mut self.connected, english.connected),
            (&mut self.offline, english.offline),
            (&mut self.needs_attention, english.needs_attention),
            (&mut self.sessions, english.sessions),
            (&mut self.start, english.start),
            (&mut self.restart, english.restart),
            (&mut self.stop, english.stop),
            (&mut self.user_owned, english.user_owned),
            (&mut self.checking, english.checking),
            (&mut self.read_failed, english.read_failed),
            (&mut self.incomplete, english.incomplete),
            (&mut self.no_services, english.no_services),
            (&mut self.working, english.working),
            (&mut self.stop_confirm_title, english.stop_confirm_title),
            (&mut self.stop_confirm_body, english.stop_confirm_body),
            (
                &mut self.stop_all_confirm_title,
                english.stop_all_confirm_title,
            ),
            (
                &mut self.stop_all_confirm_body,
                english.stop_all_confirm_body,
            ),
            (&mut self.stop_confirm_action, english.stop_confirm_action),
            (&mut self.cancel, english.cancel),
            (&mut self.action_failed_title, english.action_failed_title),
            (&mut self.login_item_failed, english.login_item_failed),
        ];
        for (label, fallback) in pairs {
            if label.trim().is_empty() {
                *label = fallback;
            }
        }
        self
    }

    fn state(&self, state: ServiceState) -> &str {
        match state {
            ServiceState::Connected => &self.connected,
            ServiceState::Offline => &self.offline,
            ServiceState::NeedsAttention => &self.needs_attention,
        }
    }
}

/// Fills `{relay}` in a label template.
pub fn fill_relay(template: &str, relay: &str) -> String {
    template.replace("{relay}", relay)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatesItem {
    pub label: String,
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuPlatform {
    MacOs,
    Windows,
    Linux,
}

impl MenuPlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else {
            Self::Linux
        }
    }

    /// Menu item images: AppKit and Win32 menus draw them; an AppIndicator menu (StatusNotifier
    /// over D-Bus) often does not, so Linux spells the status with a text mark instead.
    fn draws_item_images(self) -> bool {
        !matches!(self, Self::Linux)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrayMenuModel {
    pub labels: TrayLabels,
    /// The web UI's connection status line ("Connected · Online · 2/2"); none in menu-bar mode.
    pub status_line: Option<String>,
    pub services: ServiceList,
    /// Full-inventory count, independent of which service represents each displayed relay.
    pub running_managed_service_count: Option<u64>,
    pub updates: Option<UpdatesItem>,
    /// The login-start setting; `None` while unknown (nothing to flip).
    pub start_at_login: Option<bool>,
    /// A tray action is running; the service actions wait for it.
    pub busy: bool,
    /// The last failure the tray itself saw (a status read, an action, the login item), said in the
    /// menu until a relevant success or retry clears it — never only a log line.
    pub notice: Option<String>,
    /// The action a failure belongs to; status success cannot settle a failed mutation.
    pub action_notice: Option<(String, String)>,
    pub platform: MenuPlatform,
}

impl TrayMenuModel {
    pub fn new(platform: MenuPlatform) -> Self {
        Self {
            labels: TrayLabels::default(),
            status_line: None,
            services: ServiceList::Unread,
            running_managed_service_count: None,
            updates: None,
            start_at_login: None,
            busy: false,
            notice: None,
            action_notice: None,
            platform,
        }
    }

    pub fn record_action_failure(&mut self, action: String, message: String) {
        self.action_notice = Some((action, message));
    }

    pub fn retry_action(&mut self, action: &str) {
        if self
            .action_notice
            .as_ref()
            .is_some_and(|(failed, _)| failed == action)
        {
            self.action_notice = None;
        }
    }

    pub fn record_status_notice(&mut self, notice: Option<String>) {
        self.notice = notice;
    }

    pub fn action_succeeded(&mut self, action: &str) {
        let same_relay = |failed: &str| match (
            resolve_desktop_menu_action(failed),
            resolve_desktop_menu_action(action),
        ) {
            (
                Some(DesktopMenuAction::Service {
                    relay_url: failed_relay,
                    ..
                }),
                Some(DesktopMenuAction::Service { relay_url, .. }),
            ) => failed_relay == relay_url,
            _ => false,
        };
        if self
            .action_notice
            .as_ref()
            .is_some_and(|(failed, _)| failed == action || same_relay(failed))
        {
            self.action_notice = None;
        }
    }

    /// Whether some service can be stopped — what "stop everything" would end.
    pub fn app_managed_service_running(&self) -> Option<bool> {
        if self
            .running_managed_service_count
            .is_some_and(|count| count > 0)
        {
            return Some(true);
        }
        match &self.services {
            ServiceList::Listed { rows, complete } => {
                if *complete && self.running_managed_service_count == Some(0) {
                    Some(false)
                } else if rows
                    .iter()
                    .any(|row| row.app_managed && row.actions.contains(&ServiceAction::Stop))
                {
                    Some(true)
                } else if *complete {
                    Some(false)
                } else {
                    None
                }
            }
            _ => None,
        }
    }
}

/// A native menu item, described. `dot` is drawn as an item image where the platform draws them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MenuEntry {
    Item {
        id: Option<String>,
        text: String,
        enabled: bool,
        accelerator: Option<&'static str>,
        dot: Option<ServiceState>,
    },
    Check {
        id: String,
        text: String,
        checked: bool,
        enabled: bool,
    },
    Submenu {
        text: String,
        enabled: bool,
        dot: Option<ServiceState>,
        items: Vec<MenuEntry>,
    },
    Separator,
}

/// Longest relay name a row shows before it is shortened in the middle (keeps the TLD and the
/// start readable; the full URL is what the actions carry).
pub const MAX_RELAY_NAME_CHARS: usize = 36;

/// Longest failure notice a row shows; the dialog that reported it carried the whole message.
pub const MAX_NOTICE_CHARS: usize = 72;

fn truncate_end(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars - 1).collect();
    out.push('…');
    out
}

pub fn truncate_middle(text: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max_chars || max_chars < 3 {
        return text.to_string();
    }
    let keep = max_chars - 1;
    let head = keep.div_ceil(2);
    let tail = keep - head;
    let mut out: String = chars[..head].iter().collect();
    out.push('…');
    out.extend(chars[chars.len() - tail..].iter());
    out
}

/// The relay's host (and port) from its URL — the name when the web UI never gave one.
pub fn relay_host(relay_url: &str) -> String {
    let trimmed = relay_url.trim();
    let without_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let host = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(without_scheme);
    let host = host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host);
    if host.is_empty() {
        trimmed.to_string()
    } else {
        host.to_string()
    }
}

fn row_name(row: &ServiceRow) -> String {
    let name = row
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| relay_host(&row.relay_url));
    truncate_middle(&name, MAX_RELAY_NAME_CHARS)
}

/// A status mark in text, for menus that draw no item images.
fn text_mark(state: ServiceState) -> &'static str {
    match state {
        ServiceState::Connected => "●",
        ServiceState::Offline => "○",
        ServiceState::NeedsAttention => "▲",
    }
}

fn status_text(model: &TrayMenuModel, name: &str, state: ServiceState) -> String {
    let body = format!("{name} · {}", model.labels.state(state));
    if model.platform.draws_item_images() {
        body
    } else {
        format!("{} {body}", text_mark(state))
    }
}

fn disabled(text: &str) -> MenuEntry {
    MenuEntry::Item {
        id: None,
        text: text.to_string(),
        enabled: false,
        accelerator: None,
        dot: None,
    }
}

fn action(id: &str, text: &str, enabled: bool, accelerator: Option<&'static str>) -> MenuEntry {
    MenuEntry::Item {
        id: Some(id.to_string()),
        text: text.to_string(),
        enabled,
        accelerator,
        dot: None,
    }
}

fn accelerator(platform: MenuPlatform, key: &'static str) -> Option<&'static str> {
    // Only macOS shows (and honours) key equivalents in a status-item menu; Windows and Linux
    // tray menus have no keyboard focus to take them.
    (platform == MenuPlatform::MacOs).then_some(key)
}

fn service_submenu(model: &TrayMenuModel, row: &ServiceRow) -> MenuEntry {
    let name = row_name(row);
    let labels = &model.labels;
    let items = if row.app_managed {
        let mut items = vec![action(
            &service_menu_id(ServiceMenuAction::Open, &row.relay_url),
            &labels.open_in_happier,
            true,
            None,
        )];
        if !row.actions.is_empty() {
            items.push(MenuEntry::Separator);
        }
        for service_action in &row.actions {
            let (menu_action, text) = match service_action {
                ServiceAction::Start => (ServiceMenuAction::Start, &labels.start),
                ServiceAction::Restart => (ServiceMenuAction::Restart, &labels.restart),
                ServiceAction::Stop => (ServiceMenuAction::Stop, &labels.stop),
            };
            items.push(action(
                &service_menu_id(menu_action, &row.relay_url),
                text,
                !model.busy,
                None,
            ));
        }
        if model.busy {
            items.push(MenuEntry::Separator);
            items.push(disabled(&labels.working));
        }
        items
    } else {
        vec![disabled(&labels.user_owned)]
    };
    let mut text = status_text(model, &name, row.state);
    if let Some(count) = row.active_session_count {
        text.push_str(" · ");
        text.push_str(&labels.sessions.replace("{count}", &count.to_string()));
    }
    MenuEntry::Submenu {
        text,
        enabled: true,
        dot: model.platform.draws_item_images().then_some(row.state),
        items,
    }
}

/// The whole tray menu, top to bottom:
///
/// ```text
/// Connected · Online · 2/2                 (web UI status line, when it runs)
/// ───
/// ● relay.example.com · Connected    ▸ Open in Happier / ─ / Restart / Stop
/// ○ work.example.com · Offline       ▸ Open in Happier / ─ / Start
/// ▲ other.example.com · Needs attention ▸ Managed outside Happier (user-owned)
/// ───
/// Open Happier                  ⌘O
/// Updates available (2)…
/// Settings…                     ⌘,
/// ───
/// ✓ Start at login
/// ───
/// Quit Happier                  ⌘Q       (login start ON or not yet known)
/// Stop background services and quit       (login start ON; separate choice)
///                                         (login start OFF: replaces Quit)
/// ```
pub fn build_menu_entries(model: &TrayMenuModel) -> Vec<MenuEntry> {
    let labels = &model.labels;
    let mut entries = Vec::new();
    if let Some(line) = model
        .status_line
        .as_deref()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        entries.push(disabled(line));
    }
    for notice in [
        model
            .action_notice
            .as_ref()
            .map(|(_, message)| message.as_str()),
        model.notice.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if !notice.trim().is_empty() {
            entries.push(disabled(&format!(
                "⚠ {}",
                truncate_end(notice, MAX_NOTICE_CHARS)
            )));
        }
    }
    entries.push(MenuEntry::Separator);

    match &model.services {
        ServiceList::Unread => entries.push(disabled(&labels.checking)),
        ServiceList::Failed => entries.push(disabled(&labels.read_failed)),
        ServiceList::Listed { rows, complete } => {
            if rows.is_empty() && *complete {
                entries.push(disabled(&labels.no_services));
            }
            for row in rows {
                entries.push(service_submenu(model, row));
            }
            if !complete {
                entries.push(disabled(&labels.incomplete));
            }
        }
    }
    entries.push(MenuEntry::Separator);

    entries.push(action(
        SHOW_MAIN_WINDOW_MENU_ID,
        &labels.open,
        true,
        accelerator(model.platform, "CmdOrCtrl+O"),
    ));
    if let Some(updates) = model
        .updates
        .as_ref()
        .filter(|updates| !updates.label.trim().is_empty())
    {
        entries.push(action(
            OPEN_UPDATES_MENU_ID,
            updates.label.trim(),
            updates.enabled,
            None,
        ));
    }
    entries.push(action(
        OPEN_SETTINGS_MENU_ID,
        &labels.settings,
        true,
        accelerator(model.platform, "CmdOrCtrl+,"),
    ));
    entries.push(MenuEntry::Separator);

    entries.push(MenuEntry::Check {
        id: TOGGLE_START_AT_LOGIN_MENU_ID.to_string(),
        text: labels.start_at_login.clone(),
        checked: model.start_at_login == Some(true),
        enabled: model.start_at_login.is_some() && !model.busy,
    });
    entries.push(MenuEntry::Separator);

    entries.push(action(
        QUIT_APP_MENU_ID,
        match model.start_at_login {
            Some(false) => &labels.stop_services_and_quit,
            Some(true) | None => &labels.quit,
        },
        !model.busy,
        accelerator(model.platform, "CmdOrCtrl+Q"),
    ));
    if model.start_at_login == Some(true) {
        entries.push(action(
            STOP_SERVICES_AND_QUIT_MENU_ID,
            &labels.stop_services_and_quit,
            model.app_managed_service_running() != Some(false) && !model.busy,
            None,
        ));
    }
    entries
}

// ---- Reading `daemon.service.status.v1` in menu-bar mode ----

/// What a status read says for the tray: the executor's rows and the login-start setting.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectedStatus {
    pub services: ServiceList,
    pub running_managed_service_count: Option<u64>,
    /// The common managed-service mode, independent of the status read's Home scope.
    pub autostart: Option<AutostartMode>,
}

/// Takes the executor's `serviceRows` as they are (no judgement here). A result without them, or
/// with rows the tray cannot read, is a failed read: nothing is claimed about the services.
pub fn read_service_status(data: &Value) -> ProjectedStatus {
    let autostart = data.get("serviceAutostart").and_then(AutostartMode::parse);
    let services = match data
        .get("serviceRows")
        .cloned()
        .map(serde_json::from_value::<Vec<ServiceRow>>)
    {
        Some(Ok(rows)) => ServiceList::Listed {
            rows,
            complete: data.get("serviceRowsComplete").and_then(Value::as_bool) != Some(false),
        },
        _ => ServiceList::Failed,
    };
    ProjectedStatus {
        services,
        running_managed_service_count: data
            .get("runningManagedServiceCount")
            .and_then(Value::as_u64),
        autostart,
    }
}

// ---- Status dots ----

/// Side of a status-dot image in pixels: menu item images are drawn 18pt tall on macOS, so this is
/// its @2x; Windows scales it to the menu's small-icon size.
pub const STATUS_DOT_IMAGE_PX: u32 = 36;

/// The system palette's green / grey / orange (as AppKit's `systemGreen`, `systemGray`,
/// `systemOrange`), which read on light and dark menus alike.
fn dot_colour(state: ServiceState) -> [u8; 3] {
    match state {
        ServiceState::Connected => [52, 199, 89],
        ServiceState::Offline => [142, 142, 147],
        ServiceState::NeedsAttention => [255, 149, 0],
    }
}

/// An anti-aliased filled circle (8pt at @2x) centred on a transparent square, as RGBA.
pub fn status_dot_rgba(state: ServiceState, size_px: u32) -> Vec<u8> {
    let [r, g, b] = dot_colour(state);
    let size = size_px as f32;
    let centre = size / 2.0;
    let radius = size * (8.0 / 36.0);
    let mut rgba = Vec::with_capacity((size_px * size_px * 4) as usize);
    for y in 0..size_px {
        for x in 0..size_px {
            let dx = x as f32 + 0.5 - centre;
            let dy = y as f32 + 0.5 - centre;
            let distance = (dx * dx + dy * dy).sqrt();
            let coverage = (radius + 0.5 - distance).clamp(0.0, 1.0);
            rgba.extend_from_slice(&[r, g, b, (coverage * 255.0).round() as u8]);
        }
    }
    rgba
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_reads_and_unrelated_actions_do_not_erase_a_failed_action() {
        let mut model = TrayMenuModel::new(MenuPlatform::Windows);
        let stop = service_menu_id(ServiceMenuAction::Stop, "https://work.example.com");
        model.record_action_failure(stop.clone(), "service refused to stop".into());
        model.record_status_notice(None);
        assert_eq!(
            model
                .action_notice
                .as_ref()
                .map(|(_, message)| message.as_str()),
            Some("service refused to stop")
        );
        model.record_status_notice(Some("status read failed".into()));
        assert_eq!(
            model
                .action_notice
                .as_ref()
                .map(|(_, message)| message.as_str()),
            Some("service refused to stop")
        );
        model.retry_action(TOGGLE_START_AT_LOGIN_MENU_ID);
        assert_eq!(
            model
                .action_notice
                .as_ref()
                .map(|(_, message)| message.as_str()),
            Some("service refused to stop")
        );
        model.retry_action(&stop);
        assert_eq!(model.action_notice, None);
        model.record_status_notice(Some("status read failed".into()));
        model.record_status_notice(None);
        assert_eq!(model.notice, None);
    }

    #[test]
    fn service_failure_survives_login_failure_and_settles_only_for_the_same_relay() {
        let mut model = TrayMenuModel::new(MenuPlatform::Windows);
        let stop = service_menu_id(ServiceMenuAction::Stop, "https://work.example.com");
        model.record_action_failure(stop.clone(), "service refused to stop".into());
        model.notice = Some("login item failed".into());
        let entries = build_menu_entries(&model);
        assert!(entries.iter().any(|entry| matches!(entry, MenuEntry::Item { text, .. } if text.contains("service refused to stop"))));
        model.action_succeeded(&service_menu_id(
            ServiceMenuAction::Start,
            "https://other.example.com",
        ));
        assert!(build_menu_entries(&model).iter().any(|entry| matches!(entry, MenuEntry::Item { text, .. } if text.contains("service refused to stop"))));
        model.action_succeeded(&service_menu_id(
            ServiceMenuAction::Restart,
            "https://work.example.com",
        ));
        assert!(!build_menu_entries(&model).iter().any(|entry| matches!(entry, MenuEntry::Item { text, .. } if text.contains("service refused to stop"))));
        assert!(build_menu_entries(&model).iter().any(|entry| matches!(entry, MenuEntry::Item { text, .. } if text.contains("login item failed"))));
    }

    #[test]
    fn quit_items_use_the_existing_localized_labels_and_the_proven_mode() {
        let mut model = TrayMenuModel::new(MenuPlatform::MacOs);
        model.labels.quit = "localized quit".into();
        model.labels.stop_services_and_quit = "localized stop and quit".into();
        for (setting, expected, extra_stop) in [
            (Some(true), "localized quit", true),
            (Some(false), "localized stop and quit", false),
            (None, "localized quit", false),
        ] {
            model.start_at_login = setting;
            let entries = build_menu_entries(&model);
            assert!(entries.iter().any(|entry| matches!(entry,
                MenuEntry::Item { id: Some(id), text, accelerator: Some("CmdOrCtrl+Q"), .. }
                if id == QUIT_APP_MENU_ID && text == expected
            )));
            assert_eq!(
                ids(&entries).contains(&STOP_SERVICES_AND_QUIT_MENU_ID.to_string()),
                extra_stop
            );
        }
        assert!(!build_menu_entries(&model).contains(&disabled(&model.labels.title)));
    }
    use serde_json::json;

    /// A row as the executor would send it: offline offers Start, running Restart and Stop.
    fn row(url: &str, state: ServiceState, app_managed: bool) -> ServiceRow {
        let actions = match (app_managed, state) {
            (false, _) => vec![],
            (true, ServiceState::Offline) => vec![ServiceAction::Start],
            (true, _) => vec![ServiceAction::Restart, ServiceAction::Stop],
        };
        ServiceRow {
            relay_url: url.to_string(),
            name: None,
            state,
            app_managed,
            actions,
            active_session_count: None,
        }
    }

    fn model_with(rows: Vec<ServiceRow>) -> TrayMenuModel {
        TrayMenuModel {
            services: ServiceList::Listed {
                rows,
                complete: true,
            },
            start_at_login: Some(true),
            ..TrayMenuModel::new(MenuPlatform::MacOs)
        }
    }

    fn ids(entries: &[MenuEntry]) -> Vec<String> {
        let mut out = Vec::new();
        for entry in entries {
            match entry {
                MenuEntry::Item { id: Some(id), .. } | MenuEntry::Check { id, .. } => {
                    out.push(id.clone())
                }
                MenuEntry::Submenu { items, .. } => out.extend(ids(items)),
                _ => {}
            }
        }
        out
    }

    fn find_item<'a>(entries: &'a [MenuEntry], wanted: &str) -> Option<&'a MenuEntry> {
        for entry in entries {
            match entry {
                MenuEntry::Item { id: Some(id), .. } | MenuEntry::Check { id, .. }
                    if id == wanted =>
                {
                    return Some(entry)
                }
                MenuEntry::Submenu { items, .. } => {
                    if let Some(found) = find_item(items, wanted) {
                        return Some(found);
                    }
                }
                _ => {}
            }
        }
        None
    }

    fn enabled(entry: Option<&MenuEntry>) -> bool {
        match entry {
            Some(MenuEntry::Item { enabled, .. }) | Some(MenuEntry::Check { enabled, .. }) => {
                *enabled
            }
            _ => panic!("expected an item"),
        }
    }

    #[test]
    fn the_menu_has_every_section_in_order_with_macos_key_equivalents() {
        let entries = build_menu_entries(&model_with(vec![row(
            "https://a.example.com",
            ServiceState::Connected,
            true,
        )]));
        assert_eq!(
            ids(&entries),
            vec![
                "service:open:https://a.example.com",
                "service:restart:https://a.example.com",
                "service:stop:https://a.example.com",
                SHOW_MAIN_WINDOW_MENU_ID,
                OPEN_SETTINGS_MENU_ID,
                TOGGLE_START_AT_LOGIN_MENU_ID,
                QUIT_APP_MENU_ID,
                STOP_SERVICES_AND_QUIT_MENU_ID,
            ]
        );
        assert!(matches!(&entries[0], MenuEntry::Separator));
        assert!(matches!(
            find_item(&entries, QUIT_APP_MENU_ID),
            Some(MenuEntry::Item {
                accelerator: Some("CmdOrCtrl+Q"),
                ..
            })
        ));
        assert!(matches!(
            find_item(&entries, SHOW_MAIN_WINDOW_MENU_ID),
            Some(MenuEntry::Item {
                accelerator: Some("CmdOrCtrl+O"),
                ..
            })
        ));
        assert!(matches!(
            find_item(&entries, TOGGLE_START_AT_LOGIN_MENU_ID),
            Some(MenuEntry::Check {
                checked: true,
                enabled: true,
                ..
            })
        ));
    }

    #[test]
    fn a_desktop_managed_row_offers_start_when_offline_and_a_user_owned_row_offers_nothing() {
        let entries = build_menu_entries(&model_with(vec![
            row("https://off.example.com", ServiceState::Offline, true),
            row("https://mine.example.com", ServiceState::Connected, false),
        ]));
        let found = ids(&entries);
        assert!(found.contains(&"service:start:https://off.example.com".to_string()));
        // Only the actions the executor offered are rendered.
        assert!(find_item(&entries, "service:stop:https://off.example.com").is_none());
        assert!(!found.iter().any(|id| id.contains("mine.example.com")));
        let user_owned = entries
            .iter()
            .find_map(|entry| match entry {
                MenuEntry::Submenu { text, items, .. } if text.contains("mine.example.com") => {
                    Some(items.clone())
                }
                _ => None,
            })
            .expect("the user-owned service still has its row");
        assert_eq!(user_owned, vec![disabled("Managed outside Happier")]);
    }

    #[test]
    fn stop_everything_is_disabled_only_when_nothing_the_app_manages_runs() {
        let idle = build_menu_entries(&model_with(vec![
            row("https://off.example.com", ServiceState::Offline, true),
            row("https://mine.example.com", ServiceState::Connected, false),
        ]));
        assert!(!enabled(find_item(&idle, STOP_SERVICES_AND_QUIT_MENU_ID)));

        let unknown = build_menu_entries(&TrayMenuModel::new(MenuPlatform::MacOs));
        assert!(find_item(&unknown, STOP_SERVICES_AND_QUIT_MENU_ID).is_none());
        // Unknown login-start mode: nothing to flip.
        assert!(!enabled(find_item(&unknown, TOGGLE_START_AT_LOGIN_MENU_ID)));
    }

    #[test]
    fn full_inventory_managed_running_count_includes_services_hidden_by_relay_rows() {
        for rows in [
            vec![row("https://work.example", ServiceState::Connected, false)],
            vec![],
        ] {
            let mut model = model_with(rows);
            model.running_managed_service_count = Some(1);
            assert_eq!(model.app_managed_service_running(), Some(true));
            assert!(enabled(find_item(
                &build_menu_entries(&model),
                STOP_SERVICES_AND_QUIT_MENU_ID
            )));

            model.running_managed_service_count = Some(0);
            assert_eq!(model.app_managed_service_running(), Some(false));
            if let ServiceList::Listed { complete, .. } = &mut model.services {
                *complete = false;
            }
            assert_eq!(model.app_managed_service_running(), None);
            model.running_managed_service_count = None;
            assert_eq!(model.app_managed_service_running(), None);
            model.running_managed_service_count = Some(1);
            assert_eq!(model.app_managed_service_running(), Some(true));
        }
    }

    #[test]
    fn status_managed_running_count_is_independent_of_the_displayed_relay_rows() {
        let data = json!({
            "serviceRows": [{ "relayUrl": "https://work.example", "state": "connected", "appManaged": false }],
            "serviceRowsComplete": true,
            "runningManagedServiceCount": 1
        });
        assert_eq!(
            read_service_status(&data).running_managed_service_count,
            Some(1)
        );
        assert_eq!(
            read_service_status(&json!({ "serviceRows": [] })).running_managed_service_count,
            None
        );
        assert_eq!(
            read_service_status(&json!({ "serviceRows": [], "runningManagedServiceCount": null }))
                .running_managed_service_count,
            None
        );
    }

    #[test]
    fn a_running_action_disables_the_service_actions_until_it_settles() {
        let mut model = model_with(vec![row(
            "https://a.example.com",
            ServiceState::Connected,
            true,
        )]);
        model.busy = true;
        let entries = build_menu_entries(&model);
        assert!(!enabled(find_item(
            &entries,
            "service:restart:https://a.example.com"
        )));
        assert!(!enabled(find_item(
            &entries,
            "service:stop:https://a.example.com"
        )));
        assert!(!enabled(find_item(&entries, TOGGLE_START_AT_LOGIN_MENU_ID)));
        assert!(!enabled(find_item(&entries, QUIT_APP_MENU_ID)));
        assert!(!enabled(find_item(
            &entries,
            STOP_SERVICES_AND_QUIT_MENU_ID
        )));

        // OFF makes Quit stop services too; it must never offer an action that is dropped.
        model.start_at_login = Some(false);
        assert!(!enabled(find_item(
            &build_menu_entries(&model),
            QUIT_APP_MENU_ID
        )));
        model.busy = false;
        assert!(enabled(find_item(
            &build_menu_entries(&model),
            QUIT_APP_MENU_ID
        )));
    }

    #[test]
    fn linux_spells_the_status_in_text_and_other_platforms_draw_a_dot() {
        let rows = vec![row(
            "https://a.example.com",
            ServiceState::NeedsAttention,
            true,
        )];
        let mac = build_menu_entries(&model_with(rows.clone()));
        let linux = build_menu_entries(&TrayMenuModel {
            platform: MenuPlatform::Linux,
            ..model_with(rows)
        });
        let submenu = |entries: &[MenuEntry]| {
            entries
                .iter()
                .find_map(|entry| match entry {
                    MenuEntry::Submenu { text, dot, .. } => Some((text.clone(), *dot)),
                    _ => None,
                })
                .unwrap()
        };
        assert_eq!(
            submenu(&mac),
            (
                "a.example.com · Needs attention".to_string(),
                Some(ServiceState::NeedsAttention)
            )
        );
        assert_eq!(
            submenu(&linux),
            ("▲ a.example.com · Needs attention".to_string(), None)
        );
        assert!(!linux.iter().any(|entry| matches!(
            entry,
            MenuEntry::Item {
                accelerator: Some(_),
                ..
            }
        )));
    }

    #[test]
    fn the_services_section_says_what_it_knows() {
        let mut model = TrayMenuModel::new(MenuPlatform::MacOs);
        let texts = |model: &TrayMenuModel| {
            build_menu_entries(model)
                .into_iter()
                .filter_map(|entry| match entry {
                    MenuEntry::Item { id: None, text, .. } => Some(text),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        assert!(texts(&model).contains(&"Checking background services…".to_string()));
        model.services = ServiceList::Failed;
        assert!(texts(&model).contains(&"Couldn’t check background services".to_string()));
        model.services = ServiceList::Listed {
            rows: vec![],
            complete: true,
        };
        assert!(texts(&model).contains(&"This computer isn’t set up yet".to_string()));
        model.services = ServiceList::Listed {
            rows: vec![],
            complete: false,
        };
        let incomplete = texts(&model);
        assert!(incomplete.contains(&"Some background services couldn’t be checked".to_string()));
        assert!(!incomplete.contains(&"This computer isn’t set up yet".to_string()));
    }

    #[test]
    fn the_updates_item_appears_only_with_a_label_and_the_status_line_only_with_the_web_ui() {
        let mut model = TrayMenuModel::new(MenuPlatform::MacOs);
        assert!(find_item(&build_menu_entries(&model), OPEN_UPDATES_MENU_ID).is_none());
        model.updates = Some(UpdatesItem {
            label: "  ".into(),
            enabled: true,
        });
        assert!(find_item(&build_menu_entries(&model), OPEN_UPDATES_MENU_ID).is_none());
        model.updates = Some(UpdatesItem {
            label: "Updating…".into(),
            enabled: false,
        });
        assert!(!enabled(find_item(
            &build_menu_entries(&model),
            OPEN_UPDATES_MENU_ID
        )));
        model.status_line = Some("Connected · Online · 2/2".into());
        assert_eq!(
            build_menu_entries(&model)[0],
            disabled("Connected · Online · 2/2")
        );
    }

    #[test]
    fn labels_come_from_the_web_ui_and_fall_back_to_english_one_by_one() {
        let labels: TrayLabels = serde_json::from_value(json!({
            "open": "Happier öffnen",
            "quit": "",
            "stopConfirmTitle": "Happier-Hintergrunddienst für {relay} stoppen?"
        }))
        .expect("partial labels parse");
        let labels = labels.with_fallbacks();
        assert_eq!(labels.open, "Happier öffnen");
        assert_eq!(labels.quit, "Quit Happier");
        assert_eq!(labels.settings, "Settings…");
        assert_eq!(
            fill_relay(&labels.stop_confirm_title, "a.example.com"),
            "Happier-Hintergrunddienst für a.example.com stoppen?"
        );
    }

    #[test]
    fn long_relay_names_are_shortened_in_the_middle_and_hosts_come_from_urls() {
        assert_eq!(
            truncate_middle("short.example.com", 36),
            "short.example.com"
        );
        let long = "a-very-long-relay-subdomain-for-testing.internal.example.com";
        let shortened = truncate_middle(long, 20);
        assert_eq!(shortened.chars().count(), 20);
        assert!(shortened.starts_with("a-very-lon"));
        assert!(shortened.ends_with("ample.com"));
        assert!(shortened.contains('…'));
        assert_eq!(
            relay_host("https://relay.example.com:8443/api?x=1"),
            "relay.example.com:8443"
        );
        assert_eq!(relay_host("relay.example.com"), "relay.example.com");
        assert_eq!(
            relay_host("https://user@host.example.com/"),
            "host.example.com"
        );
    }

    #[test]
    fn a_status_dot_is_opaque_at_its_centre_and_transparent_at_its_corners() {
        let rgba = status_dot_rgba(ServiceState::Connected, STATUS_DOT_IMAGE_PX);
        assert_eq!(rgba.len(), (36 * 36 * 4) as usize);
        let pixel = |x: usize, y: usize| &rgba[(y * 36 + x) * 4..(y * 36 + x) * 4 + 4];
        assert_eq!(pixel(18, 18), &[52, 199, 89, 255]);
        assert_eq!(pixel(0, 0)[3], 0);
        assert_eq!(pixel(35, 35)[3], 0);
    }

    #[test]
    fn a_status_read_takes_the_executor_rows_as_they_are_and_nothing_else() {
        let read = read_service_status(&json!({
            "serviceAutostart": "on-demand",
            "serviceRows": [
                { "relayUrl": "https://a.example.com", "state": "offline", "appManaged": true, "serviceTargetMode": "pinned", "actions": ["start"] },
                { "relayUrl": "https://b.example.com", "state": "connected", "appManaged": false, "serviceTargetMode": "pinned", "actions": [] }
            ],
            "serviceRowsComplete": false
        }));
        assert_eq!(read.autostart, Some(AutostartMode::OnDemand));
        assert_eq!(
            read.services,
            ServiceList::Listed {
                rows: vec![
                    ServiceRow {
                        relay_url: "https://a.example.com".into(),
                        name: None,
                        state: ServiceState::Offline,
                        app_managed: true,
                        actions: vec![ServiceAction::Start],
                        active_session_count: None,
                    },
                    ServiceRow {
                        relay_url: "https://b.example.com".into(),
                        name: None,
                        state: ServiceState::Connected,
                        app_managed: false,
                        actions: vec![],
                        active_session_count: None,
                    },
                ],
                complete: false,
            }
        );
        // An executor that sent no rows, or rows the tray cannot read: nothing is claimed.
        assert_eq!(
            read_service_status(&json!({})).services,
            ServiceList::Failed
        );
        assert_eq!(
            read_service_status(&json!({ "serviceRows": [{ "relayUrl": "x", "state": "exploded", "appManaged": true }] })).services,
            ServiceList::Failed
        );
    }

    #[test]
    fn a_failure_the_tray_saw_is_said_in_the_menu_itself() {
        let mut model = TrayMenuModel::new(MenuPlatform::MacOs);
        model.status_line = Some("Connected · Online".into());
        model.notice = Some("The background service for a.example.com is still running.".into());
        let entries = build_menu_entries(&model);
        assert_eq!(
            entries[1],
            disabled("⚠ The background service for a.example.com is still running.")
        );
        model.notice = Some("x".repeat(200));
        let long = build_menu_entries(&model);
        let MenuEntry::Item { text, .. } = &long[1] else {
            panic!("the notice is a row");
        };
        assert!(text.chars().count() <= MAX_NOTICE_CHARS + 2);
    }

    #[test]
    fn flat_status_login_preference_is_the_native_login_source() {
        let data = serde_json::json!({"serviceRows":[],"serviceRowsComplete":true,"serviceAutostart":"on-demand"});
        assert_eq!(
            read_service_status(&data).autostart,
            Some(AutostartMode::OnDemand)
        );
    }

    #[test]
    fn incomplete_services_cannot_prove_no_managed_service_runs() {
        let mut model = TrayMenuModel::new(MenuPlatform::MacOs);
        model.services = ServiceList::Listed {
            rows: vec![],
            complete: false,
        };
        assert_eq!(model.app_managed_service_running(), None);
        model.services = ServiceList::Listed {
            rows: vec![row("https://a.example.com", ServiceState::Offline, true)],
            complete: false,
        };
        assert_eq!(model.app_managed_service_running(), None);
        model.services = ServiceList::Listed {
            rows: vec![row("https://a.example.com", ServiceState::Connected, true)],
            complete: false,
        };
        assert_eq!(model.app_managed_service_running(), Some(true));
        model.services = ServiceList::Listed {
            rows: vec![],
            complete: true,
        };
        assert_eq!(model.app_managed_service_running(), Some(false));
    }

    #[test]
    fn status_login_mode_is_aggregate_even_when_the_status_is_scoped() {
        let read = read_service_status(&json!({
            "serviceAutostart": "on-demand",
            "serviceRows": [], "serviceRowsComplete": true,
        }));
        assert_eq!(read.autostart, Some(AutostartMode::OnDemand));
        let unknown = read_service_status(&json!({
            "serviceAutostart": null,
            "serviceRows": [], "serviceRowsComplete": false,
        }));
        assert_eq!(unknown.autostart, None);
    }

    #[test]
    fn known_session_counts_are_rendered_but_unknown_counts_make_no_claim() {
        for count in [None, Some(0), Some(2)] {
            let mut value = json!({"relayUrl":"https://a.example.com","state":"connected","appManaged":true,"actions":["stop"]});
            if let Some(count) = count {
                value["activeSessionCount"] = json!(count);
            }
            let row = serde_json::from_value(value).expect("a service row");
            let mut model = model_with(vec![row]);
            model.labels = serde_json::from_value(json!({"sessions":"{count} Sitzungen"}))
                .expect("localized labels");
            let entries = build_menu_entries(&model);
            let text = entries
                .iter()
                .find_map(|entry| match entry {
                    MenuEntry::Submenu { text, .. } => Some(text),
                    _ => None,
                })
                .expect("service submenu");
            match count {
                Some(count) => assert!(text.contains(&format!("{count} Sitzungen"))),
                None => assert!(!text.contains("Sitzungen")),
            }
        }
    }
}
