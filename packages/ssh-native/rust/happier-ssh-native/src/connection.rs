use std::sync::Arc;
use std::sync::Mutex;

use russh::client::{self, Config, Handler};
use russh::keys::PublicKey;
use tokio::time::{timeout, Duration};

use crate::error::NativeSshError;
use crate::host_key::{
    build_changed_prompt, build_prompt, expected_host_key_fingerprint,
    public_key_fingerprint_sha256, verify_host_key_decision, HostKeyPrompter,
};
use crate::types::{NativeSshExecRequest, NativeSshHostKeyPrompt};

#[derive(Clone)]
pub struct ClientHandler {
    request: Arc<NativeSshExecRequest>,
    prompter: Arc<dyn HostKeyPrompter>,
    observed_prompt: Arc<Mutex<Option<NativeSshHostKeyPrompt>>>,
}

impl ClientHandler {
    pub fn new(
        request: NativeSshExecRequest,
        prompter: Arc<dyn HostKeyPrompter>,
        observed_prompt: Arc<Mutex<Option<NativeSshHostKeyPrompt>>>,
    ) -> Self {
        Self {
            request: Arc::new(request),
            prompter,
            observed_prompt,
        }
    }
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        let request = Arc::clone(&self.request);
        let prompter = Arc::clone(&self.prompter);
        let observed_prompt = Arc::clone(&self.observed_prompt);
        let fingerprint = public_key_fingerprint_sha256(server_public_key);
        let initially_trusted =
            verify_host_key_decision(&request.host_key_verification, &fingerprint);
        let prompt = build_prompt(&request, server_public_key);
        async move {
            if initially_trusted {
                return Ok(true);
            }
            if !matches!(
                request.host_key_verification,
                crate::types::NativeSshHostKeyVerification::Prompt
            ) {
                if let Some(existing) =
                    expected_host_key_fingerprint(&request.host_key_verification)
                {
                    if let Ok(mut observed) = observed_prompt.lock() {
                        *observed =
                            Some(build_changed_prompt(&request, server_public_key, existing));
                    }
                }
                return Ok(false);
            }
            if let Ok(mut observed) = observed_prompt.lock() {
                *observed = Some(prompt.clone());
            }
            let response = prompter.prompt(prompt);
            Ok(verify_host_key_decision(&response, &fingerprint))
        }
    }
}

pub async fn connect(
    request: NativeSshExecRequest,
    prompter: Arc<dyn HostKeyPrompter>,
) -> Result<client::Handle<ClientHandler>, NativeSshError> {
    let config = Arc::new(Config::default());
    let timeout_ms = request.connect_timeout_ms.max(1);
    let target = (request.host.clone(), request.port);
    let observed_prompt = Arc::new(Mutex::new(None));
    let result = timeout(
        Duration::from_millis(timeout_ms),
        client::connect(
            config,
            target,
            ClientHandler::new(request, prompter, Arc::clone(&observed_prompt)),
        ),
    )
    .await
    .map_err(|_| NativeSshError::new("connection-failed", "Native SSH connection timed out."))?;
    match result {
        Ok(handle) => Ok(handle),
        Err(error) => {
            if let Ok(mut observed) = observed_prompt.lock() {
                if let Some(prompt) = observed.take() {
                    if prompt.status == "changed" {
                        return Err(NativeSshError::host_key_mismatch(prompt));
                    }
                    return Err(NativeSshError::host_key_untrusted(prompt));
                }
            }
            Err(map_connection_error(error))
        }
    }
}

fn map_connection_error(error: russh::Error) -> NativeSshError {
    if is_intercepted_ssh_transport_error(&error) {
        return NativeSshError::new(
            "network-captive-portal",
            "SSH transport was intercepted before the SSH banner.",
        );
    }
    NativeSshError::new("connection-failed", "Native SSH connection failed.")
}

fn is_intercepted_ssh_transport_error(error: &russh::Error) -> bool {
    match error {
        russh::Error::Version
        | russh::Error::KexInit
        | russh::Error::Kex
        | russh::Error::PacketSize(_)
        | russh::Error::PacketAuth
        | russh::Error::DecryptionError
        | russh::Error::StrictKeyExchangeViolation { .. } => true,
        russh::Error::IO(io_error) => matches!(
            io_error.kind(),
            std::io::ErrorKind::InvalidData | std::io::ErrorKind::UnexpectedEof
        ),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_invalid_ssh_banner_to_captive_portal_diagnostic() {
        let error = map_connection_error(russh::Error::Version);

        assert_eq!(error.code, "network-captive-portal");
    }

    #[test]
    fn keeps_refused_connections_as_connection_failed() {
        let error = map_connection_error(russh::Error::IO(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "refused",
        )));

        assert_eq!(error.code, "connection-failed");
    }
}
