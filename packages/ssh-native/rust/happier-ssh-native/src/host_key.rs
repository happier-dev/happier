use base64::Engine as _;
use russh::keys::{PublicKey, PublicKeyBase64};
use sha2::{Digest, Sha256};

use crate::types::{NativeSshExecRequest, NativeSshHostKeyPrompt, NativeSshHostKeyVerification};

pub trait HostKeyPrompter: Send + Sync {
    fn prompt(&self, prompt: NativeSshHostKeyPrompt) -> NativeSshHostKeyVerification;
}

pub struct RejectingHostKeyPrompter;

impl HostKeyPrompter for RejectingHostKeyPrompter {
    fn prompt(&self, _prompt: NativeSshHostKeyPrompt) -> NativeSshHostKeyVerification {
        NativeSshHostKeyVerification::Reject {
            reason: Some("No native host-key prompt handler is installed.".to_string()),
        }
    }
}

pub fn fingerprint_sha256(key_blob: &[u8]) -> String {
    let digest = Sha256::digest(key_blob);
    format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)
    )
}

pub fn public_key_fingerprint_sha256(public_key: &PublicKey) -> String {
    fingerprint_sha256(public_key.public_key_bytes().as_ref())
}

pub fn host_key_algorithm(public_key: &PublicKey) -> String {
    public_key.algorithm().to_string()
}

pub fn verify_host_key_decision(
    decision: &NativeSshHostKeyVerification,
    fingerprint_sha256: &str,
) -> bool {
    match decision {
        NativeSshHostKeyVerification::AcceptOnce {
            fingerprint_sha256: expected,
        } => normalize_fingerprint(expected) == normalize_fingerprint(fingerprint_sha256),
        NativeSshHostKeyVerification::Prompt | NativeSshHostKeyVerification::Reject { .. } => false,
    }
}

pub fn expected_host_key_fingerprint(decision: &NativeSshHostKeyVerification) -> Option<String> {
    match decision {
        NativeSshHostKeyVerification::AcceptOnce { fingerprint_sha256 } => {
            Some(normalize_fingerprint(fingerprint_sha256))
        }
        NativeSshHostKeyVerification::Prompt | NativeSshHostKeyVerification::Reject { .. } => None,
    }
}

pub fn build_prompt(
    request: &NativeSshExecRequest,
    public_key: &PublicKey,
) -> NativeSshHostKeyPrompt {
    NativeSshHostKeyPrompt {
        request_id: request.request_id.clone(),
        prompt_id: format!("host-key-{}", request.request_id),
        host: request.host.clone(),
        port: request.port,
        algorithm: host_key_algorithm(public_key),
        fingerprint_sha256: public_key_fingerprint_sha256(public_key),
        status: "unknown".to_string(),
        existing_fingerprint_sha256: None,
    }
}

pub fn build_changed_prompt(
    request: &NativeSshExecRequest,
    public_key: &PublicKey,
    existing_fingerprint_sha256: String,
) -> NativeSshHostKeyPrompt {
    NativeSshHostKeyPrompt {
        status: "changed".to_string(),
        existing_fingerprint_sha256: Some(existing_fingerprint_sha256),
        ..build_prompt(request, public_key)
    }
}

fn normalize_fingerprint(value: &str) -> String {
    let trimmed = value.trim();
    if let Some(rest) = trimmed.strip_prefix("sha256:") {
        return format!("SHA256:{}", rest.trim().trim_end_matches('='));
    }
    if let Some(rest) = trimmed.strip_prefix("SHA256:") {
        return format!("SHA256:{}", rest.trim().trim_end_matches('='));
    }
    trimmed.trim_end_matches('=').to_string()
}

#[cfg(test)]
mod tests {
    use super::{expected_host_key_fingerprint, fingerprint_sha256, verify_host_key_decision};
    use crate::types::NativeSshHostKeyVerification;

    #[test]
    fn computes_openssh_style_sha256_fingerprints_without_padding() {
        assert_eq!(
            fingerprint_sha256(b"host-key"),
            "SHA256:CfEOS9w3pHE4KlqjcQFwWyWMmyRvvPoehydyMhTxpzg"
        );
    }

    #[test]
    fn accepts_matching_once_decisions_only_without_persistent_storage() {
        assert!(verify_host_key_decision(
            &NativeSshHostKeyVerification::AcceptOnce {
                fingerprint_sha256: " sha256:eWshj9Py2HDTZneZn8aqC/ZYaK/7vTfqPnsJWvERLGI= "
                    .to_string(),
            },
            "SHA256:eWshj9Py2HDTZneZn8aqC/ZYaK/7vTfqPnsJWvERLGI",
        ));
        assert!(!verify_host_key_decision(
            &NativeSshHostKeyVerification::Reject { reason: None },
            "SHA256:eWshj9Py2HDTZneZn8aqC/ZYaK/7vTfqPnsJWvERLGI",
        ));
        assert_eq!(
            expected_host_key_fingerprint(&NativeSshHostKeyVerification::AcceptOnce {
                fingerprint_sha256: "sha256:eWshj9Py2HDTZneZn8aqC/ZYaK/7vTfqPnsJWvERLGI="
                    .to_string(),
            }),
            Some("SHA256:eWshj9Py2HDTZneZn8aqC/ZYaK/7vTfqPnsJWvERLGI".to_string()),
        );
    }
}
