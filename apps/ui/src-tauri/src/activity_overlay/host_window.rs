use super::host_mode::{DesktopActivityOverlayDisplayContext, DesktopActivityOverlayHostMode};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSColor, NSMainMenuWindowLevel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
};
use tauri::TitleBarStyle;
#[cfg(target_os = "macos")]
use tauri::{ActivationPolicy, AppHandle, Runtime, WebviewWindow};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DesktopActivityOverlayMacWindowLevelOverride {
    NotchPanel,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum DesktopActivityOverlayMacHostPath {
    Window,
    Panel,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct DesktopActivityOverlayMacWindowBuilderDefaults {
    pub(crate) accept_first_mouse: bool,
    pub(crate) title_bar_style: TitleBarStyle,
    pub(crate) hidden_title: bool,
    pub(crate) shadow: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct DesktopActivityOverlayMacWindowHostSettings {
    pub(crate) host_path: DesktopActivityOverlayMacHostPath,
    pub(crate) prefer_accessory_activation_policy: bool,
    pub(crate) visible_on_all_workspaces: bool,
    pub(crate) shadow: bool,
    pub(crate) full_screen_auxiliary: bool,
    pub(crate) stationary: bool,
    pub(crate) ignores_cycle: bool,
    pub(crate) nonactivating_panel: bool,
    pub(crate) opaque: bool,
    pub(crate) window_level_override: Option<DesktopActivityOverlayMacWindowLevelOverride>,
}

pub(crate) fn resolve_macos_overlay_window_builder_defaults(
    is_macos: bool,
) -> Option<DesktopActivityOverlayMacWindowBuilderDefaults> {
    if !is_macos {
        return None;
    }

    Some(DesktopActivityOverlayMacWindowBuilderDefaults {
        accept_first_mouse: true,
        title_bar_style: TitleBarStyle::Transparent,
        hidden_title: true,
        shadow: false,
    })
}

pub(crate) fn resolve_macos_overlay_window_host_settings(
    host_mode: DesktopActivityOverlayHostMode,
    display_context: Option<DesktopActivityOverlayDisplayContext>,
) -> Option<DesktopActivityOverlayMacWindowHostSettings> {
    let Some(display_context) = display_context else {
        return None;
    };

    if !display_context.is_macos {
        return None;
    }

    Some(DesktopActivityOverlayMacWindowHostSettings {
        host_path: if matches!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated) {
            DesktopActivityOverlayMacHostPath::Panel
        } else {
            DesktopActivityOverlayMacHostPath::Window
        },
        prefer_accessory_activation_policy: matches!(
            host_mode,
            DesktopActivityOverlayHostMode::NotchIntegrated
        ),
        visible_on_all_workspaces: matches!(
            host_mode,
            DesktopActivityOverlayHostMode::NotchIntegrated
        ),
        shadow: false,
        full_screen_auxiliary: matches!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated),
        stationary: matches!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated),
        ignores_cycle: matches!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated),
        nonactivating_panel: matches!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated),
        opaque: false,
        window_level_override: match host_mode {
            DesktopActivityOverlayHostMode::NotchIntegrated => {
                Some(DesktopActivityOverlayMacWindowLevelOverride::NotchPanel)
            }
            DesktopActivityOverlayHostMode::Floating => None,
        },
    })
}

pub(crate) fn should_apply_raw_macos_overlay_window_collection_behavior(
    settings: DesktopActivityOverlayMacWindowHostSettings,
) -> bool {
    matches!(
        settings.host_path,
        DesktopActivityOverlayMacHostPath::Window
    )
}

#[cfg(target_os = "macos")]
pub(crate) fn apply_macos_overlay_activation_policy<R: Runtime>(
    app: &AppHandle<R>,
    settings: DesktopActivityOverlayMacWindowHostSettings,
) -> Result<(), String> {
    let activation_policy = if settings.prefer_accessory_activation_policy {
        ActivationPolicy::Accessory
    } else {
        ActivationPolicy::Regular
    };

    app.set_activation_policy(activation_policy)
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn apply_macos_overlay_activation_policy<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    _settings: DesktopActivityOverlayMacWindowHostSettings,
) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn resolve_macos_window_level_override(
    level_override: DesktopActivityOverlayMacWindowLevelOverride,
) -> isize {
    match level_override {
        // Claude Island / VibeHub both run above the menu bar using `.mainMenu + 3`.
        DesktopActivityOverlayMacWindowLevelOverride::NotchPanel => NSMainMenuWindowLevel + 3,
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn apply_macos_overlay_window_collection_behavior<R: Runtime>(
    window: &WebviewWindow<R>,
    settings: DesktopActivityOverlayMacWindowHostSettings,
) -> Result<(), String> {
    let ns_window_ptr = window.ns_window().map_err(|error| error.to_string())?;
    let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };
    let mut collection_behavior = unsafe { ns_window.collectionBehavior() };
    let mut style_mask = ns_window.styleMask();
    let clear_color = unsafe { NSColor::clearColor() };

    if settings.visible_on_all_workspaces {
        collection_behavior |= NSWindowCollectionBehavior::CanJoinAllSpaces;
    } else {
        collection_behavior &= !NSWindowCollectionBehavior::CanJoinAllSpaces;
    }

    if settings.full_screen_auxiliary {
        collection_behavior |= NSWindowCollectionBehavior::FullScreenAuxiliary;
    } else {
        collection_behavior &= !NSWindowCollectionBehavior::FullScreenAuxiliary;
    }

    if settings.stationary {
        collection_behavior |= NSWindowCollectionBehavior::Stationary;
    } else {
        collection_behavior &= !NSWindowCollectionBehavior::Stationary;
    }

    if settings.ignores_cycle {
        collection_behavior |= NSWindowCollectionBehavior::IgnoresCycle;
    } else {
        collection_behavior &= !NSWindowCollectionBehavior::IgnoresCycle;
    }

    if settings.nonactivating_panel {
        style_mask |= NSWindowStyleMask::NonactivatingPanel;
    } else {
        style_mask &= !NSWindowStyleMask::NonactivatingPanel;
    }

    ns_window.setOpaque(settings.opaque);
    ns_window.setBackgroundColor(Some(&clear_color));
    ns_window.setStyleMask(style_mask);
    if let Some(level_override) = settings.window_level_override {
        ns_window.setLevel(resolve_macos_window_level_override(level_override));
    }
    unsafe { ns_window.setCollectionBehavior(collection_behavior) };
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn apply_macos_overlay_window_collection_behavior<R: tauri::Runtime>(
    _window: &tauri::WebviewWindow<R>,
    _settings: DesktopActivityOverlayMacWindowHostSettings,
) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity_overlay::host_mode::DesktopActivityOverlayDisplayContext;
    use crate::activity_overlay::placement::Rect;

    fn display_context(
        is_macos: bool,
        is_builtin_display: bool,
        has_physical_notch: bool,
    ) -> DesktopActivityOverlayDisplayContext {
        DesktopActivityOverlayDisplayContext {
            is_macos,
            is_builtin_display,
            has_physical_notch,
            safe_area_top: 74.0,
            screen_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            visible_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 908.0,
            },
        }
    }

    #[test]
    fn macos_overlay_window_builder_defaults_prefer_transparent_titlebar_and_first_mouse() {
        let defaults = resolve_macos_overlay_window_builder_defaults(true)
            .expect("expected macOS builder defaults");

        assert!(defaults.accept_first_mouse);
        assert_eq!(defaults.title_bar_style, TitleBarStyle::Transparent);
        assert!(defaults.hidden_title);
        assert!(!defaults.shadow);
    }

    #[test]
    fn non_macos_overlay_window_builder_defaults_are_disabled() {
        assert_eq!(resolve_macos_overlay_window_builder_defaults(false), None);
    }

    #[test]
    fn notch_integrated_windows_get_workspace_visibility_support() {
        let settings = resolve_macos_overlay_window_host_settings(
            DesktopActivityOverlayHostMode::NotchIntegrated,
            Some(display_context(true, true, true)),
        )
        .expect("expected notch-integrated host settings");

        assert!(settings.visible_on_all_workspaces);
        assert_eq!(settings.host_path, DesktopActivityOverlayMacHostPath::Panel);
        assert!(settings.prefer_accessory_activation_policy);
        assert!(!settings.shadow);
        assert!(settings.full_screen_auxiliary);
        assert!(settings.stationary);
        assert!(settings.ignores_cycle);
        assert!(settings.nonactivating_panel);
        assert!(!settings.opaque);
        assert_eq!(
            settings.window_level_override,
            Some(DesktopActivityOverlayMacWindowLevelOverride::NotchPanel)
        );
    }

    #[test]
    fn floating_windows_disable_workspace_visibility_but_keep_shadowless_hosting() {
        let settings = resolve_macos_overlay_window_host_settings(
            DesktopActivityOverlayHostMode::Floating,
            Some(display_context(true, true, true)),
        )
        .expect("expected floating host settings on macOS");

        assert!(!settings.visible_on_all_workspaces);
        assert_eq!(
            settings.host_path,
            DesktopActivityOverlayMacHostPath::Window
        );
        assert!(!settings.prefer_accessory_activation_policy);
        assert!(!settings.shadow);
        assert!(!settings.full_screen_auxiliary);
        assert!(!settings.stationary);
        assert!(!settings.ignores_cycle);
        assert!(!settings.nonactivating_panel);
        assert!(!settings.opaque);
        assert_eq!(settings.window_level_override, None);
    }

    #[test]
    fn non_macos_display_contexts_do_not_enable_host_settings() {
        assert_eq!(
            resolve_macos_overlay_window_host_settings(
                DesktopActivityOverlayHostMode::NotchIntegrated,
                Some(display_context(false, true, true)),
            ),
            None
        );
    }

    #[test]
    fn notch_integrated_panel_hosts_skip_the_raw_nswindow_collection_behavior_path() {
        let settings = resolve_macos_overlay_window_host_settings(
            DesktopActivityOverlayHostMode::NotchIntegrated,
            Some(display_context(true, true, true)),
        )
        .expect("expected notch-integrated host settings");

        assert!(!should_apply_raw_macos_overlay_window_collection_behavior(
            settings
        ));
    }

    #[test]
    fn floating_hosts_keep_the_raw_nswindow_collection_behavior_path() {
        let settings = resolve_macos_overlay_window_host_settings(
            DesktopActivityOverlayHostMode::Floating,
            Some(display_context(true, true, true)),
        )
        .expect("expected floating host settings");

        assert!(should_apply_raw_macos_overlay_window_collection_behavior(
            settings
        ));
    }
}
