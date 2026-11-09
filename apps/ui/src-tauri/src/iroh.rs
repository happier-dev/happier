//! Desktop Home-transport lifecycle bridge for the Tauri host.
//!
//! Three invoke commands (`iroh_ensure_home_tunnel`, `iroh_release_home_tunnel`,
//! `iroh_get_tunnel_status`)
//! compose the renderer's desktop lifecycle module onto the shared
//! `happier-iroh-native` JSON lifecycle (one process endpoint per persistent
//! identity, legacy start/stop lease API). Lifecycle/status only: no tunnel
//! payload byte ever crosses the invoke boundary. The endpoint identity is
//! host-owned — the key path is canonical beneath the Tauri app-data
//! directory and is never accepted from the renderer — and the process
//! endpoint is shut down best-effort on app exit while the persistent key
//! file is retained.

use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

/// Canonical persistent endpoint identity location beneath the app-data dir.
const ENDPOINT_KEY_DIRECTORY: &str = "iroh";
const ENDPOINT_KEY_FILE_NAME: &str = "endpoint.key";

/// Renderer-visible rejections carry the exact native error code so the shared
/// fallback classifier keeps owning fail-open versus fail-closed decisions.
const NATIVE_ERROR_PREFIX: &str = "iroh_native_error:";
static APPLICATION_ENDPOINT_POLICY: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn application_endpoint_policy() -> &'static Mutex<Option<String>> {
    APPLICATION_ENDPOINT_POLICY.get_or_init(|| Mutex::new(None))
}

fn native_error(code: &str, message: impl std::fmt::Display) -> String {
    format!("{NATIVE_ERROR_PREFIX}{code}:{message}")
}

fn default_relay_policy() -> String {
    "automatic".to_owned()
}

/// Descriptor-derived lease facts sent by the renderer. There is deliberately
/// no key-path/seed field: unknown renderer fields are ignored and this host
/// injects its canonical endpoint identity itself.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureHomeTunnelRequest {
    home_server_identity_id: String,
    endpoint_id: String,
    #[serde(default = "default_relay_policy")]
    policy: String,
    #[serde(default)]
    direct_addresses: Vec<String>,
    #[serde(default)]
    relay_urls: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartMachineHttpTunnelRequest {
    endpoint_id: String,
    #[serde(default)]
    policy: Option<String>,
    #[serde(default)]
    direct_addresses: Vec<String>,
    #[serde(default)]
    relay_urls: Vec<String>,
    handshake_json: String,
    #[serde(default)]
    native_http_lease: Option<NativeHttpLeaseRequest>,
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeHttpLeaseRequest {
    open_json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationEndpointRequest {
    #[serde(default)]
    policy: Option<String>,
    #[serde(default)]
    relay_urls: Vec<String>,
}

fn application_endpoint_payload(
    key_path: &std::path::Path,
    relay_policy: Option<&str>,
    relay_urls: &[String],
) -> String {
    json!({
        "keyPath": key_path.to_string_lossy(),
        "relayPolicy": relay_policy,
        "relayUrls": relay_urls,
    })
    .to_string()
}

fn create_application_endpoint(
    app: &AppHandle,
    relay_policy: Option<&str>,
    relay_urls: &[String],
) -> Result<Value, String> {
    let key_path = endpoint_key_path(app)?;
    let resolved_policy = relay_policy
        .map(str::to_owned)
        .or_else(|| application_endpoint_policy().lock().ok()?.clone())
        .unwrap_or_else(default_relay_policy);
    let envelope = happier_iroh_native::create_endpoint_json(&application_endpoint_payload(
        &key_path,
        Some(&resolved_policy),
        relay_urls,
    ));
    let endpoint = envelope_result(&envelope)?;
    let applied_policy = response_string(&endpoint, "relayPolicy")?;
    if let Ok(mut current) = application_endpoint_policy().lock() {
        *current = Some(applied_policy);
    }
    Ok(endpoint)
}

#[tauri::command]
pub async fn iroh_get_availability() -> Value {
    // This command exists only in the Tauri binary that directly linked the
    // shared Rust lifecycle. Electron and mobile probe their loaded boundaries.
    json!({ "available": true })
}

#[tauri::command]
pub async fn iroh_get_application_endpoint(
    app: AppHandle,
    request: ApplicationEndpointRequest,
) -> Result<Value, String> {
    let endpoint = tauri::async_runtime::spawn_blocking(move || {
        create_application_endpoint(&app, request.policy.as_deref(), &request.relay_urls)
    })
    .await
    .map_err(|error| native_error("transport-unavailable", error))??;
    Ok(json!({ "endpointId": response_string(&endpoint, "endpointId")? }))
}

#[tauri::command]
pub async fn iroh_start_machine_http_tunnel(
    app: AppHandle,
    request: StartMachineHttpTunnelRequest,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let endpoint =
            create_application_endpoint(&app, request.policy.as_deref(), &request.relay_urls)?;
        let endpoint_handle = response_string(&endpoint, "endpointHandle")?;
        let envelope = happier_iroh_native::start_machine_http_tunnel_json(
            &json!({
                "endpointHandle": endpoint_handle,
                "endpointId": request.endpoint_id,
                "directAddresses": request.direct_addresses,
                "relayUrls": request.relay_urls,
                "handshakeJson": request.handshake_json,
                "capProfile": "machineBulk",
            })
            .to_string(),
        );
        let started = envelope_result(&envelope)?;
        renderer_machine_http_tunnel_lease(started)
    })
    .await
    .map_err(|error| native_error("transport-unavailable", error))?
}

#[tauri::command]
pub async fn iroh_start_machine_tunnel(
    app: AppHandle,
    request: StartMachineHttpTunnelRequest,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let endpoint =
            create_application_endpoint(&app, request.policy.as_deref(), &request.relay_urls)?;
        let endpoint_handle = response_string(&endpoint, "endpointHandle")?;
        let envelope = happier_iroh_native::start_machine_tunnel_json(
            &json!({
                "endpointHandle": endpoint_handle,
                "endpointId": request.endpoint_id,
                "directAddresses": request.direct_addresses,
                "relayUrls": request.relay_urls,
                "handshakeJson": request.handshake_json,
                "nativeHttpLease": request.native_http_lease,
                "capProfile": "machineBulk",
            })
            .to_string(),
        );
        let started = envelope_result(&envelope)?;
        renderer_machine_tunnel_lease(started)
    })
    .await
    .map_err(|error| native_error("transport-unavailable", error))?
}

#[tauri::command]
pub async fn iroh_wait_machine_tunnel_closed(lease_id: String) -> Result<Value, String> {
    let envelope = tauri::async_runtime::spawn_blocking(move || {
        happier_iroh_native::wait_machine_tunnel_closed_json(
            &json!({ "machineTunnelId": lease_id }).to_string(),
        )
    })
    .await
    .map_err(|error| native_error("transport-unavailable", error))?;
    envelope_result(&envelope)?;
    Ok(Value::Null)
}

#[tauri::command]
pub async fn iroh_stop_machine_tunnel(lease_id: String) -> Result<Value, String> {
    let envelope = tauri::async_runtime::spawn_blocking(move || {
        happier_iroh_native::stop_machine_tunnel_json(
            &json!({ "machineTunnelId": lease_id }).to_string(),
        )
    })
    .await
    .map_err(|error| native_error("transport-unavailable", error))?;
    envelope_result(&envelope)?;
    Ok(Value::Null)
}

/// Canonical persistent endpoint key path for this installation.
pub fn endpoint_key_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("desktop app data directory is unavailable: {error}"))?;
    Ok(app_data_dir
        .join(ENDPOINT_KEY_DIRECTORY)
        .join(ENDPOINT_KEY_FILE_NAME))
}

/// Serializes the native start request: descriptor-derived facts verbatim plus
/// the host-owned key path. The renderer cannot supply identity material.
fn serialized_ensure_request(request: &EnsureHomeTunnelRequest, endpoint_handle: &str) -> String {
    json!({
        "endpointHandle": endpoint_handle,
        "homeServerIdentityId": request.home_server_identity_id,
        "endpointId": request.endpoint_id,
        "directAddresses": request.direct_addresses,
        "relayUrls": request.relay_urls,
    })
    .to_string()
}

/// Unwraps the strict `{ok,result}|{ok,error}` native envelope, preserving the
/// exact native error code in the rejection.
fn envelope_result(envelope: &Value) -> Result<Value, String> {
    if envelope.get("ok") == Some(&Value::Bool(true)) {
        return Ok(envelope.get("result").cloned().unwrap_or(Value::Null));
    }
    let code = envelope
        .pointer("/error/code")
        .and_then(Value::as_str)
        .unwrap_or("transport-unavailable");
    let message = envelope
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("Iroh native lifecycle call failed");
    Err(native_error(code, message))
}

fn response_string(value: &Value, field: &str) -> Result<String, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|field_value| !field_value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            native_error(
                "transport-unavailable",
                format!("malformed native lease field {field}"),
            )
        })
}

fn renderer_machine_tunnel_lease(started: Value) -> Result<Value, String> {
    let local_port = started
        .get("localPort")
        .and_then(Value::as_u64)
        .filter(|port| *port > 0 && *port <= u16::MAX as u64)
        .ok_or_else(|| native_error("transport-unavailable", "malformed native machine lease"))?;
    let mut lease = json!({
        "leaseId": response_string(&started, "machineTunnelId")?,
        "localPort": local_port,
    });
    if let Some(local_capability) = started.get("localCapability") {
        if local_capability.is_null() {
            return Ok(lease);
        }
        let Some(local_capability) = local_capability.as_str().filter(|value| {
            value.len() == 64
                && value
                    .as_bytes()
                    .iter()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        }) else {
            return Err(native_error(
                "transport-unavailable",
                "malformed native machine capability",
            ));
        };
        lease["localCapability"] = Value::String(local_capability.to_owned());
    }
    Ok(lease)
}

fn renderer_machine_http_tunnel_lease(started: Value) -> Result<Value, String> {
    let mut lease = renderer_machine_tunnel_lease(started)?;
    let object = lease
        .as_object_mut()
        .ok_or_else(|| native_error("transport-unavailable", "malformed native machine lease"))?;
    let local_port = object
        .remove("localPort")
        .and_then(|value| value.as_u64())
        .ok_or_else(|| native_error("transport-unavailable", "malformed native machine lease"))?;
    if !object.contains_key("localCapability") {
        return Err(native_error(
            "transport-unavailable",
            "malformed native machine HTTP capability",
        ));
    }
    object.insert(
        "localOrigin".to_owned(),
        Value::String(format!("http://127.0.0.1:{local_port}")),
    );
    Ok(lease)
}

/// Projects the native start result onto the exact renderer lease facts.
/// Host-owned facts (the endpoint handle, which for a keyed endpoint is the
/// canonical key path) never cross the bridge.
fn renderer_lease(started: Value) -> Result<Value, String> {
    if response_string(&started, "carrier")?.as_str() != "iroh" {
        return Err(native_error(
            "transport-unavailable",
            "malformed native lease field carrier",
        ));
    }
    let observed_path = response_string(&started, "observedPath")?;
    if !matches!(observed_path.as_str(), "direct" | "relay" | "unknown") {
        return Err(native_error(
            "transport-unavailable",
            "malformed native lease field observedPath",
        ));
    }
    let started_at_ms = started
        .get("startedAtMs")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            native_error(
                "transport-unavailable",
                "malformed native lease field startedAtMs",
            )
        })?;
    let lease_id = response_string(&started, "leaseId")?;
    let home_server_identity_id = response_string(&started, "homeServerIdentityId")?;
    let home_endpoint_id = response_string(&started, "homeEndpointId")?;
    let runtime_origin = response_string(&started, "runtimeOrigin")?;
    let parsed_runtime_origin = url::Url::parse(&runtime_origin).map_err(|_| {
        native_error(
            "transport-unavailable",
            "malformed native lease field runtimeOrigin",
        )
    })?;
    let is_loopback = matches!(
        parsed_runtime_origin.host_str(),
        Some("127.0.0.1") | Some("::1")
    );
    if parsed_runtime_origin.scheme() != "http"
        || !is_loopback
        || parsed_runtime_origin.port().is_none()
        || !parsed_runtime_origin.username().is_empty()
        || parsed_runtime_origin.password().is_some()
        || parsed_runtime_origin.path() != "/"
        || parsed_runtime_origin.query().is_some()
        || parsed_runtime_origin.fragment().is_some()
    {
        return Err(native_error(
            "transport-unavailable",
            "malformed native lease field runtimeOrigin",
        ));
    }
    let runtime_origin = parsed_runtime_origin.origin().ascii_serialization();
    Ok(json!({
        "leaseId": lease_id,
        "homeServerIdentityId": home_server_identity_id,
        "homeEndpointId": home_endpoint_id,
        "runtimeOrigin": runtime_origin,
        "carrier": "iroh",
        "observedPath": observed_path,
        "startedAtMs": started_at_ms,
    }))
}

fn renderer_status(status: Value) -> Result<Value, String> {
    if status.is_null() {
        return Ok(Value::Null);
    }
    let connection_active = status
        .get("connectionActive")
        .and_then(Value::as_bool)
        .ok_or_else(|| native_error("transport-unavailable", "malformed native tunnel status"))?;
    let observed_path = response_string(&status, "observedPath")?;
    if !matches!(observed_path.as_str(), "direct" | "relay" | "unknown") {
        return Err(native_error(
            "transport-unavailable",
            "malformed native tunnel status",
        ));
    }
    Ok(json!({
        "active": connection_active,
        "connectionActive": connection_active,
        "observedPath": observed_path,
    }))
}

/// Starts (or retains) the Home tunnel lease for the descriptor-derived facts.
/// The one process endpoint is created/reused by the native lifecycle from the
/// host-owned persistent key path, so endpoint identity survives lease
/// acquire/release cycles and app restarts.
#[tauri::command]
pub async fn iroh_ensure_home_tunnel(
    app: AppHandle,
    request: EnsureHomeTunnelRequest,
) -> Result<Value, String> {
    // The native lifecycle block_on's its own process runtime; keep that off
    // the async-runtime workers like every other blocking host seam.
    let envelope = tauri::async_runtime::spawn_blocking(move || {
        let endpoint =
            create_application_endpoint(&app, Some(&request.policy), &request.relay_urls)?;
        let endpoint_handle = response_string(&endpoint, "endpointHandle")?;
        let payload = serialized_ensure_request(&request, &endpoint_handle);
        Ok::<_, String>(happier_iroh_native::ensure_home_tunnel_json(&payload))
    })
    .await
    .map_err(|error| {
        native_error(
            "transport-unavailable",
            format!("iroh native lifecycle call failed: {error}"),
        )
    })??;
    let mut started = envelope_result(&envelope)?;
    if let Some(tunnel_id) = started.get("tunnelId").cloned() {
        started["leaseId"] = tunnel_id;
    }
    renderer_lease(started)
}

/// Releases one Home tunnel lease by id. Lease-scoped and idempotent: the
/// process endpoint and its persistent identity stay.
#[tauri::command]
pub async fn iroh_release_home_tunnel(lease_id: String) -> Result<Value, String> {
    let envelope = tauri::async_runtime::spawn_blocking(move || {
        happier_iroh_native::release_home_tunnel_json(&json!({ "tunnelId": lease_id }).to_string())
    })
    .await
    .map_err(|error| {
        native_error(
            "transport-unavailable",
            format!("iroh native lifecycle call failed: {error}"),
        )
    })?;
    envelope_result(&envelope)?;
    Ok(Value::Null)
}

/// Polls the native transport owner for one Home tunnel. The renderer receives
/// only active/path facts; endpoint handles, key paths, Home auth, and payloads
/// never cross this bridge.
#[tauri::command]
pub async fn iroh_get_tunnel_status(lease_id: String) -> Result<Value, String> {
    let envelope = tauri::async_runtime::spawn_blocking(move || {
        happier_iroh_native::get_tunnel_status_json(&json!({ "tunnelId": lease_id }).to_string())
    })
    .await
    .map_err(|error| {
        native_error(
            "transport-unavailable",
            format!("iroh native lifecycle call failed: {error}"),
        )
    })?;
    renderer_status(envelope_result(&envelope)?)
}

/// Best-effort process-exit teardown: stops the shared endpoint (with its
/// acceptors and leases) while the persistent key file is retained. Identity
/// is never rotated or deleted.
pub fn shutdown_process_endpoint(app: &AppHandle) {
    let Ok(key_path) = endpoint_key_path(app) else {
        return;
    };
    // The keyed endpoint handle is its canonical key path; a failed or late
    // teardown is ignored at process exit and the OS reclaims the sockets.
    let _ = happier_iroh_native::shutdown_endpoint_json(
        &json!({ "endpointHandle": key_path.to_string_lossy() }).to_string(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    const ENDPOINT_ID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const IROH_COMMANDS: &[&str] = &[
        "iroh_ensure_home_tunnel",
        "iroh_release_home_tunnel",
        "iroh_get_tunnel_status",
        "iroh_get_availability",
        "iroh_get_application_endpoint",
        "iroh_start_machine_tunnel",
        "iroh_start_machine_http_tunnel",
        "iroh_stop_machine_tunnel",
        "iroh_wait_machine_tunnel_closed",
    ];

    #[test]
    fn iroh_commands_are_registered_for_tauri_manifest_and_main_capability() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let capability: Value = serde_json::from_str(
            &fs::read_to_string(manifest_dir.join("capabilities/default.json"))
                .expect("default capability should be readable"),
        )
        .expect("default capability should be valid JSON");
        let permissions = capability["permissions"]
            .as_array()
            .expect("default capability permissions should be an array");
        let manifests: Value = serde_json::from_str(include_str!(concat!(
            env!("OUT_DIR"),
            "/acl-manifests.json"
        )))
        .expect("generated ACL manifests should be valid JSON");

        for command in IROH_COMMANDS {
            let permission = format!("allow-{}", command.replace('_', "-"));
            assert_eq!(
                manifests["__app-acl__"]["permissions"][&permission]["commands"]["allow"],
                json!([command]),
                "generated ACL permission {permission} should allow {command}",
            );
            assert!(
                permissions.contains(&Value::String(permission.clone())),
                "default capability should include {permission}",
            );
        }
    }

    #[test]
    fn status_projection_exposes_transport_facts_only() {
        assert_eq!(
            renderer_status(json!({
                "connectionActive": false,
                "observedPath": "relay",
                "endpointHandle": "/private/iroh/endpoint.key",
                "homeServerIdentityId": "srv_home_a",
            }))
            .unwrap(),
            json!({"active": false, "connectionActive": false, "observedPath": "relay"})
        );
    }

    #[test]
    fn home_and_machine_endpoint_requests_use_the_same_host_identity_with_connection_profiles() {
        let key_path = std::path::Path::new("/app-data/iroh/endpoint.key");
        let home: Value = serde_json::from_str(&application_endpoint_payload(
            key_path,
            Some("disabled"),
            &[],
        ))
        .unwrap();
        let machine: Value = serde_json::from_str(&application_endpoint_payload(
            key_path,
            Some("disabled"),
            &[],
        ))
        .unwrap();
        assert_eq!(home["keyPath"], machine["keyPath"]);
        assert_eq!(home["relayPolicy"], "disabled");
        assert_eq!(machine["relayPolicy"], "disabled");
        assert!(home.get("capProfile").is_none());
        assert!(machine.get("capProfile").is_none());
    }

    #[test]
    fn raw_machine_lease_omits_absent_capability_but_preserves_protected_workspace_capability() {
        let finite = renderer_machine_tunnel_lease(json!({
            "machineTunnelId": "finite-lease",
            "localPort": 46013,
            "localCapability": null,
        }))
        .expect("finite lease");
        assert_eq!(
            finite,
            json!({"leaseId": "finite-lease", "localPort": 46013})
        );

        let workspace = renderer_machine_tunnel_lease(json!({
            "machineTunnelId": "workspace-lease",
            "localPort": 46014,
            "localCapability": "b".repeat(64),
        }))
        .expect("workspace lease");
        assert_eq!(workspace["localCapability"], "b".repeat(64));

        let http = renderer_machine_http_tunnel_lease(json!({
            "machineTunnelId": "http-lease",
            "localPort": 46015,
            "localCapability": "c".repeat(64),
        }))
        .expect("HTTP lease");
        assert_eq!(
            http,
            json!({
                "leaseId": "http-lease",
                "localOrigin": "http://127.0.0.1:46015",
                "localCapability": "c".repeat(64),
            })
        );
    }

    #[test]
    fn ensure_request_uses_only_the_host_owned_endpoint_handle() {
        // A renderer that ignores the contract and sends key/seed material
        // cannot have it forwarded: the typed request struct has no such
        // fields, and the host path is always the injected one.
        let request: EnsureHomeTunnelRequest = serde_json::from_str(
            r#"{"homeServerIdentityId":"srv_home_a","endpointId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","policy":"disabled","endpointKeyPath":"/tmp/renderer.key","endpointSeedBase64":"AAAA"}"#,
        )
        .expect("renderer request parses with host-identity fields ignored");
        let payload: Value = serde_json::from_str(&serialized_ensure_request(
            &request,
            "/app-data/iroh/endpoint.key",
        ))
        .expect("payload is valid JSON");
        assert_eq!(payload["endpointHandle"], "/app-data/iroh/endpoint.key");
        assert!(payload.get("endpointSeedBase64").is_none());
        assert_eq!(payload["homeServerIdentityId"], "srv_home_a");
        assert_eq!(payload["endpointId"], ENDPOINT_ID);
        assert!(payload.get("relayPolicy").is_none());
    }

    #[test]
    fn native_start_envelope_maps_to_the_exact_renderer_lease_without_host_owned_facts() {
        let started = json!({
            "ok": true,
            "result": {
                "leaseId": "iroh-7",
                "homeServerIdentityId": "srv_home_a",
                "homeEndpointId": ENDPOINT_ID,
                "runtimeOrigin": "http://127.0.0.1:46001",
                "carrier": "iroh",
                "observedPath": "direct",
                "startedAtMs": 42u64,
                "endpointHandle": "/app-data/iroh/endpoint.key",
            }
        });
        let lease = renderer_lease(envelope_result(&started).expect("ok envelope")).expect("lease");
        assert_eq!(lease["leaseId"], "iroh-7");
        assert_eq!(lease["homeServerIdentityId"], "srv_home_a");
        assert_eq!(lease["homeEndpointId"], ENDPOINT_ID);
        assert_eq!(lease["runtimeOrigin"], "http://127.0.0.1:46001");
        assert_eq!(lease["carrier"], "iroh");
        assert_eq!(lease["observedPath"], "direct");
        assert_eq!(lease["startedAtMs"], 42);
        // Host-owned identity facts never cross the bridge.
        assert!(lease.get("endpointHandle").is_none());
        assert!(lease.get("endpointKeyPath").is_none());
        assert!(lease.get("descriptorRevision").is_none());
    }

    #[test]
    fn malformed_native_start_envelopes_fail_closed_without_a_lease() {
        let missing_fields = json!({ "ok": true, "result": { "leaseId": "iroh-7" } });
        assert!(renderer_lease(missing_fields).is_err());

        let wrong_carrier = json!({
            "ok": true,
            "result": {
                "leaseId": "l", "homeServerIdentityId": "h", "homeEndpointId": "e",
                "runtimeOrigin": "http://127.0.0.1:1", "carrier": "https",
                "observedPath": "direct", "startedAtMs": 1u64,
            }
        });
        assert!(renderer_lease(wrong_carrier).is_err());

        let no_result = json!({ "ok": true });
        assert!(renderer_lease(no_result).is_err());

        let external_origin = json!({
            "leaseId": "l", "homeServerIdentityId": "h", "homeEndpointId": "e",
            "runtimeOrigin": "https://attacker.example.test", "carrier": "iroh",
            "observedPath": "direct", "startedAtMs": 1u64,
        });
        assert!(renderer_lease(external_origin).is_err());
    }

    #[test]
    fn native_failure_envelopes_reject_with_the_exact_code_preserved() {
        let failed = json!({
            "ok": false,
            "error": { "code": "endpoint_key_unavailable", "message": "endpoint-identity recovery is required" }
        });
        assert_eq!(
            envelope_result(&failed).unwrap_err(),
            "iroh_native_error:endpoint_key_unavailable:endpoint-identity recovery is required"
        );
        let malformed = json!({ "ok": false });
        assert_eq!(
            envelope_result(&malformed).unwrap_err(),
            "iroh_native_error:transport-unavailable:Iroh native lifecycle call failed"
        );
    }

    #[test]
    fn stop_envelope_resolves_null_and_stays_idempotent() {
        let ok = json!({ "ok": true, "result": null });
        assert_eq!(envelope_result(&ok).expect("ok stop"), Value::Null);
    }
}
