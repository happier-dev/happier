#[path = "../build_support.rs"]
#[allow(dead_code)]
mod build_support;

use build_support::{app_command_permission, APP_TAURI_COMMANDS};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn manifest_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn read_json_file(path: impl AsRef<Path>) -> Value {
    let path = path.as_ref();
    let source = fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
    serde_json::from_str(&source)
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", path.display()))
}

fn read_tauri_config(name: &str) -> Value {
    read_json_file(manifest_dir().join(name))
}

fn read_default_capability() -> Value {
    read_json_file(manifest_dir().join("capabilities").join("default.json"))
}

/// Every string permission granted by any capability, across every window.
fn granted_capability_permissions() -> Vec<String> {
    let capabilities_dir = manifest_dir().join("capabilities");
    let entries = fs::read_dir(&capabilities_dir)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", capabilities_dir.display()));

    let mut granted = Vec::new();
    for entry in entries {
        let path = entry
            .expect("failed to read a capability directory entry")
            .path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }

        let capability = read_json_file(&path);
        let permissions = capability["permissions"]
            .as_array()
            .unwrap_or_else(|| panic!("{} should declare a permissions array", path.display()));
        granted.extend(
            permissions
                .iter()
                .filter_map(|permission| permission.as_str())
                .map(str::to_string),
        );
    }
    granted
}

#[test]
fn default_capability_allows_main_window_chrome_commands_without_losing_pet_overlay_scope() {
    let default_capability = read_default_capability();
    assert_eq!(default_capability["windows"], serde_json::json!(["main"]));

    let permissions = default_capability["permissions"]
        .as_array()
        .expect("default capability permissions should be an array");

    for required_permission in [
        "allow-sync-desktop-pet-overlay-state",
        "core:window:allow-set-background-color",
        "allow-desktop-get-window-chrome-policy",
        "allow-desktop-get-window-state",
        "allow-desktop-minimize-window",
        "allow-desktop-toggle-window-maximize",
        "allow-desktop-close-window",
        "allow-desktop-show-main-window",
        "allow-desktop-start-window-dragging",
        "allow-desktop-finish-shutdown",
    ] {
        assert!(
            permissions.contains(&Value::String(required_permission.to_string())),
            "default capability should include {required_permission}",
        );
    }
}

#[test]
fn stable_preview_and_publicdev_configs_use_integrated_main_window_chrome() {
    for config_name in [
        "tauri.conf.json",
        "tauri.preview.conf.json",
        "tauri.publicdev.conf.json",
    ] {
        let config = read_tauri_config(config_name);
        let window = config["app"]["windows"]
            .as_array()
            .and_then(|windows| windows.first())
            .unwrap_or_else(|| panic!("{config_name} should declare a main window"));

        assert_eq!(
            window["decorations"], true,
            "{config_name} should keep native window decorations available"
        );
        assert_eq!(
            window["hiddenTitle"], true,
            "{config_name} should hide the native title text"
        );
        assert_eq!(
            window["titleBarStyle"], "Overlay",
            "{config_name} should use overlay titlebar chrome"
        );
        assert_eq!(
            window["backgroundColor"], "#F5F5F5",
            "{config_name} should set a main-window background fallback that matches the light grouped app surface"
        );
    }
}

#[test]
fn stable_and_publicdev_configs_preserve_pet_overlay_capability() {
    for config_name in ["tauri.conf.json", "tauri.publicdev.conf.json"] {
        let config = read_tauri_config(config_name);
        let capabilities = config["app"]["security"]["capabilities"]
            .as_array()
            .unwrap_or_else(|| panic!("{config_name} should declare app.security.capabilities"));

        assert!(
            capabilities.contains(&Value::String("default".to_string())),
            "{config_name} should keep the default capability",
        );
        assert!(
            capabilities.contains(&Value::String("pet_overlay".to_string())),
            "{config_name} should keep the pet_overlay capability",
        );
    }
}

/// A command the app registers but no capability grants still builds; it is only rejected when the
/// webview invokes it, with nothing on the Rust side to notice. The opposite mistake — granting a
/// permission for a command that does not exist — already fails the build with `UnknownPermission`.
#[test]
fn every_registered_app_command_is_granted_by_a_capability() {
    let granted = granted_capability_permissions();

    for command in APP_TAURI_COMMANDS {
        let permission = app_command_permission(command);
        assert!(
            granted.contains(&permission),
            "no capability grants {permission}; {command} would be rejected at invoke time",
        );
    }
}

fn read_capability(name: &str) -> Value {
    read_json_file(manifest_dir().join("capabilities").join(format!("{name}.json")))
}

fn string_permissions(capability: &Value) -> Vec<String> {
    capability["permissions"]
        .as_array()
        .expect("capability permissions should be an array")
        .iter()
        .filter_map(|permission| permission.as_str())
        .map(str::to_string)
        .collect()
}

#[test]
fn main_window_can_open_file_windows_and_local_files() {
    let permissions = string_permissions(&read_default_capability());
    for required_permission in [
        "allow-desktop-open-file-window",
        "allow-desktop-open-path-with-default-app",
        "allow-desktop-reveal-path-in-file-manager",
    ] {
        assert!(
            permissions.contains(&required_permission.to_string()),
            "default capability should include {required_permission}",
        );
    }
}

#[test]
fn file_windows_have_their_own_capability_in_every_shipped_config() {
    let capability = read_capability("file_window");
    assert_eq!(capability["windows"], serde_json::json!(["file-window-*"]));
    let permissions = string_permissions(&capability);
    for required_permission in [
        "core:default",
        "core:window:allow-set-background-color",
        "allow-desktop-open-path-with-default-app",
        "allow-desktop-reveal-path-in-file-manager",
    ] {
        assert!(
            permissions.contains(&required_permission.to_string()),
            "file_window capability should include {required_permission}",
        );
    }
    // A file window must not be able to open further windows, update the app or drive the tray.
    for forbidden_permission in [
        "allow-desktop-open-file-window",
        "allow-desktop-install-update",
        "allow-desktop-set-tray-state",
    ] {
        assert!(
            !permissions.contains(&forbidden_permission.to_string()),
            "file_window capability must not include {forbidden_permission}",
        );
    }

    for config_name in ["tauri.conf.json", "tauri.publicdev.conf.json"] {
        let config = read_tauri_config(config_name);
        let capabilities = config["app"]["security"]["capabilities"]
            .as_array()
            .unwrap_or_else(|| panic!("{config_name} should declare app.security.capabilities"));
        assert!(
            capabilities.contains(&Value::String("file_window".to_string())),
            "{config_name} should register the file_window capability",
        );
    }
}
