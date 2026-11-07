//! The tray: the Happier mark in the menu bar / notification area, and its native menu.
//!
//! One menu builder for every source (R16 c). The web UI pushes its facts while it runs
//! (`desktop_set_tray_state`); in menu-bar mode `crate::menu_bar` reads the background services
//! natively through the existing status system task. Both only update the one [`TrayMenuModel`];
//! [`rebuild_menu`] renders it from [`model::build_menu_entries`].

#[cfg(desktop)]
pub(crate) mod model;

#[cfg(desktop)]
use std::path::PathBuf;
#[cfg(desktop)]
use std::sync::Mutex;

#[cfg(desktop)]
use serde::Deserialize;
#[cfg(desktop)]
use serde_json::Value;
#[cfg(desktop)]
use tauri::{
    image::Image,
    menu::{
        CheckMenuItemBuilder, IconMenuItemBuilder, IsMenuItem, Menu, MenuItemBuilder, MenuItemKind,
        PredefinedMenuItem, Submenu,
    },
    tray::{MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager,
};

#[cfg(desktop)]
use crate::menu_bar::policy::{parse_persisted_tray_state, PersistedTrayState};
#[cfg(desktop)]
use model::{
    build_menu_entries, status_dot_rgba, AutostartMode, MenuEntry, MenuPlatform, ServiceList,
    ServiceRow, ServiceState, TrayLabels, TrayMenuModel, UpdatesItem, STATUS_DOT_IMAGE_PX,
};

#[cfg(desktop)]
const TRAY_ICON_ID: &str = "main";
/// The tray shows only the Happier mark; status lives in the menu it opens, so the icon never
/// grows a title. macOS gets a template image the menu bar tints for light and dark bars
/// (tray-icon draws it 18pt tall; 36px is its @2x). Windows and Linux get 32px images picked by the
/// tray's own theme: the full-colour mark on a light tray, a white silhouette on a dark one, where
/// the dark bag would vanish. All are rendered from `icons/AppIcon.icon/Assets/*.svg` by
/// `node scripts/generateDesktopIcons.mjs`.
#[cfg(target_os = "macos")]
const TRAY_ICON: Image<'static> = tauri::include_image!("./icons/tray/tray-template.png");
#[cfg(all(desktop, not(target_os = "macos")))]
const TRAY_ICON_FOR_LIGHT_TRAY: Image<'static> = tauri::include_image!("./icons/tray/tray.png");
#[cfg(all(desktop, not(target_os = "macos")))]
const TRAY_ICON_FOR_DARK_TRAY: Image<'static> = tauri::include_image!("./icons/tray/tray-dark.png");
#[cfg(desktop)]
const TRAY_TOOLTIP: &str = "Happier";
/// The tray is how Windows and Linux reach Quit at all: they get no app menu, and closing the main
/// window only hides it. It is also the only way to bring that window back on those platforms, and
/// in menu-bar mode it is all that remains of the app.
#[cfg(desktop)]
const DESKTOP_TRAY_ENABLED: bool = true;
/// Last-known tray facts (labels, task params, Updates item, relay names, login-start setting).
#[cfg(desktop)]
const PERSISTED_TRAY_STATE_FILE: &str = "tray-state.json";

#[cfg(desktop)]
fn is_desktop_tray_enabled_for_build() -> bool {
    DESKTOP_TRAY_ENABLED
}

/// The one tray model and what the web UI persisted for native use.
#[cfg(desktop)]
pub struct TrayState(Mutex<TrayStateInner>);

#[cfg(desktop)]
struct TrayStateInner {
    model: TrayMenuModel,
    persisted: PersistedTrayState,
    persisted_path: Option<PathBuf>,
}

#[cfg(desktop)]
impl TrayState {
    fn load(app: &App) -> Self {
        let persisted_path = app
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join(PERSISTED_TRAY_STATE_FILE));
        let bytes = persisted_path
            .as_ref()
            .and_then(|path| std::fs::read(path).ok());
        let persisted = parse_persisted_tray_state(bytes.as_deref());
        let model = persisted.initial_model(MenuPlatform::current());
        Self(Mutex::new(TrayStateInner {
            model,
            persisted,
            persisted_path,
        }))
    }
}

/// The status task's params as the web UI builds them, once it has run (else `None`).
#[cfg(desktop)]
pub(crate) fn native_task_params(app: &AppHandle) -> Option<Value> {
    let state = app.try_state::<TrayState>()?;
    let inner = state.0.lock().ok()?;
    inner.persisted.task_params.clone()
}

#[cfg(desktop)]
pub(crate) fn labels(app: &AppHandle) -> TrayLabels {
    app.try_state::<TrayState>()
        .and_then(|state| state.0.lock().ok().map(|inner| inner.model.labels.clone()))
        .unwrap_or_default()
}

/// The login-start setting as the tray last knew it (`None` = unknown).
#[cfg(desktop)]
pub(crate) fn start_at_login(app: &AppHandle) -> Option<bool> {
    let state = app.try_state::<TrayState>()?;
    let inner = state.0.lock().ok()?;
    inner.model.start_at_login
}

/// Whether some service the app manages is known to run (`None` = unknown).
#[cfg(desktop)]
pub(crate) fn app_managed_service_running(app: &AppHandle) -> Option<bool> {
    let state = app.try_state::<TrayState>()?;
    let inner = state.0.lock().ok()?;
    inner.model.app_managed_service_running()
}

/// The relay's display name: the web UI's, else its host.
#[cfg(desktop)]
pub(crate) fn relay_display_name(app: &AppHandle, relay_url: &str) -> String {
    app.try_state::<TrayState>()
        .and_then(|state| {
            state
                .0
                .lock()
                .ok()
                .and_then(|inner| inner.persisted.relay_names.get(relay_url).cloned())
        })
        .unwrap_or_else(|| model::relay_host(relay_url))
}

/// Updates the one model and re-renders the menu.
#[cfg(desktop)]
pub(crate) fn update_model(app: &AppHandle, change: impl FnOnce(&mut TrayMenuModel)) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    let model = {
        let Ok(mut inner) = state.0.lock() else {
            return;
        };
        change(&mut inner.model);
        // Every observation/write goes through the model: web pushes, native reads and toggles
        // all persist the same bit here, using the existing tray-state store.
        let observed_mode = inner.model.start_at_login;
        if inner.persisted.observe_login_start(observed_mode) {
            if let Some(path) = &inner.persisted_path {
                write_persisted_state(path, &inner.persisted);
            }
        }
        let names = inner.persisted.relay_names.clone();
        name_rows(&mut inner.model.services, &names);
        inner.model.clone()
    };
    if let Err(error) = rebuild_menu(app, &model) {
        log::warn!("failed to rebuild the tray menu: {error}");
    }
}

/// Rows a native read produced carry no name; the web UI's last one stands in.
#[cfg(desktop)]
fn name_rows(services: &mut ServiceList, names: &std::collections::BTreeMap<String, String>) {
    if let ServiceList::Listed { rows, .. } = services {
        for row in rows.iter_mut() {
            if row.name.is_none() {
                row.name = names.get(&row.relay_url).cloned();
            }
        }
    }
}

#[cfg(desktop)]
pub fn register(app: &mut App) -> tauri::Result<()> {
    if !is_desktop_tray_enabled_for_build() {
        return Ok(());
    }

    let state = TrayState::load(app);
    let initial_model = state
        .0
        .lock()
        .map(|inner| inner.model.clone())
        .unwrap_or_else(|_| TrayMenuModel::new(MenuPlatform::current()));
    app.manage(state);

    #[cfg(target_os = "macos")]
    let icon = TRAY_ICON;
    #[cfg(target_os = "windows")]
    let icon = tray_icon_for(windows_tray_theme());
    // The portal answers asynchronously; until it does the theme is unknown.
    #[cfg(target_os = "linux")]
    let icon = tray_icon_for(TrayThemeSignal::FreedesktopColorScheme(None));

    // Every platform opens the menu on click (Linux can only ever do that). The pointer reaching
    // or pressing the icon is the closest macOS and Windows come to "the menu is opening", so in
    // menu-bar mode it refreshes the services (throttled); with a main webview it forwards demand
    // to that inspection owner. AppIndicator reports neither.
    TrayIconBuilder::with_id(TRAY_ICON_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip(TRAY_TOOLTIP)
        .menu(&build_native_menu(app.handle(), &initial_model)?)
        .show_menu_on_left_click(true)
        .on_tray_icon_event(|tray, event| {
            let pointer = matches!(event, TrayIconEvent::Enter { .. })
                || matches!(
                    event,
                    TrayIconEvent::Click {
                        button_state: MouseButtonState::Down,
                        ..
                    }
                );
            if pointer {
                crate::menu_bar::on_tray_pointer(tray.app_handle());
            }
        })
        .build(app)?;

    // Windows follows the taskbar theme through the main window's events, hooked by
    // `window_chrome::configure_main_window` each time that window is created.
    #[cfg(target_os = "linux")]
    follow_tray_theme(app);

    Ok(())
}

#[cfg(all(desktop, not(target_os = "macos")))]
use model::{tray_is_light, TrayThemeSignal};

#[cfg(all(desktop, not(target_os = "macos")))]
fn tray_icon_for(signal: TrayThemeSignal) -> Image<'static> {
    if tray_is_light(signal) {
        TRAY_ICON_FOR_LIGHT_TRAY
    } else {
        TRAY_ICON_FOR_DARK_TRAY
    }
}

#[cfg(all(desktop, not(target_os = "macos")))]
fn set_tray_icon_for(app: &AppHandle, signal: TrayThemeSignal) {
    let Some(tray) = app.tray_by_id(TRAY_ICON_ID) else {
        return;
    };
    if let Err(error) = tray.set_icon(Some(tray_icon_for(signal))) {
        log::warn!("failed to switch the tray icon to the tray theme: {error}");
    }
}

#[cfg(target_os = "windows")]
fn windows_tray_theme() -> TrayThemeSignal {
    let value = windows_registry::CURRENT_USER
        .open(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|key| key.get_u32("SystemUsesLightTheme"))
        .inspect_err(|error| log::info!("tray theme unknown, using the dark-tray icon: {error}"))
        .ok();
    TrayThemeSignal::WindowsSystemUsesLightTheme(value)
}

/// With no main webview, existing pointer demand replaces the absent window theme observer.
#[cfg(target_os = "windows")]
pub(crate) fn refresh_tray_theme_on_pointer(app: &AppHandle, main_webview_exists: bool) {
    if let Some(signal) = model::sample_tray_theme_on_pointer(
        MenuPlatform::current(),
        main_webview_exists,
        windows_tray_theme,
    ) {
        set_tray_icon_for(app, signal);
    }
}

/// Re-reads taskbar mode on main-window ThemeChanged. Tray-only pointer demand samples it too.
#[cfg(target_os = "windows")]
pub(crate) fn follow_tray_theme_from_window(app: &AppHandle, window: &tauri::WebviewWindow) {
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::ThemeChanged(_)) {
            set_tray_icon_for(&handle, windows_tray_theme());
        }
    });
}

/// Reads the portal's `color-scheme` once and follows its `SettingChanged` signal, both on the
/// GTK main context (no thread, no polling). Uses `Read` rather than `ReadOne` (portal v2) so
/// older portals answer too; `Read` wraps the value in an extra variant, hence the unwrap loop.
#[cfg(target_os = "linux")]
fn follow_tray_theme(app: &mut App) {
    use gtk::{gio, glib, glib::ToVariant};

    const PORTAL: &str = "org.freedesktop.portal.Desktop";
    const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
    const SETTINGS: &str = "org.freedesktop.portal.Settings";
    const APPEARANCE: &str = "org.freedesktop.appearance";
    const COLOR_SCHEME: &str = "color-scheme";

    fn color_scheme(mut value: glib::Variant) -> Option<u32> {
        while value.type_() == glib::VariantTy::VARIANT {
            value = value.as_variant()?;
        }
        value.get::<u32>()
    }

    let handle = app.handle().clone();
    gio::bus_get(gio::BusType::Session, gio::Cancellable::NONE, move |bus| {
        let bus = match bus {
            Ok(bus) => bus,
            Err(error) => {
                log::info!("tray theme unknown (no session bus): {error}");
                return;
            }
        };

        let on_change = handle.clone();
        // The closure owns a connection clone, which keeps the shared session bus alive for as
        // long as the subscription (the app's lifetime).
        let kept_bus = bus.clone();
        bus.signal_subscribe(
            Some(PORTAL),
            Some(SETTINGS),
            Some("SettingChanged"),
            Some(PORTAL_PATH),
            Some(APPEARANCE),
            gio::DBusSignalFlags::NONE,
            move |_, _, _, _, _, parameters| {
                let _keep_alive = &kept_bus;
                if let Some((_, key, value)) = parameters.get::<(String, String, glib::Variant)>() {
                    if key == COLOR_SCHEME {
                        let signal = TrayThemeSignal::FreedesktopColorScheme(color_scheme(value));
                        set_tray_icon_for(&on_change, signal);
                    }
                }
            },
        );

        bus.call(
            Some(PORTAL),
            PORTAL_PATH,
            SETTINGS,
            "Read",
            Some(&(APPEARANCE, COLOR_SCHEME).to_variant()),
            glib::VariantTy::new("(v)").ok(),
            gio::DBusCallFlags::NONE,
            -1,
            gio::Cancellable::NONE,
            move |reply| {
                let value = match reply {
                    Ok(reply) => color_scheme(reply.child_value(0)),
                    Err(error) => {
                        log::info!("tray theme unknown (no settings portal): {error}");
                        None
                    }
                };
                set_tray_icon_for(&handle, TrayThemeSignal::FreedesktopColorScheme(value));
            },
        );
    });
}

/// One service row as the web UI projects it (`listThisComputerRelayRows`).
#[cfg(desktop)]
#[derive(Clone, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DesktopTrayServices {
    /// The web UI has not read this computer's services yet.
    Pending,
    Failed,
    Listed {
        rows: Vec<ServiceRow>,
        complete: bool,
    },
}

#[cfg(desktop)]
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrayStatePayload {
    /// The menu's connection status line, "label · detail". Unknown fields are ignored.
    pub label: String,
    pub detail: String,
    /// Every tray string, localized by the app (U14) and persisted for menu-bar mode.
    #[serde(default)]
    pub labels: Option<TrayLabels>,
    /// "Updates available (3)…" — present only while there is an update to act on.
    #[serde(default)]
    pub updates_label: Option<String>,
    /// `false` while the item only reports ("Updating…"). Absent = enabled.
    #[serde(default)]
    pub updates_enabled: Option<bool>,
    /// Whether the per-device app lock is enabled on this computer.
    #[serde(default)]
    pub app_lock_enabled: Option<bool>,
    #[serde(default)]
    pub services: Option<DesktopTrayServices>,
    /// The login-start setting as the web UI read it; absent/null = unknown.
    #[serde(default)]
    pub service_autostart: Option<AutostartMode>,
    /// `daemon.service.status.v1`'s params from the web UI's one spec builder.
    #[serde(default)]
    pub task_params: Option<Value>,
}

/// The web UI's push. Returns the screen a tray item asked for while the window was being
/// recreated (`"updates"` / `"settings"`), exactly once, so the fresh web UI can open it.
#[cfg(desktop)]
#[tauri::command]
pub fn desktop_set_tray_state(
    app: AppHandle,
    state: DesktopTrayStatePayload,
) -> Result<Option<String>, String> {
    if !is_desktop_tray_enabled_for_build() {
        return Ok(None);
    }
    apply_web_state(&app, state);
    Ok(crate::menu_bar::take_pending_destination(&app))
}

#[cfg(desktop)]
fn apply_web_state(app: &AppHandle, payload: DesktopTrayStatePayload) {
    let Some(tray_state) = app.try_state::<TrayState>() else {
        return;
    };
    let labels = payload.labels.map(TrayLabels::with_fallbacks);
    let app_lock_enabled = payload.app_lock_enabled.unwrap_or(false);
    let updates = payload
        .updates_label
        .as_deref()
        .map(str::trim)
        .map(str::to_string)
        .filter(|label| !label.is_empty())
        .map(|label| UpdatesItem {
            label,
            enabled: payload.updates_enabled.unwrap_or(true),
        });
    let services = match payload.services {
        Some(DesktopTrayServices::Listed { rows, complete }) => {
            Some(ServiceList::Listed { rows, complete })
        }
        Some(DesktopTrayServices::Failed) => Some(ServiceList::Failed),
        Some(DesktopTrayServices::Pending) | None => None,
    };
    let status_line = format!("{} · {}", payload.label, payload.detail);
    let mode_resolved = matches!(&services, Some(ServiceList::Listed { .. }))
        || payload.service_autostart.is_some();

    if let Ok(mut inner) = tray_state.0.lock() {
        let mut persisted = inner.persisted.clone();
        if let Some(labels) = &labels {
            persisted.labels = labels.clone();
        }
        persisted.updates = updates.clone();
        if let Some(params) = payload.task_params.filter(Value::is_object) {
            persisted.task_params = Some(params);
        }
        if let Some(ServiceList::Listed { rows, .. }) = &services {
            for row in rows {
                if let Some(name) = row.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
                    persisted
                        .relay_names
                        .insert(row.relay_url.clone(), name.to_string());
                }
            }
        }
        if persisted != inner.persisted {
            if let Some(path) = &inner.persisted_path {
                write_persisted_state(path, &persisted);
            }
            inner.persisted = persisted;
        }
    }

    update_model(app, |model| {
        if let Some(labels) = labels {
            model.labels = labels;
        }
        model.status_line = Some(status_line);
        model.updates = updates;
        model.app_lock_enabled = app_lock_enabled;
        if let Some(services) = services {
            model.services = services;
        }
        if mode_resolved {
            model.start_at_login = payload
                .service_autostart
                .map(|mode| mode == AutostartMode::AtLogin);
        }
    });
    if let Some(mode) = payload.service_autostart {
        crate::autostart::follow_login_start_setting(app, Some(mode));
    }
}

/// Written only when it changed. A write that fails costs the next login start its localized
/// labels (English stands in), status-read params and last-known login-start setting until a fresh
/// read or web push restores them — logged, never fatal.
#[cfg(desktop)]
fn write_persisted_state(path: &std::path::Path, state: &PersistedTrayState) {
    let result = path
        .parent()
        .map(std::fs::create_dir_all)
        .transpose()
        .and_then(|_| {
            serde_json::to_vec_pretty(state)
                .map_err(std::io::Error::other)
                .and_then(|bytes| std::fs::write(path, bytes))
        });
    if let Err(error) = result {
        log::warn!("failed to persist the tray state for menu-bar mode: {error}");
    }
}

#[cfg(desktop)]
fn rebuild_menu(app: &AppHandle, model: &TrayMenuModel) -> tauri::Result<()> {
    let tray = app
        .tray_by_id(TRAY_ICON_ID)
        .ok_or_else(|| tauri::Error::AssetNotFound("tray icon".into()))?;
    tray.set_menu(Some(build_native_menu(app, model)?))?;
    Ok(())
}

#[cfg(desktop)]
fn status_dot(state: ServiceState) -> Image<'static> {
    Image::new_owned(
        status_dot_rgba(state, STATUS_DOT_IMAGE_PX),
        STATUS_DOT_IMAGE_PX,
        STATUS_DOT_IMAGE_PX,
    )
}

/// The one native builder: [`build_menu_entries`] rendered item by item.
#[cfg(desktop)]
fn build_native_menu(app: &AppHandle, model: &TrayMenuModel) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for entry in build_menu_entries(model) {
        let item = build_native_item(app, &entry)?;
        menu.append(&item)?;
    }
    Ok(menu)
}

#[cfg(desktop)]
fn build_native_item(
    app: &AppHandle,
    entry: &MenuEntry,
) -> tauri::Result<MenuItemKind<tauri::Wry>> {
    Ok(match entry {
        MenuEntry::Separator => MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
        MenuEntry::Check {
            id,
            text,
            checked,
            enabled,
        } => MenuItemKind::Check(
            CheckMenuItemBuilder::with_id(id.as_str(), text)
                .checked(*checked)
                .enabled(*enabled)
                .build(app)?,
        ),
        MenuEntry::Item {
            id,
            text,
            enabled,
            accelerator,
            dot: Some(state),
        } => {
            let mut builder = match id {
                Some(id) => IconMenuItemBuilder::with_id(id.as_str(), text),
                None => IconMenuItemBuilder::new(text),
            }
            .icon(status_dot(*state))
            .enabled(*enabled);
            if let Some(accelerator) = accelerator {
                builder = builder.accelerator(*accelerator);
            }
            MenuItemKind::Icon(builder.build(app)?)
        }
        MenuEntry::Item {
            id,
            text,
            enabled,
            accelerator,
            dot: None,
        } => {
            let mut builder = match id {
                Some(id) => MenuItemBuilder::with_id(id.as_str(), text),
                None => MenuItemBuilder::new(text),
            }
            .enabled(*enabled);
            if let Some(accelerator) = accelerator {
                builder = builder.accelerator(*accelerator);
            }
            MenuItemKind::MenuItem(builder.build(app)?)
        }
        MenuEntry::Submenu {
            text,
            enabled,
            dot,
            items,
        } => {
            let children = items
                .iter()
                .map(|item| build_native_item(app, item))
                .collect::<tauri::Result<Vec<_>>>()?;
            let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = children
                .iter()
                .map(|item| item as &dyn IsMenuItem<tauri::Wry>)
                .collect();
            let submenu = Submenu::with_items(app, text, *enabled, &refs)?;
            if let Some(state) = dot {
                submenu.set_icon(Some(status_dot(*state)))?;
            }
            MenuItemKind::Submenu(submenu)
        }
    })
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    #[test]
    fn every_desktop_build_ships_the_tray_so_quit_is_reachable() {
        // Windows and Linux have no other quit or re-show affordance: no app menu, and the main
        // window hides on close.
        assert!(is_desktop_tray_enabled_for_build());
    }

    #[test]
    fn the_web_ui_push_parses_its_rows_labels_and_setting_and_defaults_the_rest() {
        let pushed: DesktopTrayStatePayload = serde_json::from_str(
            r#"{"label":"Verbunden","detail":"Online","labels":{"quit":"Happier beenden"},
                "services":{"status":"listed","complete":true,"rows":[{"relayUrl":"https://a.example.com","name":"Work","state":"offline","appManaged":true}]},
                "serviceAutostart":"at-login","taskParams":{"target":{"kind":"local"}}}"#,
        )
        .expect("payload parses");
        assert_eq!(
            pushed.labels.unwrap().with_fallbacks().quit,
            "Happier beenden"
        );
        assert!(matches!(
            pushed.services,
            Some(DesktopTrayServices::Listed { ref rows, complete: true }) if rows[0].state == ServiceState::Offline
        ));
        assert_eq!(pushed.service_autostart, Some(AutostartMode::AtLogin));

        let minimal: DesktopTrayStatePayload = serde_json::from_str(
            r#"{"label":"Connected","detail":"Online","serviceAutostart":null}"#,
        )
        .expect("payload without the new fields parses");
        assert!(minimal.labels.is_none());
        assert!(minimal.services.is_none());
        assert_eq!(minimal.service_autostart, None);
        assert_eq!(minimal.updates_label, None);
    }
}
