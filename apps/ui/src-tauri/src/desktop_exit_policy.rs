//! The quit decisions, pure (no tauri types) so every branch is tested.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DesktopExitAction {
    /// Native setup or component removal must finish before the process can exit.
    WaitForSystemTasks,
    /// Stop observation and await the native writer before deciding whether to exit.
    FinalizeRecording,
    /// A previous Quit is still waiting for native writer completion.
    WaitForRecording,
    /// Hold the exit and let the webview decide what to do with the background services.
    HandOffToWebview,
    /// Quit now.
    Exit,
    /// Hold the exit and keep the tray-only process: the last window went away because the app
    /// entered menu-bar mode, which is not a quit (R16 a).
    StayInMenuBar,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DesktopExitRequest {
    pub recording: RecordingExitState,
    /// Native activity still owns an executor process or is starting one.
    pub system_tasks_busy: bool,
    /// Whether there is still a webview to ask.
    pub webview_present: bool,
    /// Whether this quit already handed off once.
    pub handoff_used: bool,
    /// An update relaunch. The app is coming straight back, and `prevent_exit` is ignored for it
    /// anyway, so asking whether to stop the service would be both pointless and wrong.
    pub is_restart: bool,
    /// The app runs as a tray-only process (no window, no web UI).
    pub menu_bar_mode: bool,
    /// `app.exit(code)` asked for this exit (a Quit item); `false` when the runtime raised it
    /// because the last window was destroyed.
    pub explicit: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RecordingExitState {
    #[default]
    None,
    NeedsFinalization,
    Finalizing,
    Failed,
}

/// Finalize recording first, then one service handoff. A failed recording requires an explicit choice.
///
/// `handoff_used` is what keeps a quit from ever becoming unquittable: if the webview is wedged,
/// gone, or simply slow, pressing Quit again exits once recording and native system tasks have settled.
/// Nothing here waits on a timer. In menu-bar mode
/// only an explicit Quit exits; with no web UI there is nobody to hand off to, so it exits at once
/// and leaves every service exactly as it was. The menu router resolves the tray-only login-start
/// preference before requesting an exit, using the same Stop owner as explicit "stop and quit".
pub fn resolve_desktop_exit_action(request: DesktopExitRequest) -> DesktopExitAction {
    if request.is_restart {
        return DesktopExitAction::Exit;
    }
    if request.menu_bar_mode && !request.explicit {
        return DesktopExitAction::StayInMenuBar;
    }
    match request.recording {
        RecordingExitState::NeedsFinalization => return DesktopExitAction::FinalizeRecording,
        RecordingExitState::Finalizing => return DesktopExitAction::WaitForRecording,
        RecordingExitState::Failed => return DesktopExitAction::HandOffToWebview,
        RecordingExitState::None => {}
    }
    if request.system_tasks_busy {
        return DesktopExitAction::WaitForSystemTasks;
    }
    if request.handoff_used || !request.webview_present {
        return DesktopExitAction::Exit;
    }
    DesktopExitAction::HandOffToWebview
}

/// Which Quit the person chose, carried to the webview with the handoff.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum QuitIntent {
    /// "Quit Happier": follows the login-start setting.
    #[default]
    Quit,
    /// "Stop background services and quit".
    StopServices,
}

/// Tray-only Quit follows the one login-start setting. Unknown never authorizes a stop.
impl QuitIntent {
    pub fn for_menu_bar_quit(start_at_login: Option<bool>) -> Self {
        if start_at_login == Some(false) {
            Self::StopServices
        } else {
            Self::Quit
        }
    }
}

/// How the webview finished the handoff.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShutdownOutcome {
    Exit,
    RetryRecording,
    DiscardRecording,
    QuitRecording,
    /// Keep running in the menu bar: the login-start setting is on (R16 a).
    MenuBar,
}

/// Recording recovery choices extend the existing handoff. Missing/unknown outcomes preserve the
/// long-standing Exit request, which still passes through the recording policy.
pub fn parse_shutdown_outcome(value: Option<&str>) -> ShutdownOutcome {
    match value {
        Some("menuBar") => ShutdownOutcome::MenuBar,
        Some("recordingRetry") => ShutdownOutcome::RetryRecording,
        Some("recordingDiscard") => ShutdownOutcome::DiscardRecording,
        Some("recordingQuit") => ShutdownOutcome::QuitRecording,
        _ => ShutdownOutcome::Exit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> DesktopExitRequest {
        DesktopExitRequest {
            recording: RecordingExitState::None,
            system_tasks_busy: false,
            webview_present: true,
            handoff_used: false,
            is_restart: false,
            menu_bar_mode: false,
            explicit: true,
        }
    }

    #[test]
    fn native_system_tasks_hold_normal_quit_even_after_a_previous_handoff() {
        for handoff_used in [false, true] {
            for webview_present in [false, true] {
                assert_eq!(resolve_desktop_exit_action(DesktopExitRequest {
                    system_tasks_busy: true, handoff_used, webview_present, ..request()
                }), DesktopExitAction::WaitForSystemTasks);
            }
        }
    }

    #[test]
    fn native_activity_preserves_recording_finalization_before_quit() {
        for (recording, expected) in [
            (RecordingExitState::NeedsFinalization, DesktopExitAction::FinalizeRecording),
            (RecordingExitState::Finalizing, DesktopExitAction::WaitForRecording),
            (RecordingExitState::Failed, DesktopExitAction::HandOffToWebview),
        ] {
            assert_eq!(resolve_desktop_exit_action(DesktopExitRequest {
                recording, system_tasks_busy: true, handoff_used: true, ..request()
            }), expected);
        }
    }

    #[test]
    fn quit_finalizes_recording_even_without_a_webview_or_after_an_earlier_handoff() {
        for (webview_present, handoff_used) in [(true, false), (false, false), (true, true)] {
            assert_eq!(resolve_desktop_exit_action(DesktopExitRequest {
                recording: RecordingExitState::NeedsFinalization,
                webview_present, handoff_used, ..request()
            }), DesktopExitAction::FinalizeRecording);
        }
    }

    #[test]
    fn repeated_quit_waits_for_the_same_writer_and_failed_finish_requires_a_choice() {
        assert_eq!(resolve_desktop_exit_action(DesktopExitRequest {
            recording: RecordingExitState::Finalizing, handoff_used: true, ..request()
        }), DesktopExitAction::WaitForRecording);
        assert_eq!(resolve_desktop_exit_action(DesktopExitRequest {
            recording: RecordingExitState::Failed, handoff_used: true, ..request()
        }), DesktopExitAction::HandOffToWebview);
    }

    #[test]
    fn window_destruction_in_menu_bar_mode_does_not_stop_recording() {
        assert_eq!(resolve_desktop_exit_action(DesktopExitRequest {
            recording: RecordingExitState::NeedsFinalization,
            menu_bar_mode: true, explicit: false, ..request()
        }), DesktopExitAction::StayInMenuBar);
    }

    #[test]
    fn tray_quit_stops_services_only_when_login_start_is_known_off() {
        assert_eq!(
            QuitIntent::for_menu_bar_quit(Some(false)),
            QuitIntent::StopServices
        );
        assert_eq!(QuitIntent::for_menu_bar_quit(Some(true)), QuitIntent::Quit);
        assert_eq!(QuitIntent::for_menu_bar_quit(None), QuitIntent::Quit);
    }

    #[test]
    fn a_live_webview_gets_one_chance_to_decide() {
        assert_eq!(
            resolve_desktop_exit_action(request()),
            DesktopExitAction::HandOffToWebview
        );
    }

    #[test]
    fn quitting_again_exits_instead_of_asking_twice() {
        assert_eq!(
            resolve_desktop_exit_action(DesktopExitRequest {
                handoff_used: true,
                ..request()
            }),
            DesktopExitAction::Exit
        );
    }

    #[test]
    fn an_exit_with_nobody_to_ask_never_touches_the_background_service() {
        // No webview means no decision and no stop command: the daemon is left running.
        assert_eq!(
            resolve_desktop_exit_action(DesktopExitRequest {
                webview_present: false,
                ..request()
            }),
            DesktopExitAction::Exit
        );
    }

    #[test]
    fn an_update_relaunch_never_asks_about_the_background_service() {
        assert_eq!(
            resolve_desktop_exit_action(DesktopExitRequest {
                is_restart: true,
                system_tasks_busy: true,
                ..request()
            }),
            DesktopExitAction::Exit
        );
        assert_eq!(
            resolve_desktop_exit_action(DesktopExitRequest {
                is_restart: true,
                menu_bar_mode: true,
                explicit: false,
                ..request()
            }),
            DesktopExitAction::Exit
        );
    }

    #[test]
    fn destroying_the_last_window_for_menu_bar_mode_keeps_the_tray_process() {
        assert_eq!(
            resolve_desktop_exit_action(DesktopExitRequest {
                webview_present: false,
                menu_bar_mode: true,
                explicit: false,
                ..request()
            }),
            DesktopExitAction::StayInMenuBar
        );
    }

    #[test]
    fn quit_from_the_menu_bar_exits_at_once_and_leaves_the_services_as_they_are() {
        assert_eq!(
            resolve_desktop_exit_action(DesktopExitRequest {
                webview_present: false,
                menu_bar_mode: true,
                ..request()
            }),
            DesktopExitAction::Exit
        );
    }

    #[test]
    fn only_an_explicit_menu_bar_answer_keeps_the_tray() {
        assert_eq!(
            parse_shutdown_outcome(Some("menuBar")),
            ShutdownOutcome::MenuBar
        );
        assert_eq!(parse_shutdown_outcome(Some("exit")), ShutdownOutcome::Exit);
        assert_eq!(parse_shutdown_outcome(None), ShutdownOutcome::Exit);
    }
}
