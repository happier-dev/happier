use crate::endpoint::{
    accept_first_application_stream, verified_remote_endpoint_id, ConsumerRegistration,
    ConsumerSlot, CONSUMER_CHANNEL_CAPACITY,
};
use crate::stream::pump_bidirectional;
use crate::{
    snapshot_for_connection, validate_loopback_bind_addr, validate_loopback_target,
    AcceptedIrohConnection, IrohAlpn, IrohCapProfile, IrohError, IrohPathSnapshot, Result,
    MACHINE_ALPN, TUNNEL_PREAMBLE,
};
use iroh::RelayUrl;
use std::future::Future;
use std::io::{Error, ErrorKind};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::{JoinHandle, JoinSet};

pub const MAX_MACHINE_HANDSHAKE_BYTES: usize = 64 * 1024;
pub const MACHINE_CONTROL_TIMEOUT: Duration = Duration::from_secs(10);
pub const MACHINE_ADMISSION_PATH: &str = "/v1/iroh/machine/admit";
pub const MACHINE_REMOTE_ENDPOINT_HEADER: &str = "X-Happier-Iroh-Remote-Endpoint-Id";
/// Header of the trusted local admission response that selects the
/// application loopback port for the just-admitted stream. Only the locally
/// trusted admission owner may select a destination after it verified the
/// canonical handshake; the remote peer can never name a host or port.
pub const IROH_MACHINE_APPLICATION_PORT_HEADER: &str = "X-Happier-Iroh-Application-Port";
pub const IROH_MACHINE_APPLICATION_CAPABILITY_HEADER: &str =
    "X-Happier-Iroh-Application-Capability";
pub const IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER: &str = "X-Happier-Machine-Local-Capability";
/// Browser-compatible, loopback-only WebSocket authentication. Removed before
/// forwarding the upgrade so the local capability never reaches the peer.
pub const MACHINE_WEBSOCKET_CAPABILITY_PROTOCOL_PREFIX: &str = "happier.iroh.cap.";
pub const MACHINE_LOCAL_CAPABILITY_BYTES: usize = 32;
pub const MACHINE_LOCAL_CAPABILITY_HEX_LENGTH: usize = MACHINE_LOCAL_CAPABILITY_BYTES * 2;
const MAX_ADMISSION_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_MACHINE_HTTP_HEAD_BYTES: usize = 16 * 1024;
pub const MACHINE_STREAM_ACCEPT_BYTE: u8 = 0x01;
pub const MACHINE_STREAM_REJECT_BYTE: u8 = 0x00;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MachineFailureCode {
    InvalidPreamble,
    InvalidControl,
    AdmissionRejected,
    EndpointIdentityMismatch,
    Transport,
    AdmissionTimeout,
    LocalHttpHeadTimeout,
    LocalCapabilityTimeout,
    LocalCapabilityRejected,
    StreamDecisionTimeout,
    StreamDecisionClosed,
    NoApplicationStream,
}

impl MachineFailureCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidPreamble => "invalid-preamble",
            Self::InvalidControl => "machine-control-invalid",
            Self::AdmissionRejected => "machine-admission-rejected",
            Self::EndpointIdentityMismatch => "endpoint-identity-mismatch",
            Self::Transport => "transport-unavailable",
            Self::AdmissionTimeout => "machine-admission-timeout",
            Self::LocalHttpHeadTimeout => "local-http-head-timeout",
            Self::LocalCapabilityTimeout => "local-capability-timeout",
            Self::LocalCapabilityRejected => "local-capability-rejected",
            Self::StreamDecisionTimeout => "machine-stream-decision-timeout",
            Self::StreamDecisionClosed => "machine-stream-decision-closed",
            Self::NoApplicationStream => "no-application-stream",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MachineAcceptorConfig {
    pub admission_target: SocketAddr,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineAcceptorStatus {
    pub running: bool,
    pub connections_accepted: u64,
    pub connections_active: u64,
    pub streams_accepted: u64,
    pub streams_active: u64,
    pub streams_rejected: u64,
    pub last_path: Option<IrohPathSnapshot>,
    pub last_failure: Option<MachineFailureCode>,
}

#[derive(Default)]
struct AcceptorState {
    streams_accepted: AtomicU64,
    streams_active: AtomicU64,
    streams_rejected: AtomicU64,
    last_failure: Mutex<Option<MachineFailureCode>>,
}

struct ActiveStreamGuard<'a>(&'a AtomicU64);
impl Drop for ActiveStreamGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

pub struct MachineAcceptor {
    task: JoinHandle<()>,
    shutdown: watch::Sender<bool>,
    state: Arc<AcceptorState>,
    slot: Arc<ConsumerSlot>,
    _registration: ConsumerRegistration,
    endpoint_id: String,
    config: MachineAcceptorConfig,
}

/// A local stream uses the active acceptor's exact target and lifetime. It
/// cannot select an application port or outlive withdrawal of that acceptor.
#[derive(Clone)]
pub struct MachineLocalAdmission {
    endpoint_id: String,
    config: MachineAcceptorConfig,
    shutdown: watch::Receiver<bool>,
    state: Arc<AcceptorState>,
}

async fn local_admission_closed(admission: &mut Option<MachineLocalAdmission>) {
    let Some(admission) = admission else {
        return std::future::pending().await;
    };
    if !*admission.shutdown.borrow() {
        let _ = admission.shutdown.changed().await;
    }
}

impl MachineAcceptor {
    pub fn start(endpoint: &crate::IrohEndpoint, config: MachineAcceptorConfig) -> Result<Self> {
        validate_target(config.admission_target)?;
        let (sender, mut receiver) = mpsc::channel(CONSUMER_CHANNEL_CAPACITY);
        let registration = endpoint.register_consumer(IrohAlpn::Machine, sender)?;
        let slot = registration.slot().clone();
        let state = Arc::new(AcceptorState::default());
        let loop_state = Arc::clone(&state);
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => { break; }
                    accepted = receiver.recv() => {
                        let Some(accepted) = accepted else { break };
                        let connection_shutdown = shutdown_rx.clone();
                        connections.spawn(pump_connection(accepted, config, Arc::clone(&loop_state), connection_shutdown));
                    }
                    Some(_) = connections.join_next(), if !connections.is_empty() => {}
                }
            }
            connections.shutdown().await;
        });
        Ok(Self {
            task,
            shutdown,
            state,
            slot,
            _registration: registration,
            endpoint_id: endpoint.id().to_string(),
            config,
        })
    }

    pub fn local_admission(&self) -> MachineLocalAdmission {
        MachineLocalAdmission {
            endpoint_id: self.endpoint_id.clone(),
            config: self.config,
            shutdown: self.shutdown.subscribe(),
            state: Arc::clone(&self.state),
        }
    }

    pub fn status(&self) -> MachineAcceptorStatus {
        let counters = &self.slot.counters;
        MachineAcceptorStatus {
            running: !self.task.is_finished(),
            connections_accepted: counters.connections_accepted.load(Ordering::Relaxed),
            connections_active: counters.connections_active.load(Ordering::Relaxed),
            streams_accepted: self.state.streams_accepted.load(Ordering::Relaxed),
            streams_active: self.state.streams_active.load(Ordering::Relaxed),
            streams_rejected: self.state.streams_rejected.load(Ordering::Relaxed),
            last_path: counters
                .last_path
                .lock()
                .ok()
                .and_then(|value| value.clone()),
            last_failure: self.state.last_failure.lock().ok().and_then(|value| *value),
        }
    }
    pub fn stop(self) {
        let _ = self.shutdown.send(true);
    }

    /// Stops the acceptor and joins its consumer task so completion means all
    /// nested connection and stream pumps have released their resources.
    pub async fn stop_and_wait(mut self) {
        let _ = self.shutdown.send(true);
        let _ = (&mut self.task).await;
    }
}
impl Drop for MachineAcceptor {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        self.task.abort();
    }
}

fn validate_target(target: SocketAddr) -> Result<()> {
    validate_loopback_target(&target.ip().to_string(), target.port())
}

/// Streams on one dispatched machine connection. The connection's first stream
/// must arrive and complete signed application admission inside pre-admission
/// custody. Only then does the loop accept further streams for as long as the
/// peer holds the connection open, preserving the existing long-lived transfer
/// and workspace-sync semantics.
async fn pump_connection(
    accepted: AcceptedIrohConnection,
    config: MachineAcceptorConfig,
    state: Arc<AcceptorState>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let remote_endpoint_id = accepted.remote_endpoint_id.clone();
    let mut streams = JoinSet::new();
    let Some((send, recv)) = accept_first_application_stream(&accepted.connection).await else {
        // No first stream: the connection is closed and dropping `accepted`
        // (including its endpoint cap lease) drains the admission.
        return;
    };
    let Some(first_stream) = admit_stream(
        send,
        recv,
        config,
        &remote_endpoint_id,
        Arc::clone(&state),
    )
    .await
    else {
        accepted
            .connection
            .close(0u32.into(), b"first_stream_rejected");
        return;
    };
    streams.spawn(pump_admitted_stream(first_stream, Arc::clone(&state)));
    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => { break; }
            opened = accepted.connection.accept_bi() => match opened {
                Ok((send, recv)) => { streams.spawn(pump_stream(send, recv, config, remote_endpoint_id.clone(), Arc::clone(&state))); }
                Err(_) => break,
            },
            Some(_) = streams.join_next(), if !streams.is_empty() => {}
        };
    }
    streams.shutdown().await;
}

async fn pump_stream(
    send: iroh::endpoint::SendStream,
    recv: iroh::endpoint::RecvStream,
    config: MachineAcceptorConfig,
    remote_endpoint_id: String,
    state: Arc<AcceptorState>,
) {
    let Some(stream) = admit_stream(send, recv, config, &remote_endpoint_id, Arc::clone(&state)).await
    else {
        return;
    };
    pump_admitted_stream(stream, state).await;
}

struct AdmittedMachineStream {
    send: iroh::endpoint::SendStream,
    recv: iroh::endpoint::RecvStream,
    app: TcpStream,
}

async fn admit_stream(
    mut send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
    config: MachineAcceptorConfig,
    remote_endpoint_id: &str,
    state: Arc<AcceptorState>,
) -> Option<AdmittedMachineStream> {
    let admitted = tokio::time::timeout(MACHINE_CONTROL_TIMEOUT, async {
        let mut preamble = [0u8; 1];
        recv.read_exact(&mut preamble)
            .await
            .map_err(|_| MachineFailureCode::InvalidPreamble)?;
        if preamble[0] != TUNNEL_PREAMBLE {
            return Err(MachineFailureCode::InvalidPreamble);
        }
        let mut encoded_length = [0u8; 4];
        recv.read_exact(&mut encoded_length)
            .await
            .map_err(|_| MachineFailureCode::InvalidControl)?;
        let length = u32::from_be_bytes(encoded_length) as usize;
        if length == 0 || length > MAX_MACHINE_HANDSHAKE_BYTES {
            return Err(MachineFailureCode::InvalidControl);
        }
        let mut handshake = vec![0u8; length];
        recv.read_exact(&mut handshake)
            .await
            .map_err(|_| MachineFailureCode::InvalidControl)?;
        let text =
            std::str::from_utf8(&handshake).map_err(|_| MachineFailureCode::InvalidControl)?;
        let parsed: serde_json::Value =
            serde_json::from_str(text).map_err(|_| MachineFailureCode::InvalidControl)?;
        if !parsed.is_object() {
            return Err(MachineFailureCode::InvalidControl);
        }
        let purpose = validate_handshake(text).map_err(|_| MachineFailureCode::InvalidControl)?;
        authorize(
            config.admission_target,
            remote_endpoint_id,
            &handshake,
            purpose.requires_local_capability(),
        )
        .await
    })
    .await;
    let application_target = match admitted {
        Ok(Ok(target)) => target,
        _ => {
            let failure = match admitted {
                Ok(Err(failure)) => failure,
                _ => MachineFailureCode::AdmissionTimeout,
            };
            if let Ok(mut last) = state.last_failure.lock() {
                *last = Some(failure);
            }
            state.streams_rejected.fetch_add(1, Ordering::Relaxed);
            let _ = send.write_all(&[MACHINE_STREAM_REJECT_BYTE]).await;
            let _ = send.finish();
            return None;
        }
    };
    // The application host is hard-coded loopback; only the port comes from
    // the trusted local admission response that verified the canonical
    // handshake. No request or peer field can supply a destination.
    let app_target = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), application_target.port);
    let Ok(mut app) = TcpStream::connect(app_target).await else {
        state.streams_rejected.fetch_add(1, Ordering::Relaxed);
        let _ = send.write_all(&[MACHINE_STREAM_REJECT_BYTE]).await;
        let _ = send.finish();
        return None;
    };
    if let Some(local_capability) = application_target.local_capability {
        if app.write_all(local_capability.as_bytes()).await.is_err() {
            state.streams_rejected.fetch_add(1, Ordering::Relaxed);
            let _ = send.write_all(&[MACHINE_STREAM_REJECT_BYTE]).await;
            let _ = send.finish();
            return None;
        }
    }
    if send.write_all(&[MACHINE_STREAM_ACCEPT_BYTE]).await.is_err() {
        return None;
    }
    state.streams_accepted.fetch_add(1, Ordering::Relaxed);
    Some(AdmittedMachineStream { send, recv, app })
}

async fn pump_admitted_stream(
    stream: AdmittedMachineStream,
    state: Arc<AcceptorState>,
) {
    let AdmittedMachineStream {
        mut send,
        mut recv,
        mut app,
    } = stream;
    state.streams_active.fetch_add(1, Ordering::Relaxed);
    let _active_stream = ActiveStreamGuard(&state.streams_active);
    let (mut app_read, mut app_write) = app.split();
    pump_bidirectional(&mut app_read, &mut app_write, &mut recv, &mut send).await;
}

async fn authorize(
    target: SocketAddr,
    remote_endpoint_id: &str,
    body: &[u8],
    accepts_application_capability: bool,
) -> std::result::Result<MachineApplicationTarget, MachineFailureCode> {
    let mut socket = TcpStream::connect(target)
        .await
        .map_err(|_| MachineFailureCode::Transport)?;
    let head = format!("POST {MACHINE_ADMISSION_PATH} HTTP/1.1\r\nHost: {target}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{MACHINE_REMOTE_ENDPOINT_HEADER}: {remote_endpoint_id}\r\nConnection: close\r\n\r\n", body.len());
    socket
        .write_all(head.as_bytes())
        .await
        .map_err(|_| MachineFailureCode::Transport)?;
    socket
        .write_all(body)
        .await
        .map_err(|_| MachineFailureCode::Transport)?;
    let mut response = Vec::new();
    let head_end = loop {
        if response.len() == MAX_ADMISSION_RESPONSE_BYTES {
            return Err(MachineFailureCode::Transport);
        }
        let mut chunk = [0u8; 1024];
        let remaining = MAX_ADMISSION_RESPONSE_BYTES - response.len();
        let read_capacity = remaining.min(chunk.len());
        let read = socket
            .read(&mut chunk[..read_capacity])
            .await
            .map_err(|_| MachineFailureCode::Transport)?;
        if read == 0 {
            return Err(MachineFailureCode::Transport);
        }
        response.extend_from_slice(&chunk[..read]);
        if let Some(index) = response.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    if head_end > MAX_ADMISSION_RESPONSE_BYTES {
        return Err(MachineFailureCode::Transport);
    }
    let head = std::str::from_utf8(&response[..head_end - 4])
        .map_err(|_| MachineFailureCode::Transport)?;
    let mut lines = head.split("\r\n");
    let code = lines
        .next()
        .and_then(|line| line.split_ascii_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or(MachineFailureCode::Transport)?;
    if !(200..300).contains(&code) {
        return Err(MachineFailureCode::AdmissionRejected);
    }
    // One bounded pass over the bounded response head: exactly one
    // remote-endpoint echo must match the authenticated transport identity,
    // and exactly one well-formed application-port header may exist.
    let mut echoed: Option<&str> = None;
    let mut application_port: Option<&str> = None;
    let mut application_capability: Option<&str> = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case(MACHINE_REMOTE_ENDPOINT_HEADER) {
            // The exact-header contract: a second (or comma-folded) echo
            // header is ambiguous and fails closed before any application
            // connection.
            if echoed.replace(value.trim()).is_some() {
                return Err(MachineFailureCode::EndpointIdentityMismatch);
            }
        } else if name.eq_ignore_ascii_case(IROH_MACHINE_APPLICATION_PORT_HEADER)
            && application_port.replace(value).is_some()
        {
            // Duplicate (or comma-folded) application-port headers are
            // ambiguous and fail closed before any application connection.
            return Err(MachineFailureCode::AdmissionRejected);
        } else if accepts_application_capability
            && name.eq_ignore_ascii_case(IROH_MACHINE_APPLICATION_CAPABILITY_HEADER)
            && application_capability.replace(value).is_some()
        {
            return Err(MachineFailureCode::AdmissionRejected);
        }
    }
    let echoed = echoed.ok_or(MachineFailureCode::EndpointIdentityMismatch)?;
    if echoed != remote_endpoint_id {
        return Err(MachineFailureCode::EndpointIdentityMismatch);
    }
    let port =
        parse_application_port(application_port.ok_or(MachineFailureCode::AdmissionRejected)?)?;
    let local_capability = application_capability
        .map(parse_local_capability)
        .transpose()?;
    Ok(MachineApplicationTarget {
        port,
        local_capability,
    })
}

struct MachineApplicationTarget {
    port: u16,
    local_capability: Option<String>,
}

/// Strict canonical decimal port. Optional RFC 7230 OWS (SP/HTAB) around the
/// field value is stripped first, so a normally serialized
/// `X-Happier-Iroh-Application-Port: 46001` header is accepted. The remainder
/// must be ASCII digits only — no sign, internal whitespace, or comma
/// folding — without leading zeros, nonzero, and within 1..=65535.
fn parse_application_port(value: &str) -> std::result::Result<u16, MachineFailureCode> {
    let value = value.trim_matches(|character| character == ' ' || character == '\t');
    let bytes = value.as_bytes();
    let canonical = !bytes.is_empty()
        && bytes.len() <= 5
        && bytes[0] != b'0'
        && bytes.iter().all(|byte| byte.is_ascii_digit());
    if !canonical {
        return Err(MachineFailureCode::AdmissionRejected);
    }
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port >= 1)
        .ok_or(MachineFailureCode::AdmissionRejected)
}

fn parse_local_capability(value: &str) -> std::result::Result<String, MachineFailureCode> {
    let value = value.trim_matches(|character| character == ' ' || character == '\t');
    if value.len() != MACHINE_LOCAL_CAPABILITY_HEX_LENGTH
        || !value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(MachineFailureCode::AdmissionRejected);
    }
    Ok(value.to_owned())
}

fn generate_local_capability() -> Result<String> {
    let mut bytes = [0u8; MACHINE_LOCAL_CAPABILITY_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| IrohError::TransportClosed)?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(MACHINE_LOCAL_CAPABILITY_HEX_LENGTH);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(encoded)
}

fn capabilities_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MachineTunnelPurpose {
    FiniteTransfer,
    WorkspaceSync,
    ProviderBroker,
    TcpTunnel,
}

impl MachineTunnelPurpose {
    const fn requires_local_capability(self) -> bool {
        !matches!(self, Self::FiniteTransfer)
    }

    const fn accepts_one_local_stream(self) -> bool {
        matches!(self, Self::WorkspaceSync)
    }
}

#[derive(Debug, Clone)]
pub struct MachineTunnelConfig {
    pub endpoint_id: String,
    pub bind_addr: SocketAddr,
    pub direct_addresses: Vec<SocketAddr>,
    pub relay_urls: Vec<RelayUrl>,
    pub handshake_json: String,
    /// Both finite transfers and workspace synchronization use the one
    /// machine-bulk transport profile. Workspace's one-local-stream rule is
    /// derived separately from the verified handshake flow.
    pub cap_profile: IrohCapProfile,
}

/// Supplies the admission handshake for one newly accepted local stream.
/// The provider is invoked after the local capability is authenticated and
/// before a QUIC stream is opened. Dropping its future cancels that one
/// connection without changing tunnel custody. A trusted local provider can
/// instead return `{"kind":"http_refusal","responseBody":"<JSON>"}` to answer
/// that HTTP connection locally; this outcome is never a machine handshake.
pub type MachineHandshakeProvider =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<String>> + Send>> + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineTunnelStatus {
    pub local_port: u16,
    pub connection_active: bool,
    pub streams_opened: u64,
    /// Normalized authenticated remote endpoint identity this tunnel dials,
    /// surfaced so production adapters can construct authenticated carrier
    /// results without trusting a separate caller-supplied string.
    pub remote_endpoint_id: String,
    pub observed_path: IrohPathSnapshot,
    pub last_failure: Option<MachineFailureCode>,
}

#[derive(Default)]
struct TunnelState {
    streams_opened: AtomicU64,
    streams_active: AtomicU64,
    single_stream: bool,
    local_stream_claimed: AtomicBool,
    last_failure: Mutex<Option<MachineFailureCode>>,
}

pub struct MachineTunnel {
    local_addr: SocketAddr,
    carrier: MachineTunnelCarrier,
    remote_endpoint_id: String,
    local_capability: Option<String>,
    task: JoinHandle<()>,
    shutdown: watch::Sender<bool>,
    state: Arc<TunnelState>,
}

#[derive(Clone)]
enum MachineTunnelCarrier {
    Remote(Arc<MachineTunnelConnection>),
    Local(MachineLocalAdmission),
}

impl MachineTunnelCarrier {
    fn local_admission(&self) -> Option<MachineLocalAdmission> {
        match self {
            Self::Local(admission) => Some(admission.clone()),
            Self::Remote(_) => None,
        }
    }

    fn close(&self) {
        if let Self::Remote(connection) = self {
            connection.close();
        }
    }
}

/// One authenticated connection owner for every local stream of a tunnel.
/// Opening the listener still proves the remote identity. Subsequent requests
/// replace a closed connection on demand, after obtaining their admission
/// witness; no idle task keeps an unused target connection in custody.
struct MachineTunnelConnection {
    endpoint: iroh::Endpoint,
    remote: iroh::EndpointAddr,
    remote_id: iroh::EndpointId,
    cap_profile: IrohCapProfile,
    current: Mutex<iroh::endpoint::Connection>,
    dial: tokio::sync::Mutex<()>,
}

impl MachineTunnelConnection {
    fn current(&self) -> iroh::endpoint::Connection {
        self.current.lock().expect("machine connection").clone()
    }

    async fn for_local_stream(&self) -> Result<iroh::endpoint::Connection> {
        let connection = self.current();
        if connection.close_reason().is_none() {
            return Ok(connection);
        }
        // Concurrent local requests share the replacement, not separate dials.
        let _dial = self.dial.lock().await;
        let connection = self.current();
        if connection.close_reason().is_none() {
            return Ok(connection);
        }
        let connection = dial_machine_connection(
            &self.endpoint, self.remote.clone(), self.remote_id, self.cap_profile,
        ).await?;
        *self.current.lock().expect("machine connection") = connection.clone();
        Ok(connection)
    }

    fn close(&self) {
        self.current().close(0u32.into(), b"machine_tunnel_released");
    }
}

async fn dial_machine_connection(
    endpoint: &iroh::Endpoint,
    remote: iroh::EndpointAddr,
    remote_id: iroh::EndpointId,
    cap_profile: IrohCapProfile,
) -> Result<iroh::endpoint::Connection> {
    let connecting = endpoint.connect_with_opts(
        remote,
        MACHINE_ALPN,
        iroh::endpoint::ConnectOptions::new()
            .with_transport_config(cap_profile.transport_config()?),
    ).await.map_err(IrohError::from)?;
    let connection = connecting.await.map_err(IrohError::from)?;
    verified_remote_endpoint_id(connection.remote_id(), remote_id)?;
    Ok(connection)
}

/// Qualified provider-broker/readiness HTTP adapter over the capability-gated
/// machine listener.
///
/// The public listener accepts framed HTTP/1.1 requests. Its Rust-owned bridge
/// validates and removes the loopback capability from every request, connects
/// to the private machine listener, and writes the inner listener capability
/// before streaming request bodies and application responses. Neither local
/// capability crosses the Iroh stream or a language binding.
pub struct MachineHttpTunnel {
    local_addr: SocketAddr,
    local_capability: String,
    tunnel: MachineTunnel,
    task: JoinHandle<()>,
    shutdown: watch::Sender<bool>,
}

#[derive(Debug, Clone, Copy)]
enum HttpRequestBodyFraming {
    None,
    ContentLength(u64),
    Chunked,
    WebSocket,
}

struct CapabilityGatedHttpRequestHead {
    sanitized: Vec<u8>,
    body_framing: HttpRequestBodyFraming,
}

fn invalid_http_request() -> Error {
    Error::new(
        ErrorKind::InvalidData,
        "invalid capability-gated HTTP request",
    )
}

async fn read_capability_gated_http_request_head<R>(
    socket: &mut R,
    buffered: &mut Vec<u8>,
    expected_capability: &[u8],
    allow_websocket: bool,
) -> std::io::Result<Option<CapabilityGatedHttpRequestHead>>
where
    R: AsyncRead + Unpin,
{
    let mut chunk = [0u8; 1024];
    let header_end = loop {
        if let Some(index) = buffered.windows(4).position(|window| window == b"\r\n\r\n") {
            let header_end = index + 4;
            if header_end > MAX_MACHINE_HTTP_HEAD_BYTES {
                return Err(invalid_http_request());
            }
            break header_end;
        }
        if buffered.len() >= MAX_MACHINE_HTTP_HEAD_BYTES {
            return Err(invalid_http_request());
        }
        let remaining = MAX_MACHINE_HTTP_HEAD_BYTES - buffered.len();
        let read_capacity = remaining.min(chunk.len());
        let read = socket.read(&mut chunk[..read_capacity]).await?;
        if read == 0 {
            return if buffered.is_empty() {
                Ok(None)
            } else {
                Err(Error::new(
                    ErrorKind::UnexpectedEof,
                    "HTTP request ended before its header",
                ))
            };
        }
        buffered.extend_from_slice(&chunk[..read]);
    };
    let request: Vec<u8> = buffered.drain(..header_end).collect();
    let header_fields_end = request.len() - 4;
    let Some(request_line_end) = request[..header_fields_end]
        .windows(2)
        .position(|window| window == b"\r\n")
    else {
        return Err(invalid_http_request());
    };
    let mut capability_line: Option<(usize, usize)> = None;
    let mut content_length: Option<u64> = None;
    let mut transfer_encoding: Option<&[u8]> = None;
    let mut websocket = false;
    let mut connection_upgrade = false;
    let mut line_start = request_line_end + 2;
    while line_start <= header_fields_end {
        let Some(relative_end) = request[line_start..header_fields_end + 2]
            .windows(2)
            .position(|window| window == b"\r\n")
        else {
            return Err(invalid_http_request());
        };
        let line_end = line_start + relative_end;
        let line = &request[line_start..line_end];
        if let Some(colon) = line.iter().position(|byte| *byte == b':') {
            let name = line[..colon].trim_ascii_start().trim_ascii_end();
            let value = line[colon + 1..].trim_ascii_start().trim_ascii_end();
            let websocket_capability = allow_websocket && name.eq_ignore_ascii_case(b"sec-websocket-protocol")
                && value.starts_with(MACHINE_WEBSOCKET_CAPABILITY_PROTOCOL_PREFIX.as_bytes());
            // Provider clients send their declared standard auth header. The
            // loopback capability is stripped before crossing the carrier.
            // TCP/WebSocket tunnels retain their separate native contract.
            let broker_bearer = !allow_websocket && name.eq_ignore_ascii_case(b"authorization")
                && value.len() >= 7 && value[..7].eq_ignore_ascii_case(b"bearer ")
                && capabilities_equal(&value[7..], expected_capability);
            let broker_key = !allow_websocket && (name.eq_ignore_ascii_case(b"x-api-key")
                || name.eq_ignore_ascii_case(b"x-goog-api-key"));
            if name.eq_ignore_ascii_case(IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER.as_bytes())
                || websocket_capability || broker_bearer || broker_key {
                if capability_line.is_some() {
                    return Err(invalid_http_request());
                }
                let capability = if websocket_capability {
                    &value[MACHINE_WEBSOCKET_CAPABILITY_PROTOCOL_PREFIX.len()..]
                } else if broker_bearer {
                    &value[7..]
                } else { value };
                if !capabilities_equal(capability, expected_capability) {
                    return Err(invalid_http_request());
                }
                capability_line = Some((line_start, line_end + 2));
            } else if name.eq_ignore_ascii_case(b"upgrade") {
                if websocket || !value.eq_ignore_ascii_case(b"websocket") { return Err(invalid_http_request()); }
                websocket = true;
            } else if name.eq_ignore_ascii_case(b"connection") {
                connection_upgrade |= value.split(|byte| *byte == b',')
                    .any(|token| token.trim_ascii_start().trim_ascii_end().eq_ignore_ascii_case(b"upgrade"));
            } else if name.eq_ignore_ascii_case(b"content-length") {
                if content_length.is_some() || value.is_empty() {
                    return Err(invalid_http_request());
                }
                let mut parsed = 0u64;
                for byte in value {
                    if !byte.is_ascii_digit() {
                        return Err(invalid_http_request());
                    }
                    parsed = parsed
                        .checked_mul(10)
                        .and_then(|current| current.checked_add(u64::from(*byte - b'0')))
                        .ok_or_else(invalid_http_request)?;
                }
                content_length = Some(parsed);
            } else if name.eq_ignore_ascii_case(b"transfer-encoding") {
                if transfer_encoding.replace(value).is_some() {
                    return Err(invalid_http_request());
                }
            }
        } else if !line.is_empty() {
            return Err(invalid_http_request());
        }
        line_start = line_end + 2;
    }
    let Some((capability_start, capability_end)) = capability_line else {
        return Err(invalid_http_request());
    };
    let body_framing = if websocket {
        if !allow_websocket || !connection_upgrade || content_length.is_some() || transfer_encoding.is_some() {
            return Err(invalid_http_request());
        }
        HttpRequestBodyFraming::WebSocket
    } else { match (content_length, transfer_encoding) {
        (Some(_), Some(_)) => return Err(invalid_http_request()),
        (Some(length), None) => HttpRequestBodyFraming::ContentLength(length),
        (None, Some(value)) => {
            let codings: Vec<&[u8]> = value
                .split(|byte| *byte == b',')
                .map(|coding| coding.trim_ascii_start().trim_ascii_end())
                .collect();
            if codings.is_empty()
                || codings.iter().any(|coding| coding.is_empty())
                || !codings
                    .last()
                    .is_some_and(|coding| coding.eq_ignore_ascii_case(b"chunked"))
                || codings[..codings.len() - 1]
                    .iter()
                    .any(|coding| coding.eq_ignore_ascii_case(b"chunked"))
            {
                return Err(invalid_http_request());
            }
            HttpRequestBodyFraming::Chunked
        }
        (None, None) => HttpRequestBodyFraming::None,
    }};
    let mut sanitized = Vec::with_capacity(request.len() - (capability_end - capability_start));
    sanitized.extend_from_slice(&request[..capability_start]);
    sanitized.extend_from_slice(&request[capability_end..]);
    Ok(Some(CapabilityGatedHttpRequestHead {
        sanitized,
        body_framing,
    }))
}

async fn read_crlf_line<R>(socket: &mut R, buffered: &mut Vec<u8>) -> std::io::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(index) = buffered.windows(2).position(|window| window == b"\r\n") {
            return Ok(buffered.drain(..index + 2).collect());
        }
        if buffered.len() >= MAX_MACHINE_HTTP_HEAD_BYTES {
            return Err(invalid_http_request());
        }
        let remaining = MAX_MACHINE_HTTP_HEAD_BYTES - buffered.len();
        let read_capacity = remaining.min(chunk.len());
        let read = socket.read(&mut chunk[..read_capacity]).await?;
        if read == 0 {
            return Err(Error::new(
                ErrorKind::UnexpectedEof,
                "HTTP request ended before its framed body",
            ));
        }
        buffered.extend_from_slice(&chunk[..read]);
    }
}

async fn read_exact_buffered<R>(
    socket: &mut R,
    buffered: &mut Vec<u8>,
    target: &mut [u8],
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
{
    let buffered_length = buffered.len().min(target.len());
    target[..buffered_length].copy_from_slice(&buffered[..buffered_length]);
    buffered.drain(..buffered_length);
    if buffered_length < target.len() {
        socket.read_exact(&mut target[buffered_length..]).await?;
    }
    Ok(())
}

async fn forward_exact_buffered<R, W>(
    socket: &mut R,
    destination: &mut W,
    buffered: &mut Vec<u8>,
    mut remaining: u64,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    if !buffered.is_empty() && remaining > 0 {
        let length = buffered
            .len()
            .min(usize::try_from(remaining).unwrap_or(usize::MAX));
        destination.write_all(&buffered[..length]).await?;
        buffered.drain(..length);
        remaining -= length as u64;
    }
    let mut chunk = [0u8; 16 * 1024];
    while remaining > 0 {
        let length = chunk
            .len()
            .min(usize::try_from(remaining).unwrap_or(usize::MAX));
        let read = socket.read(&mut chunk[..length]).await?;
        if read == 0 {
            return Err(Error::new(
                ErrorKind::UnexpectedEof,
                "HTTP request ended before its framed body",
            ));
        }
        destination.write_all(&chunk[..read]).await?;
        remaining -= read as u64;
    }
    Ok(())
}

fn parse_chunk_size(line: &[u8]) -> std::io::Result<u64> {
    let encoded = line
        .strip_suffix(b"\r\n")
        .ok_or_else(invalid_http_request)?;
    let size = encoded
        .split(|byte| *byte == b';')
        .next()
        .unwrap_or_default()
        .trim_ascii_start()
        .trim_ascii_end();
    if size.is_empty() {
        return Err(invalid_http_request());
    }
    let mut parsed = 0u64;
    for byte in size {
        let digit = match byte {
            b'0'..=b'9' => u64::from(*byte - b'0'),
            b'a'..=b'f' => u64::from(*byte - b'a' + 10),
            b'A'..=b'F' => u64::from(*byte - b'A' + 10),
            _ => return Err(invalid_http_request()),
        };
        parsed = parsed
            .checked_mul(16)
            .and_then(|current| current.checked_add(digit))
            .ok_or_else(invalid_http_request)?;
    }
    Ok(parsed)
}

fn is_local_capability_header(line: &[u8]) -> bool {
    let line = line.strip_suffix(b"\r\n").unwrap_or(line);
    line.iter()
        .position(|byte| *byte == b':')
        .is_some_and(|colon| {
            line[..colon]
                .trim_ascii_start()
                .trim_ascii_end()
                .eq_ignore_ascii_case(IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER.as_bytes())
        })
}

async fn forward_chunked_http_body<R, W>(
    socket: &mut R,
    destination: &mut W,
    buffered: &mut Vec<u8>,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    loop {
        let size_line = read_crlf_line(socket, buffered).await?;
        let chunk_size = parse_chunk_size(&size_line)?;
        destination.write_all(&size_line).await?;
        if chunk_size > 0 {
            forward_exact_buffered(socket, destination, buffered, chunk_size).await?;
            let mut delimiter = [0u8; 2];
            read_exact_buffered(socket, buffered, &mut delimiter).await?;
            if delimiter != *b"\r\n" {
                return Err(invalid_http_request());
            }
            destination.write_all(&delimiter).await?;
            continue;
        }

        let mut trailer_bytes = 0usize;
        loop {
            let trailer = read_crlf_line(socket, buffered).await?;
            trailer_bytes = trailer_bytes
                .checked_add(trailer.len())
                .filter(|length| *length <= MAX_MACHINE_HTTP_HEAD_BYTES)
                .ok_or_else(invalid_http_request)?;
            if trailer == b"\r\n" {
                destination.write_all(&trailer).await?;
                return Ok(());
            }
            if !is_local_capability_header(&trailer) {
                destination.write_all(&trailer).await?;
            }
        }
    }
}

async fn forward_capability_gated_http_requests<R, W>(
    socket: &mut R,
    destination: &mut W,
    expected_capability: &[u8],
    allow_websocket: bool,
    mut buffered: Vec<u8>,
    mut request: CapabilityGatedHttpRequestHead,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    loop {
        destination.write_all(&request.sanitized).await?;
        match request.body_framing {
            HttpRequestBodyFraming::WebSocket => {
                destination.write_all(&buffered).await?;
                tokio::io::copy(socket, destination).await?;
                destination.shutdown().await?;
                return Ok(());
            }
            HttpRequestBodyFraming::None => {}
            HttpRequestBodyFraming::ContentLength(length) => {
                forward_exact_buffered(socket, destination, &mut buffered, length).await?;
            }
            HttpRequestBodyFraming::Chunked => {
                forward_chunked_http_body(socket, destination, &mut buffered).await?;
            }
        }
        let Some(next_request) =
            read_capability_gated_http_request_head(socket, &mut buffered, expected_capability, allow_websocket)
                .await?
        else {
            destination.shutdown().await?;
            return Ok(());
        };
        request = next_request;
    }
}

impl MachineHttpTunnel {
    pub async fn start(
        endpoint: &crate::IrohEndpoint,
        config: MachineTunnelConfig,
    ) -> Result<Self> {
        Self::start_inner(endpoint, config, None, None).await
    }

    pub async fn start_with_handshake_provider(
        endpoint: &crate::IrohEndpoint,
        config: MachineTunnelConfig,
        handshake_provider: MachineHandshakeProvider,
    ) -> Result<Self> {
        Self::start_inner(endpoint, config, Some(handshake_provider), None).await
    }

    pub async fn start_with_local_admission(
        endpoint: &crate::IrohEndpoint,
        config: MachineTunnelConfig,
        admission: MachineLocalAdmission,
        handshake_provider: Option<MachineHandshakeProvider>,
    ) -> Result<Self> {
        if validate_handshake(&config.handshake_json)? != MachineTunnelPurpose::ProviderBroker
            || config.endpoint_id != endpoint.id().to_string()
            || admission.endpoint_id != config.endpoint_id
            || *admission.shutdown.borrow()
        {
            return Err(IrohError::InvalidDescriptor);
        }
        Self::start_inner(endpoint, config, handshake_provider, Some(admission)).await
    }

    async fn start_inner(
        endpoint: &crate::IrohEndpoint,
        config: MachineTunnelConfig,
        handshake_provider: Option<MachineHandshakeProvider>,
        local_admission: Option<MachineLocalAdmission>,
    ) -> Result<Self> {
        let purpose = validate_handshake(&config.handshake_json)?;
        if !matches!(purpose,
            MachineTunnelPurpose::ProviderBroker | MachineTunnelPurpose::TcpTunnel) {
            return Err(IrohError::InvalidDescriptor);
        }
        // Bind the public listener before starting the inner machine tunnel.
        // After `MachineTunnel::start` returns there must be no cancellation
        // point before both owned task handles are assembled into `Self`, or
        // dropping this start future could detach the already-started inner
        // tunnel during endpoint shutdown.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| IrohError::LoopbackBindFailed)?;
        let local_addr = listener
            .local_addr()
            .map_err(|_| IrohError::LoopbackBindFailed)?;
        let tunnel = MachineTunnel::start_inner(endpoint, config, handshake_provider, local_admission).await?;
        let private_addr = tunnel.local_addr;
        let allow_websocket = purpose == MachineTunnelPurpose::TcpTunnel;
        let local_capability = tunnel
            .local_capability
            .clone()
            .expect("provider-broker tunnels always require a local capability");
        let capability = Arc::<[u8]>::from(local_capability.as_bytes());
        let tunnel_state = Arc::clone(&tunnel.state);
        let mut local_admission = tunnel.carrier.local_admission();
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        let task = tokio::spawn(async move {
            let mut streams = JoinSet::new();
            loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => { break; }
                    _ = local_admission_closed(&mut local_admission) => { break; }
                    accepted = listener.accept() => {
                        let Ok((mut application, _)) = accepted else { break };
                        let capability = Arc::clone(&capability);
                        let state = Arc::clone(&tunnel_state);
                        streams.spawn(async move {
                            let mut buffered = Vec::with_capacity(1024);
                            let initial = tokio::time::timeout(
                                MACHINE_CONTROL_TIMEOUT,
                                read_capability_gated_http_request_head(
                                    &mut application,
                                    &mut buffered,
                                    &capability,
                                    allow_websocket,
                                ),
                            ).await;
                            let initial_request = match initial {
                                Ok(Ok(Some(request))) => request,
                                Err(_) => {
                                    if let Ok(mut last) = state.last_failure.lock() {
                                        *last = Some(MachineFailureCode::LocalHttpHeadTimeout);
                                    }
                                    return;
                                }
                                _ => return,
                            };
                            let Ok(mut secured) = TcpStream::connect(private_addr).await else { return };
                            if secured.write_all(&capability).await.is_err() { return; }
                            let (mut application_read, mut application_write) = application.split();
                            let (mut secured_read, mut secured_write) = secured.split();
                            let requests = forward_capability_gated_http_requests(
                                &mut application_read,
                                &mut secured_write,
                                &capability,
                                allow_websocket,
                                buffered,
                                initial_request,
                            );
                            let responses = async {
                                let result = tokio::io::copy(&mut secured_read, &mut application_write).await;
                                let _ = application_write.shutdown().await;
                                result
                            };
                            tokio::pin!(requests);
                            tokio::pin!(responses);
                            let request_result = tokio::select! {
                                result = &mut requests => Some(result),
                                result = &mut responses => {
                                    // Preserve the response FIN while an early
                                    // refusal's request body is still uploading.
                                    // Dropping unread TCP input would reset it.
                                    if result.is_ok() { let _ = requests.await; }
                                    None
                                },
                            };
                            if matches!(request_result, Some(Ok(()))) {
                                let _ = responses.await;
                            }
                        });
                    }
                    Some(_) = streams.join_next(), if !streams.is_empty() => {}
                }
            }
            streams.shutdown().await;
        });
        Ok(Self {
            local_addr,
            local_capability,
            tunnel,
            task,
            shutdown,
        })
    }

    pub fn local_addr(&self) -> Result<SocketAddr> {
        Ok(self.local_addr)
    }

    pub fn local_port(&self) -> u16 {
        self.local_addr.port()
    }

    pub fn local_capability(&self) -> &str {
        &self.local_capability
    }

    pub fn status(&self) -> MachineTunnelStatus {
        let mut status = self.tunnel.status();
        status.local_port = self.local_port();
        status
    }

    pub fn stop(self) {
        let _ = self.shutdown.send(true);
        self.tunnel.stop();
    }

    pub async fn stop_and_wait(self) {
        let _ = self.shutdown.send(true);
        let _ = self.task.await;
        self.tunnel.stop_and_wait().await;
    }
}

impl MachineTunnel {
    pub async fn start(
        endpoint: &crate::IrohEndpoint,
        config: MachineTunnelConfig,
    ) -> Result<Self> {
        Self::start_inner(endpoint, config, None, None).await
    }

    async fn start_inner(
        endpoint: &crate::IrohEndpoint,
        config: MachineTunnelConfig,
        handshake_provider: Option<MachineHandshakeProvider>,
        local_admission: Option<MachineLocalAdmission>,
    ) -> Result<Self> {
        validate_loopback_bind_addr(config.bind_addr)?;
        let purpose = validate_handshake(&config.handshake_json)?;
        if config.cap_profile != IrohCapProfile::MachineBulk {
            return Err(IrohError::EndpointConfigConflict);
        }
        endpoint.ensure_relay_urls(&config.relay_urls).await?;
        let endpoint_id = iroh::EndpointId::from_str(&config.endpoint_id)
            .map_err(|_| IrohError::InvalidDescriptor)?;
        let mut remote = iroh::EndpointAddr::new(endpoint_id);
        for relay in config.relay_urls {
            remote = remote.with_relay_url(relay);
        }
        for addr in config.direct_addresses {
            remote = remote.with_ip_addr(addr);
        }
        let carrier = match local_admission {
            Some(admission) => MachineTunnelCarrier::Local(admission),
            None => {
                let connection = dial_machine_connection(
                    &endpoint.endpoint(), remote.clone(), endpoint_id, config.cap_profile,
                ).await?;
                MachineTunnelCarrier::Remote(Arc::new(MachineTunnelConnection {
                    endpoint: endpoint.endpoint(), remote, remote_id: endpoint_id,
                    cap_profile: config.cap_profile, current: Mutex::new(connection),
                    dial: tokio::sync::Mutex::new(()),
                }))
            }
        };
        // The authenticated transport identity — not the requested descriptor
        // copy — is the only honest remote identity this tunnel reports. A
        // mismatch fails the start closed with the shared
        // endpoint-identity-mismatch classification before any loopback
        // listener is published.
        let remote_endpoint_id = match &carrier {
            MachineTunnelCarrier::Remote(connection) => connection.current().remote_id().to_string(),
            MachineTunnelCarrier::Local(admission) => admission.endpoint_id.clone(),
        };
        let listener = TcpListener::bind(config.bind_addr)
            .await
            .map_err(|_| IrohError::LoopbackBindFailed)?;
        let local_addr = listener
            .local_addr()
            .map_err(|_| IrohError::LoopbackBindFailed)?;
        let handshake = Arc::<[u8]>::from(config.handshake_json.into_bytes());
        let local_capability = if purpose.requires_local_capability() {
            Some(generate_local_capability()?)
        } else {
            None
        };
        let pump_local_capability = purpose.requires_local_capability().then(|| {
            Arc::<[u8]>::from(
                local_capability
                    .as_deref()
                    .expect("capability-gated purpose has a local capability")
                    .as_bytes(),
            )
        });
        let state = Arc::new(TunnelState {
            streams_opened: AtomicU64::new(0),
            streams_active: AtomicU64::new(0),
            single_stream: purpose.accepts_one_local_stream(),
            local_stream_claimed: AtomicBool::new(false),
            last_failure: Mutex::new(None),
        });
        let loop_carrier = carrier.clone();
        let mut loop_admission = carrier.local_admission();
        let loop_state = Arc::clone(&state);
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        let task = tokio::spawn(async move {
            let mut streams = JoinSet::new();
            loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => { break; }
                    _ = local_admission_closed(&mut loop_admission) => { break; }
                    accepted = listener.accept() => {
                        let Ok((socket, _)) = accepted else { break };
                        loop_state.streams_active.fetch_add(1, Ordering::AcqRel);
                        streams.spawn(pump_local(
                            loop_carrier.clone(),
                            socket,
                            Arc::clone(&handshake),
                            handshake_provider.clone(),
                            pump_local_capability.clone(),
                            Arc::clone(&loop_state),
                        ));
                    }
                    Some(_) = streams.join_next(), if !streams.is_empty() => {}
                }
            }
            streams.shutdown().await;
            loop_carrier.close();
        });
        Ok(Self {
            local_addr,
            carrier,
            remote_endpoint_id,
            local_capability,
            task,
            shutdown,
            state,
        })
    }
    pub fn local_addr(&self) -> Result<SocketAddr> {
        Ok(self.local_addr)
    }
    pub fn local_port(&self) -> u16 {
        self.local_addr.port()
    }
    pub fn local_capability(&self) -> Option<&str> {
        self.local_capability.as_deref()
    }
    pub fn status(&self) -> MachineTunnelStatus {
        let connection = match &self.carrier {
            MachineTunnelCarrier::Remote(connection) => Some(connection.current()),
            MachineTunnelCarrier::Local(_) => None,
        };
        let last_failure = self.state.last_failure.lock().ok().and_then(|value| *value)
            .or_else(|| match connection.as_ref().and_then(|connection| connection.close_reason()) {
                Some(iroh::endpoint::ConnectionError::ApplicationClosed(close))
                    if close.reason.as_ref() == b"no_application_stream" => Some(MachineFailureCode::NoApplicationStream),
                _ => None,
            });
        MachineTunnelStatus {
            local_port: self.local_addr.port(),
            connection_active: !self.task.is_finished() && connection.as_ref().map_or_else(
                || self.carrier.local_admission().is_some_and(|admission| !*admission.shutdown.borrow()),
                |connection| connection.close_reason().is_none()),
            streams_opened: self.state.streams_opened.load(Ordering::Relaxed),
            remote_endpoint_id: self.remote_endpoint_id.clone(),
            observed_path: connection.as_ref().map(snapshot_for_connection).unwrap_or_else(||
                IrohPathSnapshot::new(crate::IrohObservedPath::Unknown, &self.remote_endpoint_id, crate::unix_ms())),
            last_failure,
        }
    }
    pub fn stop(self) {
        let _ = self.shutdown.send(true);
        self.carrier.close();
    }

    pub async fn stop_and_wait(self) {
        let _ = self.shutdown.send(true);
        self.carrier.close();
        let _ = self.task.await;
    }
}

async fn pump_local(
    carrier: MachineTunnelCarrier,
    mut socket: TcpStream,
    handshake: Arc<[u8]>,
    handshake_provider: Option<MachineHandshakeProvider>,
    local_capability: Option<Arc<[u8]>>,
    state: Arc<TunnelState>,
) {
    struct ActiveStream(Arc<TunnelState>);
    impl Drop for ActiveStream {
        fn drop(&mut self) {
            self.0.streams_active.fetch_sub(1, Ordering::AcqRel);
        }
    }
    let _active = ActiveStream(state);
    if let Some(local_capability) = local_capability {
        let mut supplied_capability = [0u8; MACHINE_LOCAL_CAPABILITY_HEX_LENGTH];
        let capability_result = tokio::time::timeout(
            MACHINE_CONTROL_TIMEOUT,
            socket.read_exact(&mut supplied_capability),
        )
        .await;
        if !matches!(capability_result, Ok(Ok(_)))
            || !capabilities_equal(&supplied_capability, &local_capability)
        {
            if let Ok(mut last) = _active.0.last_failure.lock() {
                *last = Some(if capability_result.is_err() {
                    MachineFailureCode::LocalCapabilityTimeout
                } else { MachineFailureCode::LocalCapabilityRejected });
            }
            return;
        }
    }
    if _active.0.single_stream
        && _active
            .0
            .local_stream_claimed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
    {
        return;
    }
    let handshake = if let Some(provider) = handshake_provider {
        // Home authorization is application work with its caller's lifetime.
        // The wire-control budget starts only after the witness is available.
        // Tunnel shutdown still cancels this stream task and its pending future.
        let Ok(handshake) = provider().await else {
            return;
        };
        if handshake.is_empty() || handshake.len() > MAX_MACHINE_HANDSHAKE_BYTES {
            return;
        }
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&handshake) else {
            return;
        };
        if parsed.get("kind").and_then(serde_json::Value::as_str) == Some("http_refusal") {
            let Some(outcome) = parsed.as_object().filter(|outcome| outcome.len() == 2) else {
                return;
            };
            let Some(body) = outcome.get("responseBody").and_then(serde_json::Value::as_str) else {
                return;
            };
            if serde_json::from_str::<serde_json::Value>(body).is_err() {
                return;
            }
            // Only the trusted local admission owner chooses the failure body.
            // Fixed framing prevents it from supplying status or HTTP headers.
            let head = format!(
                "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len(),
            );
            if socket.write_all(head.as_bytes()).await.is_ok() {
                let _ = socket.write_all(body.as_bytes()).await;
            }
            let _ = socket.shutdown().await;
            // Finish the HTTP response before discarding the caller's upload.
            // Reading through EOF avoids a reset from unread local input; the
            // tunnel's stream task still owns cancellation of both directions.
            let _ = tokio::io::copy(&mut socket, &mut tokio::io::sink()).await;
            return;
        }
        if !matches!(
            validate_handshake_purpose(&parsed),
            Ok(MachineTunnelPurpose::ProviderBroker)
        ) {
            return;
        }
        Arc::<[u8]>::from(handshake.into_bytes())
    } else {
        handshake
    };
    if let MachineTunnelCarrier::Local(admission) = &carrier {
        _active.0.streams_opened.fetch_add(1, Ordering::Relaxed);
        let target = tokio::time::timeout(MACHINE_CONTROL_TIMEOUT, authorize(
            admission.config.admission_target, &admission.endpoint_id, &handshake, true,
        )).await;
        let target = match target {
            Ok(Ok(target)) => target,
            failure => {
                let failure = match failure { Ok(Err(failure)) => failure, _ => MachineFailureCode::AdmissionTimeout };
                admission.state.streams_rejected.fetch_add(1, Ordering::Relaxed);
                if let Ok(mut last) = _active.0.last_failure.lock() { *last = Some(failure); }
                return;
            }
        };
        if *admission.shutdown.borrow() { return; }
        let Ok(mut application) = TcpStream::connect((Ipv4Addr::LOCALHOST, target.port)).await else { return };
        if let Some(capability) = target.local_capability {
            if application.write_all(capability.as_bytes()).await.is_err() { return; }
        }
        admission.state.streams_accepted.fetch_add(1, Ordering::Relaxed);
        admission.state.streams_active.fetch_add(1, Ordering::Relaxed);
        let _active_stream = ActiveStreamGuard(&admission.state.streams_active);
        tokio::io::copy_bidirectional(&mut socket, &mut application).await.ok();
        return;
    }
    let MachineTunnelCarrier::Remote(connection) = carrier else { return };
    let Ok(connection) = connection.for_local_stream().await else {
        if let Ok(mut last) = _active.0.last_failure.lock() {
            *last = Some(MachineFailureCode::Transport);
        }
        return;
    };
    _active.0.streams_opened.fetch_add(1, Ordering::Relaxed);
    let Ok((mut send, mut recv)) = connection.open_bi().await else {
        if let Ok(mut last) = _active.0.last_failure.lock() {
            *last = Some(MachineFailureCode::Transport);
        }
        return;
    };
    if send.write_all(&[TUNNEL_PREAMBLE]).await.is_err()
        || send
            .write_all(&(handshake.len() as u32).to_be_bytes())
            .await
            .is_err()
        || send.write_all(&handshake).await.is_err()
    {
        if let Ok(mut last) = _active.0.last_failure.lock() {
            *last = Some(MachineFailureCode::Transport);
        }
        return;
    }
    let mut decision = [0u8; 1];
    let decision_result =
        tokio::time::timeout(MACHINE_CONTROL_TIMEOUT, recv.read_exact(&mut decision)).await;
    if !matches!(decision_result, Ok(Ok(()))) {
        if let Ok(mut last) = _active.0.last_failure.lock() {
            *last = Some(if decision_result.is_err() {
                MachineFailureCode::StreamDecisionTimeout
            } else { MachineFailureCode::StreamDecisionClosed });
        }
        return;
    }
    if decision[0] != MACHINE_STREAM_ACCEPT_BYTE {
        if let Ok(mut last) = _active.0.last_failure.lock() {
            *last = Some(MachineFailureCode::AdmissionRejected);
        }
        return;
    }
    let (mut socket_read, mut socket_write) = socket.split();
    pump_bidirectional(&mut socket_read, &mut socket_write, &mut recv, &mut send).await;
}

fn validate_handshake(value: &str) -> Result<MachineTunnelPurpose> {
    if value.is_empty() || value.len() > MAX_MACHINE_HANDSHAKE_BYTES {
        return Err(IrohError::ResourceLimit);
    }
    let parsed: serde_json::Value =
        serde_json::from_str(value).map_err(|_| IrohError::InvalidDescriptor)?;
    validate_handshake_purpose(&parsed)
}

fn validate_handshake_purpose(parsed: &serde_json::Value) -> Result<MachineTunnelPurpose> {
    if !parsed.is_object() {
        return Err(IrohError::InvalidDescriptor);
    }
    // Provider-broker handshakes deliberately use a sibling application
    // envelope (`kind: provider_broker`) rather than the same-account
    // transfer `flow` union. They still use the machine/1 multi-stream
    // carrier; the TypeScript admission owner performs the signed grant and
    // current resource checks. Keep this native check structural only.
    if let Some(kind) = parsed.get("kind").and_then(serde_json::Value::as_str) {
        if matches!(kind, "provider_broker" | "provider_broker_readiness") {
            return Ok(MachineTunnelPurpose::ProviderBroker);
        }
        return Err(IrohError::InvalidDescriptor);
    }
    match parsed.get("flow").and_then(serde_json::Value::as_str) {
        Some("finite_transfer") => Ok(MachineTunnelPurpose::FiniteTransfer),
        Some("workspace_sync") => Ok(MachineTunnelPurpose::WorkspaceSync),
        Some("tcp_tunnel") => Ok(MachineTunnelPurpose::TcpTunnel),
        Some(_) | None => Err(IrohError::InvalidDescriptor),
    }
}

#[cfg(test)]
mod handshake_tests {
    use super::{validate_handshake, MachineTunnelPurpose};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn native_tcp_websocket_authentication_stays_local_and_preserves_binary_frames() {
        let capability = "a".repeat(64);
        let (mut client, mut server) = tokio::io::duplex(4096);
        let request = format!("GET /peer-mediation/v1/tunnel/stream HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: happier.iroh.cap.{capability}\r\n\r\n");
        let binary = [0x82, 0x03, 0xff, 0x00, 0x7f];
        client.write_all(request.as_bytes()).await.unwrap();
        client.write_all(&binary).await.unwrap();
        client.shutdown().await.unwrap();
        let mut buffered = Vec::new();
        let head = super::read_capability_gated_http_request_head(&mut server, &mut buffered, capability.as_bytes(), true).await
            .expect("authenticated WebSocket head").expect("request");
        let (mut received, mut destination) = tokio::io::duplex(4096);
        super::forward_capability_gated_http_requests(&mut server, &mut destination, capability.as_bytes(), true, buffered, head).await.unwrap();
        drop(destination);
        let mut output = Vec::new();
        received.read_to_end(&mut output).await.unwrap();
        assert!(output.ends_with(&binary));
        assert!(!String::from_utf8_lossy(&output).contains(&capability));
    }

    #[test]
    fn tcp_tunnel_keeps_the_capability_gated_multi_stream_carrier() {
        let purpose = validate_handshake(r#"{"v":1,"flow":"tcp_tunnel"}"#)
            .expect("TCP tunnel handshake");
        assert!(purpose.requires_local_capability());
        assert!(!purpose.accepts_one_local_stream());
    }

    #[test]
    fn accepts_provider_broker_handshakes_as_multi_stream_carriers() {
        assert_eq!(
            validate_handshake(r#"{"v":1,"kind":"provider_broker","authority":{}}"#)
                .expect("provider broker handshake should be structurally accepted"),
            MachineTunnelPurpose::ProviderBroker,
        );
    }

    #[test]
    fn classifies_finite_transfer_and_workspace_sync_without_conflating_local_semantics() {
        assert_eq!(
            validate_handshake(r#"{"v":1,"flow":"finite_transfer"}"#)
                .expect("finite transfer handshake"),
            MachineTunnelPurpose::FiniteTransfer,
        );
        assert_eq!(
            validate_handshake(r#"{"v":1,"flow":"workspace_sync"}"#)
                .expect("workspace sync handshake"),
            MachineTunnelPurpose::WorkspaceSync,
        );
        assert!(validate_handshake(r#"{"v":1}"#).is_err());
    }

    #[test]
    fn runner_broker_readiness_reuses_the_provider_broker_capability_gated_http_purpose() {
        assert_eq!(
            validate_handshake(r#"{"v":1,"kind":"provider_broker_readiness","authority":{}}"#)
                .expect("runner broker readiness handshake"),
            MachineTunnelPurpose::ProviderBroker,
        );
    }

    #[tokio::test]
    async fn provider_broker_bearer_capability_is_authenticated_and_stripped() {
        use super::{read_capability_gated_http_request_head, IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER};
        let capability = "c".repeat(64);
        for header in [format!("Authorization: Bearer {capability}"),
            format!("x-api-key: {capability}"), format!("x-goog-api-key: {capability}"),
            format!("{IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER}: {capability}")] {
            let request = format!("POST /v1/responses HTTP/1.1\r\nHost: localhost\r\n{header}\r\nContent-Length: 2\r\n\r\n{{}}");
            let mut socket = request.as_bytes();
            let mut buffered = Vec::new();
            let head = read_capability_gated_http_request_head(&mut socket, &mut buffered, capability.as_bytes(), false)
                .await.expect("valid broker capability").expect("request head");
            assert_eq!(String::from_utf8(head.sanitized).unwrap(),
                "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n");
            assert_eq!(buffered, b"{}");
        }
        // Host-private control calls retain their distinct signed authorization.
        let request = format!("GET /control HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer signed-authority\r\n{IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER}: {capability}\r\n\r\n");
        let head = read_capability_gated_http_request_head(&mut request.as_bytes(), &mut Vec::new(), capability.as_bytes(), false)
            .await.unwrap().unwrap();
        assert_eq!(String::from_utf8(head.sanitized).unwrap(),
            "GET /control HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer signed-authority\r\n\r\n");
        for headers in ["Authorization: Bearer wrong".to_owned(),
            format!("Authorization: Bearer {capability}\r\n{IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER}: {capability}")] {
            let request = format!("GET / HTTP/1.1\r\nHost: localhost\r\n{headers}\r\n\r\n");
            let mut socket = request.as_bytes();
            assert!(read_capability_gated_http_request_head(&mut socket, &mut Vec::new(), capability.as_bytes(), false).await.is_err());
        }
        let request = format!("GET / HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {capability}\r\n\r\n");
        assert!(read_capability_gated_http_request_head(&mut request.as_bytes(), &mut Vec::new(), capability.as_bytes(), true).await.is_err());
    }

    #[test]
    fn rejects_unknown_machine_handshake_kinds() {
        assert!(validate_handshake(r#"{"v":1,"kind":"unknown"}"#).is_err());
        assert!(validate_handshake(r#"{"kind":"http_refusal","responseBody":"{}"}"#).is_err());
    }
}
