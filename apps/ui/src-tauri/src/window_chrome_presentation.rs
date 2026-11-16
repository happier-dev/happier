//! Main-window reveal intent. Geometry and a loaded HTML document do not establish rendered content.

/// Who asked for the main window. `User`: the Dock, the app icon or launching it again, a tray or
/// menu item, a shortcut, a notification click. `App`: the app itself (its launch reveal, which a
/// login item or `open -g` starts in the background, a restored window, a renderer request).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MainWindowRevealRequest {
    User,
    App,
}

/// A reveal takes keyboard focus only when the user asked for the window, or when Happier is
/// already the active app (focus then moves inside Happier). Otherwise it must not take focus from
/// the app the user is working in.
pub(crate) fn reveal_takes_focus(request: MainWindowRevealRequest, app_active: bool) -> bool {
    request == MainWindowRevealRequest::User || app_active
}

#[derive(Default)]
pub(crate) struct MainWindowPresentation {
    rendered: bool,
    requested: bool,
    user_requested: bool,
}

impl MainWindowPresentation {
    /// The window can be revealed now (its content is rendered): returns who asked.
    pub(crate) fn request_show(&mut self, request: MainWindowRevealRequest) -> Option<MainWindowRevealRequest> {
        self.requested = true;
        if self.rendered {
            self.user_requested = false;
            return Some(request);
        }
        self.user_requested |= request == MainWindowRevealRequest::User;
        None
    }

    /// The first rendered content reveals a requested window: returns who asked, `User` when any
    /// request since the last reveal came from the user.
    pub(crate) fn content_rendered(&mut self) -> Option<MainWindowRevealRequest> {
        let reveal = !self.rendered && self.requested;
        self.rendered = true;
        if !reveal {
            return None;
        }
        let by_user = std::mem::take(&mut self.user_requested);
        Some(if by_user { MainWindowRevealRequest::User } else { MainWindowRevealRequest::App })
    }

    pub(crate) fn loading(&mut self, visible: bool) {
        self.requested = if self.rendered { visible } else { self.requested || visible };
        self.rendered = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use MainWindowRevealRequest::{App, User};

    #[test]
    fn startup_and_reopen_wait_for_content_then_reveal_once() {
        let mut presentation = MainWindowPresentation::default();
        assert!(presentation.request_show(App).is_none(), "a blank transparent window must stay hidden");
        assert!(presentation.request_show(App).is_none());
        assert!(presentation.content_rendered().is_some());
        presentation.loading(false);
        assert!(presentation.content_rendered().is_none(), "reloading a hidden window must not reopen it");
        assert!(presentation.content_rendered().is_none(), "repeated layouts must not steal focus");
        assert!(presentation.request_show(User).is_some(), "rendered windows can be reopened");
    }

    #[test]
    fn hidden_boot_stays_hidden_and_reload_requires_new_content() {
        let mut presentation = MainWindowPresentation::default();
        assert!(presentation.content_rendered().is_none());
        assert!(presentation.request_show(App).is_some());
        presentation.loading(true);
        assert!(presentation.request_show(App).is_none(), "reload cannot expose an empty webview");
        assert!(presentation.content_rendered().is_some());
    }

    #[test]
    fn a_background_launch_reveals_without_the_user_and_a_user_request_is_kept_until_the_reveal() {
        // A login item or `open -g` launch: only the app asked.
        let mut background = MainWindowPresentation::default();
        background.request_show(App);
        assert_eq!(background.content_rendered(), Some(App));
        // The Dock clicked while the first content is still rendering.
        let mut reopened = MainWindowPresentation::default();
        reopened.request_show(App);
        reopened.request_show(User);
        assert_eq!(reopened.content_rendered(), Some(User));
        // Once revealed, a later app request does not inherit that user request.
        reopened.loading(true);
        reopened.request_show(App);
        assert_eq!(reopened.content_rendered(), Some(App));
        assert_eq!(reopened.request_show(App), Some(App));
    }

    #[test]
    fn only_the_user_or_an_already_active_happier_moves_focus() {
        assert!(!reveal_takes_focus(App, false), "a background reveal must not take focus from another app");
        assert!(reveal_takes_focus(App, true));
        assert!(reveal_takes_focus(User, false));
        assert!(reveal_takes_focus(User, true));
    }
}
