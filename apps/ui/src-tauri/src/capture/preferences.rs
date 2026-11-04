use happier_desktop_native::capture::CaptureError;
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureBindingKey { CaptureShortcut, InstantWindowShortcut, RecordingShortcut }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Bindings {
    pub capture_shortcut: Option<String>,
    pub instant_window_shortcut: Option<String>,
    pub recording_shortcut: Option<String>,
}
impl Default for Bindings {
    fn default() -> Self {
        Self { capture_shortcut: Some("CmdOrCtrl+Shift+2".into()), instant_window_shortcut: None, recording_shortcut: None }
    }
}
impl Bindings {
    pub fn get(&self, key: CaptureBindingKey) -> Option<&str> {
        match key { CaptureBindingKey::CaptureShortcut => self.capture_shortcut.as_deref(),
            CaptureBindingKey::InstantWindowShortcut => self.instant_window_shortcut.as_deref(),
            CaptureBindingKey::RecordingShortcut => self.recording_shortcut.as_deref() }
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SavedPreferences {
    library_folder: Option<PathBuf>,
    include_window_shadow: bool,
    #[serde(flatten)]
    bindings: Bindings,
    #[serde(flatten)]
    other: serde_json::Map<String, serde_json::Value>,
}

pub(super) struct CapturePreferences { path: PathBuf, saved: SavedPreferences }
impl CapturePreferences {
    pub fn include_window_shadow(&self) -> bool { self.saved.include_window_shadow }
    pub fn set_include_window_shadow(&mut self, enabled: bool) -> Result<bool, CaptureError> {
        if self.saved.include_window_shadow == enabled { return Ok(false); }
        let mut next = self.saved.clone();
        next.include_window_shadow = enabled;
        self.persist(next)?;
        Ok(true)
    }
    pub fn bindings(&self) -> Bindings { self.saved.bindings.clone() }
    pub fn set_binding(&mut self, key: CaptureBindingKey, binding: Option<String>) -> Result<bool, CaptureError> {
        if self.saved.bindings.get(key) == binding.as_deref() { return Ok(false); }
        let mut next = self.saved.clone();
        match key {
            CaptureBindingKey::CaptureShortcut => next.bindings.capture_shortcut = binding,
            CaptureBindingKey::InstantWindowShortcut => next.bindings.instant_window_shortcut = binding,
            CaptureBindingKey::RecordingShortcut => next.bindings.recording_shortcut = binding,
        }
        self.persist(next)?;
        Ok(true)
    }
    pub fn load(path: PathBuf) -> Result<Self, CaptureError> {
        let saved = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| CaptureError::FileIo)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => SavedPreferences::default(),
            Err(_) => return Err(CaptureError::FileIo),
        };
        Ok(Self { path, saved })
    }
    pub fn library_folder(&self) -> Option<PathBuf> { self.saved.library_folder.clone() }
    pub fn set_library_folder(&mut self, folder: Option<PathBuf>) -> Result<bool, CaptureError> {
        if self.saved.library_folder == folder { return Ok(false); }
        let mut next = self.saved.clone(); next.library_folder = folder;
        self.persist(next)?;
        Ok(true)
    }
    fn persist(&mut self, next: SavedPreferences) -> Result<(), CaptureError> {
        let directory = self.path.parent().ok_or(CaptureError::FileIo)?;
        fs::create_dir_all(directory).map_err(|_| CaptureError::FileIo)?;
        let bytes = serde_json::to_vec(&next).map_err(|_| CaptureError::FileIo)?;
        let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|_| CaptureError::FileIo)?;
        temp.write_all(&bytes).and_then(|_| temp.flush()).map_err(|_| CaptureError::FileIo)?;
        temp.persist(&self.path).map_err(|_| CaptureError::FileIo)?;
        self.saved = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn window_shadow_defaults_off_and_persists_without_rewriting_equal_values() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("capture-preferences.json");
        std::fs::write(&path, br#"{"captureShortcut":"Alt+2","futurePreference":true}"#).unwrap();
        let mut preferences = CapturePreferences::load(path.clone()).unwrap();
        assert!(!preferences.include_window_shadow());
        assert!(preferences.set_include_window_shadow(true).unwrap());
        assert!(CapturePreferences::load(path.clone()).unwrap().include_window_shadow());
        let bytes = std::fs::read(&path).unwrap();
        assert!(!preferences.set_include_window_shadow(true).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let saved: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(saved["captureShortcut"], "Alt+2");
        assert_eq!(saved["futurePreference"], true);
        assert!(preferences.set_include_window_shadow(false).unwrap());
        assert!(!CapturePreferences::load(path).unwrap().include_window_shadow());
    }
    #[test]
    fn bindings_keep_unbound_defaults_and_change_only_the_named_native_key() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("capture-preferences.json");
        let mut preferences = CapturePreferences::load(path.clone()).unwrap();
        let initial = preferences.bindings();
        assert_eq!(initial.capture_shortcut.as_deref(), Some("CmdOrCtrl+Shift+2"));
        assert_eq!(initial.instant_window_shortcut, None);
        assert_eq!(initial.recording_shortcut, None);
        assert!(preferences.set_binding(CaptureBindingKey::InstantWindowShortcut, Some("Ctrl+Shift+8".into())).unwrap());
        let after = preferences.bindings();
        assert_eq!(after.capture_shortcut, initial.capture_shortcut);
        assert_eq!(after.instant_window_shortcut.as_deref(), Some("Ctrl+Shift+8"));
        let before_bytes = std::fs::read(&path).unwrap();
        assert!(!preferences.set_binding(CaptureBindingKey::InstantWindowShortcut, Some("Ctrl+Shift+8".into())).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), before_bytes);
        assert!(preferences.set_library_folder(Some(root.path().join("chosen"))).unwrap());
        assert_eq!(CapturePreferences::load(path.clone()).unwrap().bindings(), after);
        assert!(preferences.set_binding(CaptureBindingKey::CaptureShortcut, None).unwrap());
        assert_eq!(CapturePreferences::load(path).unwrap().bindings().capture_shortcut, None);
    }
    #[test]
    fn folder_survives_recreation_without_erasing_other_native_preferences() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("capture-preferences.json");
        std::fs::write(&path, br#"{"captureShortcut":"CmdOrCtrl+Shift+2"}"#).unwrap();
        let mut preferences = CapturePreferences::load(path.clone()).unwrap();
        let folder = root.path().join("chosen-library");
        assert!(preferences.set_library_folder(Some(folder.clone())).unwrap());
        assert_eq!(CapturePreferences::load(path.clone()).unwrap().library_folder(), Some(folder));
        let bytes = std::fs::read(&path).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["captureShortcut"], "CmdOrCtrl+Shift+2");
        let mut tagged = bytes.clone(); tagged.push(b'\n'); std::fs::write(&path, &tagged).unwrap();
        assert!(!preferences.set_library_folder(preferences.library_folder()).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), tagged); // Equal edit must not rewrite the record.
        assert!(preferences.set_library_folder(None).unwrap());
        assert_eq!(CapturePreferences::load(path).unwrap().library_folder(), None);
    }
}
