use serde::Serialize;
use std::fmt::{Display, Formatter};

use crate::types::{NativeSshAuthPrompt, NativeSshHostKeyPrompt};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSshErrorPayload {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_key_prompt: Option<NativeSshHostKeyPrompt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_prompt: Option<NativeSshAuthPrompt>,
}

#[derive(Clone, Debug)]
pub struct NativeSshError {
    pub code: &'static str,
    pub message: String,
    pub host_key_prompt: Option<NativeSshHostKeyPrompt>,
    pub auth_prompt: Option<NativeSshAuthPrompt>,
}

impl NativeSshError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            host_key_prompt: None,
            auth_prompt: None,
        }
    }

    pub fn host_key_untrusted(prompt: NativeSshHostKeyPrompt) -> Self {
        Self {
            code: "host-key-untrusted",
            message: "SSH host key requires user trust.".to_string(),
            host_key_prompt: Some(prompt),
            auth_prompt: None,
        }
    }

    pub fn host_key_mismatch(prompt: NativeSshHostKeyPrompt) -> Self {
        Self {
            code: "host-key-mismatch",
            message: "SSH host key does not match the trusted fingerprint.".to_string(),
            host_key_prompt: Some(prompt),
            auth_prompt: None,
        }
    }

    pub fn auth_prompt_required(prompt: NativeSshAuthPrompt) -> Self {
        Self {
            code: "auth-prompt-required",
            message: "SSH authentication requires user input.".to_string(),
            host_key_prompt: None,
            auth_prompt: Some(prompt),
        }
    }

    pub fn payload(&self) -> NativeSshErrorPayload {
        NativeSshErrorPayload {
            code: self.code,
            message: self.message.clone(),
            host_key_prompt: self.host_key_prompt.clone(),
            auth_prompt: self.auth_prompt.clone(),
        }
    }
}

impl Display for NativeSshError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for NativeSshError {}

impl From<russh::Error> for NativeSshError {
    fn from(error: russh::Error) -> Self {
        Self::new("engine-internal", sanitize_error_message(error.to_string()))
    }
}

impl From<serde_json::Error> for NativeSshError {
    fn from(_: serde_json::Error) -> Self {
        Self::new("engine-internal", "Invalid native SSH request.")
    }
}

pub fn sanitize_error_message(message: String) -> String {
    if message.trim().is_empty() {
        return "Native SSH engine failed.".to_string();
    }
    message
        .lines()
        .next()
        .unwrap_or("Native SSH engine failed.")
        .to_string()
}
