#![cfg(feature = "capture")]
use happier_desktop_native::capture::permissions::*;
use std::cell::Cell;

struct Os { state: Cell<PermissionSnapshot>, reads: Cell<usize>, requests: Cell<usize>, request_result: Cell<PermissionState> }
impl Os {
    fn new() -> Self {
        Self { state: Cell::new(PermissionSnapshot { screen: PermissionState::Granted,
            window_text: PermissionState::RequestRequired }), reads: Cell::new(0), requests: Cell::new(0),
            request_result: Cell::new(PermissionState::Denied) }
    }
}
impl PermissionBackend for Os {
    fn read(&self) -> PermissionSnapshot {
        self.reads.set(self.reads.get()+1); self.state.get()
    }
    fn request(&self, _: PermissionSubject) -> PermissionState {
        self.requests.set(self.requests.get()+1); self.request_result.get()
    }
}

#[test]
fn hidden_permissions_make_no_probes_and_equal_activations_publish_nothing() {
    let os = Os::new(); let mut owner = PermissionOwner::default();
    assert_eq!(owner.refresh_consumed(&os), None);
    assert_eq!(os.reads.get(), 0);
    owner.set_consumed("capture".into(), 1, true);
    assert_eq!(owner.refresh_consumed(&os), Some(os.state.get()));
    assert_eq!(owner.refresh_consumed(&os), None);
    let granted = PermissionSnapshot { window_text: PermissionState::Granted, ..os.state.get() };
    os.state.set(granted);
    assert_eq!(owner.refresh_consumed(&os), Some(granted));
    assert_eq!(owner.refresh_consumed(&os), None);
    owner.set_consumed("capture".into(), 1, false);
    let before = os.reads.get();
    assert_eq!(owner.refresh_consumed(&os), None);
    assert_eq!(os.reads.get(), before);
    assert_eq!(os.requests.get(), 0);
}

#[test]
fn denial_recovers_through_settings_without_prompting_again_or_restarting() {
    let os = Os::new(); let mut owner = PermissionOwner::default();
    let first = owner.request(&os, PermissionSubject::WindowText);
    assert_eq!(first.snapshot.window_text, PermissionState::Denied);
    assert_eq!(first.recovery, RecoveryAction::None);
    let retry = owner.request(&os, PermissionSubject::WindowText);
    assert_eq!(retry.snapshot.window_text, PermissionState::Denied);
    assert_eq!(retry.recovery, RecoveryAction::OpenSettings);
    assert_eq!(os.requests.get(), 1);
    owner.set_consumed("settings".into(), 1, true);
    os.state.set(PermissionSnapshot { window_text: PermissionState::Granted, ..os.state.get() });
    assert_eq!(owner.refresh_consumed(&os).unwrap().window_text, PermissionState::Granted);
    assert_eq!(owner.request(&os, PermissionSubject::WindowText).snapshot.window_text, PermissionState::Granted);
    assert_eq!(os.requests.get(), 1);
}

#[test]
fn asynchronous_prompt_is_not_reported_as_denied_and_recovery_does_not_reprompt() {
    let os = Os::new(); let mut owner = PermissionOwner::default();
    os.request_result.set(PermissionState::RequestRequired);
    let first = owner.request(&os, PermissionSubject::WindowText);
    assert_eq!(first.snapshot.window_text, PermissionState::RequestRequired);
    assert_eq!(first.recovery, RecoveryAction::None);
    let retry = owner.request(&os, PermissionSubject::WindowText);
    assert_eq!(retry.snapshot.window_text, PermissionState::RequestRequired);
    assert_eq!(retry.recovery, RecoveryAction::OpenSettings);
    assert_eq!(os.requests.get(), 1);
}

#[test]
fn settings_recovery_then_activation_exposes_reopen_and_settings_until_a_fresh_process_is_granted() {
    for subject in [PermissionSubject::Screen, PermissionSubject::WindowText] {
        let os = Os::new();
        os.state.set(PermissionSnapshot { screen: PermissionState::RequestRequired,
            window_text: PermissionState::RequestRequired });
        let mut owner = PermissionOwner::default();
        let state = |snapshot: PermissionSnapshot| match subject {
            PermissionSubject::Screen => snapshot.screen, PermissionSubject::WindowText => snapshot.window_text,
        };
        assert_eq!(state(owner.request(&os, subject).snapshot), PermissionState::Denied);
        assert_eq!(owner.request(&os, subject).recovery, RecoveryAction::OpenSettings);
        // Substitute only the OS Settings-open completion; activation and its
        // permission observation/publication remain the real owner path.
        let reads = os.reads.get();
        owner.settings_opened(subject);
        assert_eq!(os.reads.get(), reads, "opening Settings creates no probe or polling work");
        owner.set_consumed("capture".into(), 1, true);
        let snapshot = owner.refresh_consumed(&os).expect("activation publishes the recovery change");
        assert_eq!(os.reads.get(), reads + 1, "activation reads the OS exactly once");
        assert_eq!(state(snapshot), PermissionState::RestartRequired);
        let key = match subject { PermissionSubject::Screen => "screen", PermissionSubject::WindowText => "windowText" };
        assert_eq!(serde_json::to_value(snapshot).unwrap()["recoveryActions"][key],
            serde_json::json!(["reopen", "open_settings"]));
        let other = match subject { PermissionSubject::Screen => snapshot.window_text, PermissionSubject::WindowText => snapshot.screen };
        assert_eq!(other, PermissionState::RequestRequired, "opening one pane cannot change the other subject");
        assert_eq!(owner.refresh_consumed(&os), None, "equal activations publish nothing");
        assert_eq!(os.requests.get(), 1, "recovery never repeats the native prompt");
        os.state.set(PermissionSnapshot { screen: PermissionState::Granted, window_text: PermissionState::Granted });
        let mut relaunched = PermissionOwner::default();
        let granted = relaunched.read(&os).snapshot;
        assert_eq!(state(granted), PermissionState::Granted);
        assert_eq!(serde_json::to_value(granted).unwrap()["recoveryActions"][key], serde_json::json!([]));
        assert_eq!(state(owner.refresh_consumed(&os).unwrap()), PermissionState::Granted,
            "an observable grant also wins in the current process");
    }
}

#[test]
fn closing_one_presenter_preserves_other_demand_and_destroying_a_window_releases_its_subscriptions() {
    let os = Os::new(); let mut owner = PermissionOwner::default();
    owner.set_consumed("main".into(), 1, true);
    owner.set_consumed("main".into(), 2, true);
    owner.set_consumed("capture".into(), 1, true);
    owner.refresh_consumed(&os);
    owner.set_consumed("main".into(), 1, false);
    owner.remove_window("main");
    os.state.set(PermissionSnapshot { window_text: PermissionState::Granted, ..os.state.get() });
    assert_eq!(owner.refresh_consumed(&os).unwrap().window_text, PermissionState::Granted);
    owner.remove_window("capture");
    let reads = os.reads.get();
    assert_eq!(owner.refresh_consumed(&os), None);
    assert_eq!(os.reads.get(), reads);
}
