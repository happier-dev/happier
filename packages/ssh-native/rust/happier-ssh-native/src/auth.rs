use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use russh::client::KeyboardInteractiveAuthResponse;
use russh::keys::{decode_secret_key, Error as RusshKeyError, PrivateKey, PrivateKeyWithHashAlg};

use crate::error::NativeSshError;
use crate::types::{
    NativeSshAuthContext, NativeSshAuthPrompt, NativeSshAuthRequest,
    NativeSshKeyboardInteractivePrompt,
};

const PRIVATE_KEY_PASSPHRASE_ATTEMPTS: u32 = 3;

pub async fn authenticate(
    session: &mut russh::client::Handle<crate::connection::ClientHandler>,
    context: &NativeSshAuthContext,
    auth: &NativeSshAuthRequest,
) -> Result<(), NativeSshError> {
    if auth.private_key_pem.is_some() {
        let key = decode_private_key_for_auth(context, auth)?;
        let hash_alg = session.best_supported_rsa_hash().await?.flatten();
        if session
            .authenticate_publickey(
                &context.username,
                PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
            )
            .await?
            .success()
        {
            return Ok(());
        }
    }

    if let Some(password) = auth.password.as_deref() {
        if session
            .authenticate_password(&context.username, password)
            .await?
            .success()
        {
            return Ok(());
        }
    }

    {
        let mut response = session
            .authenticate_keyboard_interactive_start(&context.username, None)
            .await?;
        let mut answer_offset = 0usize;
        loop {
            match response {
                KeyboardInteractiveAuthResponse::Success => return Ok(()),
                KeyboardInteractiveAuthResponse::Failure { .. } => break,
                KeyboardInteractiveAuthResponse::InfoRequest {
                    name,
                    instructions,
                    prompts,
                } => {
                    let count = prompts.len();
                    if answer_offset + count > auth.keyboard_interactive_answers.len() {
                        return Err(keyboard_interactive_required_error(
                            context,
                            empty_string_to_option(name),
                            empty_string_to_option(instructions),
                            prompts
                                .into_iter()
                                .enumerate()
                                .map(|(index, prompt)| NativeSshKeyboardInteractivePrompt {
                                    id: index.to_string(),
                                    label: prompt.prompt,
                                    echo: prompt.echo,
                                })
                                .collect(),
                        ));
                    }
                    let answers = auth.keyboard_interactive_answers
                        [answer_offset..answer_offset + count]
                        .to_vec();
                    answer_offset += count;
                    response = session
                        .authenticate_keyboard_interactive_respond(answers)
                        .await?;
                }
            }
        }
    }

    Err(NativeSshError::new(
        "authentication-failed",
        "Native SSH authentication failed.",
    ))
}

fn decode_private_key_for_auth(
    context: &NativeSshAuthContext,
    auth: &NativeSshAuthRequest,
) -> Result<PrivateKey, NativeSshError> {
    let Some(private_key_pem) = auth.private_key_pem.as_deref() else {
        return Err(private_key_decode_failed_error(context, auth, false));
    };

    let key_is_encrypted = is_encrypted_private_key_pem(private_key_pem);
    if auth.private_key_passphrase.is_none() && key_is_encrypted {
        return Err(private_key_passphrase_required_error(
            context,
            PRIVATE_KEY_PASSPHRASE_ATTEMPTS,
        ));
    }

    decode_secret_key(private_key_pem, auth.private_key_passphrase.as_deref()).map_err(|error| {
        private_key_decode_failed_error(
            context,
            auth,
            key_is_encrypted || matches!(error, RusshKeyError::KeyIsEncrypted),
        )
    })
}

fn private_key_decode_failed_error(
    context: &NativeSshAuthContext,
    auth: &NativeSshAuthRequest,
    key_is_encrypted: bool,
) -> NativeSshError {
    if key_is_encrypted {
        if auth.private_key_passphrase.is_none() {
            return private_key_passphrase_required_error(context, PRIVATE_KEY_PASSPHRASE_ATTEMPTS);
        }

        let attempts_used = auth.private_key_passphrase_attempts.max(1);
        if attempts_used < PRIVATE_KEY_PASSPHRASE_ATTEMPTS {
            return private_key_passphrase_required_error(
                context,
                PRIVATE_KEY_PASSPHRASE_ATTEMPTS - attempts_used,
            );
        }
    }

    NativeSshError::new(
        "authentication-failed",
        "Native SSH private key could not be decoded.",
    )
}

pub fn private_key_passphrase_required_error(
    context: &NativeSshAuthContext,
    attempts_remaining: u32,
) -> NativeSshError {
    NativeSshError::auth_prompt_required(NativeSshAuthPrompt {
        request_id: context.request_id.clone(),
        prompt_id: format!("auth-passphrase-{}", context.request_id),
        kind: "private-key-passphrase".to_string(),
        host: context.host.clone(),
        port: context.port,
        username: context.username.clone(),
        key_label: None,
        attempts_remaining: Some(attempts_remaining),
        name: None,
        instruction: None,
        prompts: Vec::new(),
    })
}

pub fn keyboard_interactive_required_error(
    context: &NativeSshAuthContext,
    name: Option<String>,
    instruction: Option<String>,
    prompts: Vec<NativeSshKeyboardInteractivePrompt>,
) -> NativeSshError {
    NativeSshError::auth_prompt_required(NativeSshAuthPrompt {
        request_id: context.request_id.clone(),
        prompt_id: format!("auth-kbi-{}", context.request_id),
        kind: "keyboard-interactive".to_string(),
        host: context.host.clone(),
        port: context.port,
        username: context.username.clone(),
        key_label: None,
        attempts_remaining: None,
        name,
        instruction,
        prompts,
    })
}

fn is_encrypted_private_key_pem(private_key_pem: &str) -> bool {
    private_key_pem.contains("ENCRYPTED PRIVATE KEY")
        || private_key_pem.contains("Proc-Type: 4,ENCRYPTED")
        || is_encrypted_openssh_private_key_pem(private_key_pem)
}

fn is_encrypted_openssh_private_key_pem(private_key_pem: &str) -> bool {
    let Some(body) = collect_pem_body(
        private_key_pem,
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "-----END OPENSSH PRIVATE KEY-----",
    ) else {
        return false;
    };
    let Ok(bytes) = BASE64_STANDARD.decode(body.as_bytes()) else {
        return false;
    };
    let Some(rest) = bytes.strip_prefix(b"openssh-key-v1\0") else {
        return false;
    };
    let mut offset = 0usize;
    let Some(cipher_name) = read_ssh_string(rest, &mut offset) else {
        return false;
    };
    let Some(kdf_name) = read_ssh_string(rest, &mut offset) else {
        return false;
    };

    cipher_name != b"none" || kdf_name != b"none"
}

fn collect_pem_body(private_key_pem: &str, begin: &str, end: &str) -> Option<String> {
    let mut started = false;
    let mut body = String::new();
    for line in private_key_pem.lines() {
        let trimmed = line.trim();
        if trimmed == begin {
            started = true;
            continue;
        }
        if trimmed == end {
            return Some(body);
        }
        if started {
            body.push_str(trimmed);
        }
    }
    None
}

fn read_ssh_string<'a>(bytes: &'a [u8], offset: &mut usize) -> Option<&'a [u8]> {
    let length_bytes = bytes.get(*offset..*offset + 4)?;
    let length = u32::from_be_bytes(length_bytes.try_into().ok()?) as usize;
    *offset += 4;
    let value = bytes.get(*offset..*offset + length)?;
    *offset += length;
    Some(value)
}

fn empty_string_to_option(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{NativeSshAuthContext, NativeSshKeyboardInteractivePrompt};

    fn context() -> NativeSshAuthContext {
        NativeSshAuthContext {
            request_id: "request-1".to_string(),
            host: "Example.COM".to_string(),
            port: 2222,
            username: "dev".to_string(),
        }
    }

    #[test]
    fn private_key_passphrase_prompt_error_carries_request_context() {
        let error = private_key_passphrase_required_error(&context(), 3);

        assert_eq!(error.code, "auth-prompt-required");
        let prompt = error.auth_prompt.expect("auth prompt");
        assert_eq!(prompt.kind, "private-key-passphrase");
        assert_eq!(prompt.request_id, "request-1");
        assert_eq!(prompt.prompt_id, "auth-passphrase-request-1");
        assert_eq!(prompt.host, "Example.COM");
        assert_eq!(prompt.port, 2222);
        assert_eq!(prompt.username, "dev");
        assert_eq!(prompt.attempts_remaining, Some(3));
    }

    #[test]
    fn keyboard_interactive_prompt_error_preserves_prompt_order_and_echo() {
        let error = keyboard_interactive_required_error(
            &context(),
            Some("MFA".to_string()),
            Some("Enter the OTP".to_string()),
            vec![
                NativeSshKeyboardInteractivePrompt {
                    id: "0".to_string(),
                    label: "Password:".to_string(),
                    echo: false,
                },
                NativeSshKeyboardInteractivePrompt {
                    id: "1".to_string(),
                    label: "Token:".to_string(),
                    echo: true,
                },
            ],
        );

        assert_eq!(error.code, "auth-prompt-required");
        let prompt = error.auth_prompt.expect("auth prompt");
        assert_eq!(prompt.kind, "keyboard-interactive");
        assert_eq!(prompt.prompt_id, "auth-kbi-request-1");
        assert_eq!(prompt.name.as_deref(), Some("MFA"));
        assert_eq!(prompt.instruction.as_deref(), Some("Enter the OTP"));
        assert_eq!(prompt.prompts.len(), 2);
        assert_eq!(prompt.prompts[0].id, "0");
        assert!(!prompt.prompts[0].echo);
        assert_eq!(prompt.prompts[1].id, "1");
        assert!(prompt.prompts[1].echo);
    }

    const ENCRYPTED_OPENSSH_ED25519_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABD1phlku5
A2G7Q9iP+DcOc9AAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIHeLC1lWiCYrXsf/
85O/pkbUFZ6OGIt49PX3nw8iRoXEAAAAkKRF0st5ZI7xxo9g6A4m4l6NarkQre3mycqNXQ
dP3jryYgvsCIBAA5jMWSjrmnOTXhidqcOy4xYCrAttzSnZ/cUadfBenL+DQq6neffw7j8r
0tbCxVGp6yCQlKrgSZf6c0Hy7dNEIU2bJFGxLe6/kWChcUAt/5Ll5rI7DVQPJdLgehLzvv
sJWR7W+cGvJ/vLsw==
-----END OPENSSH PRIVATE KEY-----";

    #[test]
    fn detects_openssh_format_encrypted_private_keys() {
        assert!(is_encrypted_private_key_pem(ENCRYPTED_OPENSSH_ED25519_KEY));
    }

    #[test]
    fn missing_openssh_private_key_passphrase_requests_prompt() {
        let auth = NativeSshAuthRequest {
            username: "dev".to_string(),
            password: None,
            private_key_pem: Some(ENCRYPTED_OPENSSH_ED25519_KEY.to_string()),
            private_key_passphrase: None,
            private_key_passphrase_attempts: 0,
            keyboard_interactive_answers: Vec::new(),
        };

        let error = decode_private_key_for_auth(&context(), &auth).expect_err("auth prompt");

        assert_eq!(error.code, "auth-prompt-required");
        assert_eq!(
            error.auth_prompt.expect("auth prompt").attempts_remaining,
            Some(PRIVATE_KEY_PASSPHRASE_ATTEMPTS),
        );
    }

    #[test]
    fn wrong_openssh_private_key_passphrase_requests_bounded_retry() {
        let auth = NativeSshAuthRequest {
            username: "dev".to_string(),
            password: None,
            private_key_pem: Some(ENCRYPTED_OPENSSH_ED25519_KEY.to_string()),
            private_key_passphrase: Some("wrong".to_string()),
            private_key_passphrase_attempts: 1,
            keyboard_interactive_answers: Vec::new(),
        };

        let error = decode_private_key_for_auth(&context(), &auth).expect_err("auth prompt");

        assert_eq!(error.code, "auth-prompt-required");
        assert_eq!(error.auth_prompt.expect("auth prompt").attempts_remaining, Some(2));
    }

    #[test]
    fn exhausted_openssh_private_key_passphrase_attempts_fail_authentication() {
        let auth = NativeSshAuthRequest {
            username: "dev".to_string(),
            password: None,
            private_key_pem: Some(ENCRYPTED_OPENSSH_ED25519_KEY.to_string()),
            private_key_passphrase: Some("wrong".to_string()),
            private_key_passphrase_attempts: PRIVATE_KEY_PASSPHRASE_ATTEMPTS,
            keyboard_interactive_answers: Vec::new(),
        };

        let error = decode_private_key_for_auth(&context(), &auth).expect_err("auth failure");

        assert_eq!(error.code, "authentication-failed");
        assert!(error.auth_prompt.is_none());
    }
}
