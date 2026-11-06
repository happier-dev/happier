/// Keep OS motion registrations only for a visible click-through interval.
pub fn update<T>(
    monitors: &mut Option<T>,
    visible: bool,
    ignores_mouse_events: bool,
    register: impl FnOnce() -> Result<T, String>,
) -> Result<(), String> {
    if !visible || !ignores_mouse_events { *monitors = None; }
    else if monitors.is_none() { *monitors = Some(register()?); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::update;
    use std::cell::Cell;

    struct Registration<'a>(&'a Cell<usize>);
    impl Drop for Registration<'_> {
        fn drop(&mut self) { self.0.set(self.0.get() - 2); }
    }

    #[test]
    fn reentry_removes_both_monitors_and_inside_motion_performs_no_registration() {
        let live = Cell::new(0);
        let registrations = Cell::new(0);
        let register = || {
            registrations.set(registrations.get() + 1);
            live.set(live.get() + 2);
            Ok(Registration(&live))
        };
        let mut monitors = None;
        for _ in 0..100 { update(&mut monitors, true, false, register).unwrap(); }
        assert_eq!(registrations.get(), 0, "an interactive island needs no system motion monitors");
        update(&mut monitors, true, true, register).unwrap();
        assert_eq!(live.get(), 2);
        for _ in 0..100 { update(&mut monitors, true, true, register).unwrap(); }
        assert_eq!(registrations.get(), 1, "outside moves reuse the current OS registrations");
        update(&mut monitors, true, false, register).unwrap();
        assert_eq!(live.get(), 0, "pointer reentry removes both OS registrations");
        update(&mut monitors, true, true, register).unwrap();
        assert_eq!(live.get(), 2, "a later exit installs the monitors again");
        drop(monitors);
        assert_eq!(live.get(), 0, "window teardown releases the remaining monitors");
    }

    #[test]
    fn hiding_outside_releases_motion_monitors_until_shown_and_reentry_still_releases_them() {
        let live = Cell::new(0);
        let registrations = Cell::new(0);
        let register = || {
            registrations.set(registrations.get() + 1);
            live.set(live.get() + 2);
            Ok(Registration(&live))
        };
        let mut monitors = None;
        update(&mut monitors, true, true, register).unwrap();
        assert_eq!(live.get(), 2);
        update(&mut monitors, false, true, register).unwrap();
        assert_eq!(live.get(), 0, "hiding outside must remove both OS motion registrations");
        for _ in 0..100 { update(&mut monitors, false, true, register).unwrap(); }
        assert_eq!(registrations.get(), 1, "hidden geometry or motion must not reinstall monitors");
        update(&mut monitors, true, true, register).unwrap();
        assert_eq!(live.get(), 2, "showing outside restores reentry tracking");
        update(&mut monitors, true, false, register).unwrap();
        assert_eq!(live.get(), 0, "reentry after showing releases both monitors");
    }
}
