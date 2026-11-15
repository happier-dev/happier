//! Owner-level tests for the native Home transport boundary.
//!
//! Every byte-level test here traverses the real owners: `HomeTunnel` (client
//! dialer) → real Iroh QUIC → `HomeAcceptor` (fixed loopback target) → a local
//! TCP echo server. Raw-endpoint tests only exist where the acceptor itself is
//! not the subject (ALPN dispatch to the fixed two-ALPN consumer slots and the
//! forced relay fixture).
//!
//! The forced-relay fixture uses the pinned stock relay server and is compiled
//! only under the `test-relay-fixture` cargo feature (never a release
//! dependency).
#![cfg(test)]

use crate::endpoint::{
    CONSUMER_CHANNEL_CAPACITY, MAX_PENDING_HANDSHAKES, PRE_APPLICATION_CUSTODY_TIMEOUT,
};
use crate::{
    AcceptedIrohConnection, HomeAcceptor, HomeAcceptorConfig, HomeTunnel, HomeTunnelConfig,
    IrohAlpn, IrohEndpoint, IrohError, IrohObservedPath, RelayPolicy, TUNNEL_PREAMBLE,
};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

const DIRECT: RelayPolicy = RelayPolicy::Disabled;

/// Local TCP echo target: the fixed loopback origin every acceptor forwards to.
/// Reports every accepted TCP connection through the channel so tests can prove
/// the acceptor never opened (or delivered bytes to) the fixed target.
async fn spawn_echo_target() -> (SocketAddr, tokio::task::JoinHandle<()>, mpsc::Receiver<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind echo target");
    let addr = listener.local_addr().expect("echo target local addr");
    let (accepted_tx, accepted_rx) = mpsc::channel::<()>(16);
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            if accepted_tx.send(()).await.is_err() {
                break;
            }
            tokio::spawn(async move {
                let mut buffer = [0u8; 1024];
                loop {
                    match socket.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if socket.write_all(&buffer[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });
    (addr, task, accepted_rx)
}

fn direct_endpoint_config() -> crate::EndpointConfig {
    crate::EndpointConfig {
        relay_policy: DIRECT,
        ..crate::EndpointConfig::default()
    }
}

fn home_tunnel_config(endpoint_id: String, direct: SocketAddr) -> HomeTunnelConfig {
    HomeTunnelConfig {
        endpoint_id,
        direct_addresses: vec![direct],
        ..HomeTunnelConfig::default()
    }
}

/// Parses the tunnel's published HTTP origin into the concrete loopback socket
/// address the fixture dials. The grammar is strict — `http://` scheme, an
/// IP-literal host (never a DNS name), a port — and the parsed address must be
/// loopback, so the fixture can never resolve or dial an arbitrary
/// destination while still proving `local_origin()` keeps its HTTP contract.
fn loopback_target_of_origin(origin: &str) -> SocketAddr {
    let host_port = origin
        .strip_prefix("http://")
        .expect("tunnel origin must be an http:// URL");
    let addr: SocketAddr = host_port
        .parse()
        .expect("tunnel origin host must be an IP-literal socket address");
    assert!(
        addr.ip().is_loopback(),
        "tunnel origin must stay loopback-only"
    );
    addr
}

/// Streams one request/response through a local TCP connection into the
/// tunnel's loopback origin and asserts the fixed-target echo returns it.
async fn echo_over_tunnel(origin: &str, payload: &[u8]) {
    let mut socket = TcpStream::connect(loopback_target_of_origin(origin))
        .await
        .expect("connect tunnel loopback origin");
    socket
        .write_all(payload)
        .await
        .expect("write tunnel payload");
    socket.flush().await.expect("flush tunnel payload");
    let mut response = vec![0u8; payload.len()];
    socket
        .read_exact(&mut response)
        .await
        .expect("read tunnel echo");
    assert_eq!(
        response, payload,
        "tunnel must preserve moving bytes exactly"
    );
}

/// Fixed target that waits for the tunneled request direction to reach EOF
/// before replying. This models protocols whose response is delimited by the
/// request half-close rather than by an application frame.
async fn spawn_eof_then_reply_target(
    expected: &'static [u8],
    response: &'static [u8],
) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind EOF target");
    let addr = listener.local_addr().expect("EOF target local addr");
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept EOF target");
        let mut request = Vec::new();
        socket
            .read_to_end(&mut request)
            .await
            .expect("read request through directional EOF");
        assert_eq!(request, expected);
        socket
            .write_all(response)
            .await
            .expect("write EOF response");
        socket.shutdown().await.expect("finish EOF response");
    });
    (addr, task)
}

/// Fixed target that finishes its response direction while deliberately
/// keeping its request direction open. The tunnel must expose that EOF to the
/// local client without waiting for the opposite direction to finish.
async fn spawn_reply_then_keep_reading_target(
    expected_prefix: &'static [u8],
    response: &'static [u8],
) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind half-close target");
    let addr = listener.local_addr().expect("half-close target local addr");
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept half-close target");
        let mut prefix = vec![0u8; expected_prefix.len()];
        socket
            .read_exact(&mut prefix)
            .await
            .expect("read request prefix");
        assert_eq!(prefix, expected_prefix);
        socket.write_all(response).await.expect("write response");
        socket.shutdown().await.expect("finish response direction");

        // Keep consuming the other direction until the local client closes.
        let mut remainder = Vec::new();
        socket
            .read_to_end(&mut remainder)
            .await
            .expect("drain request direction");
    });
    (addr, task)
}

/// Polls `probe` until it returns `Some` or the deadline elapses.
async fn wait_for(timeout: Duration, mut probe: impl FnMut() -> bool) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if probe() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    probe()
}

/// The Home tunnel derives its remote identity from the authenticated QUIC
/// connection and verifies it against the requested descriptor before the
/// loopback origin is published. Mismatch classification is proved at the
/// shared guard
/// (`endpoint::tests::outgoing_tunnel_identity_guard_reports_authenticated_id_and_fails_closed_on_mismatch`);
/// this test proves the Home start path is wired to it and reports the
/// authenticated id rather than never deriving one.
#[tokio::test]
async fn home_tunnel_reports_the_authenticated_identity_not_the_requested_descriptor_copy() {
    let (target_addr, _target, _target_accepted) = spawn_echo_target().await;
    let server = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let direct_addr = server
        .endpoint()
        .addr()
        .ip_addrs()
        .next()
        .copied()
        .expect("server endpoint publishes a direct address");
    let acceptor = HomeAcceptor::start(
        &server,
        HomeAcceptorConfig {
            target: target_addr,
            ..HomeAcceptorConfig::default()
        },
    )
    .expect("acceptor starts with a loopback target");

    let tunnel = HomeTunnel::start(
        &client,
        home_tunnel_config(server.id().to_string(), direct_addr),
    )
    .await
    .expect("tunnel connects to the descriptor endpoint");

    assert_eq!(tunnel.remote_endpoint_id(), server.id().to_string());
    assert_ne!(tunnel.remote_endpoint_id(), client.id().to_string());

    tunnel.stop();
    acceptor.stop();
    client.shutdown().await;
    server.shutdown().await;
    _target.abort();
}

/// Positive vertical: multiple local TCP streams traverse real
/// HomeTunnel -> real Iroh -> real HomeAcceptor -> the fixed loopback target,
/// all multiplexed over ONE reused Iroh connection.
#[tokio::test]
async fn home_tunnel_moves_bytes_through_real_acceptor_over_one_reused_connection() {
    let (target_addr, _target, _target_accepted) = spawn_echo_target().await;
    let server = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let direct_addr = server
        .endpoint()
        .addr()
        .ip_addrs()
        .next()
        .copied()
        .expect("server endpoint publishes a direct address");

    let acceptor = HomeAcceptor::start(
        &server,
        HomeAcceptorConfig {
            target: target_addr,
            ..HomeAcceptorConfig::default()
        },
    )
    .expect("acceptor starts with a loopback target");
    let tunnel = HomeTunnel::start(
        &client,
        home_tunnel_config(server.id().to_string(), direct_addr),
    )
    .await
    .expect("tunnel connects to the descriptor endpoint");

    // More than one local stream through the reused Iroh connection.
    echo_over_tunnel(
        &tunnel.local_origin().unwrap(),
        b"GET /health HTTP/1.1\r\n\r\n",
    )
    .await;
    echo_over_tunnel(&tunnel.local_origin().unwrap(), b"websocket-frame-bytes").await;
    echo_over_tunnel(&tunnel.local_origin().unwrap(), &[0u8, 1, 2, 255, 0]).await;

    assert_eq!(
        acceptor.status().connections_accepted,
        1,
        "all local streams must multiplex over one accepted Iroh connection"
    );
    assert_eq!(
        acceptor.status().streams_accepted,
        3,
        "each local TCP connection must map to one accepted bidi stream"
    );
    assert_eq!(acceptor.status().streams_rejected, 0);

    // Honest path telemetry: an observed Iroh IP path is reported as direct.
    let acceptor_path = acceptor
        .status()
        .last_path
        .expect("acceptor observed a path");
    assert_eq!(acceptor_path.observed_path, IrohObservedPath::Direct);
    assert!(!acceptor_path.is_relay);
    let tunnel_path = tunnel
        .status()
        .observed_path
        .expect("tunnel observed a path");
    assert_eq!(tunnel_path.observed_path, IrohObservedPath::Direct);
    assert_eq!(tunnel.status().streams_opened, 3);
    assert!(tunnel.status().connection_active);

    // Remote QUIC death does not remove the retained local tunnel handle.
    // Native polling must observe this terminal connection fact even before
    // the application releases that handle during recovery.
    server.shutdown().await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while tunnel.status().connection_active {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("remote shutdown must publish terminal connection status");
    assert!(tunnel.local_origin().is_ok());

    tunnel.stop();
    acceptor.stop();
    client.shutdown().await;
    _target.abort();
}

/// A closed QUIC connection must not retire a still-owned local listener.
/// The next local TCP accept reacquires the same Home through a fresh QUIC
/// connection without asking the caller to replace its tunnel lease.
#[tokio::test]
async fn home_tunnel_reacquires_closed_quic_on_next_local_connection() {
    let (target_addr, target, _target_accepted) = spawn_echo_target().await;
    let server = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let server_id = server.id().to_string();
    let direct_addr = server
        .endpoint()
        .addr()
        .ip_addrs()
        .next()
        .copied()
        .expect("server endpoint publishes a direct address");
    let acceptor = HomeAcceptor::start(
        &server,
        HomeAcceptorConfig { target: target_addr },
    )
    .unwrap();
    let tunnel = HomeTunnel::start(
        &client,
        home_tunnel_config(server_id.clone(), direct_addr),
    )
    .await
    .unwrap();
    let origin = tunnel.local_origin().unwrap();
    echo_over_tunnel(&origin, b"before-quic-close").await;
    assert_eq!(acceptor.status().connections_accepted, 1);

    // Retire only the remote acceptor's connection custody. Both authenticated
    // endpoints and the client tunnel lease remain alive.
    acceptor.stop_and_wait().await;
    let closed = wait_for(Duration::from_secs(5), || {
        !tunnel.status().connection_active
    })
    .await;
    if !closed {
        tunnel.stop_and_wait().await;
        client.shutdown().await;
        server.shutdown().await;
        target.abort();
        panic!("fixture remote retirement must close QUIC before the next local connect");
    }
    let replacement_acceptor = HomeAcceptor::start(
        &server,
        HomeAcceptorConfig { target: target_addr },
    )
    .expect("same Home endpoint can resume accepting connections");

    // No new HomeTunnel::start: the caller keeps its already-published origin.
    let payload = b"after-quic-close";
    let recovered: std::io::Result<Vec<u8>> = async {
        let mut socket = TcpStream::connect(loopback_target_of_origin(&origin)).await?;
        socket.write_all(payload).await?;
        let mut response = vec![0; payload.len()];
        socket.read_exact(&mut response).await?;
        Ok(response)
    }
    .await;
    let status = tunnel.status();
    let accepted = replacement_acceptor.status().connections_accepted;
    let remote_endpoint_id = tunnel.remote_endpoint_id().to_string();
    let retained_origin = tunnel.local_origin().unwrap();

    tunnel.stop_and_wait().await;
    replacement_acceptor.stop_and_wait().await;
    client.shutdown().await;
    server.shutdown().await;
    target.abort();

    assert_eq!(
        recovered.expect("next local TCP connection must reacquire QUIC and return the Home response"),
        payload,
    );
    assert_eq!(accepted, 1, "next local accept must establish a fresh QUIC connection");
    assert!(status.connection_active);
    assert_eq!(remote_endpoint_id, server_id);
    assert_eq!(retained_origin, origin);
}

/// Directional EOF from the QUIC initiator must shut down the fixed target's
/// TCP write half immediately. Waiting for the reverse direction would
/// deadlock targets that reply only after request EOF.
#[tokio::test]
async fn acceptor_propagates_quic_request_eof_to_fixed_target() {
    let request = b"request-delimited-by-eof";
    let response = b"response-after-eof";
    let (target_addr, target) = spawn_eof_then_reply_target(request, response).await;
    let server = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let direct_addr = server
        .endpoint()
        .addr()
        .ip_addrs()
        .next()
        .copied()
        .expect("server endpoint publishes a direct address");
    let acceptor = HomeAcceptor::start(
        &server,
        HomeAcceptorConfig {
            target: target_addr,
            ..HomeAcceptorConfig::default()
        },
    )
    .unwrap();
    let connection = client
        .endpoint()
        .connect(
            iroh::EndpointAddr::new(server.id()).with_ip_addr(direct_addr),
            crate::HOME_TUNNEL_ALPN,
        )
        .await
        .unwrap();
    let (mut send, mut recv) = connection.open_bi().await.unwrap();
    send.write_all(&[TUNNEL_PREAMBLE]).await.unwrap();
    send.write_all(request).await.unwrap();
    send.finish().unwrap();

    let mut received = vec![0u8; response.len()];
    tokio::time::timeout(Duration::from_secs(5), recv.read_exact(&mut received))
        .await
        .expect("fixed target must observe request EOF and reply")
        .expect("read fixed-target response");
    assert_eq!(received, response);

    connection.close(0u32.into(), b"done");
    acceptor.stop();
    client.shutdown().await;
    server.shutdown().await;
    target.await.unwrap();
}

/// Directional EOF from the fixed target must reach the local TCP client even
/// while the client keeps its request write half open.
#[tokio::test]
async fn tunnel_propagates_home_response_eof_to_local_client() {
    let request = b"request-prefix";
    let response = b"response-then-half-close";
    let (target_addr, target) = spawn_reply_then_keep_reading_target(request, response).await;
    let server = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let direct_addr = server
        .endpoint()
        .addr()
        .ip_addrs()
        .next()
        .copied()
        .expect("server endpoint publishes a direct address");
    let acceptor = HomeAcceptor::start(
        &server,
        HomeAcceptorConfig {
            target: target_addr,
            ..HomeAcceptorConfig::default()
        },
    )
    .unwrap();
    let tunnel = HomeTunnel::start(
        &client,
        home_tunnel_config(server.id().to_string(), direct_addr),
    )
    .await
    .unwrap();
    let mut local = TcpStream::connect(tunnel.local_addr().unwrap())
        .await
        .unwrap();
    local.write_all(request).await.unwrap();

    let mut received = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), local.read_to_end(&mut received))
        .await
        .expect("Home response EOF must reach the local client independently")
        .expect("read Home response");
    assert_eq!(received, response);

    drop(local);
    tunnel.stop();
    acceptor.stop();
    client.shutdown().await;
    server.shutdown().await;
    target.await.unwrap();
}

/// Stopping a live Home acceptor owns its active connection and stream pumps:
/// the public joined boundary cannot return while a detached pump can still
/// serve the old fixed target.
#[tokio::test]
async fn stopping_acceptor_joins_an_active_home_stream() {
    let (target_addr, target, mut target_accepted) = spawn_echo_target().await;
    let server = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let direct_addr = server
        .endpoint()
        .addr()
        .ip_addrs()
        .next()
        .copied()
        .expect("server endpoint publishes a direct address");
    let acceptor = HomeAcceptor::start(
        &server,
        HomeAcceptorConfig {
            target: target_addr,
            ..HomeAcceptorConfig::default()
        },
    )
    .unwrap();
    let tunnel = HomeTunnel::start(
        &client,
        home_tunnel_config(server.id().to_string(), direct_addr),
    )
    .await
    .unwrap();
    let mut local = TcpStream::connect(tunnel.local_addr().unwrap())
        .await
        .unwrap();
    local.write_all(b"active-before-release").await.unwrap();
    assert!(target_accepted.recv().await.is_some());

    acceptor.stop_and_wait().await;
    let mut byte = [0u8; 1];
    let closed = tokio::time::timeout(Duration::from_secs(5), local.read(&mut byte))
        .await
        .expect("joined acceptor shutdown must settle its active stream");
    assert!(
        !matches!(closed, Ok(n) if n > 0),
        "joined acceptor shutdown must not leave a stream serving bytes"
    );

    tunnel.stop_and_wait().await;
    client.shutdown().await;
    server.shutdown().await;
    target.abort();
}

/// Negative vertical: a wrong preamble byte must fail closed before the
/// acceptor opens anything toward the fixed loopback target.
#[tokio::test]
async fn malformed_preamble_fails_closed_before_any_fixed_target_byte() {
    let (target_addr, _target, mut target_accepted) = spawn_echo_target().await;
    let server = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let direct_addr = server
        .endpoint()
        .addr()
        .ip_addrs()
        .next()
        .copied()
        .expect("server endpoint publishes a direct address");
    let acceptor = HomeAcceptor::start(
        &server,
        HomeAcceptorConfig {
            target: target_addr,
            ..HomeAcceptorConfig::default()
        },
    )
    .unwrap();

    // Raw Iroh connection: exactly the pre-TCP preamble boundary under test.
    let connection = client
        .endpoint()
        .connect(
            iroh::EndpointAddr::new(server.id()).with_ip_addr(direct_addr),
            crate::HOME_TUNNEL_ALPN,
        )
        .await
        .unwrap();
    let (mut send, mut recv) = connection.open_bi().await.unwrap();
    send.write_all(&[0x00]).await.unwrap(); // wrong preamble framing byte

    // The peer must observe the failed stream, not an echo.
    let mut response = [0u8; 4];
    let observed_closed = tokio::time::timeout(Duration::from_secs(5), recv.read(&mut response))
        .await
        .map(|outcome| !matches!(outcome, Ok(Some(n)) if n > 0))
        .unwrap_or(true);
    assert!(observed_closed, "invalid preamble stream must fail closed");

    assert!(
        wait_for(Duration::from_secs(5), || {
            acceptor.status().streams_rejected >= 1
        })
        .await,
        "acceptor must account the rejected stream"
    );
    assert_eq!(
        acceptor.status().streams_accepted,
        0,
        "no stream may progress past the preamble boundary"
    );
    assert!(
        target_accepted.try_recv().is_err(),
        "the fixed loopback target must never be opened for a malformed preamble"
    );
    // The Iroh connection itself was accepted, so its observed path is real
    // telemetry even though every stream failed the preamble boundary.
    assert_eq!(acceptor.status().connections_accepted, 1);
    let accepted_path = acceptor
        .status()
        .last_path
        .expect("accepted connection produced an observed path snapshot");
    assert_eq!(accepted_path.observed_path, IrohObservedPath::Direct);

    connection.close(0u32.into(), b"done");
    acceptor.stop();
    client.shutdown().await;
    server.shutdown().await;
    _target.abort();
}

/// Three distinct legitimate remote endpoints can stay connected to one Home
/// concurrently. The transport's stream/window limits remain per connection;
/// an endpoint-wide product ceiling must not reject an otherwise valid third
/// device before it can move application bytes.
#[tokio::test]
async fn three_remote_endpoints_can_share_one_home_acceptor() {
    let (target_addr, _target, mut target_accepted) = spawn_echo_target().await;
    let server = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let direct_addr = server
        .endpoint()
        .addr()
        .ip_addrs()
        .next()
        .copied()
        .expect("server endpoint publishes a direct address");
    let acceptor = HomeAcceptor::start(
        &server,
        HomeAcceptorConfig {
            target: target_addr,
            ..HomeAcceptorConfig::default()
        },
    )
    .unwrap();

    let remote = iroh::EndpointAddr::new(server.id()).with_ip_addr(direct_addr);
    let mut clients = Vec::new();
    for expected_active in 1..=3 {
        let client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
        let connection = client
            .endpoint()
            .connect(remote.clone(), crate::HOME_TUNNEL_ALPN)
            .await
            .expect("legitimate remote endpoint connects");
        assert!(
            wait_for(Duration::from_secs(5), || {
                acceptor.status().connections_active >= expected_active
            })
            .await,
            "remote endpoint {expected_active} must remain active"
        );
        clients.push((client, connection));
    }

    // Every distinct remote endpoint moves bytes through the same fixed Home
    // target while all three connections remain live.
    for (client, connection) in clients.iter() {
        let (mut send, mut recv) = connection.open_bi().await.unwrap();
        send.write_all(&[TUNNEL_PREAMBLE]).await.unwrap();
        send.write_all(b"ping").await.unwrap();
        let mut echo = [0u8; 4];
        tokio::time::timeout(Duration::from_secs(5), recv.read_exact(&mut echo))
            .await
            .expect("admitted connection still echoes")
            .expect("admitted connection echo read");
        assert_eq!(echo, *b"ping");
        client.shutdown().await;
    }
    assert_eq!(acceptor.status().connections_accepted, 3);

    // All three streams reached the fixed target.
    assert!(target_accepted.recv().await.is_some());
    assert!(target_accepted.recv().await.is_some());
    assert!(target_accepted.recv().await.is_some());

    acceptor.stop();
    server.shutdown().await;
    _target.abort();
}

/// The acceptor only ever targets its configured loopback origin.
#[tokio::test]
async fn acceptor_rejects_non_loopback_targets() {
    let server = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let non_loopback: std::net::SocketAddr = "10.1.2.3:8080".parse().unwrap();
    let unspecified: std::net::SocketAddr = "0.0.0.0:8080".parse().unwrap();
    assert!(HomeAcceptor::start(
        &server,
        HomeAcceptorConfig {
            target: non_loopback,
            ..HomeAcceptorConfig::default()
        },
    )
    .is_err());
    assert!(HomeAcceptor::start(
        &server,
        HomeAcceptorConfig {
            target: unspecified,
            ..HomeAcceptorConfig::default()
        },
    )
    .is_err());
    server.shutdown().await;
}

/// Releasing one tunnel lease must neither shut down the shared process
/// endpoint nor disturb a sibling lease.
#[tokio::test]
async fn releasing_one_tunnel_keeps_shared_endpoint_and_sibling_lease() {
    let (target_addr, _target, _accepted) = spawn_echo_target().await;
    let server = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let direct_addr = server
        .endpoint()
        .addr()
        .ip_addrs()
        .next()
        .copied()
        .expect("server endpoint publishes a direct address");
    let acceptor = HomeAcceptor::start(
        &server,
        HomeAcceptorConfig {
            target: target_addr,
            ..HomeAcceptorConfig::default()
        },
    )
    .unwrap();

    let first = HomeTunnel::start(
        &client,
        home_tunnel_config(server.id().to_string(), direct_addr),
    )
    .await
    .unwrap();
    let second = HomeTunnel::start(
        &client,
        home_tunnel_config(server.id().to_string(), direct_addr),
    )
    .await
    .unwrap();

    echo_over_tunnel(&first.local_origin().unwrap(), b"first-lease").await;
    echo_over_tunnel(&second.local_origin().unwrap(), b"second-lease").await;

    // Release the first lease: its listener closes, nothing else does.
    let first_origin = first.local_origin().unwrap();
    first.stop();

    // Wait for the released lease's connection to drain before proving a new
    // lease can bind on the still-shared endpoint.
    assert!(
        wait_for(Duration::from_secs(5), || {
            acceptor.status().connections_active < 2
        })
        .await,
        "released lease connection must drain"
    );

    assert!(
        TcpStream::connect(loopback_target_of_origin(&first_origin))
            .await
            .is_err(),
        "released lease must stop serving its loopback origin"
    );
    echo_over_tunnel(&second.local_origin().unwrap(), b"second-lease-still-alive").await;

    // The shared client endpoint survives the release: a new lease binds.
    let third = HomeTunnel::start(
        &client,
        home_tunnel_config(server.id().to_string(), direct_addr),
    )
    .await
    .expect("shared endpoint must still accept new leases after a release");
    echo_over_tunnel(&third.local_origin().unwrap(), b"third-lease").await;

    third.stop();
    second.stop();
    acceptor.stop();
    client.shutdown().await;
    server.shutdown().await;
    _target.abort();
}

/// Tunnels bind loopback only; a non-loopback bind address is rejected.
#[tokio::test]
async fn tunnel_rejects_non_loopback_bind_addresses() {
    let client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let config = HomeTunnelConfig {
        bind_addr: "0.0.0.0:0".parse().unwrap(),
        ..HomeTunnelConfig::default()
    };
    assert!(HomeTunnel::start(&client, config).await.is_err());
    client.shutdown().await;
}

/// Opens one bidi stream on a raw client connection, optionally writing the
/// Home tunnel preamble first, sends `payload`, and returns the echoed bytes.
/// `None` means the stream or connection failed closed.
async fn raw_stream_roundtrip(
    connection: &iroh::endpoint::Connection,
    payload: &[u8],
    with_home_preamble: bool,
) -> Option<Vec<u8>> {
    let (mut send, mut recv) = connection.open_bi().await.ok()?;
    if with_home_preamble && send.write_all(&[TUNNEL_PREAMBLE]).await.is_err() {
        return None;
    }
    if send.write_all(payload).await.is_err() {
        return None;
    }
    let mut echoed = vec![0u8; payload.len()];
    tokio::time::timeout(Duration::from_secs(5), recv.read_exact(&mut echoed))
        .await
        .ok()?
        .ok()?;
    Some(echoed)
}

/// The minimal machine-ALPN seam consumer used by the dispatch tests: it
/// receives exactly the connections dispatched to the `happier/machine/1`
/// registration, asserts the authenticated remote identity, reports the
/// observed path, and echoes every bidi stream so the dialing client can prove
/// real bytes moved. This is dispatch-seam coverage only — no machine
/// handshake, grant parsing, loopback target, or application semantics.
async fn spawn_machine_echo_consumer(
    mut connections: mpsc::Receiver<AcceptedIrohConnection>,
    expected_remote_endpoint_id: String,
) -> (tokio::task::JoinHandle<()>, mpsc::Receiver<String>) {
    let (receipt_tx, receipt_rx) = mpsc::channel(4);
    let task = tokio::spawn(async move {
        let Some(accepted) = connections.recv().await else {
            return;
        };
        assert_eq!(
            accepted.remote_endpoint_id, expected_remote_endpoint_id,
            "machine consumer must receive the authenticated endpoint id of its own connection"
        );
        let _ = receipt_tx
            .send(accepted.path.observed_path.as_str().to_string())
            .await;
        let connection = accepted.connection;
        loop {
            let Ok((mut send, mut recv)) = connection.accept_bi().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buffer = [0u8; 512];
                loop {
                    match recv.read(&mut buffer).await {
                        Ok(Some(n)) if n > 0 => {
                            if send.write_all(&buffer[..n]).await.is_err() {
                                break;
                            }
                        }
                        _ => break,
                    }
                }
                let _ = send.finish();
            });
        }
    });
    (task, receipt_rx)
}

/// The single-endpoint ALPN dispatcher: one server endpoint advertising both
/// ALPNs, separate Home and machine consumers registered on that same
/// endpoint, and concurrent client dials. Each consumer must receive only its
/// own authenticated connection and only its own traffic, while the endpoint
/// owns exactly one accept loop.
#[tokio::test]
async fn dual_alpn_dispatch_routes_each_authenticated_connection_to_its_registered_consumer() {
    let (target_addr, _target, mut target_accepted) = spawn_echo_target().await;
    let server = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let direct_addr = server
        .endpoint()
        .addr()
        .ip_addrs()
        .next()
        .copied()
        .expect("server endpoint publishes a direct address");

    // Two consumers on ONE endpoint: Home via the acceptor, machine via the
    // fixed two-ALPN registration seam.
    let acceptor = HomeAcceptor::start(
        &server,
        HomeAcceptorConfig {
            target: target_addr,
            ..HomeAcceptorConfig::default()
        },
    )
    .expect("acceptor registers the Home consumer");
    let (machine_tx, machine_rx) = mpsc::channel(16);
    let _machine_registration = server
        .register_consumer(IrohAlpn::Machine, machine_tx)
        .expect("machine consumer registers on the same endpoint");

    let home_client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let machine_client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let remote = iroh::EndpointAddr::new(server.id()).with_ip_addr(direct_addr);
    let machine_echo =
        spawn_machine_echo_consumer(machine_rx, machine_client.id().to_string()).await;

    // Concurrent dials, one per ALPN, from separate real client endpoints.
    let home_client_endpoint = home_client.endpoint();
    let machine_client_endpoint = machine_client.endpoint();
    let (home_connection, machine_connection) = tokio::join!(
        home_client_endpoint.connect(remote.clone(), crate::HOME_TUNNEL_ALPN),
        machine_client_endpoint.connect(remote.clone(), crate::MACHINE_ALPN),
    );
    let home_connection = home_connection.expect("home ALPN dial connects");
    let machine_connection = machine_connection.expect("machine ALPN dial connects");

    // Each consumer served exactly its own connection with real bytes.
    let home_echo = raw_stream_roundtrip(&home_connection, b"home-tunnel-bytes", true)
        .await
        .expect("home connection echoes through the fixed target");
    assert_eq!(home_echo, b"home-tunnel-bytes");
    let machine_echo_bytes =
        raw_stream_roundtrip(&machine_connection, b"machine-carrier-bytes", false)
            .await
            .expect("machine connection echoes through its consumer");
    assert_eq!(machine_echo_bytes, b"machine-carrier-bytes");

    assert!(
        target_accepted.recv().await.is_some(),
        "home bytes reached the fixed loopback target"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(250), target_accepted.recv())
            .await
            .is_err(),
        "machine traffic must never touch the Home fixed target"
    );

    let (machine_echo_task, mut machine_receipts) = machine_echo;
    let observed = machine_receipts
        .recv()
        .await
        .expect("machine consumer reported its accepted connection");
    assert_eq!(
        observed, "direct",
        "a dialed IP path is honestly observed as direct"
    );
    // Exactly one machine connection was dispatched: no second receipt ever
    // arrives.
    assert!(
        tokio::time::timeout(Duration::from_millis(250), machine_receipts.recv())
            .await
            .is_err(),
        "exactly one connection may be dispatched to the machine consumer"
    );

    // Slot-scoped accounting: the Home acceptor saw only its own connection.
    assert!(
        wait_for(Duration::from_secs(5), || acceptor
            .status()
            .connections_active
            == 1)
        .await,
        "the home connection must stay admitted"
    );
    assert_eq!(
        acceptor.status().connections_accepted,
        1,
        "the Home slot must count only its own dispatched connection"
    );
    assert_eq!(acceptor.status().streams_accepted, 1);
    assert_eq!(acceptor.status().streams_rejected, 0);

    home_connection.close(0u32.into(), b"done");
    machine_connection.close(0u32.into(), b"done");
    machine_echo_task.abort();
    acceptor.stop();
    home_client.shutdown().await;
    machine_client.shutdown().await;
    server.shutdown().await;
    _target.abort();
}

/// Advertised-but-unregistered ALPNs (machine here) and completely unknown
/// ALPNs get no application access: the dispatcher fails closed without
/// touching any consumer, the fixed target, or any application stream, and it
/// keeps serving registered consumers afterwards.
#[tokio::test]
async fn unregistered_and_unknown_alpns_get_no_application_access() {
    let (target_addr, _target, mut target_accepted) = spawn_echo_target().await;
    let server = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let direct_addr = server
        .endpoint()
        .addr()
        .ip_addrs()
        .next()
        .copied()
        .expect("server endpoint publishes a direct address");
    let acceptor = HomeAcceptor::start(
        &server,
        HomeAcceptorConfig {
            target: target_addr,
            ..HomeAcceptorConfig::default()
        },
    )
    .unwrap();
    let client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let remote = iroh::EndpointAddr::new(server.id()).with_ip_addr(direct_addr);

    // Machine ALPN is advertised by the endpoint but no consumer is
    // registered for it.
    match client
        .endpoint()
        .connect(remote.clone(), crate::MACHINE_ALPN)
        .await
    {
        Err(_) => {
            // Rejected before the handshake completed.
        }
        Ok(connection) => {
            // Even if the handshake completed before the rejection landed, the
            // dispatcher closed the connection: it must terminate without any
            // application stream being served.
            tokio::time::timeout(Duration::from_secs(5), connection.closed())
                .await
                .expect("unregistered-ALPN connection must close");
            assert!(
                connection.open_bi().await.is_err(),
                "an unregistered ALPN must never gain an application stream"
            );
        }
    }

    // A completely unknown ALPN is refused at QUIC ALPN negotiation.
    assert!(
        client
            .endpoint()
            .connect(remote.clone(), b"happier/other/9")
            .await
            .is_err(),
        "unknown ALPNs must fail negotiation and never reach any consumer"
    );

    // The dispatcher stays healthy: Home still moves bytes afterwards.
    let home = client
        .endpoint()
        .connect(remote, crate::HOME_TUNNEL_ALPN)
        .await
        .unwrap();
    let echoed = raw_stream_roundtrip(&home, b"after-rejections", true)
        .await
        .expect("home dispatch survives rejected ALPN dials");
    assert_eq!(echoed, b"after-rejections");
    assert!(target_accepted.recv().await.is_some());
    assert_eq!(acceptor.status().connections_accepted, 1);

    home.close(0u32.into(), b"done");
    acceptor.stop();
    client.shutdown().await;
    server.shutdown().await;
    _target.abort();
}

/// A real TLS no_application_protocol alert must remain a protocol refusal,
/// not ordinary reachability failure eligible for another Home carrier.
#[tokio::test]
async fn home_tunnel_preserves_incompatible_alpn_negotiation_failure() {
    let server = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    server
        .endpoint()
        .set_alpns(vec![b"happier/other/9".to_vec()]);
    let direct_addr = server.endpoint().addr().ip_addrs().next().copied().unwrap();
    let client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        HomeTunnel::start(
            &client,
            home_tunnel_config(server.id().to_string(), direct_addr),
        ),
    )
    .await
    .expect("incompatible ALPN handshake must settle");
    let failure = result
        .err()
        .expect("incompatible ALPN cannot publish a Home tunnel");
    client.shutdown().await;
    server.shutdown().await;
    assert_eq!(failure, IrohError::UnsupportedAlpn);
}

/// Pre-application custody at the endpoint: connections the dispatcher has
/// accepted but not yet handed to a consumer are its own bounded resource. When
/// the hand-over stalls, the accept side must backpressure instead of retaining
/// unbounded handshake work, and endpoint shutdown must release everything still
/// held.
#[tokio::test]
async fn pre_dispatch_custody_stays_bounded_under_stalled_handovers_and_shutdown_releases_it() {
    let server = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let direct_addr = server
        .endpoint()
        .addr()
        .ip_addrs()
        .next()
        .copied()
        .expect("server endpoint publishes a direct address");

    // A registered consumer that never drains its queue: once the queue is
    // full every further hand-over stalls inside the dispatcher.
    let (home_tx, _stalled_home_rx) = mpsc::channel(CONSUMER_CHANNEL_CAPACITY);
    let _registration = server
        .register_consumer(IrohAlpn::HomeTunnel, home_tx)
        .expect("home consumer registers");

    let client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let remote = iroh::EndpointAddr::new(server.id()).with_ip_addr(direct_addr);
    let mut dials = Vec::new();
    for _ in 0..(MAX_PENDING_HANDSHAKES * 2) {
        let endpoint = client.endpoint();
        let remote = remote.clone();
        dials.push(tokio::spawn(async move {
            endpoint.connect(remote, crate::HOME_TUNNEL_ALPN).await.ok()
        }));
    }

    let mut peak = 0usize;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        let pending = server.pending_handshakes();
        peak = peak.max(pending);
        assert!(
            pending <= MAX_PENDING_HANDSHAKES,
            "the endpoint must never hold more than {MAX_PENDING_HANDSHAKES} connections in pre-application custody (observed {pending})"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        peak > CONSUMER_CHANNEL_CAPACITY,
        "the fixture must push past one consumer queue's worth of work for the bound to mean anything (peak {peak})"
    );

    server.shutdown().await;
    assert!(
        wait_for(Duration::from_secs(5), || server.pending_handshakes() == 0).await,
        "endpoint shutdown must release every connection still in pre-application custody"
    );

    for dial in dials {
        dial.abort();
    }
    client.shutdown().await;
}

/// An admitted Home connection that never opens an application stream is
/// released after the bounded custody window instead of holding connection
/// resources for as long as the peer likes. Nothing reaches the fixed loopback
/// target, because no stream ever existed to reach it.
#[tokio::test]
async fn an_admitted_home_connection_that_opens_no_stream_drains_after_the_custody_window() {
    let (target_addr, _target, mut target_accepted) = spawn_echo_target().await;
    let server = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let direct_addr = server
        .endpoint()
        .addr()
        .ip_addrs()
        .next()
        .copied()
        .expect("server endpoint publishes a direct address");
    let acceptor = HomeAcceptor::start(
        &server,
        HomeAcceptorConfig {
            target: target_addr,
            ..HomeAcceptorConfig::default()
        },
    )
    .expect("acceptor registers the Home consumer");
    let client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let remote = iroh::EndpointAddr::new(server.id()).with_ip_addr(direct_addr);

    let connection = client
        .endpoint()
        .connect(remote, crate::HOME_TUNNEL_ALPN)
        .await
        .expect("home dial connects");
    assert!(
        wait_for(Duration::from_secs(5), || acceptor
            .status()
            .connections_active
            == 1)
        .await,
        "the connection must be admitted before the custody window is measured"
    );

    // The peer never opens a bidirectional application stream.
    tokio::time::timeout(
        PRE_APPLICATION_CUSTODY_TIMEOUT + Duration::from_secs(5),
        connection.closed(),
    )
    .await
    .expect("a connection that opens no application stream must be released");

    assert!(
        tokio::time::timeout(Duration::from_millis(250), target_accepted.recv())
            .await
            .is_err(),
        "a connection without a first stream must never contact the fixed target"
    );
    assert_eq!(
        acceptor.status().streams_accepted,
        0,
        "no stream was ever accepted"
    );

    acceptor.stop();
    client.shutdown().await;
    server.shutdown().await;
    _target.abort();
}

/// Once a connection has opened its first application stream it keeps the
/// existing long-lived semantics: the custody window does not become a
/// connection-wide idle timeout, so a later stream still works after a gap
/// longer than the window. This is what Socket.IO and Mutagen depend on.
#[tokio::test]
async fn a_home_connection_stays_usable_past_the_custody_window_after_its_first_stream() {
    let (target_addr, _target, mut target_accepted) = spawn_echo_target().await;
    let server = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let direct_addr = server
        .endpoint()
        .addr()
        .ip_addrs()
        .next()
        .copied()
        .expect("server endpoint publishes a direct address");
    let acceptor = HomeAcceptor::start(
        &server,
        HomeAcceptorConfig {
            target: target_addr,
            ..HomeAcceptorConfig::default()
        },
    )
    .expect("acceptor registers the Home consumer");
    let client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let remote = iroh::EndpointAddr::new(server.id()).with_ip_addr(direct_addr);

    let connection = client
        .endpoint()
        .connect(remote, crate::HOME_TUNNEL_ALPN)
        .await
        .expect("home dial connects");
    let first = raw_stream_roundtrip(&connection, b"first-stream", true)
        .await
        .expect("the first application stream moves bytes");
    assert_eq!(first, b"first-stream");
    assert!(target_accepted.recv().await.is_some());

    // Idle for longer than the pre-application custody window.
    tokio::time::sleep(PRE_APPLICATION_CUSTODY_TIMEOUT + Duration::from_secs(2)).await;

    let later = raw_stream_roundtrip(&connection, b"later-stream", true)
        .await
        .expect("a connection that did application work stays usable past the custody window");
    assert_eq!(later, b"later-stream");
    assert_eq!(acceptor.status().streams_accepted, 2);

    connection.close(0u32.into(), b"done");
    acceptor.stop();
    client.shutdown().await;
    server.shutdown().await;
    _target.abort();
}

/// Registration is exclusive per ALPN and fails typed on duplicates (a second
/// accept owner), while a stopped acceptor fully releases its registration so
/// the same still-live endpoint can start a fresh acceptor with no stale
/// registration. The machine ALPN is an independent key on the same endpoint.
#[tokio::test]
async fn duplicate_registration_fails_typed_and_stop_releases_for_restart() {
    let (target_addr, _target, mut target_accepted) = spawn_echo_target().await;
    let server = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let direct_addr = server
        .endpoint()
        .addr()
        .ip_addrs()
        .next()
        .copied()
        .expect("server endpoint publishes a direct address");
    let config = HomeAcceptorConfig {
        target: target_addr,
        ..HomeAcceptorConfig::default()
    };
    let acceptor = HomeAcceptor::start(&server, config).unwrap();

    // Duplicate Home registration attempts fail typed, both raw and via a
    // second acceptor (which would otherwise race the first accept loop).
    let (duplicate_tx, _duplicate_rx) = mpsc::channel(16);
    assert!(
        matches!(
            server.register_consumer(IrohAlpn::HomeTunnel, duplicate_tx),
            Err(IrohError::EndpointConfigConflict)
        ),
        "a duplicate Home registration must fail typed"
    );
    assert!(
        HomeAcceptor::start(&server, config).is_err(),
        "a second Home acceptor must not create a second accept owner"
    );

    // The machine ALPN is an independent key on the same endpoint: it can be
    // registered while Home is registered (its full dispatch behavior is
    // exercised by the dual-dispatch test).
    let (machine_tx, _machine_rx) = mpsc::channel(16);
    server
        .register_consumer(IrohAlpn::Machine, machine_tx)
        .expect("machine slot must be independent of the Home slot");

    // Stop releases the Home registration; a fresh acceptor can start on the
    // same still-live endpoint and serve moving bytes again.
    acceptor.stop();
    let restarted = HomeAcceptor::start(&server, config)
        .expect("restart after stop must not hit a stale registration");
    let client = IrohEndpoint::bind(&direct_endpoint_config()).await.unwrap();
    let connection = client
        .endpoint()
        .connect(
            iroh::EndpointAddr::new(server.id()).with_ip_addr(direct_addr),
            crate::HOME_TUNNEL_ALPN,
        )
        .await
        .unwrap();
    let echoed = raw_stream_roundtrip(&connection, b"restarted-acceptor", true)
        .await
        .expect("restarted acceptor moves bytes through the fixed target");
    assert_eq!(echoed, b"restarted-acceptor");
    assert!(target_accepted.recv().await.is_some());
    assert_eq!(restarted.status().connections_accepted, 1);

    connection.close(0u32.into(), b"done");
    restarted.stop();
    client.shutdown().await;
    server.shutdown().await;
    _target.abort();
}

/// A forced-relay fixture: with direct IP transports removed on both endpoints
/// and only a local relay configured, Home tunnel bytes traverse the relay and
/// both sides honestly report the observed relay path.
///
/// Uses the one local relay owner (`LocalTestRelay`), compiled only under the
/// test-only `test-relay-fixture` cargo feature so it can never become a
/// release behavior dependency.
///
/// Sequencing contract (the boundaries that can otherwise wait forever):
/// 1. The fixture relay serves plain HTTP, so both endpoints bind with ordinary
///    CA verification: there is no TLS trust bypass anywhere in the tree.
/// 2. `bind()` only binds sockets; relay connections come up in the
///    background. Both endpoints must await relay readiness (`online()`)
///    before the dial, bounded so an unreachable relay fails with a stable
///    diagnostic instead of hanging the binary.
/// 3. Tunnel connect, each byte exchange, and shutdown are individually
///    bounded so a relay-path regression identifies the fixture phase that
///    stalled. The transport profiles retain upstream keepalive and idle
///    detection; those do not measure completion of an application exchange.
#[cfg(all(test, feature = "test-relay-fixture"))]
mod relay_fixture {
    use super::*;
    use crate::{
        IrohCapProfile, MachineAcceptor, MachineAcceptorConfig, MachineHandshakeProvider,
        MachineHttpTunnel, MachineTunnelConfig, RelaySelection,
        IROH_MACHINE_APPLICATION_PORT_HEADER, IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
    };
    use iroh::Watcher;
    use std::sync::Arc;

    /// Bounded diagnostic windows: generous for a loopback relay, small enough
    /// that a regression fails fast at the exact stalled boundary.
    const RELAY_ONLINE_TIMEOUT: Duration = Duration::from_secs(15);
    const TUNNEL_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
    const ECHO_EXCHANGE_TIMEOUT: Duration = Duration::from_secs(10);
    const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

    /// Bounded relay-readiness wait: `online()` pends forever when the relay
    /// never becomes reachable (e.g. relay TLS trust or relay-map
    /// misconfiguration), so it is wrapped and the observed home relay is
    /// asserted to be exactly the fixture relay.
    async fn wait_relay_online(role: &str, endpoint: &IrohEndpoint, relay_url: &iroh::RelayUrl) {
        tokio::time::timeout(RELAY_ONLINE_TIMEOUT, async {
            loop {
                if endpoint
                    .endpoint()
                    .home_relay_status()
                    .get()
                    .iter()
                    .any(|relay| relay.url() == relay_url && relay.is_connected())
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "{role} endpoint must reach the local test relay within \
                 {RELAY_ONLINE_TIMEOUT:?} (fixture relay reachability / relay map)"
            )
        });
    }

    #[tokio::test]
    async fn forced_relay_carries_home_tunnel_bytes_and_reports_relay_path() {
        // The one local relay owner; the server stops when the binding drops.
        let relay = crate::LocalTestRelay::spawn().await.expect("local relay");
        let relay_url = relay.url().clone();
        let relay_url_string = relay.url_string();

        // Direct IP transports are removed: the relay is the only route.
        let relay_endpoint_config = || crate::EndpointConfig {
            relay_policy: RelayPolicy::Automatic,
            relay_urls: vec![relay_url_string.clone()],
            caps: IrohCapProfile::HomeInteractive,
            disable_ip_transports: true,
            ..crate::EndpointConfig::default()
        };
        let server = IrohEndpoint::bind(&relay_endpoint_config()).await.unwrap();
        let client = IrohEndpoint::bind(&relay_endpoint_config()).await.unwrap();

        // Readiness boundary: dialing before both endpoints are connected to
        // the (only) relay can never succeed, and waiting is bounded above.
        wait_relay_online("server", &server, &relay_url).await;
        wait_relay_online("client", &client, &relay_url).await;

        // The endpoints must have published the relay as their only transport.
        assert!(server.endpoint().addr().ip_addrs().next().is_none());
        assert_eq!(
            RelaySelection::resolve(&RelayPolicy::Automatic, &[relay_url_string.clone()])
                .unwrap()
                .relay_urls(),
            std::slice::from_ref(&relay_url)
        );

        let (target_addr, _target, mut target_accepted) = spawn_echo_target().await;
        let acceptor = HomeAcceptor::start(
            &server,
            HomeAcceptorConfig {
                target: target_addr,
                ..HomeAcceptorConfig::default()
            },
        )
        .unwrap();

        // Tunnel connect is the next indefinite-wait boundary: bounded with a
        // stable diagnostic instead of an unbounded await.
        let tunnel = tokio::time::timeout(
            TUNNEL_CONNECT_TIMEOUT,
            HomeTunnel::start(
                &client,
                HomeTunnelConfig {
                    endpoint_id: server.id().to_string(),
                    // Relay hint only; no direct address exists in this topology.
                    relay_urls: vec![relay_url.clone()],
                    ..HomeTunnelConfig::default()
                },
            ),
        )
        .await
        .unwrap_or_else(|_| {
            panic!(
                "tunnel connect through the forced-relay topology must complete \
                 within {TUNNEL_CONNECT_TIMEOUT:?}"
            )
        })
        .expect("tunnel connects through the forced-relay topology");

        // Bound each application exchange separately from transport liveness
        // so a stalled relay echo has a phase-specific fixture failure.
        for payload in [b"over-relay".as_slice(), b"second-relay-stream".as_slice()] {
            tokio::time::timeout(
                ECHO_EXCHANGE_TIMEOUT,
                echo_over_tunnel(&tunnel.local_origin().unwrap(), payload),
            )
            .await
            .unwrap_or_else(|_| {
                panic!("relay echo exchange must complete within {ECHO_EXCHANGE_TIMEOUT:?}")
            });
        }

        assert_eq!(acceptor.status().connections_accepted, 1);
        assert_eq!(acceptor.status().streams_accepted, 2);
        assert!(
            target_accepted.try_recv().is_ok(),
            "relay path delivers bytes to the fixed target"
        );

        // Honest telemetry: the observed path is the relay, on both sides.
        let acceptor_path = acceptor
            .status()
            .last_path
            .expect("acceptor observed the relay path");
        assert_eq!(acceptor_path.observed_path, IrohObservedPath::Relay);
        assert!(acceptor_path.is_relay);
        let tunnel_path = tunnel
            .status()
            .observed_path
            .expect("tunnel observed the relay path");
        assert_eq!(tunnel_path.observed_path, IrohObservedPath::Relay);
        assert!(tunnel_path.is_relay);

        tunnel.stop();
        acceptor.stop();
        // Bounded shutdown: a stuck endpoint close must fail the test, not
        // hang it (and the fixture relay stops when this binding drops).
        tokio::time::timeout(SHUTDOWN_TIMEOUT, client.shutdown())
            .await
            .expect("client endpoint shutdown must complete");
        tokio::time::timeout(SHUTDOWN_TIMEOUT, server.shutdown())
            .await
            .expect("server endpoint shutdown must complete");
        _target.abort();
    }

    #[tokio::test]
    async fn forced_relay_carries_authorized_machine_tunnel_bytes() {
        let relay = crate::LocalTestRelay::spawn().await.expect("local relay");
        let relay_url = relay.url().clone();
        let config = || crate::EndpointConfig {
            relay_policy: RelayPolicy::Automatic,
            relay_urls: vec![relay_url.to_string()],
            caps: IrohCapProfile::MachineBulk,
            disable_ip_transports: true,
            ..crate::EndpointConfig::default()
        };
        let server = IrohEndpoint::bind(&config()).await.unwrap();
        let client = IrohEndpoint::bind(&config()).await.unwrap();
        wait_relay_online("machine-server", &server, &relay_url).await;
        wait_relay_online("machine-client", &client, &relay_url).await;

        let (app_target, app_task, mut app_accepted) = spawn_echo_target().await;
        let admission_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let admission_target = admission_listener.local_addr().unwrap();
        let expected_remote = client.id().to_string();
        let admission_task = tokio::spawn(async move {
            let (mut socket, _) = admission_listener.accept().await.unwrap();
            let mut request = vec![0u8; 128 * 1024];
            let read = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.contains(&format!(
                "X-Happier-Iroh-Remote-Endpoint-Id: {expected_remote}\r\n"
            )));
            assert!(
                request.ends_with(r#"{"v":1,"kind":"provider_broker","witness":"fresh-relay"}"#)
            );
            // The trusted local admission response selects the application
            // loopback port for the admitted stream.
            let response = format!("HTTP/1.1 204 No Content\r\nX-Happier-Iroh-Remote-Endpoint-Id: {expected_remote}\r\n{IROH_MACHINE_APPLICATION_PORT_HEADER}: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", app_target.port());
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        let acceptor =
            MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target }).unwrap();
        let provider: MachineHandshakeProvider = Arc::new(|| {
            Box::pin(async {
                Ok(r#"{"v":1,"kind":"provider_broker","witness":"fresh-relay"}"#.to_owned())
            })
        });
        let tunnel = tokio::time::timeout(
            TUNNEL_CONNECT_TIMEOUT,
            MachineHttpTunnel::start_with_handshake_provider(
                &client,
                MachineTunnelConfig {
                    endpoint_id: server.id().to_string(),
                    bind_addr: "127.0.0.1:0".parse().unwrap(),
                    direct_addresses: vec![],
                    relay_urls: vec![relay_url.clone()],
                    handshake_json:
                        r#"{"v":1,"kind":"provider_broker","operationId":"relay-machine"}"#
                            .to_owned(),
                    cap_profile: IrohCapProfile::MachineBulk,
                },
                provider,
            ),
        )
        .await
        .expect("bounded relay machine connect")
        .expect("relay machine tunnel");
        let mut socket = TcpStream::connect(tunnel.local_addr().unwrap())
            .await
            .unwrap();
        let request = format!(
            "POST /machine-relay HTTP/1.1\r\nHost: 127.0.0.1\r\n{IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER}: {}\r\nContent-Length: 18\r\n\r\nmachine-over-relay",
            tunnel.local_capability(),
        );
        let forwarded_request = "POST /machine-relay HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 18\r\n\r\nmachine-over-relay";
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut echo = vec![0u8; forwarded_request.len()];
        tokio::time::timeout(ECHO_EXCHANGE_TIMEOUT, socket.read_exact(&mut echo))
            .await
            .expect("bounded machine relay echo")
            .unwrap();
        assert_eq!(echo, forwarded_request.as_bytes());
        assert!(app_accepted.try_recv().is_ok());
        assert_eq!(
            acceptor.status().last_path.unwrap().observed_path,
            IrohObservedPath::Relay
        );
        assert_eq!(
            tunnel.status().observed_path.observed_path,
            IrohObservedPath::Relay
        );
        assert_eq!(tunnel.status().remote_endpoint_id, server.id().to_string());
        admission_task.await.unwrap();
        tunnel.stop();
        acceptor.stop();
        tokio::time::timeout(SHUTDOWN_TIMEOUT, client.shutdown())
            .await
            .unwrap();
        tokio::time::timeout(SHUTDOWN_TIMEOUT, server.shutdown())
            .await
            .unwrap();
        app_task.abort();
    }

    #[tokio::test]
    async fn one_client_endpoint_serves_two_homes_on_distinct_relays_concurrently() {
        let relay_server_a = crate::LocalTestRelay::spawn().await.unwrap();
        let relay_server_b = crate::LocalTestRelay::spawn().await.unwrap();
        let relay_a = relay_server_a.url().clone();
        let relay_b = relay_server_b.url().clone();

        let server_config = |relay: &iroh::RelayUrl| crate::EndpointConfig {
            relay_policy: RelayPolicy::Automatic,
            relay_urls: vec![relay.to_string()],
            caps: IrohCapProfile::HomeInteractive,
            disable_ip_transports: true,
            ..crate::EndpointConfig::default()
        };
        let home_a = IrohEndpoint::bind(&server_config(&relay_a)).await.unwrap();
        let home_b = IrohEndpoint::bind(&server_config(&relay_b)).await.unwrap();
        wait_relay_online("home-a", &home_a, &relay_a).await;
        wait_relay_online("home-b", &home_b, &relay_b).await;

        let manager = crate::EndpointManager::new();
        let identity = crate::EndpointIdentity::Seeded(
            crate::EndpointSeed::from_bytes([91; 32]).endpoint_id(),
        );
        let client_config = |relay: &iroh::RelayUrl| crate::EndpointConfig {
            key_seed: Some(crate::EndpointSeed::from_bytes([91; 32])),
            relay_policy: RelayPolicy::Automatic,
            relay_urls: vec![relay.to_string()],
            caps: IrohCapProfile::HomeInteractive,
            disable_ip_transports: true,
            ..crate::EndpointConfig::default()
        };
        let client = manager
            .acquire_identified(identity.clone(), &client_config(&relay_a))
            .await
            .unwrap();
        let client_id = client.id();
        let same_client = manager
            .acquire_identified(identity.clone(), &client_config(&relay_b))
            .await
            .expect("second Home relay extends the shared endpoint");
        assert_eq!(same_client.id(), client_id);

        let (target_a_addr, target_a, _target_a_accepted) = spawn_echo_target().await;
        let (target_b_addr, target_b, _target_b_accepted) = spawn_echo_target().await;
        let acceptor_a = HomeAcceptor::start(
            &home_a,
            HomeAcceptorConfig {
                target: target_a_addr,
            },
        )
        .unwrap();
        let acceptor_b = HomeAcceptor::start(
            &home_b,
            HomeAcceptorConfig {
                target: target_b_addr,
            },
        )
        .unwrap();
        let tunnel_a = HomeTunnel::start(
            &client,
            HomeTunnelConfig {
                endpoint_id: home_a.id().to_string(),
                relay_urls: vec![relay_a.clone()],
                ..HomeTunnelConfig::default()
            },
        )
        .await
        .unwrap();
        let tunnel_b = HomeTunnel::start(
            &client,
            HomeTunnelConfig {
                endpoint_id: home_b.id().to_string(),
                relay_urls: vec![relay_b.clone()],
                ..HomeTunnelConfig::default()
            },
        )
        .await
        .unwrap();

        echo_over_tunnel(&tunnel_a.local_origin().unwrap(), b"home-a").await;
        echo_over_tunnel(&tunnel_b.local_origin().unwrap(), b"home-b").await;
        assert_eq!(
            tunnel_a.status().observed_path.unwrap().observed_path,
            IrohObservedPath::Relay
        );
        assert_eq!(
            tunnel_b.status().observed_path.unwrap().observed_path,
            IrohObservedPath::Relay
        );
        let (applied, _) = manager.get(&identity).unwrap();
        assert_eq!(applied.relay.relay_urls().len(), 2);

        tunnel_a.stop();
        tunnel_b.stop();
        acceptor_a.stop();
        acceptor_b.stop();
        target_a.abort();
        target_b.abort();
        manager.shutdown(&identity).await;
        home_a.shutdown().await;
        home_b.shutdown().await;
    }
}
