#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct DesktopActivityOverlayDisplayChangeDebounce {
    pending_since_epoch_ms: Option<u64>,
}

impl DesktopActivityOverlayDisplayChangeDebounce {
    pub(crate) fn record_display_change(&mut self, now_epoch_ms: u64) {
        self.pending_since_epoch_ms = Some(now_epoch_ms);
    }

    pub(crate) fn resolve_ready_action(
        &mut self,
        now_epoch_ms: u64,
        debounce_ms: u64,
    ) -> Option<()> {
        let pending_since_epoch_ms = self.pending_since_epoch_ms?;
        if now_epoch_ms.saturating_sub(pending_since_epoch_ms) < debounce_ms {
            return None;
        }

        self.pending_since_epoch_ms = None;
        Some(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn display_change_debounce_waits_and_extends_without_presentation_changes() {
        let mut debounce = DesktopActivityOverlayDisplayChangeDebounce::default();
        debounce.record_display_change(1000);
        assert_eq!(debounce.resolve_ready_action(1499, 500), None);
        debounce.record_display_change(1300);
        assert_eq!(debounce.resolve_ready_action(1799, 500), None);
        assert_eq!(debounce.resolve_ready_action(1800, 500), Some(()));
        assert_eq!(debounce.resolve_ready_action(1801, 500), None);
    }
}
