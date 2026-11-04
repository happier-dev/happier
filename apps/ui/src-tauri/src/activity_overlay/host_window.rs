use tauri::TitleBarStyle;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct DesktopActivityOverlayMacWindowBuilderDefaults {
    pub(crate) accept_first_mouse: bool,
    pub(crate) title_bar_style: TitleBarStyle,
    pub(crate) hidden_title: bool,
    pub(crate) shadow: bool,
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
