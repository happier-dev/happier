//! One desktop-session shortcut backend; registration never initializes capture.
use super::{
    commands,
    preferences::{Bindings, CaptureBindingKey},
    CaptureState,
};
use happier_desktop_native::capture::CaptureError;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState as KeyState};

#[cfg(target_os = "linux")]
mod portal;

pub const SHORTCUT_EVENT: &str = "desktopCapture://shortcuts";
const KEYS: [CaptureBindingKey; 3] = [
    CaptureBindingKey::CaptureShortcut,
    CaptureBindingKey::InstantWindowShortcut,
    CaptureBindingKey::RecordingShortcut,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Backend {
    Native,
    Portal,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Pending,
    Ready,
    Unavailable,
    Closed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShortcutFailure {
    Invalid,
    Conflict,
    Unavailable,
    DesktopSettingsRequired,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBinding {
    pub key: CaptureBindingKey,
    pub requested: Option<String>,
    pub active: Option<String>,
    pub failure: Option<ShortcutFailure>,
    #[serde(skip)]
    suspended: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSnapshot {
    pub backend: Backend,
    pub availability: Availability,
    pub configure_supported: bool,
    pub editing: bool,
    pub bindings: Vec<ShortcutBinding>,
}
struct Shortcuts {
    snapshot: Mutex<ShortcutSnapshot>,
    editing: Arc<AtomicBool>,
    #[cfg(target_os = "linux")]
    portal: Mutex<Option<tokio::sync::mpsc::UnboundedSender<portal::Command>>>,
}

fn publish(app: &AppHandle, next: ShortcutSnapshot) {
    let state = app.state::<Shortcuts>();
    let mut current = state.snapshot.lock().unwrap();
    if *current != next {
        *current = next;
        notify(app, &current);
    }
}

fn notify(app: &AppHandle, snapshot: &ShortcutSnapshot) {
    let active = |key| {
        snapshot
            .bindings
            .iter()
            .find(|binding| binding.key == key)
            .and_then(|binding| binding.active.clone())
    };
    let capture = active(CaptureBindingKey::CaptureShortcut);
    let recording = active(CaptureBindingKey::RecordingShortcut);
    crate::tray::set_capture_shortcuts(app, capture, recording);
    let _ = app.emit(SHORTCUT_EVENT, snapshot);
}
pub fn snapshot(app: &AppHandle) -> ShortcutSnapshot {
    app.state::<Shortcuts>().snapshot.lock().unwrap().clone()
}

/// Called by Tauri setup on its main thread. Only preferences and the selected
/// shortcut backend are initialized; native registration itself runs off main.
pub fn install(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    let session = super::session::install(app);
    let backend = {
        #[cfg(target_os = "linux")]
        {
            if matches!(
                session,
                Ok(happier_desktop_native::capture::linux::DesktopSession::Wayland)
            ) {
                Backend::Portal
            } else {
                Backend::Native
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            Backend::Native
        }
    };
    let initial = ShortcutSnapshot {
        backend,
        availability: Availability::Pending,
        configure_supported: false,
        editing: false,
        bindings: KEYS
            .into_iter()
            .map(|key| ShortcutBinding {
                key,
                requested: None,
                active: None,
                failure: None,
                suspended: None,
            })
            .collect(),
    };
    if !app.manage(Shortcuts {
        snapshot: Mutex::new(initial),
        editing: Arc::new(AtomicBool::new(false)),
        #[cfg(target_os = "linux")]
        portal: Mutex::new(None),
    }) {
        return;
    }
    #[cfg(target_os = "linux")]
    if session.is_err() {
        unavailable(app, Availability::Unavailable);
        return;
    }
    let preferences =
        commands::with_preferences(app, &app.state::<CaptureState>(), |p| Ok(p.bindings()));
    let bindings = match preferences {
        Ok(bindings) => bindings,
        Err(_) => {
            unavailable(app, Availability::Unavailable);
            return;
        }
    };
    #[cfg(target_os = "linux")]
    if backend == Backend::Portal {
        portal::install(app, bindings);
        return;
    }
    if app
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .is_err()
    {
        unavailable(app, Availability::Unavailable);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut next = snapshot(&app);
        next.availability = Availability::Ready;
        for entry in &mut next.bindings {
            let mut binding = registration::Binding::default();
            binding.edit(
                bindings.get(entry.key).map(str::to_owned),
                &mut Native {
                    app: &app,
                    key: entry.key,
                },
            );
            project(entry, &binding);
        }
        publish(&app, next);
    });
}

fn unavailable(app: &AppHandle, availability: Availability) {
    let mut next = snapshot(app);
    next.availability = availability;
    for binding in &mut next.bindings {
        binding.active = None;
        binding.failure = Some(ShortcutFailure::Unavailable);
    }
    publish(app, next);
}

fn project(entry: &mut ShortcutBinding, binding: &registration::Binding) {
    entry.requested = binding.requested.clone();
    entry.active = binding.active.clone();
    entry.suspended = binding.suspended.clone();
    entry.failure = binding.failure.map(|failure| match failure {
        registration::Failure::Invalid => ShortcutFailure::Invalid,
        registration::Failure::Conflict => ShortcutFailure::Conflict,
        registration::Failure::Unavailable => ShortcutFailure::Unavailable,
    });
}

struct Native<'a> {
    app: &'a AppHandle,
    key: CaptureBindingKey,
}
impl registration::OsRegistration for Native<'_> {
    fn register(&mut self, chord: &str) -> Result<(), registration::Failure> {
        let shortcut = chord
            .parse::<Shortcut>()
            .map_err(|_| registration::Failure::Invalid)?;
        let editing = self.app.state::<Shortcuts>().editing.clone();
        let held = AtomicBool::new(false);
        let key = self.key;
        self.app
            .global_shortcut()
            .on_shortcut(shortcut, move |app, _, event| {
                if event.state == KeyState::Released {
                    held.store(false, Ordering::Release);
                    return;
                }
                if !held.swap(true, Ordering::AcqRel) && !editing.load(Ordering::Acquire) {
                    dispatch(app, key);
                }
            })
            .map_err(|_| registration::Failure::Conflict)
    }
    fn unregister(&mut self, chord: &str) -> Result<(), registration::Failure> {
        self.app
            .global_shortcut()
            .unregister(chord)
            .map_err(|_| registration::Failure::Unavailable)
    }
}
fn dispatch(app: &AppHandle, key: CaptureBindingKey) {
    use super::triggers::{self, CaptureIntent};
    let intent = match key {
        CaptureBindingKey::CaptureShortcut => CaptureIntent::Still,
        CaptureBindingKey::InstantWindowShortcut => CaptureIntent::Frontmost,
        CaptureBindingKey::RecordingShortcut => CaptureIntent::Recording,
    };
    triggers::dispatch(app, intent);
}

/// The command wrapper runs this on the blocking pool, since native hotkey calls
/// synchronize with the main thread on macOS.
pub fn update_binding(
    app: &AppHandle,
    key: CaptureBindingKey,
    requested: Option<String>,
) -> Result<ShortcutSnapshot, CaptureError> {
    if app.state::<Shortcuts>().editing.load(Ordering::Acquire) {
        set_editing(app, false)?;
    }
    let state = app.state::<Shortcuts>();
    let mut current = state.snapshot.lock().unwrap();
    if current.backend == Backend::Portal {
        if current.bindings.iter().any(|entry| entry.key == key && entry.requested == requested) {
            return Ok(current.clone());
        }
        drop(current);
        return configure(app);
    }
    if current.availability != Availability::Ready {
        return Ok(current.clone());
    }
    let entry = current
        .bindings
        .iter_mut()
        .find(|entry| entry.key == key)
        .unwrap();
    let prior = entry.clone();
    let mut binding = registration::Binding {
        requested: entry.requested.clone(),
        active: entry.active.clone(),
        failure: None,
        suspended: entry.suspended.clone(),
    };
    let mut native = Native { app, key };
    if !binding.edit(requested.clone(), &mut native) {
        return Ok(current.clone());
    }
    if binding.failure.is_none() {
        match commands::with_preferences(app, &app.state::<CaptureState>(), |p| {
            p.set_binding(key, requested.clone())
        }) {
            Ok(true) => {
                let name = match key {
                    CaptureBindingKey::CaptureShortcut => "captureShortcut",
                    CaptureBindingKey::InstantWindowShortcut => "instantWindowShortcut",
                    CaptureBindingKey::RecordingShortcut => "recordingShortcut",
                };
                super::preference_commands::publish_preference(app, name, requested.as_deref());
            }
            Ok(false) => {}
            Err(error) => {
                binding.edit(prior.active.clone(), &mut native);
                project(entry, &binding);
                notify(app, &current);
                return Err(error);
            }
        }
    }
    project(entry, &binding);
    notify(app, &current);
    Ok(current.clone())
}

pub fn set_editing(app: &AppHandle, editing: bool) -> Result<ShortcutSnapshot, CaptureError> {
    let state = app.state::<Shortcuts>();
    let mut current = state.snapshot.lock().unwrap();
    if current.editing == editing {
        return Ok(current.clone());
    }
    state.editing.store(editing, Ordering::Release);
    if current.backend == Backend::Native && current.availability == Availability::Ready {
        for entry in &mut current.bindings {
            let mut binding = registration::Binding {
                requested: entry.requested.clone(),
                active: entry.active.clone(),
                failure: None,
                suspended: entry.suspended.clone(),
            };
            binding.suspend(
                editing,
                &mut Native {
                    app,
                    key: entry.key,
                },
            );
            project(entry, &binding);
        }
    }
    current.editing = editing;
    notify(app, &current);
    Ok(current.clone())
}

pub fn configure(app: &AppHandle) -> Result<ShortcutSnapshot, CaptureError> {
    #[cfg(target_os = "linux")]
    if let Some(sender) = app.state::<Shortcuts>().portal.lock().unwrap().as_ref() {
        let current = snapshot(app);
        if current.configure_supported {
            sender
                .send(portal::Command::Configure)
                .map_err(|_| CaptureError::NativeFailure)?;
            return Ok(current);
        }
    }
    let mut current = snapshot(app);
    if current.backend == Backend::Portal {
        for entry in &mut current.bindings {
            entry.failure = Some(ShortcutFailure::DesktopSettingsRequired);
        }
        publish(app, current.clone());
    }
    Ok(current)
}
pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<Shortcuts>() else {
        return;
    };
    state.editing.store(true, Ordering::Release);
    #[cfg(target_os = "linux")]
    if let Some(sender) = state.portal.lock().unwrap().take() {
        let _ = sender.send(portal::Command::Close);
    };
    // The native plugin owns its OS manager and releases all hotkeys on app exit.
}

// Kept dependency-free so the registration contract can be tested without a GUI.
mod registration {
    #[cfg(any(target_os = "linux", test))]
    pub fn portal_hint(chord: &str) -> Option<String> {
        let mut parts = chord.split('+').map(str::trim).collect::<Vec<_>>();
        let key = parts.pop()?;
        let key = match key.to_ascii_lowercase().as_str() {
            "enter" => "Return".to_owned(),
            "space" => "space".to_owned(),
            "arrowup" => "Up".to_owned(),
            "arrowdown" => "Down".to_owned(),
            "arrowleft" => "Left".to_owned(),
            "arrowright" => "Right".to_owned(),
            "pageup" => "Prior".to_owned(),
            "pagedown" => "Next".to_owned(),
            "backspace" => "BackSpace".to_owned(),
            "escape" | "esc" => "Escape".to_owned(),
            "tab" => "Tab".to_owned(),
            "home" => "Home".to_owned(),
            "end" => "End".to_owned(),
            "delete" => "Delete".to_owned(),
            "slash" | "/" => "slash".to_owned(),
            "." => "period".to_owned(),
            "," => "comma".to_owned(),
            "[" => "bracketleft".to_owned(),
            "]" => "bracketright".to_owned(),
            "`" => "grave".to_owned(),
            "\\" => "backslash".to_owned(),
            _ if key.len() == 1 && key.as_bytes()[0].is_ascii_alphanumeric() => {
                key.to_ascii_lowercase()
            }
            _ if key.starts_with('F') && key[1..].parse::<u8>().is_ok() => key.to_owned(),
            _ => return None, // No hint: the portal still lets the person choose any supported key.
        };
        let mut trigger = Vec::new();
        for modifier in parts {
            trigger.push(
                match modifier.to_ascii_lowercase().as_str() {
                    "cmdorctrl" | "commandorcontrol" | "commandorctrl" | "cmdorcontrol"
                    | "ctrl" | "control" | "mod" => "CTRL",
                    "shift" => "SHIFT",
                    "alt" | "option" => "ALT",
                    "meta" | "super" | "cmd" | "command" => "LOGO",
                    _ => return None,
                }
                .to_owned(),
            );
        }
        trigger.push(key);
        Some(trigger.join("+"))
    }
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Failure {
        Invalid,
        Conflict,
        Unavailable,
    }

    pub trait OsRegistration {
        fn register(&mut self, chord: &str) -> Result<(), Failure>;
        fn unregister(&mut self, chord: &str) -> Result<(), Failure>;
    }

    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    pub struct Binding {
        pub requested: Option<String>,
        pub active: Option<String>,
        pub failure: Option<Failure>,
        pub suspended: Option<String>,
    }
    impl Binding {
        pub fn suspend(&mut self, editing: bool, os: &mut impl OsRegistration) {
            if editing {
                if let Some(chord) = self.active.as_deref() {
                    if let Err(error) = os.unregister(chord) {
                        self.failure = Some(error);
                        return;
                    }
                    self.suspended = self.active.take();
                }
            } else if let Some(chord) = self.suspended.take() {
                match os.register(&chord) {
                    Ok(()) => {
                        self.active = Some(chord);
                        self.failure = None;
                    }
                    Err(error) => {
                        self.active = None;
                        self.failure = Some(error);
                    }
                }
            }
        }
        pub fn edit(&mut self, requested: Option<String>, os: &mut impl OsRegistration) -> bool {
            if self.requested == requested {
                return false;
            }
            let previous = self.clone();
            self.requested = requested.clone();
            self.failure = None;
            if self.active == requested {
                return *self != previous;
            }
            if let Some(chord) = requested.as_deref() {
                if let Err(reason) = os.register(chord) {
                    self.failure = Some(reason);
                    return *self != previous;
                }
            }
            if let Some(chord) = self.active.as_deref() {
                if let Err(reason) = os.unregister(chord) {
                    if let Some(new) = requested.as_deref() {
                        let _ = os.unregister(new);
                    }
                    self.failure = Some(reason);
                    return *self != previous;
                }
            }
            self.active = requested;
            *self != previous
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::collections::HashSet;
        #[derive(Default)]
        struct Desktop {
            occupied: HashSet<String>,
            registrations: usize,
            removals: usize,
        }
        impl OsRegistration for Desktop {
            fn register(&mut self, chord: &str) -> Result<(), Failure> {
                self.registrations += 1;
                if self.occupied.insert(chord.into()) {
                    Ok(())
                } else {
                    Err(Failure::Conflict)
                }
            }
            fn unregister(&mut self, chord: &str) -> Result<(), Failure> {
                self.removals += 1;
                self.occupied.remove(chord);
                Ok(())
            }
        }
        #[test]
        fn portal_hints_translate_recorder_names_to_xdg_keysyms() {
            assert_eq!(
                portal_hint("CmdOrCtrl+Shift+2").as_deref(),
                Some("CTRL+SHIFT+2")
            );
            assert_eq!(portal_hint("Ctrl+Enter").as_deref(), Some("CTRL+Return"));
            assert_eq!(portal_hint("Alt+ArrowLeft").as_deref(), Some("ALT+Left"));
            assert_eq!(portal_hint("Meta+Space").as_deref(), Some("LOGO+space"));
            assert_eq!(portal_hint("Ctrl+Shift+A").as_deref(), Some("CTRL+SHIFT+a"));
            assert_eq!(portal_hint("UnsupportedKey"), None);
        }
        #[test]
        fn conflict_retains_previous_working_binding_and_equal_edits_are_quiet() {
            let mut desktop = Desktop::default();
            let mut binding = Binding::default();
            assert!(binding.edit(Some("Ctrl+Shift+2".into()), &mut desktop));
            assert!(desktop.occupied.contains("Ctrl+Shift+2"));
            for _ in 0..1000 {
                assert!(!binding.edit(Some("Ctrl+Shift+2".into()), &mut desktop));
            }
            assert_eq!(desktop.registrations, 1);
            assert_eq!(desktop.removals, 0);
            desktop.occupied.insert("Ctrl+Shift+3".into());
            assert!(binding.edit(Some("Ctrl+Shift+3".into()), &mut desktop));
            assert_eq!(binding.failure, Some(Failure::Conflict));
            assert_eq!(binding.active.as_deref(), Some("Ctrl+Shift+2"));
            assert!(desktop.occupied.contains("Ctrl+Shift+2"));
            assert!(binding.edit(Some("Ctrl+Shift+4".into()), &mut desktop));
            assert_eq!(binding.active.as_deref(), Some("Ctrl+Shift+4"));
            assert_eq!(binding.failure, None);
            assert!(!desktop.occupied.contains("Ctrl+Shift+2"));
            assert!(binding.edit(None, &mut desktop));
            assert_eq!(binding.active, None);
            assert!(!desktop.occupied.contains("Ctrl+Shift+4"));
        }
        #[test]
        fn recorder_releases_hotkey_and_restores_it_on_cancel_without_repeating_equal_transitions()
        {
            let mut desktop = Desktop::default();
            let mut binding = Binding::default();
            binding.edit(Some("Ctrl+Shift+2".into()), &mut desktop);
            binding.suspend(true, &mut desktop);
            assert!(desktop.occupied.is_empty());
            assert_eq!(binding.active, None);
            binding.suspend(true, &mut desktop);
            assert_eq!(desktop.removals, 1);
            binding.suspend(false, &mut desktop);
            assert!(desktop.occupied.contains("Ctrl+Shift+2"));
            assert_eq!(binding.active.as_deref(), Some("Ctrl+Shift+2"));
            binding.suspend(false, &mut desktop);
            assert_eq!(desktop.registrations, 2);
        }
    }
}
