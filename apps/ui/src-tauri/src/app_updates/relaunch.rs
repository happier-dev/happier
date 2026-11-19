//! One-shot relaunch intent owned by the desktop updater; no Tauri types.

use std::{fs, io, path::Path};

use serde::{Deserialize, Serialize};

pub const UPDATE_RELAUNCH_FILE: &str = "updater-relaunch.json";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRelaunchMarker {
    from_version: String,
}

/// Windows exits inside the installer. Record intent first, not after an unreachable return.
pub fn install_with_relaunch_marker(
    app_data_dir: &Path,
    from_version: &str,
    install: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let path = app_data_dir.join(UPDATE_RELAUNCH_FILE);
    let result = (|| {
        fs::create_dir_all(app_data_dir).map_err(|error| error.to_string())?;
        let bytes = serde_json::to_vec(&UpdateRelaunchMarker {
            from_version: from_version.into(),
        })
        .map_err(|error| error.to_string())?;
        fs::write(&path, bytes).map_err(|error| error.to_string())?;
        install()
    })();
    if let Err(error) = result {
        return match fs::remove_file(&path) {
            Ok(()) => Err(error),
            Err(cleanup) if cleanup.kind() == io::ErrorKind::NotFound => Err(error),
            Err(cleanup) => Err(format!(
                "{error}; could not clear updater relaunch intent: {cleanup}"
            )),
        };
    }
    Ok(())
}

/// Consume before deciding login mode. An unchanged binary proves no successful replacement.
pub fn consume_update_relaunch_marker(
    app_data_dir: &Path,
    running_version: &str,
) -> io::Result<bool> {
    let path = app_data_dir.join(UPDATE_RELAUNCH_FILE);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    fs::remove_file(path)?;
    Ok(
        serde_json::from_slice::<UpdateRelaunchMarker>(&bytes).is_ok_and(|marker| {
            !marker.from_version.trim().is_empty() && marker.from_version != running_version
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::menu_bar::policy::{classify_startup_launch, StartupLaunch, MENU_BAR_ARG};
    use serde_json::json;

    #[test]
    fn install_records_intent_before_an_installer_that_can_exit_and_replacement_consumes_it_once() {
        let dir = tempfile::tempdir().unwrap();
        install_with_relaunch_marker(dir.path(), "0.3.10", || {
            let bytes = std::fs::read(dir.path().join(UPDATE_RELAUNCH_FILE))
                .expect("intent exists before install may exit");
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
                json!({ "fromVersion": "0.3.10" })
            );
            Ok(())
        })
        .unwrap();
        let replacement = consume_update_relaunch_marker(dir.path(), "0.3.11").unwrap();
        assert_eq!(
            classify_startup_launch(["Happier", MENU_BAR_ARG], replacement),
            StartupLaunch::UpdateFromMenuBar
        );
        assert!(!dir.path().join(UPDATE_RELAUNCH_FILE).exists());
        let later_login = consume_update_relaunch_marker(dir.path(), "0.3.11").unwrap();
        assert_eq!(
            classify_startup_launch(["Happier", MENU_BAR_ARG], later_login),
            StartupLaunch::MenuBar
        );
    }

    #[test]
    fn unchanged_version_and_invalid_markers_are_consumed_without_overriding_login_mode() {
        let dir = tempfile::tempdir().unwrap();
        for marker in [
            r#"{"fromVersion":"0.3.11"}"#,
            r#"{"fromVersion":""}"#,
            r#"{"fromVersion":false}"#,
            "not json",
        ] {
            let path = dir.path().join(UPDATE_RELAUNCH_FILE);
            std::fs::write(&path, marker).unwrap();
            assert!(!consume_update_relaunch_marker(dir.path(), "0.3.11").unwrap());
            assert!(!path.exists());
        }
        assert!(!consume_update_relaunch_marker(dir.path(), "0.3.11").unwrap());
    }

    #[test]
    fn failed_install_clears_intent_and_an_unwritable_marker_does_not_call_the_installer() {
        let dir = tempfile::tempdir().unwrap();
        let failure = install_with_relaunch_marker(dir.path(), "0.3.10", || {
            assert!(
                dir.path().join(UPDATE_RELAUNCH_FILE).exists(),
                "intent is recorded even when install fails"
            );
            Err("installer refused".into())
        });
        assert_eq!(failure, Err("installer refused".into()));
        assert!(!dir.path().join(UPDATE_RELAUNCH_FILE).exists());
        let not_a_dir = dir.path().join("file");
        std::fs::write(&not_a_dir, "not a directory").unwrap();
        let called = std::cell::Cell::new(false);
        assert!(install_with_relaunch_marker(&not_a_dir, "0.3.10", || {
            called.set(true);
            Ok(())
        })
        .is_err());
        assert!(!called.get());
    }
}
