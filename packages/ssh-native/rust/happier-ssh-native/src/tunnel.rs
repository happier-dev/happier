use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;

use once_cell::sync::Lazy;
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tokio::time::{timeout, Duration};

use crate::auth::authenticate;
use crate::cancellation::{
    cancellation_error, register_request, wait_for_cancellation, CancellationRegistration,
};
use crate::connection::connect;
use crate::error::NativeSshError;
use crate::host_key::RejectingHostKeyPrompter;
use crate::types::{
    NativeSshAuthContext, NativeSshExecRequest, NativeSshLoopbackTunnelRequest,
    NativeSshLoopbackTunnelResult,
};
use std::sync::Arc;

static NEXT_TUNNEL_ID: AtomicU64 = AtomicU64::new(1);
static TUNNELS: Lazy<Mutex<HashMap<String, oneshot::Sender<()>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn start_loopback_tunnel_blocking(
    request: NativeSshLoopbackTunnelRequest,
) -> Result<NativeSshLoopbackTunnelResult, NativeSshError> {
    if request.destination_host != "127.0.0.1" && request.destination_host != "localhost" {
        return Err(NativeSshError::new(
            "engine-internal",
            "Native SSH loopback destination must be local.",
        ));
    }

    let tunnel_id = format!(
        "russh-{}-{}",
        request.request_id,
        NEXT_TUNNEL_ID.fetch_add(1, Ordering::Relaxed)
    );
    let cancellation = register_request(&request.request_id)?;
    let cancellation_receiver = cancellation.receiver();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (stop_tx, stop_rx) = oneshot::channel();
    TUNNELS
        .lock()
        .map_err(|_| NativeSshError::new("engine-internal", "Native SSH tunnel registry failed."))?
        .insert(tunnel_id.clone(), stop_tx);
    let thread_tunnel_id = tunnel_id.clone();
    thread::spawn(move || {
        let _cleanup = register_tunnel_cleanup(thread_tunnel_id.clone());
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
        {
            Ok(runtime) => runtime,
            Err(_) => {
                let _ = ready_tx.send(Err(NativeSshError::new(
                    "engine-internal",
                    "Native SSH tunnel runtime could not start.",
                )));
                return;
            }
        };
        runtime.block_on(async move {
            let result = run_tunnel(
                thread_tunnel_id,
                request,
                cancellation,
                cancellation_receiver,
                stop_rx,
                ready_tx,
            )
            .await;
            if let Err(_error) = result {
                // Post-start tunnel failures are reflected by probe/degraded state in the TS supervisor.
            }
        });
    });

    let result = ready_rx.recv().map_err(|_| {
        NativeSshError::new("engine-internal", "Native SSH tunnel failed to start.")
    })??;
    Ok(result)
}

pub fn stop_loopback_tunnel(tunnel_id: &str) {
    if let Ok(mut tunnels) = TUNNELS.lock() {
        if let Some(stop) = tunnels.remove(tunnel_id) {
            let _ = stop.send(());
        }
    }
}

async fn run_tunnel(
    tunnel_id: String,
    request: NativeSshLoopbackTunnelRequest,
    _cancellation: CancellationRegistration,
    mut cancellation_receiver: watch::Receiver<bool>,
    mut stop_rx: oneshot::Receiver<()>,
    ready_tx: mpsc::Sender<Result<NativeSshLoopbackTunnelResult, NativeSshError>>,
) -> Result<(), NativeSshError> {
    let exec_request = NativeSshExecRequest {
        request_id: request.request_id.clone(),
        host: request.host.clone(),
        port: request.port,
        username: request.username.clone(),
        command: String::new(),
        auth: request.auth.clone(),
        connect_timeout_ms: request.connect_timeout_ms,
        auth_timeout_ms: request.auth_timeout_ms,
        exec_timeout_ms: 1,
        host_key_verification: request.host_key_verification.clone(),
    };
    let mut session = tokio::select! {
        _ = wait_for_cancellation(&mut cancellation_receiver) => {
            return send_start_error(&ready_tx, cancellation_error());
        }
        result = connect(exec_request, Arc::new(RejectingHostKeyPrompter)) => result?,
    };
    let auth_context = auth_context_from_loopback_request(&request);
    tokio::select! {
        _ = wait_for_cancellation(&mut cancellation_receiver) => {
            return send_start_error(&ready_tx, cancellation_error());
        }
        result = timeout(
            Duration::from_millis(request.auth_timeout_ms.max(1)),
            authenticate(&mut session, &auth_context, &request.auth),
        ) => {
            result
                .map_err(|_| NativeSshError::new("authentication-failed", "Native SSH authentication timed out."))??;
        }
    }

    let listener = tokio::select! {
        _ = wait_for_cancellation(&mut cancellation_receiver) => {
            return send_start_error(&ready_tx, cancellation_error());
        }
        result = TcpListener::bind(("127.0.0.1", request.requested_local_port.unwrap_or(0))) => {
            result.map_err(|_| loopback_bind_failed_error())?
        }
    };
    let local_port = listener
        .local_addr()
        .map_err(|_| loopback_bind_failed_error())?
        .port();
    ready_tx
        .send(Ok(NativeSshLoopbackTunnelResult {
            native_tunnel_id: tunnel_id,
            local_port,
        }))
        .map_err(|_| {
            NativeSshError::new("engine-internal", "Native SSH tunnel start result failed.")
        })?;

    loop {
        tokio::select! {
            _ = wait_for_cancellation(&mut cancellation_receiver) => break,
            _ = &mut stop_rx => break,
            accepted = listener.accept() => {
                let (mut socket, origin) = accepted
                    .map_err(|_| NativeSshError::new("connection-failed", "Native SSH loopback accept failed."))?;
                let origin_port = origin_port(origin);
                let channel = match session.channel_open_direct_tcpip(
                    request.destination_host.clone(),
                    u32::from(request.destination_port),
                    "127.0.0.1",
                    u32::from(origin_port),
                ).await {
                    Ok(channel) => channel,
                    Err(_) => {
                        continue;
                    }
                };
                tokio::spawn(async move {
                    let mut stream = channel.into_stream();
                    let _ = copy_bidirectional(&mut socket, &mut stream).await;
                });
            }
        }
    }
    Ok(())
}

fn origin_port(origin: SocketAddr) -> u16 {
    origin.port()
}

fn auth_context_from_loopback_request(request: &NativeSshLoopbackTunnelRequest) -> NativeSshAuthContext {
    NativeSshAuthContext {
        request_id: request.request_id.clone(),
        host: request.host.clone(),
        port: request.port,
        username: request.username.clone(),
    }
}

fn loopback_bind_failed_error() -> NativeSshError {
    NativeSshError::new("loopback-bind-failed", "Native SSH loopback bind failed.")
}

fn send_start_error(
    ready_tx: &mpsc::Sender<Result<NativeSshLoopbackTunnelResult, NativeSshError>>,
    error: NativeSshError,
) -> Result<(), NativeSshError> {
    let _ = ready_tx.send(Err(error.clone()));
    Err(error)
}

struct TunnelRegistryCleanup {
    tunnel_id: String,
}

impl Drop for TunnelRegistryCleanup {
    fn drop(&mut self) {
        if let Ok(mut tunnels) = TUNNELS.lock() {
            tunnels.remove(&self.tunnel_id);
        }
    }
}

fn register_tunnel_cleanup(tunnel_id: String) -> TunnelRegistryCleanup {
    TunnelRegistryCleanup { tunnel_id }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tunnel_registry_lease_removes_entry_when_background_task_exits() {
        let (stop_tx, _stop_rx) = oneshot::channel();
        let tunnel_id = "rust-tunnel-cleanup-test".to_string();
        {
            let mut tunnels = TUNNELS.lock().expect("registry lock");
            tunnels.remove(&tunnel_id);
            tunnels.insert(tunnel_id.clone(), stop_tx);
        }

        drop(register_tunnel_cleanup(tunnel_id.clone()));

        let tunnels = TUNNELS.lock().expect("registry lock");
        assert!(!tunnels.contains_key(&tunnel_id));
    }

    #[test]
    fn loopback_bind_failure_uses_dedicated_error_code() {
        let error = loopback_bind_failed_error();

        assert_eq!(error.code, "loopback-bind-failed");
    }
}
