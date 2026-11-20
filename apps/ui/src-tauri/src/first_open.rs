//! The opening's reveal choice is made at main's first content, using the events already received.

#[cfg(desktop)]
mod presentation;
#[cfg(desktop)]
pub(crate) use presentation::*;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Handoff {
    Preparing { play: bool, ready: bool },
    Playing,
    Swapped,
    #[default]
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FirstContent {
    Reveal,
    PlayOverlay,
}

impl Handoff {
    fn prepare() -> Self {
        Self::Preparing { play: false, ready: false }
    }

    fn decide(&mut self, play_overlay: bool) -> bool {
        let Self::Preparing { play, .. } = self else { return false };
        if !play_overlay {
            *self = Self::Closed;
            return false;
        }
        if *play { return false; }
        *play = true;
        true
    }

    fn overlay_ready(&mut self) {
        if let Self::Preparing { play: true, ready } = self {
            *ready = true;
        }
    }

    fn first_content(&mut self, has_welcome: bool, launch_has_focus: impl FnOnce() -> bool) -> FirstContent {
        if has_welcome && matches!(*self, Self::Preparing { play: true, ready: true }) && launch_has_focus() {
            *self = Self::Playing;
            FirstContent::PlayOverlay
        } else {
            *self = Self::Closed;
            FirstContent::Reveal
        }
    }

    fn swap(&mut self) -> bool {
        if *self != Self::Playing { return false; }
        *self = Self::Swapped;
        true
    }

    fn close(&mut self) -> bool {
        std::mem::replace(self, Self::Closed) == Self::Playing
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_painted_overlay_without_a_welcome_reveals_main_immediately() {
        let mut handoff = Handoff::prepare();
        assert!(handoff.decide(true));
        handoff.overlay_ready();
        assert_eq!(handoff.first_content(false, || panic!("no replica can be presented")), FirstContent::Reveal);
        assert!(!handoff.swap());
    }

    #[test]
    fn ready_overlay_owns_the_foreground_until_a_single_swap() {
        let mut handoff = Handoff::prepare();
        assert!(handoff.decide(true));
        handoff.overlay_ready();
        assert_eq!(handoff.first_content(true, || true), FirstContent::PlayOverlay);
        assert!(handoff.swap());
        assert!(!handoff.swap());
        assert!(!handoff.close());
    }

    #[test]
    fn main_content_reveals_immediately_and_discards_late_readiness() {
        let mut handoff = Handoff::prepare();
        assert!(handoff.decide(true));
        assert_eq!(handoff.first_content(true, || panic!("unready overlay needs no activation check")), FirstContent::Reveal);
        handoff.overlay_ready();
        assert_eq!(handoff, Handoff::Closed);
        assert!(!handoff.swap());
    }

    #[test]
    fn readiness_before_decision_and_background_launches_cannot_start_an_overlay() {
        let mut unprepared = Handoff::prepare();
        unprepared.overlay_ready();
        assert!(unprepared.decide(true));
        assert_eq!(unprepared.first_content(true, || true), FirstContent::Reveal);

        let mut background = Handoff::prepare();
        assert!(background.decide(true));
        background.overlay_ready();
        assert_eq!(background.first_content(true, || false), FirstContent::Reveal);
    }

    #[test]
    fn reduced_motion_or_in_app_routes_close_the_prepared_overlay() {
        let mut handoff = Handoff::prepare();
        assert!(!handoff.decide(false));
        assert_eq!(handoff, Handoff::Closed);
        assert!(!handoff.decide(true));
    }

    #[test]
    fn interrupted_playing_reveals_whereas_destroy_after_swap_does_not() {
        let mut handoff = Handoff::prepare();
        assert!(handoff.decide(true));
        handoff.overlay_ready();
        assert_eq!(handoff.first_content(true, || true), FirstContent::PlayOverlay);
        assert!(handoff.close());
        assert!(!handoff.close());
    }
}
