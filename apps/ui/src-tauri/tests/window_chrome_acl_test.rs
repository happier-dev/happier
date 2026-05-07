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

#[test]
fn default_capability_allows_main_window_chrome_commands_without_losing_pet_overlay_scope() {
    let default_capability = read_default_capability();
    assert_eq!(default_capability["windows"], serde_json::json!(["main"]));

    let permissions = default_capability["permissions"]
        .as_array()
        .expect("default capability permissions should be an array");

    for required_permission in [
        "allow-sync-desktop-pet-overlay-state",
        "allow-desktop-get-window-chrome-policy",
        "allow-desktop-get-window-state",
        "allow-desktop-minimize-window",
        "allow-desktop-toggle-window-maximize",
        "allow-desktop-close-window",
        "allow-desktop-show-main-window",
        "allow-desktop-start-window-dragging",
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
