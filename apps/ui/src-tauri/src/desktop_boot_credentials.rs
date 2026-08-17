use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBootEncryption {
    pub public_key: String,
    pub machine_key: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBootCredentials {
    pub token: String,
    pub encryption: Option<DesktopBootEncryption>,
}

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

fn build_candidate_paths(cli_home: &Path, active_server_id: Option<&str>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(server_id) = active_server_id {
        let trimmed = server_id.trim();
        if !trimmed.is_empty() {
            paths.push(cli_home.join("servers").join(trimmed).join("access.key"));
        }
    }
    paths.push(cli_home.join("access.key"));
    paths
}

fn parse_boot_credentials(raw: &str) -> Option<DesktopBootCredentials> {
    let parsed = serde_json::from_str::<DesktopBootCredentials>(raw).ok()?;
    if parsed.token.trim().is_empty() {
        return None;
    }
    if let Some(encryption) = &parsed.encryption {
        if encryption.public_key.trim().is_empty() || encryption.machine_key.trim().is_empty() {
            return None;
        }
    }
    Some(parsed)
}

fn read_boot_credentials_from_path(path: &Path) -> Option<DesktopBootCredentials> {
    let raw = fs::read_to_string(path).ok()?;
    parse_boot_credentials(&raw)
}

fn resolve_desktop_stack_boot_credentials_with<F>(
    read_env: &F,
) -> Result<Option<DesktopBootCredentials>, String>
where
    F: Fn(&str) -> Option<String>,
{
    if !has_stack_context_with(read_env) {
        return Ok(None);
    }

    let Some(cli_home) = resolve_cli_home_with(read_env) else {
        return Ok(None);
    };

    let active_server_id = resolve_active_server_id_with(&cli_home, read_env);
    for candidate in build_candidate_paths(&cli_home, active_server_id.as_deref()) {
        if let Some(credentials) = read_boot_credentials_from_path(&candidate) {
            return Ok(Some(credentials));
        }
    }

    Ok(None)
}

#[tauri::command]
pub fn desktop_read_stack_boot_credentials() -> Result<Option<DesktopBootCredentials>, String> {
    resolve_desktop_stack_boot_credentials_with(&|key| read_non_empty_env(key))
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_desktop_stack_boot_credentials_with, DesktopBootCredentials, DesktopBootEncryption,
    };
    use std::collections::HashMap;
    use std::fs::{create_dir_all, write};
    use tempfile::tempdir;

    fn write_access_key(
        cli_home: &std::path::Path,
        server_id: &str,
        credentials: &DesktopBootCredentials,
    ) {
        let dir = cli_home.join("servers").join(server_id);
        create_dir_all(&dir).expect("expected server dir");
        write(
            dir.join("access.key"),
            serde_json::to_string(credentials).expect("expected serialized credentials"),
        )
        .expect("expected access key");
    }

    fn sample_credentials() -> DesktopBootCredentials {
        DesktopBootCredentials {
            token: "stack-token".to_string(),
            encryption: Some(DesktopBootEncryption {
                public_key: "public-key".to_string(),
                machine_key: "machine-key".to_string(),
            }),
        }
    }

    #[test]
    fn resolves_server_scoped_stack_boot_credentials_from_env() {
        let temp = tempdir().expect("expected tempdir");
        let cli_home = temp.path().join("cli");
        create_dir_all(&cli_home).expect("expected cli home");
        let credentials = sample_credentials();
        write_access_key(
            &cli_home,
            "stack_activity-surfaces-qa__id_default",
            &credentials,
        );

        let env = HashMap::from([
            ("HAPPIER_STACK_STACK", "activity-surfaces-qa".to_string()),
            ("HAPPIER_HOME_DIR", cli_home.display().to_string()),
            (
                "HAPPIER_ACTIVE_SERVER_ID",
                "stack_activity-surfaces-qa__id_default".to_string(),
            ),
        ]);

        let resolved = resolve_desktop_stack_boot_credentials_with(&|key| env.get(key).cloned())
            .expect("expected credentials result");
        assert_eq!(resolved, Some(credentials));
    }

    #[test]
    fn resolves_token_only_stack_boot_credentials_without_encryption_material() {
        let temp = tempdir().expect("expected tempdir");
        let cli_home = temp.path().join("cli");
        let server_id = "stack_activity-surfaces-qa__id_default";
        let access_key_dir = cli_home.join("servers").join(server_id);
        create_dir_all(&access_key_dir).expect("expected server dir");
        write(
            access_key_dir.join("access.key"),
            r#"{"token":"stack-token-only","encryption":null}"#,
        )
        .expect("expected access key");

        let env = HashMap::from([
            ("HAPPIER_STACK_STACK", "activity-surfaces-qa".to_string()),
            ("HAPPIER_HOME_DIR", cli_home.display().to_string()),
            ("HAPPIER_ACTIVE_SERVER_ID", server_id.to_string()),
        ]);

        let resolved = resolve_desktop_stack_boot_credentials_with(&|key| env.get(key).cloned())
            .expect("expected credentials result");
        assert_eq!(
            resolved.map(|credentials| credentials.token),
            Some("stack-token-only".to_string()),
        );
    }

    #[test]
    fn falls_back_to_settings_active_server_id_when_explicit_scope_is_missing() {
        let temp = tempdir().expect("expected tempdir");
        let cli_home = temp.path().join("cli");
        create_dir_all(&cli_home).expect("expected cli home");
        write(
            cli_home.join("settings.json"),
            r#"{"activeServerId":"stack_activity-surfaces-qa__id_default"}"#,
        )
        .expect("expected settings");
        let credentials = sample_credentials();
        write_access_key(
            &cli_home,
            "stack_activity-surfaces-qa__id_default",
            &credentials,
        );

        let env = HashMap::from([
            ("HAPPIER_STACK_STACK", "activity-surfaces-qa".to_string()),
            ("HAPPIER_STACK_CLI_HOME_DIR", cli_home.display().to_string()),
        ]);

        let resolved = resolve_desktop_stack_boot_credentials_with(&|key| env.get(key).cloned())
            .expect("expected credentials result");
        assert_eq!(resolved, Some(credentials));
    }

    #[test]
    fn returns_none_without_stack_context() {
        let env = HashMap::<&str, String>::new();

        let resolved = resolve_desktop_stack_boot_credentials_with(&|key| env.get(key).cloned())
            .expect("expected credentials result");
        assert_eq!(resolved, None);
    }
}
