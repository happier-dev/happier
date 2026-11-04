//! Main-window reveal intent. Geometry and a loaded HTML document do not establish rendered content.
#[derive(Default)]
pub(crate) struct MainWindowPresentation {
    rendered: bool,
    requested: bool,
}

impl MainWindowPresentation {
    pub(crate) fn request_show(&mut self) -> bool {
        self.requested = true;
        self.rendered
    }

    pub(crate) fn content_rendered(&mut self) -> bool {
        let reveal = !self.rendered && self.requested;
        self.rendered = true;
        reveal
    }

    pub(crate) fn loading(&mut self, visible: bool) {
        self.requested = if self.rendered { visible } else { self.requested || visible };
        self.rendered = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_and_reopen_wait_for_content_then_reveal_once() {
        let mut presentation = MainWindowPresentation::default();
        assert!(!presentation.request_show(), "a blank transparent window must stay hidden");
        assert!(!presentation.request_show());
        assert!(presentation.content_rendered());
        presentation.loading(false);
        assert!(!presentation.content_rendered(), "reloading a hidden window must not reopen it");
        assert!(!presentation.content_rendered(), "repeated layouts must not steal focus");
        assert!(presentation.request_show(), "rendered windows can be reopened");
    }

    #[test]
    fn hidden_boot_stays_hidden_and_reload_requires_new_content() {
        let mut presentation = MainWindowPresentation::default();
        assert!(!presentation.content_rendered());
        assert!(presentation.request_show());
        presentation.loading(true);
        assert!(!presentation.request_show(), "reload cannot expose an empty webview");
        assert!(presentation.content_rendered());
    }
}
