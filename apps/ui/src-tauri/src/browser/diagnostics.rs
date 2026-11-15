use std::collections::VecDeque;

// Existing per-view retention policy. Its resource derivation remains an owner decision;
// keep the current bounds while making every omission observable at the drain boundary.
pub(super) const DESKTOP_BROWSER_DIAGNOSTICS_BUFFER_CAP: usize = 2000;
pub(super) const DESKTOP_BROWSER_DIAGNOSTICS_BYTES_CAP: usize = 8 * 1024 * 1024;
pub(super) const DESKTOP_BROWSER_DIAGNOSTICS_MAX_MESSAGE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Default)]
pub(crate) struct DiagnosticsQueue {
    entries: VecDeque<String>,
    buffered_bytes: usize,
    dropped_message_count: usize,
}

impl DiagnosticsQueue {
    pub(super) fn record(&mut self, message: String) {
        let bytes = message.len();
        if bytes > DESKTOP_BROWSER_DIAGNOSTICS_MAX_MESSAGE_BYTES {
            self.dropped_message_count += 1;
            return;
        }
        self.buffered_bytes += bytes;
        self.entries.push_back(message);
        while self.entries.len() > DESKTOP_BROWSER_DIAGNOSTICS_BUFFER_CAP
            || self.buffered_bytes > DESKTOP_BROWSER_DIAGNOSTICS_BYTES_CAP
        {
            if let Some(dropped) = self.entries.pop_front() {
                self.buffered_bytes -= dropped.len();
                self.dropped_message_count += 1;
            }
        }
    }

    pub(super) fn drain(&mut self) -> (Vec<String>, usize) {
        self.buffered_bytes = 0;
        (
            self.entries.drain(..).collect(),
            std::mem::take(&mut self.dropped_message_count),
        )
    }
}
