//! Hands a stack-launched desktop app the selected server's CLI access key.
//!
//! The host reads exactly `servers/<id>/access.key` for the selected server and passes its JSON
//! through unread: the UI's `parseDesktopBootCredentials` is the only decoder (legacy secret,
//! data key, token-only, historical custody). There is no Home-level `access.key` fallback; the
//! CLI uses that file only for the `cloud` server, which is never a stack server. Without a stack
//! context, a selected server or a readable key, the answer is `None` and the UI shows ordinary
//! sign-in.

use std::fs;
use std::path::{Path, PathBuf};

fn read_non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn read_non_empty_env_with<F>(read_env: &F, key: &str) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    read_env(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn has_stack_context_with<F>(read_env: &F) -> bool
where
    F: Fn(&str) -> Option<String>,
{
    read_non_empty_env_with(read_env, "HAPPIER_STACK_STACK").is_some()
        || read_non_empty_env_with(read_env, "HAPPIER_STACK_CLI_HOME_DIR").is_some()
        || read_non_empty_env_with(read_env, "HAPPIER_HOME_DIR").is_some()
}

fn resolve_cli_home_with<F>(read_env: &F) -> Option<PathBuf>
where
    F: Fn(&str) -> Option<String>,
{
    read_non_empty_env_with(read_env, "HAPPIER_HOME_DIR")
        .or_else(|| read_non_empty_env_with(read_env, "HAPPIER_STACK_CLI_HOME_DIR"))
        .map(PathBuf::from)
}

fn read_settings_active_server_id(cli_home: &Path) -> Option<String> {
    let settings_path = cli_home.join("settings.json");
    let raw = fs::read_to_string(settings_path).ok()?;
    let parsed = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    parsed
        .get("activeServerId")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn resolve_active_server_id_with<F>(cli_home: &Path, read_env: &F) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    read_non_empty_env_with(read_env, "HAPPIER_ACTIVE_SERVER_ID")
        .or_else(|| read_settings_active_server_id(cli_home))
}

fn resolve_desktop_stack_boot_credentials_with<F>(
    read_env: &F,
) -> Result<Option<serde_json::Value>, String>
where
    F: Fn(&str) -> Option<String>,
{
    if !has_stack_context_with(read_env) {
        return Ok(None);
    }
    let Some(cli_home) = resolve_cli_home_with(read_env) else {
        return Ok(None);
    };
    let Some(server_id) = resolve_active_server_id_with(&cli_home, read_env) else {
        return Ok(None);
    };
    let path = cli_home.join("servers").join(server_id).join("access.key");
    // A missing, unreadable or unparseable key means ordinary sign-in.
    Ok(fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok()))
}

#[tauri::command]
pub fn desktop_read_stack_boot_credentials() -> Result<Option<serde_json::Value>, String> {
    resolve_desktop_stack_boot_credentials_with(&|key| read_non_empty_env(key))
}

#[cfg(test)]
mod tests {
    use super::resolve_desktop_stack_boot_credentials_with;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::fs::{create_dir_all, write};
    use std::path::Path;
    use tempfile::tempdir;

    const SERVER_ID: &str = "stack_activity-surfaces-qa__id_default";

    // Synthetic values in the exact shapes the CLI persistence owner writes
    // (`writeCredentialsLegacy`, `writeCredentialsDataKey`, `encodeStoredCredentials`).
    fn cli_shapes() -> Vec<(&'static str, Value)> {
        vec![
            ("legacy", json!({ "secret": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=", "token": "legacy-token" })),
            ("data-key", json!({
                "encryption": {
                    "publicKey": "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
                    "machineKey": "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM="
                },
                "token": "data-key-token"
            })),
            ("token-only", json!({ "token": "token-only" })),
            ("released-0.2-token-only", json!({ "token": "token-only", "encryption": null })),
            ("historical", json!({ "token": "historical-token", "secret": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=", "custody": "historical" })),
        ]
    }

    fn write_server_key(cli_home: &Path, server_id: &str, value: &Value) {
        let dir = cli_home.join("servers").join(server_id);
        create_dir_all(&dir).expect("expected server dir");
        write(dir.join("access.key"), serde_json::to_string_pretty(value).expect("expected json"))
            .expect("expected access key");
    }

    fn resolve(env: &HashMap<&str, String>) -> Option<Value> {
        resolve_desktop_stack_boot_credentials_with(&|key| env.get(key).cloned())
            .expect("expected credentials result")
    }

    fn stack_env(cli_home: &Path, server_id: Option<&str>) -> HashMap<&'static str, String> {
        let mut env = HashMap::from([
            ("HAPPIER_STACK_STACK", "activity-surfaces-qa".to_string()),
            ("HAPPIER_HOME_DIR", cli_home.display().to_string()),
        ]);
        if let Some(server_id) = server_id {
            env.insert("HAPPIER_ACTIVE_SERVER_ID", server_id.to_string());
        }
        env
    }

    #[test]
    fn passes_every_cli_access_key_shape_through_unchanged() {
        for (name, value) in cli_shapes() {
            let temp = tempdir().expect("expected tempdir");
            let cli_home = temp.path().join("cli");
            write_server_key(&cli_home, SERVER_ID, &value);
            assert_eq!(resolve(&stack_env(&cli_home, Some(SERVER_ID))), Some(value), "{name}");
        }
    }

    #[test]
    fn missing_server_key_never_falls_back_to_the_home_level_key() {
        let temp = tempdir().expect("expected tempdir");
        let cli_home = temp.path().join("cli");
        create_dir_all(&cli_home).expect("expected cli home");
        write(cli_home.join("access.key"), r#"{"token":"home-level"}"#).expect("expected key");
        assert_eq!(resolve(&stack_env(&cli_home, Some(SERVER_ID))), None);
    }

    #[test]
    fn unresolved_server_id_returns_none_even_with_a_home_level_key() {
        let temp = tempdir().expect("expected tempdir");
        let cli_home = temp.path().join("cli");
        create_dir_all(&cli_home).expect("expected cli home");
        write(cli_home.join("access.key"), r#"{"token":"home-level"}"#).expect("expected key");
        assert_eq!(resolve(&stack_env(&cli_home, None)), None);
    }

    #[test]
    fn falls_back_to_settings_active_server_id_when_explicit_scope_is_missing() {
        let temp = tempdir().expect("expected tempdir");
        let cli_home = temp.path().join("cli");
        create_dir_all(&cli_home).expect("expected cli home");
        write(cli_home.join("settings.json"), format!(r#"{{"activeServerId":"{SERVER_ID}"}}"#))
            .expect("expected settings");
        let value = json!({ "token": "token-only" });
        write_server_key(&cli_home, SERVER_ID, &value);
        let env = HashMap::from([
            ("HAPPIER_STACK_STACK", "activity-surfaces-qa".to_string()),
            ("HAPPIER_STACK_CLI_HOME_DIR", cli_home.display().to_string()),
        ]);
        assert_eq!(resolve(&env), Some(value));
    }

    #[test]
    fn unparseable_key_returns_none() {
        let temp = tempdir().expect("expected tempdir");
        let cli_home = temp.path().join("cli");
        let dir = cli_home.join("servers").join(SERVER_ID);
        create_dir_all(&dir).expect("expected server dir");
        write(dir.join("access.key"), "not json").expect("expected key");
        assert_eq!(resolve(&stack_env(&cli_home, Some(SERVER_ID))), None);
    }

    #[test]
    fn returns_none_without_stack_context() {
        assert_eq!(resolve(&HashMap::new()), None);
    }
}
