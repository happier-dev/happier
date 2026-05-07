use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSshAuthRequest {
    pub username: String,
    pub password: Option<String>,
    pub private_key_pem: Option<String>,
    pub private_key_passphrase: Option<String>,
    #[serde(default)]
    pub private_key_passphrase_attempts: u32,
    #[serde(default)]
    pub keyboard_interactive_answers: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct NativeSshAuthContext {
    pub request_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "decision", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum NativeSshHostKeyVerification {
    Prompt,
    AcceptOnce { fingerprint_sha256: String },
    Reject { reason: Option<String> },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSshExecRequest {
    pub request_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub command: String,
    pub auth: NativeSshAuthRequest,
    pub connect_timeout_ms: u64,
    pub auth_timeout_ms: u64,
    pub exec_timeout_ms: u64,
    pub host_key_verification: NativeSshHostKeyVerification,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSshLoopbackTunnelRequest {
    pub request_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: NativeSshAuthRequest,
    pub host_key_verification: NativeSshHostKeyVerification,
    pub destination_host: String,
    pub destination_port: u16,
    pub requested_local_port: Option<u16>,
    pub connect_timeout_ms: u64,
    pub auth_timeout_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSshExecResult {
    pub exit_code: Option<u32>,
    pub stdout: String,
    pub stderr: String,
    pub signal: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSshHostKeyPrompt {
    pub request_id: String,
    pub prompt_id: String,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint_sha256: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub existing_fingerprint_sha256: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSshKeyboardInteractivePrompt {
    pub id: String,
    pub label: String,
    pub echo: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSshAuthPrompt {
    pub request_id: String,
    pub prompt_id: String,
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempts_remaining: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub prompts: Vec<NativeSshKeyboardInteractivePrompt>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSshLoopbackTunnelResult {
    pub native_tunnel_id: String,
    pub local_port: u16,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::NativeSshHostKeyVerification;

    #[test]
    fn parses_accept_once_with_camel_case_fingerprint_field() {
        let parsed = serde_json::from_value::<NativeSshHostKeyVerification>(json!({
            "decision": "accept-once",
            "fingerprintSha256": "SHA256:abc"
        }));

        assert!(matches!(
            parsed,
            Ok(NativeSshHostKeyVerification::AcceptOnce { fingerprint_sha256 }) if fingerprint_sha256 == "SHA256:abc"
        ));
    }

    #[test]
    fn rejects_transport_owned_persistent_host_key_trust() {
        let parsed = serde_json::from_value::<NativeSshHostKeyVerification>(json!({
            "decision": "accept-and-store",
            "fingerprintSha256": "SHA256:abc"
        }));

        assert!(parsed.is_err());
    }
}
