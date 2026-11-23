//! Native setup ordering and the distinction between optional integrations and a usable shell.

use crate::tray::model::MenuPlatform as Platform;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Log,
    Autostart,
    Tray,
    MainWindow,
    ActivityOverlay,
    Updater,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Unavailable {
    pub capability: Step,
    pub reason: String,
}

/// The callback is the native registration boundary; all startup paths use this ordering.
pub fn setup<E: std::fmt::Display>(
    platform: Platform,
    menu_bar_launch: bool,
    mut register: impl FnMut(Step) -> Result<(), E>,
) -> Result<Vec<Unavailable>, E> {
    let mut unavailable = Vec::new();
    for step in [
        Step::Log,
        Step::Autostart,
        Step::Tray,
        Step::MainWindow,
        Step::ActivityOverlay,
        Step::Updater,
    ] {
        if let Err(error) = register(step) {
            // Windows/Linux have no app menu; a tray-only login has no window either.
            // Those trays and actual window creation are required to keep Quit reachable.
            if step == Step::MainWindow
                || (step == Step::Tray && (platform != Platform::MacOs || menu_bar_launch))
            {
                return Err(error);
            }
            unavailable.push(Unavailable {
                capability: step,
                reason: error.to_string(),
            });
        }
    }
    Ok(unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_native_failures_settle_with_reasons_and_still_create_the_main_window() {
        for platform in [Platform::MacOs, Platform::Windows, Platform::Linux] {
            let mut reached = Vec::new();
            let result = setup(platform, false, |step| {
                reached.push(step);
                match step {
                    Step::Log | Step::Autostart | Step::Updater => {
                        Err("native integration unavailable")
                    }
                    _ => Ok(()),
                }
            })
            .expect("optional failures must allow Ready");
            assert_eq!(
                reached,
                [
                    Step::Log,
                    Step::Autostart,
                    Step::Tray,
                    Step::MainWindow,
                    Step::ActivityOverlay,
                    Step::Updater,
                ]
            );
            assert_eq!(
                result,
                [Step::Log, Step::Autostart, Step::Updater].map(|capability| Unavailable {
                    capability,
                    reason: "native integration unavailable".into(),
                })
            );
        }
    }

    #[test]
    fn macos_app_menu_keeps_quit_reachable_when_optional_tray_setup_fails() {
        let mut window_created = false;
        let result = setup(Platform::MacOs, false, |step| {
            if step == Step::MainWindow {
                window_created = true;
            }
            if step == Step::Tray {
                Err("tray unavailable")
            } else {
                Ok(())
            }
        })
        .expect("the macOS app menu owns Quit independently of the tray");
        assert!(window_created);
        assert_eq!(
            result,
            vec![Unavailable {
                capability: Step::Tray,
                reason: "tray unavailable".into()
            }]
        );
    }

    #[test]
    fn a_required_quit_surface_or_main_window_failure_remains_fatal() {
        for (platform, menu_bar) in [
            (Platform::Windows, false),
            (Platform::Linux, false),
            (Platform::MacOs, true),
        ] {
            assert!(setup(platform, menu_bar, |step| {
                if step == Step::Tray {
                    Err("no Quit surface")
                } else {
                    Ok(())
                }
            })
            .is_err());
        }
        for platform in [Platform::MacOs, Platform::Windows, Platform::Linux] {
            assert!(setup(platform, false, |step| {
                if step == Step::MainWindow {
                    Err("window creation failed")
                } else {
                    Ok(())
                }
            })
            .is_err());
        }
    }
}
