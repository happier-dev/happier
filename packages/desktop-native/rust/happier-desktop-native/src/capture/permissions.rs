//! Permission facts belong to the executing desktop process, never a remote Machine.
use serde::{Deserialize, Serialize, ser::SerializeStruct};
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionState {
    Granted, RequestRequired, Denied, RestartRequired, Unknown,
    NotRequired, PerRequest, Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionSubject { Screen, WindowText }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSnapshot {
    pub screen: PermissionState,
    pub window_text: PermissionState,
}

impl Serialize for PermissionSnapshot {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct RecoveryActions { screen: &'static [RecoveryAction], window_text: &'static [RecoveryAction] }
        let actions = |state| match state {
            PermissionState::RestartRequired => &[RecoveryAction::Reopen, RecoveryAction::OpenSettings][..],
            PermissionState::Denied | PermissionState::RequestRequired => &[RecoveryAction::OpenSettings][..],
            PermissionState::Granted | PermissionState::Unknown | PermissionState::NotRequired
                | PermissionState::PerRequest | PermissionState::Unavailable => &[][..],
        };
        let mut snapshot = serializer.serialize_struct("PermissionSnapshot", 3)?;
        snapshot.serialize_field("screen", &self.screen)?;
        snapshot.serialize_field("windowText", &self.window_text)?;
        snapshot.serialize_field("recoveryActions", &RecoveryActions {
            screen: actions(self.screen), window_text: actions(self.window_text),
        })?;
        snapshot.end()
    }
}

/// The only substituted boundary in permission tests: native OS permission calls.
pub trait PermissionBackend {
    fn read(&self) -> PermissionSnapshot;
    fn request(&self, subject: PermissionSubject) -> PermissionState;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryAction { None, OpenSettings, Reopen }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub snapshot: PermissionSnapshot,
    pub recovery: RecoveryAction,
    #[serde(skip)]
    pub changed: bool,
}

pub struct PermissionObservation { pub snapshot: PermissionSnapshot, pub changed: bool }

/// Demand lasts only while a permission presenter is consumed. No provider,
/// filesystem access, grant probe or timer is created by default construction.
#[derive(Default)]
pub struct PermissionOwner {
    consumers: HashSet<(String, u64)>,
    snapshot: Option<PermissionSnapshot>,
    requested: HashSet<PermissionSubject>,
    settings_opened: HashSet<PermissionSubject>,
}

impl PermissionOwner {
    /// Record only a successful native Settings-open operation, not its intent.
    /// The next consumed activation/read can then explain a stale macOS preflight.
    /// RestartRequired means reopen to apply, or allow in Settings; it is not
    /// evidence that the person actually enabled the permission there.
    pub fn settings_opened(&mut self, subject: PermissionSubject) {
        self.settings_opened.insert(subject);
    }

    pub fn set_consumed(&mut self, window: String, subscription_ref: u64, consumed: bool) {
        if consumed { self.consumers.insert((window, subscription_ref)); }
        else { self.consumers.remove(&(window, subscription_ref)); }
    }

    pub fn remove_window(&mut self, window: &str) {
        self.consumers.retain(|(label, _)| label != window);
    }

    pub fn consuming_windows(&self) -> HashSet<&str> {
        self.consumers.iter().map(|(label, _)| label.as_str()).collect()
    }

    fn observe(&mut self, snapshot: PermissionSnapshot) -> PermissionObservation {
        let changed = self.snapshot != Some(snapshot);
        self.snapshot = Some(snapshot);
        PermissionObservation { snapshot, changed }
    }

    pub fn read(&mut self, backend: &dyn PermissionBackend) -> PermissionObservation {
        let mut snapshot = backend.read();
        // macOS preflight cannot distinguish an unrequested grant from a known
        // refusal/restart. Preserve the request's actual outcome until granted.
        if let Some(previous) = self.snapshot {
            let preserve = |current, previous| {
                if current == PermissionState::RequestRequired
                    && matches!(previous, PermissionState::Denied | PermissionState::RestartRequired) {
                    previous
                } else { current }
            };
            snapshot.screen = preserve(snapshot.screen, previous.screen);
            snapshot.window_text = preserve(snapshot.window_text, previous.window_text);
        }
        let after_settings = |subject, status| {
            if self.settings_opened.contains(&subject) && status != PermissionState::Granted {
                PermissionState::RestartRequired
            } else { status }
        };
        snapshot.screen = after_settings(PermissionSubject::Screen, snapshot.screen);
        snapshot.window_text = after_settings(PermissionSubject::WindowText, snapshot.window_text);
        self.observe(snapshot)
    }

    pub fn refresh_consumed(&mut self, backend: &dyn PermissionBackend) -> Option<PermissionSnapshot> {
        if self.consumers.is_empty() { return None; }
        let observed = self.read(backend);
        observed.changed.then_some(observed.snapshot)
    }

    pub fn request(&mut self, backend: &dyn PermissionBackend, subject: PermissionSubject) -> PermissionRequest {
        let previous = self.snapshot;
        let mut snapshot = self.read(backend).snapshot;
        let current = match subject { PermissionSubject::Screen => snapshot.screen,
            PermissionSubject::WindowText => snapshot.window_text };
        let recovery = match current {
            PermissionState::Denied | PermissionState::RestartRequired => RecoveryAction::OpenSettings,
            PermissionState::RequestRequired if self.requested.contains(&subject) => RecoveryAction::OpenSettings,
            _ => RecoveryAction::None,
        };
        let status = if current == PermissionState::RequestRequired && recovery == RecoveryAction::None {
            self.requested.insert(subject);
            backend.request(subject)
        } else { current };
        match subject { PermissionSubject::Screen => snapshot.screen = status,
            PermissionSubject::WindowText => snapshot.window_text = status }
        self.observe(snapshot);
        PermissionRequest { snapshot, recovery, changed: previous != Some(snapshot) }
    }
}

/// Direct permission APIs only. Constructing this adapter performs no probe,
/// accessibility provider initialization or native resource acquisition.
#[cfg(not(target_os = "linux"))]
pub struct NativePermissions;
#[cfg(target_os = "linux")]
pub struct NativePermissions { session: Option<super::linux::DesktopSession> }
#[cfg(target_os = "linux")]
impl NativePermissions {
    pub fn for_session(session: Option<super::linux::DesktopSession>) -> Self { Self { session } }
}
impl PermissionBackend for NativePermissions {
    fn read(&self) -> PermissionSnapshot {
        #[cfg(target_os = "linux")]
        let screen = match self.session {
            Some(super::linux::DesktopSession::X11) => PermissionState::NotRequired,
            Some(super::linux::DesktopSession::Wayland) => PermissionState::PerRequest,
            None => PermissionState::Unknown,
        };
        #[cfg(not(target_os = "linux"))]
        let screen = screen_permission();
        PermissionSnapshot { screen, window_text: text_permission() }
    }
    fn request(&self, subject: PermissionSubject) -> PermissionState {
        #[cfg(target_os = "linux")]
        if subject == PermissionSubject::Screen { return self.read().screen; }
        match subject { PermissionSubject::Screen => request_screen_permission(),
            PermissionSubject::WindowText => request_text_permission() }
    }
}

pub fn screen_permission() -> PermissionState {
    #[cfg(target_os = "macos")]
    { if unsafe { objc2_core_graphics::CGPreflightScreenCaptureAccess() } {
        PermissionState::Granted
    } else { PermissionState::RequestRequired } }
    #[cfg(target_os = "windows")]
    { PermissionState::NotRequired }
    // Linux access is target/backend-specific (X11 versus per-request portal),
    // so a process-wide grant cannot be inferred from DISPLAY or library presence.
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { PermissionState::Unknown }
}

pub fn request_screen_permission() -> PermissionState {
    #[cfg(target_os = "macos")]
    { if unsafe { objc2_core_graphics::CGRequestScreenCaptureAccess() } {
        if screen_permission() == PermissionState::Granted { PermissionState::Granted }
        else { PermissionState::RestartRequired }
    } else { PermissionState::Denied } }
    #[cfg(not(target_os = "macos"))]
    { screen_permission() }
}

pub fn text_permission() -> PermissionState {
    #[cfg(target_os = "macos")]
    { if unsafe { macos::AXIsProcessTrusted() } != 0 { PermissionState::Granted }
        else { PermissionState::RequestRequired } }
    #[cfg(not(target_os = "macos"))]
    { PermissionState::Unknown }
}

pub fn request_text_permission() -> PermissionState {
    #[cfg(target_os = "macos")]
    { macos::request_text() }
    #[cfg(not(target_os = "macos"))]
    { text_permission() }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::PermissionState;
    use std::ffi::c_void;
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        pub fn AXIsProcessTrusted() -> u8;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> u8;
        static kAXTrustedCheckOptionPrompt: *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: *const c_void;
        fn CFDictionaryCreate(allocator: *const c_void, keys: *const *const c_void,
            values: *const *const c_void, count: isize, key_callbacks: *const c_void,
            value_callbacks: *const c_void) -> *const c_void;
        fn CFRelease(value: *const c_void);
    }
    pub fn request_text() -> PermissionState {
        unsafe {
            // Both entries are framework-owned constants; the dictionary lives
            // through the synchronous call and does not own its entries.
            let options = CFDictionaryCreate(std::ptr::null(), &kAXTrustedCheckOptionPrompt,
                &kCFBooleanTrue, 1, std::ptr::null(), std::ptr::null());
            if options.is_null() { return PermissionState::Unknown; }
            let trusted = AXIsProcessTrustedWithOptions(options) != 0;
            CFRelease(options);
            // AX prompting is asynchronous. False is not evidence of denial;
            // activation/Check again observes the eventual grant without polling.
            if trusted { PermissionState::Granted } else { PermissionState::RequestRequired }
        }
    }
}
