use std::sync::Arc;

use russh::ChannelMsg;
use tokio::sync::watch;
use tokio::time::{timeout, Duration};

use crate::auth::authenticate;
use crate::cancellation::{cancellation_error, wait_for_cancellation};
use crate::connection::connect;
use crate::error::NativeSshError;
use crate::host_key::HostKeyPrompter;
use crate::types::{NativeSshAuthContext, NativeSshExecRequest, NativeSshExecResult};

pub async fn exec(
    request: NativeSshExecRequest,
    prompter: Arc<dyn HostKeyPrompter>,
    mut cancellation: watch::Receiver<bool>,
) -> Result<NativeSshExecResult, NativeSshError> {
    let mut session = tokio::select! {
        _ = wait_for_cancellation(&mut cancellation) => return Err(cancellation_error()),
        result = connect(request.clone(), prompter) => result?,
    };
    let auth_context = auth_context_from_exec_request(&request);
    tokio::select! {
        _ = wait_for_cancellation(&mut cancellation) => return Err(cancellation_error()),
        result = timeout(
            Duration::from_millis(request.auth_timeout_ms.max(1)),
            authenticate(&mut session, &auth_context, &request.auth),
        ) => {
            result
                .map_err(|_| NativeSshError::new("authentication-failed", "Native SSH authentication timed out."))??;
        }
    }

    let exec_result = timeout(
        Duration::from_millis(request.exec_timeout_ms.max(1)),
        async {
            let mut channel = session.channel_open_session().await?;
            channel.exec(true, request.command.as_bytes()).await?;
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let mut exit_code = None;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                    ChannelMsg::Eof => {}
                    _ => {}
                }
            }
            channel.close().await?;
            Ok::<_, russh::Error>(NativeSshExecResult {
                exit_code,
                stdout: String::from_utf8_lossy(&stdout).to_string(),
                stderr: String::from_utf8_lossy(&stderr).to_string(),
                signal: None,
            })
        },
    );
    tokio::select! {
        _ = wait_for_cancellation(&mut cancellation) => Err(cancellation_error()),
        result = exec_result => result
            .map_err(|_| NativeSshError::new("exec-timeout", "Native SSH command timed out."))?
            .map_err(Into::into),
    }
}

fn auth_context_from_exec_request(request: &NativeSshExecRequest) -> NativeSshAuthContext {
    NativeSshAuthContext {
        request_id: request.request_id.clone(),
        host: request.host.clone(),
        port: request.port,
        username: request.username.clone(),
    }
}
