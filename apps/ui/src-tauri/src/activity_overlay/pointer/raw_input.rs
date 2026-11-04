//! Win32 permits only one raw mouse target per process. Share its lifetime across overlays.
#[derive(Default)]
pub struct RawInputSink {
    target: Option<isize>,
    engaged: std::collections::BTreeSet<isize>,
    outside_press: std::collections::BTreeSet<isize>,
}

impl RawInputSink {
    pub fn is_engaged(&self, hwnd: isize) -> bool {
        self.engaged.contains(&hwnd) || self.outside_press.contains(&hwnd)
    }

    pub fn set_outside_press<E>(&mut self, hwnd: isize, wanted: bool,
        register: impl FnMut(Option<isize>) -> Result<(), E>) -> Result<(), E> {
        let previous = self.outside_press.contains(&hwnd);
        if wanted { self.outside_press.insert(hwnd); } else { self.outside_press.remove(&hwnd); }
        if let Err(error) = self.reconcile(register) {
            if previous { self.outside_press.insert(hwnd); } else { self.outside_press.remove(&hwnd); }
            return Err(error);
        }
        Ok(())
    }

    pub fn set_engaged<E>(
        &mut self,
        hwnd: isize,
        engaged: bool,
        register: impl FnMut(Option<isize>) -> Result<(), E>,
    ) -> Result<(), E> {
        let previous = self.engaged.contains(&hwnd);
        if engaged {
            self.engaged.insert(hwnd);
        } else {
            self.engaged.remove(&hwnd);
        }
        if let Err(error) = self.reconcile(register) {
            if previous {
                self.engaged.insert(hwnd);
            } else {
                self.engaged.remove(&hwnd);
            }
            return Err(error);
        }
        Ok(())
    }

    pub fn observe<E>(
        &mut self,
        hwnd: isize,
        inside: bool,
        register: impl FnMut(Option<isize>) -> Result<(), E>,
    ) -> Result<(), E> {
        if !inside {
            self.set_engaged(hwnd, false, register)?;
        }
        Ok(())
    }

    fn reconcile<E>(
        &mut self,
        mut register: impl FnMut(Option<isize>) -> Result<(), E>,
    ) -> Result<(), E> {
        let next = self
            .target
            .filter(|target| self.is_engaged(*target))
            .or_else(|| self.engaged.first().or(self.outside_press.first()).copied());
        if next == self.target {
            return Ok(());
        }
        register(next)?;
        self.target = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_notch_retains_the_shared_sink_after_pointer_leave_until_collapse() {
        let mut sink = RawInputSink::default();
        let mut registrations = vec![];
        for _ in 0..50 {
            sink.set_outside_press(7, true, |target| { registrations.push(target); Ok::<_, ()>(()) }).unwrap();
            sink.observe(7, false, |target| { registrations.push(target); Ok::<_, ()>(()) }).unwrap();
            assert!(sink.is_engaged(7));
            sink.set_outside_press(7, false, |target| { registrations.push(target); Ok::<_, ()>(()) }).unwrap();
            assert!(!sink.is_engaged(7));
        }
        assert_eq!(registrations.len(), 100, "one install/removal per expansion, no reinstall on leave");
    }

    #[test]
    fn short_notch_crossings_stop_without_any_presentation_command_and_keep_pet_demand() {
        let mut sink = RawInputSink::default();
        let mut registrations = vec![];
        for _ in 0..3 {
            sink.set_engaged(7, true, |target| {
                registrations.push(target);
                Ok::<_, ()>(())
            })
            .unwrap();
            sink.observe(7, false, |target| {
                registrations.push(target);
                Ok::<_, ()>(())
            })
            .unwrap();
            assert!(
                !sink.is_engaged(7),
                "native notch leave ends hover demand without a present call"
            );
        }
        assert_eq!(
            registrations,
            vec![Some(7), None, Some(7), None, Some(7), None]
        );
        sink.set_engaged(9, true, |target| {
            registrations.push(target);
            Ok::<_, ()>(())
        })
        .unwrap();
        sink.set_engaged(7, true, |target| {
            registrations.push(target);
            Ok::<_, ()>(())
        })
        .unwrap();
        sink.observe(7, false, |target| {
            registrations.push(target);
            Ok::<_, ()>(())
        })
        .unwrap();
        assert!(sink.is_engaged(9));
        assert_eq!(
            registrations.last(),
            Some(&Some(9)),
            "notch leave preserves the pet's one native sink"
        );
        sink.observe(9, false, |target| {
            registrations.push(target);
            Ok::<_, ()>(())
        })
        .unwrap();
        assert_eq!(registrations.last(), Some(&None));
    }

    #[test]
    fn raw_input_is_installed_per_engagement_and_shared_with_the_pet() {
        let mut sink = RawInputSink::default();
        let mut registrations = vec![];
        let mut register = |target| {
            registrations.push(target);
            Ok::<_, ()>(())
        };
        for _ in 0..1000 {
            sink.set_engaged(7, false, &mut register).unwrap();
        }
        assert!(
            registrations.is_empty(),
            "resting windows perform zero raw-input installation work"
        );
        for _ in 0..50 {
            sink.set_engaged(7, true, |target| {
                registrations.push(target);
                Ok::<_, ()>(())
            })
            .unwrap();
            sink.set_engaged(9, true, |target| {
                registrations.push(target);
                Ok::<_, ()>(())
            })
            .unwrap();
            sink.set_engaged(9, false, |target| {
                registrations.push(target);
                Ok::<_, ()>(())
            })
            .unwrap();
            sink.set_engaged(7, false, |target| {
                registrations.push(target);
                Ok::<_, ()>(())
            })
            .unwrap();
        }
        assert_eq!(
            registrations.len(),
            100,
            "one install and one removal per real engagement, with no second pet sink"
        );
        assert_eq!(registrations[0..2], [Some(7), None]);
    }
}
