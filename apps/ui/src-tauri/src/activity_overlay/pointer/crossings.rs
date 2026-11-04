//! Changed pointer facts, shared by the notch and pet native adapters.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub inside: bool,
    pub x: f64,
    pub y: f64,
}

impl Sample {
    #[cfg(any(target_os = "macos", test))]
    pub fn from_bottom_left_hit_rect(
        frame: (f64, f64, f64, f64),
        hit_rect: (f64, f64, f64, f64),
        point: (f64, f64),
    ) -> Self {
        let sample = Self::from_bottom_left(frame, point);
        let inside = sample.inside
            && sample.x >= hit_rect.0 && sample.x <= hit_rect.0 + hit_rect.2
            && sample.y >= hit_rect.1 && sample.y <= hit_rect.1 + hit_rect.3;
        Self { inside, x: if inside { sample.x } else { 0. }, y: if inside { sample.y } else { 0. } }
    }

    #[cfg(any(target_os = "macos", test))]
    pub fn from_bottom_left(frame: (f64, f64, f64, f64), point: (f64, f64)) -> Self {
        let x = point.0 - frame.0;
        let y = frame.3 - (point.1 - frame.1);
        let inside = x >= 0.0 && y >= 0.0 && x <= frame.2 && y <= frame.3;
        Self {
            inside,
            x: if inside { x } else { 0.0 },
            y: if inside { y } else { 0.0 },
        }
    }
}

#[derive(Default)]
pub(super) struct Crossings {
    pub visible: bool,
    last: Option<Sample>,
}

impl Crossings {
    pub fn set_visible(&mut self, visible: bool) {
        self.visible = visible;
        if !visible {
            self.last = None;
        }
    }

    pub fn observe(&mut self, sample: Sample) -> Option<(bool, Sample)> {
        if !self.visible || self.last == Some(sample) {
            return None;
        }
        let crossing = self.last.map(|last| last.inside).unwrap_or(false) != sample.inside;
        self.last = Some(sample);
        Some((crossing, sample))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_animation_envelope_does_not_capture_the_band_outside_the_island() {
        let envelope = (0., 483., 1512., 48.);
        let island = (0., 0., 90., 48.);
        for x in [200., 756., 1490.] {
            assert!(!Sample::from_bottom_left_hit_rect(envelope, island, (x, 507.)).inside,
                "transparent animation envelope must pass through at screen x={x}");
        }
        let inside = Sample::from_bottom_left_hit_rect(envelope, island, (45., 507.));
        assert_eq!(inside, Sample { inside: true, x: 45., y: 24. });
        let expanded = (0., 0., 464., 869.);
        let envelope = (0., 80., 1512., 869.);
        assert!(Sample::from_bottom_left_hit_rect(envelope, expanded, (300., 500.)).inside);
        assert!(!Sample::from_bottom_left_hit_rect(envelope, expanded, (756., 500.)).inside);
        assert!(!Sample::from_bottom_left_hit_rect(envelope, island, (300., 925.)).inside,
            "closing must stop capturing the former expanded content area");
    }

    #[test]
    fn native_pet_points_keep_top_left_coordinates_and_clear_points_on_leave() {
        assert_eq!(
            Sample::from_bottom_left((100.0, 200.0, 300.0, 160.0), (124.0, 328.0)),
            Sample {
                inside: true,
                x: 24.0,
                y: 32.0
            }
        );
        assert_eq!(
            Sample::from_bottom_left((100.0, 200.0, 300.0, 160.0), (99.0, 328.0)),
            Sample {
                inside: false,
                x: 0.0,
                y: 0.0
            }
        );
    }

    #[test]
    fn crossings_publish_once_and_preserve_real_pet_motion_without_idle_work() {
        let mut pointer = Crossings::default();
        let enter = Sample {
            inside: true,
            x: 24.0,
            y: 32.0,
        };
        assert_eq!(
            pointer.observe(enter),
            None,
            "hidden windows cannot publish pointer facts"
        );
        pointer.set_visible(true);
        assert_eq!(pointer.observe(enter), Some((true, enter)));
        for _ in 0..1000 {
            assert_eq!(pointer.observe(enter), None);
        }
        let moved = Sample { x: 25.0, ..enter };
        assert_eq!(
            pointer.observe(moved),
            Some((false, moved)),
            "pet hit testing receives actual movement within the window"
        );
        let leave = Sample {
            inside: false,
            x: 0.0,
            y: 0.0,
        };
        assert_eq!(pointer.observe(leave), Some((true, leave)));
        assert_eq!(pointer.observe(leave), None);
        pointer.set_visible(false);
        for _ in 0..1000 {
            assert_eq!(pointer.observe(moved), None);
        }
        pointer.set_visible(true);
        assert_eq!(
            pointer.observe(enter),
            Some((true, enter)),
            "showing the same native window starts a fresh crossing"
        );
    }
}
