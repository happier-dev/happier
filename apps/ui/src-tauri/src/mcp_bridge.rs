use tauri::plugin::TauriPlugin;
use tauri::Runtime;
use tauri_plugin_mcp_bridge::Builder as McpBridgeBuilder;

const DEFAULT_DEBUG_MCP_BRIDGE_BIND_ADDRESS: &str = "127.0.0.1";

fn read_non_empty_env_with<F>(read_env: &F, key: &str) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    read_env(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn resolve_debug_mcp_bridge_bind_address_with<F>(read_env: F) -> String
where
    F: Fn(&str) -> Option<String>,
{
    read_non_empty_env_with(&read_env, "HAPPIER_TAURI_MCP_BRIDGE_BIND_ADDRESS")
        .unwrap_or_else(|| DEFAULT_DEBUG_MCP_BRIDGE_BIND_ADDRESS.to_string())
}

pub(crate) fn build_debug_mcp_bridge_plugin<R: Runtime>() -> TauriPlugin<R> {
    let bind_address = resolve_debug_mcp_bridge_bind_address_with(|key| std::env::var(key).ok());
    McpBridgeBuilder::new().bind_address(&bind_address).build()
}

#[cfg(test)]
mod tests {
    use super::resolve_debug_mcp_bridge_bind_address_with;
    use std::collections::HashMap;

    #[test]
    fn defaults_debug_mcp_bridge_to_localhost_only() {
        let env = HashMap::<&str, &str>::new();

        let resolved = resolve_debug_mcp_bridge_bind_address_with(|key| {
            env.get(key).map(|value| (*value).to_string())
        });

        assert_eq!(resolved, "127.0.0.1");
    }

    #[test]
    fn allows_explicit_debug_mcp_bridge_bind_address_override() {
        let env = HashMap::from([("HAPPIER_TAURI_MCP_BRIDGE_BIND_ADDRESS", "  0.0.0.0  ")]);

        let resolved = resolve_debug_mcp_bridge_bind_address_with(|key| {
            env.get(key).map(|value| (*value).to_string())
        });

        assert_eq!(resolved, "0.0.0.0");
    }
}
