use crate::endpoint::{
    accept_first_application_stream, ConsumerRegistration,
    ConsumerSlot, CONSUMER_CHANNEL_CAPACITY,
};
use crate::stream::pump_bidirectional;
use crate::tunnel_connection::TunnelConnection;
use crate::{
    snapshot_for_connection, validate_loopback_bind_addr, validate_loopback_target,
    AcceptedIrohConnection, IrohAlpn, IrohError, IrohPathSnapshot, Result,
    TUNNEL_PREAMBLE,
};
use iroh::RelayUrl;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::{JoinHandle, JoinSet};

/// Bounded resource-safety window for reading the one-byte tunnel preamble.
/// A peer that neither sends a valid preamble nor closes within this budget
/// gets its stream reset; no local TCP connection is ever opened first.
pub const PREAMBLE_READ_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy)]
pub struct HomeAcceptorConfig {
    pub target: SocketAddr,
}

impl Default for HomeAcceptorConfig {
    fn default() -> Self {
        Self {
            target: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3000),
        }
    }
}

/// Accept-only status for the Home acceptor: metadata and counters, never
/// payload bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HomeAcceptorStatus {
    pub running: bool,
    pub connections_accepted: u64,
    pub connections_active: u64,
    pub streams_accepted: u64,
    pub streams_rejected: u64,
    pub last_path: Option<IrohPathSnapshot>,
}

/// Stream-level counters owned by the acceptor's own pump loops. Connection
/// admission/refusal/path accounting lives in the endpoint dispatcher's
/// per-ALPN slot and is observed through it.
#[derive(Default)]
struct AcceptorState {
    streams_accepted: AtomicU64,
    streams_rejected: AtomicU64,
}

/// Home-side consumer of the endpoint's single ALPN dispatcher. The
/// [`crate::IrohEndpoint`] owns the one incoming accept loop; this acceptor
/// registers as the `happier/home-tunnel/1` consumer, receives only
/// Home-dispatched authenticated connections, and forwards every accepted
/// stream to the configured loopback Home origin after a bounded one-byte
/// preamble check; no peer-selected destination is ever interpreted. The
/// endpoint's incoming-service profile is enforced per connection at the QUIC
/// transport boundary.
pub struct HomeAcceptor {
    task: JoinHandle<()>,
    shutdown: watch::Sender<bool>,
    state: Arc<AcceptorState>,
    slot: Arc<ConsumerSlot>,
    _registration: ConsumerRegistration,
}

impl HomeAcceptor {
    pub fn start(endpoint: &crate::IrohEndpoint, config: HomeAcceptorConfig) -> Result<Self> {
        validate_loopback_target(&config.target.ip().to_string(), config.target.port())?;
        let (sender, mut receiver) = mpsc::channel(CONSUMER_CHANNEL_CAPACITY);
        // Acquires the exclusive Home consumer slot. A second live acceptor
        // (a second accept owner) fails typed instead of racing the first.
        let registration = endpoint.register_consumer(IrohAlpn::HomeTunnel, sender)?;
        let slot = registration.slot().clone();
        let state = Arc::new(AcceptorState::default());
        let loop_state = Arc::clone(&state);
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        // The consumer loop owns the per-connection JoinSet: shutdown signals
        // every nested connection/stream task, then joins it before public stop
        // returns. Completed connection tasks are reaped as they finish.
        let task = tokio::spawn(async move {
            let mut connections: JoinSet<()> = JoinSet::new();
            loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => { break; }
                    accepted = receiver.recv() => {
                        let Some(accepted) = accepted else {
                            // Registration released or endpoint shut down.
                            break;
                        };
                        let connection_state = Arc::clone(&loop_state);
                        let connection_shutdown = shutdown_rx.clone();
                        connections.spawn(async move {
                            pump_connection(accepted, config.target, connection_state, connection_shutdown).await;
                        });
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
        })
    }

    pub fn status(&self) -> HomeAcceptorStatus {
        let running = !self.task.is_finished();
        let counters = &self.slot.counters;
        HomeAcceptorStatus {
            running,
            connections_accepted: counters.connections_accepted.load(Ordering::Relaxed),
            connections_active: counters.connections_active.load(Ordering::Relaxed),
            streams_accepted: self.state.streams_accepted.load(Ordering::Relaxed),
            streams_rejected: self.state.streams_rejected.load(Ordering::Relaxed),
            last_path: counters.last_path.lock().ok().and_then(|slot| slot.clone()),
        }
    }

    /// Stops the acceptor: the consumer loop is aborted and the Home ALPN
    /// registration is released with the acceptor, so the same live endpoint
    /// can start a fresh acceptor without a stale registration.
    pub fn stop(self) {
        let _ = self.shutdown.send(true);
    }

    /// Stops the acceptor and waits until its consumer task has joined every
    /// nested connection/stream pump and released the ALPN registration.
    pub async fn stop_and_wait(mut self) {
        let _ = self.shutdown.send(true);
        let _ = (&mut self.task).await;
    }
}

impl Drop for HomeAcceptor {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        self.task.abort();
        // `_registration` releases the Home ALPN slot when dropped.
    }
}

/// Streams on one dispatched Home connection. The QUIC transport config
/// already rejects streams beyond the profile cap; this loop accepts
/// everything the transport admitted and gives each stream one fixed-target
/// TCP connection. Completed stream tasks are reaped as they finish. The
/// dispatched connection's endpoint cap lease is released when this pump ends.
///
/// The connection's first stream must arrive inside the endpoint's
/// pre-application custody window; after it has, the loop keeps waiting for
/// further streams for as long as the peer holds the connection open, which is
/// what long-lived Socket.IO sockets rely on.
async fn pump_connection(
    accepted: AcceptedIrohConnection,
    target: SocketAddr,
    state: Arc<AcceptorState>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let mut streams: JoinSet<()> = JoinSet::new();
    let Some((send, recv)) = accept_first_application_stream(&accepted.connection).await else {
        // No first stream: the connection is closed and dropping `accepted`
        // (including its endpoint cap lease) drains the admission.
        return;
    };
    let first_stream_state = Arc::clone(&state);
    streams.spawn(async move {
        pump_stream(send, recv, target, first_stream_state).await;
    });
    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => { break; }
            opened = accepted.connection.accept_bi() => {
                match opened {
                    Ok((send, recv)) => {
                        // Stream accounting happens in `pump_stream` at the preamble
                        // boundary, not here: only a stream that progresses past the
                        // mandatory valid preamble is accepted.
                        let stream_state = Arc::clone(&state);
                        streams.spawn(async move {
                            pump_stream(send, recv, target, stream_state).await;
                        });
                    }
                    Err(_) => break,
                }
            }
            // Reap completed stream tasks instead of retaining them for the
            // lifetime of the connection.
            Some(_) = streams.join_next(), if !streams.is_empty() => {}
        }
    }
    streams.shutdown().await;
    // Dropping `accepted` (including its endpoint cap lease) drains admission.
}

/// One tunneled stream: bounded preamble read → fixed-target TCP connect →
/// bidirectional copy with half-close. Invalid, short, or timed-out preambles
/// reset the stream without ever opening the fixed target; no payload is ever
/// logged.
///
/// This is the single stream-accounting point: exactly one of `streams_accepted`
/// (progressed past the mandatory valid preamble, recorded before any target
/// contact) or `streams_rejected` (invalid, short, EOF, or timed-out preamble)
/// is recorded once per stream.
async fn pump_stream(
    mut send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
    target: SocketAddr,
    state: Arc<AcceptorState>,
) {
    let mut preamble = [0u8; 1];
    let read = tokio::time::timeout(PREAMBLE_READ_TIMEOUT, recv.read_exact(&mut preamble)).await;
    let preamble_ok = matches!(read, Ok(Ok(()))) && preamble[0] == TUNNEL_PREAMBLE;
    if !preamble_ok {
        state.streams_rejected.fetch_add(1, Ordering::Relaxed);
        // Fail closed at the stream: reset it and never touch the target.
        let _ = send.reset(0u32.into());
        return;
    }
    // Accepted exactly here — past the mandatory valid preamble, before any
    // target contact; the paired rejection branch above keeps this the one
    // accounting point per stream (no double counting, no race: one task per
    // stream owns its counter decision).
    state.streams_accepted.fetch_add(1, Ordering::Relaxed);
    let Ok(mut socket) = TcpStream::connect(target).await else {
        let _ = send.reset(0u32.into());
        return;
    };
    let (mut socket_read, mut socket_write) = socket.split();
    pump_bidirectional(&mut socket_read, &mut socket_write, &mut recv, &mut send).await;
}

#[derive(Debug, Clone)]
pub struct HomeTunnelConfig {
    pub endpoint_id: String,
    pub bind_addr: SocketAddr,
    /// Explicit direct addresses learned from the endpoint descriptor.
    ///
    /// Iroh's `EndpointId` is an identity only; without an address lookup
    /// service a client must provide at least one transport address.
    pub direct_addresses: Vec<SocketAddr>,
    /// Validated relay hints for the remote endpoint (used only when the local
    /// relay selection permits them).
    pub relay_urls: Vec<RelayUrl>,
}

impl Default for HomeTunnelConfig {
    fn default() -> Self {
        Self {
            endpoint_id: String::new(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: Vec::new(),
            relay_urls: Vec::new(),
        }
    }
}

/// Status for one Home tunnel lease: metadata and honest path telemetry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HomeTunnelStatus {
    pub local_origin: String,
    pub connection_active: bool,
    pub streams_opened: u64,
    pub observed_path: Option<IrohPathSnapshot>,
}

#[derive(Default)]
struct TunnelState {
    streams_opened: AtomicU64,
}

/// Client-side loopback dialer. The tunnel connects to the descriptor endpoint
/// once per healthy connection and multiplexes local TCP streams over it.
/// The next local connection replaces a closed QUIC connection through the
/// shared tunnel connection owner. The returned origin is ephemeral and must
/// not be persisted as a Home profile URL; no background retry runs here.
pub struct HomeTunnel {
    origin: String,
    local_addr: SocketAddr,
    remote_endpoint_id: String,
    connection: Arc<TunnelConnection>,
    task: JoinHandle<()>,
    shutdown: watch::Sender<bool>,
    state: Arc<TunnelState>,
}

impl HomeTunnel {
    pub async fn start(endpoint: &crate::IrohEndpoint, config: HomeTunnelConfig) -> Result<Self> {
        validate_loopback_bind_addr(config.bind_addr)?;
        endpoint.ensure_relay_urls(&config.relay_urls).await?;
        let endpoint_id = iroh::EndpointId::from_str(&config.endpoint_id)
            .map_err(|_| IrohError::InvalidDescriptor)?;
        let mut remote = iroh::EndpointAddr::new(endpoint_id);
        for url in &config.relay_urls {
            remote = remote.with_relay_url(url.clone());
        }
        for addr in &config.direct_addresses {
            remote = remote.with_ip_addr(*addr);
        }
        // Authenticate the requested Home before publishing its local listener.
        let connection = Arc::new(TunnelConnection::connect(
            endpoint.endpoint(), remote, endpoint_id, IrohAlpn::HomeTunnel,
            crate::IrohCapProfile::HomeInteractive,
        ).await?);
        let remote_endpoint_id = connection.current().remote_id().to_string();
        let listener = TcpListener::bind(config.bind_addr)
            .await
            .map_err(|_| IrohError::LoopbackBindFailed)?;
        let local_addr = listener
            .local_addr()
            .map_err(|_| IrohError::LoopbackBindFailed)?;

        let state = Arc::new(TunnelState::default());
        let loop_connection = connection.clone();
        let loop_state = Arc::clone(&state);
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        let task = tokio::spawn(async move {
            let mut streams = JoinSet::new();
            loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => { break; }
                    accepted = listener.accept() => {
                        let Ok((mut socket, _)) = accepted else { break };
                        loop_state.streams_opened.fetch_add(1, Ordering::Relaxed);
                        let stream_connection = loop_connection.clone();
                        streams.spawn(async move {
                            let Ok(stream_connection) = stream_connection.for_local_stream().await else {
                                return;
                            };
                            // One bidi stream per local TCP connection; the preamble is
                            // written immediately because Iroh streams are lazy until
                            // the first write.
                            let Ok((mut send, mut recv)) = stream_connection.open_bi().await else {
                                return;
                            };
                            if send.write_all(&[TUNNEL_PREAMBLE]).await.is_err() {
                                return;
                            }
                            let (mut socket_read, mut socket_write) = socket.split();
                            pump_bidirectional(
                                &mut socket_read,
                                &mut socket_write,
                                &mut recv,
                                &mut send,
                            )
                            .await;
                        });
                    }
                    Some(_) = streams.join_next(), if !streams.is_empty() => {}
                }
            }
            streams.shutdown().await;
            loop_connection.close(b"tunnel_released");
        });
        Ok(Self {
            origin: format!("http://{}:{}", local_addr.ip(), local_addr.port()),
            local_addr,
            remote_endpoint_id,
            connection,
            task,
            shutdown,
            state,
        })
    }

    pub fn local_origin(&self) -> Result<String> {
        Ok(self.origin.clone())
    }

    pub fn local_addr(&self) -> Result<SocketAddr> {
        Ok(self.local_addr)
    }

    /// The authenticated identity of the connected Home endpoint, verified
    /// against the requested descriptor at start. Hosts report this instead of
    /// echoing the requested descriptor string back to callers.
    pub fn remote_endpoint_id(&self) -> &str {
        &self.remote_endpoint_id
    }

    pub fn status(&self) -> HomeTunnelStatus {
        HomeTunnelStatus {
            local_origin: self.origin.clone(),
            connection_active: !self.task.is_finished() && self.connection.current().close_reason().is_none(),
            streams_opened: self.state.streams_opened.load(Ordering::Relaxed),
            // Live observation: the currently selected path of the lease's
            // one reused Iroh connection. Direct/relay only when actually
            // observed, `unknown` otherwise; path migration is telemetry, so
            // status reflects it without touching the logical connection.
            observed_path: Some(snapshot_for_connection(&self.connection.current())),
        }
    }

    /// Releases this lease only: the loopback listener and the lease's shared
    /// Iroh connection close; the underlying process endpoint (and any sibling
    /// lease) stays healthy. Explicit endpoint shutdown is owned by the
    /// endpoint manager.
    pub fn stop(self) {
        let _ = self.shutdown.send(true);
        self.connection.close(b"tunnel_released");
    }

    /// Releases the lease and waits until the loopback accept task has joined
    /// all active local socket pumps. Native lifecycle APIs use this form
    /// because reporting a completed release while the old runtime origin still
    /// accepts sockets would let callers publish or reuse a resource they no
    /// longer own.
    pub async fn stop_and_wait(self) {
        let _ = self.shutdown.send(true);
        self.connection.close(b"tunnel_released");
        let _ = self.task.await;
    }
}
