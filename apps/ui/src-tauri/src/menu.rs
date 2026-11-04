//! Desktop menus and the single router for every menu command.
//!
//! Two menus can issue the same app commands — the tray menu on every desktop platform, and the
//! macOS app menu — so the id → action decision lives here once rather than in each menu's own
//! handler. muda delivers every `MenuEvent` to one global channel, so this is registered once at
//! the app level ([`tauri::Builder::on_menu_event`]) and never per menu: registering it twice would
//! call `app.exit(0)` twice for one Quit, and the second exit finds the shutdown handoff already
//! used and quits without waiting for it.
//!
//! The macOS app menu mirrors Tauri's default menu, with its own Quit item routed through
//! [`handle_menu_event`] to `app.exit(0)`. Dock Quit reaches that same
//! [`crate::desktop_lifecycle`] owner through the AppKit termination delegate adapter.
//!
//! Explicit system-ending Apple events, force quit and power loss keep their native termination
//! path. Ordinary person Quit awaits the writer and existing shutdown handoff before AppKit replies.

#[cfg(desktop)]
use tauri::{menu::MenuEvent, AppHandle, Emitter, Manager};

#[cfg(target_os = "macos")]
use tauri::{
    menu::{
        AboutMetadata, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    },
    Runtime,
};

#[cfg(desktop)]
pub mod ids;

#[cfg(target_os = "macos")]
use ids::QUIT_APP_MENU_ID;
#[cfg(desktop)]
use ids::{resolve_desktop_menu_action, DesktopMenuAction};

/// Tells the main webview to navigate to Settings › Updates; the webview owns routing.
#[cfg(desktop)]
pub const OPEN_UPDATES_REQUESTED_EVENT: &str = "desktop_open_updates_requested";
/// Tells the main webview to navigate to Settings.
#[cfg(desktop)]
pub const OPEN_SETTINGS_REQUESTED_EVENT: &str = "desktop_open_settings_requested";
#[cfg(desktop)]
pub const NEW_WINDOW_REQUESTED_EVENT: &str = "desktop_new_window_requested";

#[cfg(desktop)]
pub fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    let Some(action) = resolve_desktop_menu_action(event.id().0.as_str()) else {
        return;
    };
    match action {
        DesktopMenuAction::ShowMainWindow => {
            crate::window_chrome::request_show_main_window(app);
        }
        DesktopMenuAction::NewWindow => {
            let target = app.webview_windows().into_iter().find(|(label, window)| {
                window.is_focused().unwrap_or(false)
                    && (label == crate::desktop_window::MAIN_WINDOW_LABEL
                        || crate::app_window::uses_full_chrome(app, label))
            }).map(|(label, _)| label);
            let label = target.unwrap_or_else(|| {
                crate::window_chrome::request_show_main_window(app);
                crate::desktop_window::MAIN_WINDOW_LABEL.to_string()
            });
            if let Err(error) = app.emit_to(label, NEW_WINDOW_REQUESTED_EVENT, ()) {
                log::warn!("failed to deliver New Window menu intent: {error}");
            }
        }
        DesktopMenuAction::OpenUpdates => crate::menu_bar::open_main_window_at(
            app,
            crate::menu_bar::MainWindowDestination::Updates,
        ),
        DesktopMenuAction::OpenSettings => crate::menu_bar::open_main_window_at(
            app,
            crate::menu_bar::MainWindowDestination::Settings,
        ),
        // Held once by `crate::desktop_lifecycle` so the webview can honour the background-service
        // preference before the app goes.
        DesktopMenuAction::QuitApp => crate::menu_bar::quit(app),
        DesktopMenuAction::StopServicesAndQuit => crate::menu_bar::stop_services_and_quit(app),
        DesktopMenuAction::ToggleStartAtLogin => crate::menu_bar::toggle_start_at_login(app),
        DesktopMenuAction::CaptureScreen => crate::capture::triggers::dispatch(app, crate::capture::triggers::CaptureIntent::Still),
        DesktopMenuAction::RecordScreen => crate::capture::triggers::dispatch(app, crate::capture::triggers::CaptureIntent::Recording),
        action @ (DesktopMenuAction::PauseRecording | DesktopMenuAction::ResumeRecording | DesktopMenuAction::StopRecording) =>
            crate::tray::recording_control(app, action),
        DesktopMenuAction::Service { action, relay_url } => {
            crate::menu_bar::run_service_action(app, action, relay_url)
        }
    }
}

/// tauri's default menu, with its predefined Quit replaced by one that reaches the handoff.
///
/// The Window and Help submenus keep tauri's own ids because tauri registers those two with NSApp
/// by id (`setWindowsMenu` / `setHelpMenu`); a different id silently loses the macOS window list
/// and the Help search field.
#[cfg(target_os = "macos")]
pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let package_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(package_info.name.clone()),
        version: Some(package_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    let quit_item = MenuItemBuilder::with_id(QUIT_APP_MENU_ID, "Quit Happier")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    let app_menu = Submenu::with_items(
        app,
        package_info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItemBuilder::with_id(ids::NEW_WINDOW_MENU_ID, "New Window")
                .accelerator("CmdOrCtrl+Shift+N").build(app)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;

    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}
