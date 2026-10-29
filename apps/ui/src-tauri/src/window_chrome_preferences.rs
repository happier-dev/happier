use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct SavedWindowChrome {
    use_native_title_bar: bool,
}

/// Native-owned because the preference must be available before the webview exists.
#[derive(Default)]
pub(super) struct WindowChromePreferences {
    path: Option<PathBuf>,
    pub use_native_title_bar: bool,
    pub persistence_error: bool,
}

impl WindowChromePreferences {
    pub fn load(path: PathBuf) -> Self {
        let mut state = Self {
            path: Some(path),
            ..Self::default()
        };
        match fs::read(state.path.as_ref().unwrap()) {
            Ok(bytes) => match serde_json::from_slice::<SavedWindowChrome>(&bytes) {
                Ok(saved) => state.use_native_title_bar = saved.use_native_title_bar,
                Err(error) => {
                    log::warn!("could not read main-window chrome preference: {error}");
                    state.persistence_error = true;
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                log::warn!("could not read main-window chrome preference: {error}");
                state.persistence_error = true;
            }
        }
        state
    }

    /// Called only after the native window accepted the change. A failed save keeps
    /// the effective value and exposes the failure in the settings payload for retry.
    pub fn save_applied(&mut self, use_native_title_bar: bool) {
        self.use_native_title_bar = use_native_title_bar;
        let result = self
            .path
            .as_ref()
            .ok_or_else(|| "chrome preference path unavailable".to_string())
            .and_then(|path| {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                let bytes = serde_json::to_vec(&SavedWindowChrome {
                    use_native_title_bar,
                })
                .map_err(|error| error.to_string())?;
                fs::write(path, bytes).map_err(|error| error.to_string())
            });
        self.persistence_error = result.is_err();
        if let Err(error) = result {
            log::warn!("could not save main-window chrome preference: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preference_survives_recreation_and_can_return_to_integrated_chrome() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window-state/main-window-chrome.json");
        let mut preferences = WindowChromePreferences::load(path.clone());
        assert!(!preferences.use_native_title_bar);
        assert!(!preferences.persistence_error);
        preferences.save_applied(true);
        assert!(!preferences.persistence_error);
        let mut recreated = WindowChromePreferences::load(path.clone());
        assert!(recreated.use_native_title_bar);
        recreated.save_applied(false);
        assert!(!WindowChromePreferences::load(path).use_native_title_bar);
    }

    #[test]
    fn unreadable_preferences_are_observable_and_can_be_repaired_by_user_intent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("main-window-chrome.json");
        fs::write(&path, b"not json").unwrap();
        let mut preferences = WindowChromePreferences::load(path.clone());
        assert!(preferences.persistence_error);
        assert!(!preferences.use_native_title_bar);
        preferences.save_applied(true);
        assert!(!preferences.persistence_error);
        assert!(WindowChromePreferences::load(path).use_native_title_bar);
    }

    #[test]
    fn save_failure_keeps_the_effective_window_mode_and_reports_incomplete_persistence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blocked");
        fs::create_dir(&path).unwrap();
        let mut preferences = WindowChromePreferences::load(path);
        preferences.save_applied(true);
        assert!(preferences.use_native_title_bar);
        assert!(preferences.persistence_error);
    }
}
