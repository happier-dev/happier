#[cfg(desktop)]
use serde::Serialize;

#[cfg(desktop)]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopWebRuntimeConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    server_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_context: Option<String>,
}

#[cfg(desktop)]
fn read_non_empty_env_with<F>(read_env: &F, key: &str) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    read_env(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(desktop)]
fn has_explicit_runtime_override_with<F>(read_env: &F) -> bool
where
    F: Fn(&str) -> Option<String>,
{
    read_non_empty_env_with(read_env, "HAPPIER_TAURI_WEB_RUNTIME_SERVER_URL").is_some()
        || read_non_empty_env_with(read_env, "HAPPIER_TAURI_WEB_RUNTIME_SERVER_CONTEXT").is_some()
}

#[cfg(desktop)]
fn has_stack_runtime_hint_with<F>(read_env: &F) -> bool
where
    F: Fn(&str) -> Option<String>,
{
    if has_explicit_runtime_override_with(read_env) {
        return true;
    }

    if read_non_empty_env_with(read_env, "HAPPIER_SERVER_URL").is_some() {
        return true;
    }

    if read_non_empty_env_with(read_env, "HAPPIER_STACK_STACK").is_some() {
        return true;
    }

    read_non_empty_env_with(read_env, "HAPPIER_STACK_TAURI_IDENTIFIER")
        .map(|identifier| identifier.starts_with("com.happier.stack."))
        .unwrap_or(false)
}

#[cfg(desktop)]
fn resolve_runtime_server_url_with<F>(read_env: &F) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    read_non_empty_env_with(read_env, "HAPPIER_TAURI_WEB_RUNTIME_SERVER_URL")
        .or_else(|| read_non_empty_env_with(read_env, "HAPPIER_STACK_TAURI_SERVER_URL"))
        .or_else(|| read_non_empty_env_with(read_env, "HAPPIER_SERVER_URL"))
        .or_else(|| {
            read_non_empty_env_with(read_env, "HAPPIER_STACK_SERVER_PORT").and_then(|port| {
                port.parse::<u16>()
                    .ok()
                    .filter(|value| *value > 0)
                    .map(|value| format!("http://127.0.0.1:{value}"))
            })
        })
        .or_else(|| read_non_empty_env_with(read_env, "HAPPIER_PUBLIC_SERVER_URL"))
        .or_else(|| read_non_empty_env_with(read_env, "HAPPIER_STACK_SERVER_URL"))
}

#[cfg(desktop)]
fn resolve_runtime_server_context_with<F>(read_env: &F) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    read_non_empty_env_with(read_env, "HAPPIER_TAURI_WEB_RUNTIME_SERVER_CONTEXT")
        .or_else(|| read_non_empty_env_with(read_env, "EXPO_PUBLIC_HAPPY_SERVER_CONTEXT"))
        .or_else(|| {
            if has_stack_runtime_hint_with(read_env) {
                Some("stack".to_string())
            } else {
                None
            }
        })
}

#[cfg(desktop)]
fn resolve_desktop_web_runtime_config_with<F>(read_env: F) -> Option<DesktopWebRuntimeConfig>
where
    F: Fn(&str) -> Option<String>,
{
    if !has_stack_runtime_hint_with(&read_env) {
        return None;
    }

    let config = DesktopWebRuntimeConfig {
        server_url: resolve_runtime_server_url_with(&read_env),
        server_context: resolve_runtime_server_context_with(&read_env),
    };

    if config.server_url.is_none() && config.server_context.is_none() {
        return None;
    }

    Some(config)
}

#[cfg(desktop)]
fn build_desktop_web_runtime_config_init_script(
    config: &DesktopWebRuntimeConfig,
) -> Option<String> {
    let payload = serde_json::to_string(config).ok()?;
    Some(format!(
        r#";(function(){{try{{const next={payload};if(!next||typeof next!=="object"){{return;}}const current=(window.__HAPPIER_WEB_RUNTIME_CONFIG__&&typeof window.__HAPPIER_WEB_RUNTIME_CONFIG__==="object")?window.__HAPPIER_WEB_RUNTIME_CONFIG__:{{}};window.__HAPPIER_WEB_RUNTIME_CONFIG__={{...current,...next}};if(typeof next.serverUrl==="string"&&next.serverUrl.trim()){{try{{const nextUrl=new URL(window.location.href);nextUrl.searchParams.set("server",next.serverUrl.trim());window.history.replaceState(null,"",nextUrl.toString());}}catch(_urlError){{}}}}}}catch(_error){{}}}})();"#,
    ))
}

#[cfg(desktop)]
pub(crate) fn build_desktop_web_runtime_config_init_script_from_env() -> Option<String> {
    let config = resolve_desktop_web_runtime_config_with(|key| std::env::var(key).ok())?;
    build_desktop_web_runtime_config_init_script(&config)
}

#[cfg(test)]
mod tests {
    use super::{
        build_desktop_web_runtime_config_init_script, resolve_desktop_web_runtime_config_with,
        DesktopWebRuntimeConfig,
    };
    use std::collections::HashMap;

    #[test]
    fn resolves_stack_runtime_config_from_stack_port_env() {
        let env = HashMap::from([
            ("HAPPIER_STACK_STACK", "activity-surfaces-qa"),
            ("HAPPIER_STACK_SERVER_PORT", "3009"),
            (
                "HAPPIER_STACK_TAURI_IDENTIFIER",
                "com.happier.stack.activity-surfaces-qa",
            ),
        ]);

        let resolved = resolve_desktop_web_runtime_config_with(|key| {
            env.get(key).map(|value| (*value).to_string())
        });

        assert_eq!(
            resolved,
            Some(DesktopWebRuntimeConfig {
                server_url: Some("http://127.0.0.1:3009".to_string()),
                server_context: Some("stack".to_string()),
            })
        );
    }

    #[test]
    fn skips_runtime_injection_without_stack_or_explicit_runtime_hints() {
        let env = HashMap::<&str, &str>::new();

        let resolved = resolve_desktop_web_runtime_config_with(|key| {
            env.get(key).map(|value| (*value).to_string())
        });

        assert_eq!(resolved, None);
    }

    #[test]
    fn resolves_runtime_config_from_the_launched_server_url_even_without_stack_hints() {
        let env = HashMap::from([("HAPPIER_SERVER_URL", "http://127.0.0.1:3009")]);

        let resolved = resolve_desktop_web_runtime_config_with(|key| {
            env.get(key).map(|value| (*value).to_string())
        });

        assert_eq!(
            resolved,
            Some(DesktopWebRuntimeConfig {
                server_url: Some("http://127.0.0.1:3009".to_string()),
                server_context: Some("stack".to_string()),
            })
        );
    }

    #[test]
    fn builds_initialization_script_that_merges_runtime_config() {
        let script = build_desktop_web_runtime_config_init_script(&DesktopWebRuntimeConfig {
            server_url: Some("http://127.0.0.1:3009".to_string()),
            server_context: Some("stack".to_string()),
        })
        .expect("expected runtime init script");

        assert!(script.starts_with(";("));
        assert!(script.contains("__HAPPIER_WEB_RUNTIME_CONFIG__"));
        assert!(script.contains("\"serverUrl\":\"http://127.0.0.1:3009\""));
        assert!(script.contains("\"serverContext\":\"stack\""));
        assert!(script.contains("history.replaceState"));
        assert!(script.contains("searchParams.set("));
        assert!(script.contains("\"server\""));
    }
}
