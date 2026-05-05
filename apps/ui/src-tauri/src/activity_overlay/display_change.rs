use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DesktopActivityOverlayOpenReason {
    Click,
    Hover,
    Notification,
    Boot,
    DisplayChanged,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DesktopActivityOverlayDisplayChangeAction {
    pub(crate) reopen_expanded: bool,
    pub(crate) open_reason: DesktopActivityOverlayOpenReason,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct DesktopActivityOverlayDisplayChangeDebounce {
    pending_since_epoch_ms: Option<u64>,
    reopen_expanded: bool,
}

impl DesktopActivityOverlayDisplayChangeDebounce {
    pub(crate) fn record_display_change(&mut self, now_epoch_ms: u64, was_expanded: bool) {
        self.pending_since_epoch_ms = Some(now_epoch_ms);
        self.reopen_expanded = self.reopen_expanded || was_expanded;
    }

    pub(crate) fn resolve_ready_action(
        &mut self,
        now_epoch_ms: u64,
        debounce_ms: u64,
    ) -> Option<DesktopActivityOverlayDisplayChangeAction> {
        let pending_since_epoch_ms = self.pending_since_epoch_ms?;
        if now_epoch_ms.saturating_sub(pending_since_epoch_ms) < debounce_ms {
            return None;
        }

        self.pending_since_epoch_ms = None;
        let reopen_expanded = self.reopen_expanded;
        self.reopen_expanded = false;
        Some(DesktopActivityOverlayDisplayChangeAction {
            reopen_expanded,
            open_reason: DesktopActivityOverlayOpenReason::DisplayChanged,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_change_debounce_waits_before_repositioning() {
        let mut state = DesktopActivityOverlayDisplayChangeDebounce::default();

        state.record_display_change(1_000, true);

        assert_eq!(state.resolve_ready_action(1_499, 500), None);
        assert_eq!(
            state.resolve_ready_action(1_500, 500),
            Some(DesktopActivityOverlayDisplayChangeAction {
                reopen_expanded: true,
                open_reason: DesktopActivityOverlayOpenReason::DisplayChanged,
            }),
        );
        assert_eq!(state.resolve_ready_action(1_501, 500), None);
    }

    #[test]
    fn display_change_debounce_extends_when_changes_keep_arriving() {
        let mut state = DesktopActivityOverlayDisplayChangeDebounce::default();

        state.record_display_change(1_000, true);
        state.record_display_change(1_300, false);

        assert_eq!(state.resolve_ready_action(1_799, 500), None);
        assert_eq!(
            state.resolve_ready_action(1_800, 500),
            Some(DesktopActivityOverlayDisplayChangeAction {
                reopen_expanded: true,
                open_reason: DesktopActivityOverlayOpenReason::DisplayChanged,
            }),
        );
    }

    #[test]
    fn display_change_debounce_clears_reopen_state_after_ready_action() {
        let mut state = DesktopActivityOverlayDisplayChangeDebounce::default();

        state.record_display_change(1_000, true);

        assert_eq!(
            state.resolve_ready_action(1_500, 500),
            Some(DesktopActivityOverlayDisplayChangeAction {
                reopen_expanded: true,
                open_reason: DesktopActivityOverlayOpenReason::DisplayChanged,
            }),
        );

        state.record_display_change(2_000, false);

        assert_eq!(
            state.resolve_ready_action(2_500, 500),
            Some(DesktopActivityOverlayDisplayChangeAction {
                reopen_expanded: false,
                open_reason: DesktopActivityOverlayOpenReason::DisplayChanged,
            }),
        );
    }
}
