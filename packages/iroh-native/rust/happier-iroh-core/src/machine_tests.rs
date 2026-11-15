use crate::{
    EndpointConfig, HomeAcceptor, HomeAcceptorConfig, HomeTunnel, HomeTunnelConfig, IrohCapProfile,
    IrohEndpoint, IrohError, MachineAcceptor, MachineAcceptorConfig, MachineFailureCode, MachineHandshakeProvider,
    MachineHttpTunnel, MachineTunnel, MachineTunnelConfig, RelayPolicy,
    IROH_MACHINE_APPLICATION_CAPABILITY_HEADER, IROH_MACHINE_APPLICATION_PORT_HEADER,
    IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
};
use std::collections::VecDeque;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

async fn endpoint(profile: IrohCapProfile) -> IrohEndpoint {
    IrohEndpoint::bind(&EndpointConfig {
        relay_policy: RelayPolicy::Disabled,
        caps: profile,
        ..EndpointConfig::default()
    })
    .await
    .expect("endpoint")
}

async fn direct_addr(endpoint: &IrohEndpoint) -> SocketAddr {
    for _ in 0..100 {
        if let Some(addr) = endpoint.endpoint().addr().ip_addrs().next() {
            return *addr;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("direct address unavailable")
}

async fn echo_server(contacts: Arc<AtomicUsize>) -> SocketAddr {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind app");
    let addr = listener.local_addr().expect("app addr");
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            contacts.fetch_add(1, Ordering::Relaxed);
            tokio::spawn(async move {
                let (mut read, mut write) = socket.split();
                let mut request = Vec::new();
                if read.read_to_end(&mut request).await.is_ok() {
                    let _ = write.write_all(b"app-reply:").await;
                    let _ = write.write_all(&request).await;
                }
            });
        }
    });
    addr
}

/// Loopback discovery can contact any fixture listener with a root HTTP probe,
/// TLS handshake, or an empty connection. Only admission requests belong to
/// these fixtures; once the request line matches, keep all strict framing and
/// payload assertions so a broken admission client still fails its test.
async fn accept_admission_request(listener: &TcpListener) -> (TcpStream, Vec<u8>) {
    const REQUEST_LINE: &[u8] = b"POST /v1/iroh/machine/admit HTTP/1.1\r\n";
    loop {
        let (mut socket, _) = listener.accept().await.expect("accept admission");
        let mut matched = true;
        for expected in REQUEST_LINE {
            let mut byte = [0u8; 1];
            if socket.read_exact(&mut byte).await.is_err() || byte[0] != *expected {
                matched = false;
                break;
            }
        }
        if matched {
            let request = read_http_request(&mut socket, REQUEST_LINE.to_vec()).await;
            return (socket, request);
        }
    }
}

async fn read_http_request(socket: &mut TcpStream, mut request: Vec<u8>) -> Vec<u8> {
    let header_end = loop {
        let mut chunk = [0u8; 1024];
        let read = socket.read(&mut chunk).await.expect("read request head");
        assert!(read > 0, "request ended before its HTTP head");
        request.extend_from_slice(&chunk[..read]);
        if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let head = std::str::from_utf8(&request[..header_end]).expect("utf8 request head");
    let content_length = head
        .lines()
        .find_map(|line| {
            line.split_once(':').and_then(|(name, value)| {
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().expect("content length"))
            })
        })
        .expect("content length header");
    let body_end = header_end + content_length;
    while request.len() < body_end {
        let mut chunk = vec![0u8; body_end - request.len()];
        let read = socket.read(&mut chunk).await.expect("read request body");
        assert!(read > 0, "request ended before its Content-Length body");
        request.extend_from_slice(&chunk[..read]);
    }
    request.truncate(body_end);
    request
}

async fn read_http_head_bytewise(socket: &mut TcpStream) -> Vec<u8> {
    let mut head = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        socket
            .read_exact(&mut byte)
            .await
            .expect("read complete HTTP request head");
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            return head;
        }
    }
}

/// Admission responses with a per-response queue of application-port header
/// values: each queued entry is the exact set of
/// `{IROH_MACHINE_APPLICATION_PORT_HEADER}` header lines to emit for one
/// admission response. An empty entry omits the header entirely; multiple
/// entries emit duplicate header lines. Every response is a valid 2xx with an
/// exact remote-endpoint echo, so only the application-port selection varies.
async fn admission_server(
    expected_remote: String,
    application_ports: Arc<Mutex<VecDeque<Vec<String>>>>,
    contacts: Arc<AtomicUsize>,
) -> SocketAddr {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind admission");
    let addr = listener.local_addr().expect("admission addr");
    tokio::spawn(async move {
        loop {
            let (mut socket, request) = accept_admission_request(&listener).await;
            contacts.fetch_add(1, Ordering::Relaxed);
            let request = String::from_utf8_lossy(&request);
            assert!(request.starts_with("POST /v1/iroh/machine/admit HTTP/1.1\r\n"));
            assert!(request.contains(&format!(
                "X-Happier-Iroh-Remote-Endpoint-Id: {expected_remote}\r\n"
            )));
            // The verified canonical handshake is forwarded to admission as a
            // bounded JSON object body, independent of the handshake content.
            let (_, body) = request.split_once("\r\n\r\n").expect("request head/body");
            let parsed: serde_json::Value =
                serde_json::from_str(body).expect("handshake body must be a JSON object");
            assert!(parsed.is_object());
            let ports = application_ports
                .lock()
                .expect("application port queue")
                .pop_front()
                .unwrap_or_default();
            let mut response = format!(
                "HTTP/1.1 204 No Content\r\nX-Happier-Iroh-Remote-Endpoint-Id: {expected_remote}\r\n"
            );
            for port in ports {
                response.push_str(&format!(
                    "{IROH_MACHINE_APPLICATION_PORT_HEADER}: {port}\r\n"
                ));
            }
            response.push_str("Content-Length: 0\r\nConnection: close\r\n\r\n");
            socket
                .write_all(response.as_bytes())
                .await
                .expect("admission response");
        }
    });
    addr
}

async fn recording_admission_server(
    expected_remote: String,
    application_port: u16,
    handshakes: Arc<Mutex<Vec<String>>>,
) -> SocketAddr {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind recording admission");
    let addr = listener.local_addr().expect("recording admission addr");
    tokio::spawn(async move {
        loop {
            let (mut socket, request) = accept_admission_request(&listener).await;
            let request = String::from_utf8(request).expect("utf8 admission request");
            let (_, body) = request.split_once("\r\n\r\n").expect("request head/body");
            handshakes.lock().expect("handshakes").push(body.to_owned());
            let response = format!(
                "HTTP/1.1 204 No Content\r\nX-Happier-Iroh-Remote-Endpoint-Id: {expected_remote}\r\n{IROH_MACHINE_APPLICATION_PORT_HEADER}: {application_port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("admission response");
        }
    });
    addr
}

/// Faithful transport behavior of Node's default HTTP server: the request is
/// complete at Content-Length, but a client FIN also closes the server's
/// writable response side when `allowHalfOpen` is false. The production
/// admission client must therefore keep its write half open while awaiting
/// the bounded HTTP response.
async fn node_default_half_close_admission_server(
    expected_remote: String,
    application_port: u16,
) -> SocketAddr {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind node-like admission");
    let addr = listener.local_addr().expect("node-like admission addr");
    tokio::spawn(async move {
        let (mut socket, _request) = accept_admission_request(&listener).await;

        let mut early_fin_probe = [0u8; 1];
        if matches!(
            tokio::time::timeout(Duration::from_millis(50), socket.read(&mut early_fin_probe))
                .await,
            Ok(Ok(0))
        ) {
            // Node's default allowHalfOpen=false closes this response side.
            return;
        }
        let response = format!(
            "HTTP/1.1 204 No Content\r\nX-Happier-Iroh-Remote-Endpoint-Id: {expected_remote}\r\n{IROH_MACHINE_APPLICATION_PORT_HEADER}: {application_port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        socket
            .write_all(response.as_bytes())
            .await
            .expect("write node-like admission response");
    });
    addr
}

#[tokio::test]
async fn admission_fixtures_ignore_unrelated_loopback_connections() {
    for fixture in ["queued", "recording", "node-half-close"] {
        let contacts = Arc::new(AtomicUsize::new(0));
        let ports = Arc::new(Mutex::new(VecDeque::from([vec!["12345".to_owned()]])));
        let handshakes = Arc::new(Mutex::new(Vec::new()));
        let addr = match fixture {
            "queued" => admission_server(
                "expected-peer".to_owned(),
                Arc::clone(&ports),
                Arc::clone(&contacts),
            )
            .await,
            "recording" => recording_admission_server(
                "expected-peer".to_owned(),
                12345,
                Arc::clone(&handshakes),
            )
            .await,
            _ => node_default_half_close_admission_server("expected-peer".to_owned(), 12345)
                .await,
        };
        for stray in [
            b"HEAD / HTTP/1.1\r\nHost: localhost\r\n\r\n".as_slice(),
            b"GET / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n".as_slice(),
            b"".as_slice(),
            b"\x16\x03\x01\x00\x00".as_slice(),
        ] {
            let mut socket = TcpStream::connect(addr).await.expect("stray connect");
            socket.write_all(stray).await.expect("stray request");
            socket.shutdown().await.expect("stray half close");
            let mut response = Vec::new();
            // Closing a rejected socket may surface as either EOF or reset.
            let _ = tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut response))
                .await
                .expect("stray connection closes");
            assert!(response.is_empty(), "{fixture} served unrelated traffic");
        }
        let mut socket = TcpStream::connect(addr).await.expect("admission connect");
        socket
            .write_all(b"POST /v1/iroh/machine/admit HTTP/1.1\r\nX-Happier-Iroh-Remote-Endpoint-Id: expected-peer\r\nContent-Length: 2\r\n\r\n{}")
            .await
            .expect("admission request");
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut response))
            .await
            .expect("admission response completes")
            .expect("read admission response");
        let response = String::from_utf8(response).expect("utf8 response");
        assert!(response.starts_with("HTTP/1.1 204 No Content\r\n"), "{fixture}");
        assert!(response.contains(&format!("{IROH_MACHINE_APPLICATION_PORT_HEADER}: 12345\r\n")));
        match fixture {
            "queued" => {
                assert_eq!(contacts.load(Ordering::Relaxed), 1);
                assert!(ports.lock().expect("port queue").is_empty());
            }
            "recording" => assert_eq!(*handshakes.lock().expect("handshakes"), ["{}"]),
            _ => {}
        }
    }
}

/// One full local-loop duplex exchange through a machine tunnel: distinct
/// nonzero bytes out, half-close, echo back.
async fn exchange_echo(local_addr: SocketAddr, payload: &[u8]) -> Vec<u8> {
    let mut socket = TcpStream::connect(local_addr).await.expect("local connect");
    socket.write_all(payload).await.expect("write payload");
    socket.shutdown().await.expect("half close");
    let mut echoed = Vec::new();
    socket.read_to_end(&mut echoed).await.expect("read echo");
    echoed
}

async fn exercise_tcp_tunnel_websocket(
    server: IrohEndpoint,
    client: IrohEndpoint,
    direct_addresses: Vec<SocketAddr>,
    relay_urls: Vec<iroh::RelayUrl>,
    expected_path: crate::IrohObservedPath,
) {
    let app = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let app_port = app.local_addr().unwrap().port();
    let app_task = tokio::spawn(async move {
        let (mut socket, _) = app.accept().await.unwrap();
        let head = read_http_head_bytewise(&mut socket).await;
        let head = String::from_utf8(head).unwrap();
        assert!(head.contains("Upgrade: websocket\r\n"));
        assert!(!head.to_lowercase().contains("sec-websocket-protocol"));
        assert!(!head.to_lowercase().contains("x-happier-machine-local-capability"));
        socket.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n").await.unwrap();
        let mut binary = [0u8; 5];
        socket.read_exact(&mut binary).await.unwrap();
        assert_eq!(binary, [0x82, 3, 0xff, 0, 0x7f]);
        socket.write_all(&binary).await.unwrap();
        let mut byte = [0u8; 1];
        assert!(!matches!(socket.read(&mut byte).await, Ok(n) if n > 0));
    });
    let admission_contacts = Arc::new(AtomicUsize::new(0));
    let admission_target = admission_server(
        client.id().to_string(),
        Arc::new(Mutex::new(VecDeque::from([vec![app_port.to_string()]]))),
        Arc::clone(&admission_contacts),
    ).await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target }).unwrap();
    let tunnel = MachineHttpTunnel::start(&client, MachineTunnelConfig {
        endpoint_id: server.id().to_string(),
        bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        direct_addresses,
        relay_urls,
        handshake_json: r#"{"v":1,"flow":"tcp_tunnel"}"#.to_owned(),
        cap_profile: IrohCapProfile::MachineBulk,
    }).await.expect("native TCP tunnel carrier");
    let addr = tunnel.local_addr().unwrap();
    let mut denied = TcpStream::connect(addr).await.unwrap();
    denied.write_all(b"GET /peer-mediation/v1/tunnel/stream HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: happier.iroh.cap.wrong\r\n\r\n").await.unwrap();
    let mut rejected = Vec::new();
    denied.read_to_end(&mut rejected).await.unwrap();
    assert!(rejected.is_empty());
    assert_eq!(admission_contacts.load(Ordering::Relaxed), 0);
    let mut socket = TcpStream::connect(addr).await.unwrap();
    let request = format!("GET /peer-mediation/v1/tunnel/stream HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: happier.iroh.cap.{}\r\n\r\n", tunnel.local_capability());
    socket.write_all(request.as_bytes()).await.unwrap();
    let response = read_http_head_bytewise(&mut socket).await;
    assert!(response.starts_with(b"HTTP/1.1 101"));
    socket.write_all(&[0x82, 3, 0xff, 0, 0x7f]).await.unwrap();
    let mut echoed = [0u8; 5];
    socket.read_exact(&mut echoed).await.unwrap();
    assert_eq!(echoed, [0x82, 3, 0xff, 0, 0x7f]);
    assert_eq!(tunnel.status().observed_path.observed_path, expected_path);
    tunnel.stop_and_wait().await;
    let mut byte = [0u8; 1];
    assert!(!matches!(socket.read(&mut byte).await, Ok(n) if n > 0));
    acceptor.stop_and_wait().await;
    app_task.await.unwrap();
    client.shutdown().await;
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn native_tcp_tunnel_websocket_carries_binary_frames_directly_and_cancels() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let addr = direct_addr(&server).await;
    tokio::time::timeout(Duration::from_secs(15), exercise_tcp_tunnel_websocket(
        server, client, vec![addr], vec![], crate::IrohObservedPath::Direct,
    )).await.expect("direct native carrier proof");
}

#[cfg(feature = "test-relay-fixture")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn native_tcp_tunnel_websocket_carries_binary_frames_over_forced_relay_and_cancels() {
    let relay = crate::LocalTestRelay::spawn().await.unwrap();
    let config = || EndpointConfig {
        relay_policy: RelayPolicy::Automatic,
        relay_urls: vec![relay.url_string()],
        caps: IrohCapProfile::MachineBulk,
        disable_ip_transports: true,
        ..EndpointConfig::default()
    };
    let server = IrohEndpoint::bind(&config()).await.unwrap();
    let client = IrohEndpoint::bind(&config()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        server.endpoint().online().await;
        client.endpoint().online().await;
    }).await.expect("relay readiness");
    assert!(server.endpoint().addr().ip_addrs().next().is_none());
    tokio::time::timeout(Duration::from_secs(15), exercise_tcp_tunnel_websocket(
        server, client, vec![], vec![relay.url().clone()], crate::IrohObservedPath::Relay,
    )).await.expect("forced relay native carrier proof");
}

async fn exchange_echo_with_capability(
    local_addr: SocketAddr,
    local_capability: &str,
    payload: &[u8],
) -> Vec<u8> {
    let mut socket = TcpStream::connect(local_addr).await.expect("local connect");
    socket
        .write_all(local_capability.as_bytes())
        .await
        .expect("write local capability");
    socket.write_all(payload).await.expect("write payload");
    socket.shutdown().await.expect("half close");
    let mut echoed = Vec::new();
    socket.read_to_end(&mut echoed).await.expect("read echo");
    echoed
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_client_endpoint_identity_moves_home_then_machine_bytes() {
    let home_server = endpoint(IrohCapProfile::HomeInteractive).await;
    let machine_server = endpoint(IrohCapProfile::MachineBulk).await;
    // The application endpoint starts with the interactive incoming default.
    // MachineBulk must be selected on the outgoing connection, not by binding
    // a second endpoint identity.
    let client = endpoint(IrohCapProfile::HomeInteractive).await;
    let client_id = client.id();

    let home_contacts = Arc::new(AtomicUsize::new(0));
    let home_target = echo_server(Arc::clone(&home_contacts)).await;
    let home_acceptor = HomeAcceptor::start(
        &home_server,
        HomeAcceptorConfig {
            target: home_target,
        },
    )
    .expect("home acceptor");
    let home_tunnel = HomeTunnel::start(
        &client,
        HomeTunnelConfig {
            endpoint_id: home_server.id().to_string(),
            direct_addresses: vec![direct_addr(&home_server).await],
            ..HomeTunnelConfig::default()
        },
    )
    .await
    .expect("home tunnel on shared client endpoint");
    assert_eq!(
        exchange_echo(home_tunnel.local_addr().unwrap(), b"home-shared-endpoint").await,
        [b"app-reply:".as_slice(), b"home-shared-endpoint".as_slice()].concat()
    );

    let machine_contacts = Arc::new(AtomicUsize::new(0));
    let machine_port = echo_server(Arc::clone(&machine_contacts)).await.port();
    let admission_target = admission_server(
        client_id.to_string(),
        Arc::new(Mutex::new(VecDeque::from([vec![machine_port.to_string()]]))),
        Arc::new(AtomicUsize::new(0)),
    )
    .await;
    let machine_acceptor =
        MachineAcceptor::start(&machine_server, MachineAcceptorConfig { admission_target })
            .expect("machine acceptor");
    let machine_tunnel = MachineTunnel::start(
        &client,
        MachineTunnelConfig {
            endpoint_id: machine_server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&machine_server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"flow":"workspace_sync","operationId":"shared-endpoint"}"#
                .to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
    )
    .await
    .expect("machine tunnel on the same client endpoint");
    assert_eq!(
        exchange_echo_with_capability(
            machine_tunnel.local_addr().unwrap(),
            machine_tunnel
                .local_capability()
                .expect("workspace tunnel capability"),
            b"machine-shared-endpoint",
        )
        .await,
        [
            b"app-reply:".as_slice(),
            b"machine-shared-endpoint".as_slice()
        ]
        .concat()
    );
    assert_eq!(client.id(), client_id, "one persistent client identity");
    assert_eq!(home_contacts.load(Ordering::Relaxed), 1);
    assert_eq!(machine_contacts.load(Ordering::Relaxed), 1);

    machine_tunnel.stop();
    machine_acceptor.stop();
    home_tunnel.stop();
    home_acceptor.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_tunnel_moves_duplex_bytes_to_the_admission_selected_application_port() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let app_contacts = Arc::new(AtomicUsize::new(0));
    let app_port = echo_server(Arc::clone(&app_contacts)).await.port();
    let admission_contacts = Arc::new(AtomicUsize::new(0));
    let admission_target = admission_server(
        client.id().to_string(),
        Arc::new(Mutex::new(VecDeque::from([vec![app_port.to_string()]]))),
        Arc::clone(&admission_contacts),
    )
    .await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let tunnel = MachineTunnel::start(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"flow":"finite_transfer","operationId":"op-1"}"#.to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
    )
    .await
    .expect("machine tunnel");
    assert_eq!(
        tunnel.local_capability(),
        None,
        "finite-transfer fetch bytes must enter the sole loopback listener unchanged"
    );

    let echoed = exchange_echo(
        tunnel.local_addr().expect("local addr"),
        b"machine-native-nonzero-duplex",
    )
    .await;
    assert_eq!(
        echoed,
        [
            b"app-reply:".as_slice(),
            b"machine-native-nonzero-duplex".as_slice()
        ]
        .concat()
    );
    assert_eq!(admission_contacts.load(Ordering::Relaxed), 1);
    assert_eq!(app_contacts.load(Ordering::Relaxed), 1);
    assert_eq!(acceptor.status().streams_accepted, 1);
    // The tunnel surfaces the normalized authenticated remote identity so a
    // production adapter never needs a separate caller-supplied string.
    assert_eq!(tunnel.status().remote_endpoint_id, server.id().to_string());
    tunnel.stop();
    acceptor.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_http_tunnel_rejects_finite_transfer_before_publishing_a_second_listener() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let app_contacts = Arc::new(AtomicUsize::new(0));
    let app_port = echo_server(Arc::clone(&app_contacts)).await.port();
    let admission_target = admission_server(
        client.id().to_string(),
        Arc::new(Mutex::new(VecDeque::from([vec![app_port.to_string()]]))),
        Arc::new(AtomicUsize::new(0)),
    )
    .await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");

    let result = MachineHttpTunnel::start(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"flow":"finite_transfer","operationId":"no-http-facade"}"#
                .to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
    )
    .await;

    match result {
        Err(error) => assert_eq!(error, IrohError::InvalidDescriptor),
        Ok(tunnel) => {
            tunnel.stop_and_wait().await;
            panic!("finite transfer must not allocate the Machine HTTP facade");
        }
    }
    assert_eq!(app_contacts.load(Ordering::Relaxed), 0);
    acceptor.stop_and_wait().await;
    client.shutdown().await;
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_http_tunnel_accepts_runner_broker_readiness_as_a_capability_gated_consumer() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let app_contacts = Arc::new(AtomicUsize::new(0));
    let app_port = echo_server(Arc::clone(&app_contacts)).await.port();
    let admission_target = admission_server(
        client.id().to_string(),
        Arc::new(Mutex::new(VecDeque::from([vec![app_port.to_string()]]))),
        Arc::new(AtomicUsize::new(0)),
    )
    .await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let tunnel =
        MachineHttpTunnel::start(
            &client,
            MachineTunnelConfig {
                endpoint_id: server.id().to_string(),
                bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
                direct_addresses: vec![direct_addr(&server).await],
                relay_urls: vec![],
                handshake_json:
                    r#"{"v":1,"kind":"provider_broker_readiness","operationId":"readiness"}"#
                        .to_owned(),
                cap_profile: IrohCapProfile::MachineBulk,
            },
        )
        .await
        .expect("readiness uses the qualified HTTP tunnel");
    assert_eq!(tunnel.local_capability().len(), 64);
    tunnel.stop_and_wait().await;
    acceptor.stop_and_wait().await;
    client.shutdown().await;
    server.shutdown().await;
}

/// The public Machine acceptor shutdown boundary owns its active per-stream
/// pumps. Once it returns, an already-admitted local tunnel socket can no
/// longer exchange bytes through a detached task.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stopping_acceptor_joins_an_active_machine_stream() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let app_contacts = Arc::new(AtomicUsize::new(0));
    let app_port = echo_server(Arc::clone(&app_contacts)).await.port();
    let admission_target = admission_server(
        client.id().to_string(),
        Arc::new(Mutex::new(VecDeque::from([vec![app_port.to_string()]]))),
        Arc::new(AtomicUsize::new(0)),
    )
    .await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let tunnel = MachineTunnel::start(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"flow":"workspace_sync","operationId":"joined-stop"}"#
                .to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
    )
    .await
    .expect("machine tunnel");
    let local_addr = tunnel.local_addr().expect("local addr");
    let local_capability = tunnel
        .local_capability()
        .expect("workspace tunnel capability")
        .to_owned();
    let mut local = TcpStream::connect(local_addr).await.expect("local connect");
    local
        .write_all(local_capability.as_bytes())
        .await
        .expect("write local capability");
    local
        .write_all(b"active-before-acceptor-stop")
        .await
        .expect("write active payload");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while acceptor.status().streams_active == 0 && tokio::time::Instant::now() < deadline {
        tokio::task::yield_now().await;
    }
    assert_eq!(acceptor.status().streams_active, 1, "stream became active");

    acceptor.stop_and_wait().await;
    let mut byte = [0u8; 1];
    let closed = tokio::time::timeout(Duration::from_secs(5), local.read(&mut byte))
        .await
        .expect("joined Machine shutdown must settle its active stream");
    assert!(
        !matches!(closed, Ok(n) if n > 0),
        "joined Machine shutdown must not leave a stream serving bytes"
    );

    tunnel.stop_and_wait().await;
    client.shutdown().await;
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_http_tunnel_requires_capability_before_opening_a_machine_stream() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let app_contacts = Arc::new(AtomicUsize::new(0));
    let app_port = echo_server(Arc::clone(&app_contacts)).await.port();
    let admission_contacts = Arc::new(AtomicUsize::new(0));
    let admission_target = admission_server(
        client.id().to_string(),
        Arc::new(Mutex::new(VecDeque::from([vec![app_port.to_string()]]))),
        Arc::clone(&admission_contacts),
    )
    .await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let tunnel = MachineHttpTunnel::start(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"kind":"provider_broker","operationId":"http-op-1"}"#
                .to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
    )
    .await
    .expect("machine HTTP tunnel");

    let mut unauthorized = TcpStream::connect(tunnel.local_addr().expect("HTTP loopback addr"))
        .await
        .expect("connect unauthenticated HTTP loopback");
    unauthorized
        .write_all(b"GET /probe HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .await
        .expect("write unauthenticated request");
    unauthorized
        .shutdown()
        .await
        .expect("shutdown unauthenticated request");
    let mut rejected = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(2),
        unauthorized.read_to_end(&mut rejected),
    )
    .await
    .expect("unauthenticated listener close")
    .expect("read unauthenticated close");
    assert!(rejected.is_empty());
    assert_eq!(admission_contacts.load(Ordering::Relaxed), 0);
    assert_eq!(app_contacts.load(Ordering::Relaxed), 0);

    let mut wrong = TcpStream::connect(tunnel.local_addr().expect("HTTP loopback addr"))
        .await
        .expect("connect wrong-capability HTTP loopback");
    wrong
        .write_all(
            format!(
                "GET /probe HTTP/1.1\r\nHost: 127.0.0.1\r\n{}: {}\r\nConnection: close\r\n\r\n",
                IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
                "f".repeat(64),
            )
            .as_bytes(),
        )
        .await
        .expect("write wrong-capability request");
    wrong
        .shutdown()
        .await
        .expect("shutdown wrong-capability request");
    let mut wrong_rejected = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(2),
        wrong.read_to_end(&mut wrong_rejected),
    )
    .await
    .expect("wrong-capability listener close")
    .expect("read wrong-capability close");
    assert!(wrong_rejected.is_empty());
    assert_eq!(admission_contacts.load(Ordering::Relaxed), 0);
    assert_eq!(app_contacts.load(Ordering::Relaxed), 0);

    let mut ambiguous = TcpStream::connect(tunnel.local_addr().expect("HTTP loopback addr"))
        .await
        .expect("connect ambiguous-framing HTTP loopback");
    ambiguous
        .write_all(
            format!(
                "POST /probe HTTP/1.1\r\nHost: 127.0.0.1\r\n{}: {}\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n",
                IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
                tunnel.local_capability(),
            )
            .as_bytes(),
        )
        .await
        .expect("write ambiguous-framing request");
    ambiguous
        .shutdown()
        .await
        .expect("shutdown ambiguous-framing request");
    let mut ambiguous_rejected = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(2),
        ambiguous.read_to_end(&mut ambiguous_rejected),
    )
    .await
    .expect("ambiguous-framing listener close")
    .expect("read ambiguous-framing close");
    assert!(ambiguous_rejected.is_empty());
    assert_eq!(admission_contacts.load(Ordering::Relaxed), 0);
    assert_eq!(app_contacts.load(Ordering::Relaxed), 0);

    let authenticated_request = format!(
        "POST /machine-transfers/direct/imports/http-op-1 HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Happier-Test-Preserved: yes\r\n{}: {}\r\nContent-Length: 18\r\nConnection: close\r\n\r\nmachine-body-bytes",
        IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
        tunnel.local_capability(),
    );
    let forwarded_request = "POST /machine-transfers/direct/imports/http-op-1 HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Happier-Test-Preserved: yes\r\nContent-Length: 18\r\nConnection: close\r\n\r\nmachine-body-bytes";
    let echoed = exchange_echo(
        tunnel.local_addr().expect("HTTP loopback addr"),
        authenticated_request.as_bytes(),
    )
    .await;
    assert_eq!(
        echoed,
        [b"app-reply:".as_slice(), forwarded_request.as_bytes(),].concat()
    );
    assert_eq!(admission_contacts.load(Ordering::Relaxed), 1);
    assert_eq!(app_contacts.load(Ordering::Relaxed), 1);
    assert_eq!(tunnel.status().streams_opened, 1);
    tunnel.stop();
    acceptor.stop();
}

/// A Provider client's large request body is still unread when the gated
/// listener rejects its head, so the kernel answers with RST (ECONNRESET) and
/// no machine stream or admission is attempted. The tunnel status must name
/// the content-free local stage instead of leaving the reset unexplained.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_http_tunnel_records_a_rejected_head_that_resets_its_client() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let app_contacts = Arc::new(AtomicUsize::new(0));
    let app_port = echo_server(Arc::clone(&app_contacts)).await.port();
    let admission_contacts = Arc::new(AtomicUsize::new(0));
    let admission_target = admission_server(
        client.id().to_string(),
        Arc::new(Mutex::new(VecDeque::from([vec![app_port.to_string()]]))),
        Arc::clone(&admission_contacts),
    )
    .await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let tunnel = MachineHttpTunnel::start(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"kind":"provider_broker"}"#.to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
    )
    .await
    .expect("machine HTTP tunnel");
    assert_eq!(tunnel.status().last_failure, None);

    let body = vec![b'x'; 256 * 1024];
    let send_and_read = |head: String| {
        let addr = tunnel.local_addr().expect("HTTP loopback addr");
        let body = body.clone();
        async move {
            let mut socket = TcpStream::connect(addr).await.expect("connect HTTP loopback");
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.write_all(&body).await;
            let mut response = Vec::new();
            tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut response))
                .await
                .expect("gated listener closes the connection")
        }
    };

    // A bearer that is not this tunnel's capability: no capability line.
    let rejected = send_and_read(format!(
        "POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        "f".repeat(64), body.len(),
    )).await;
    assert_eq!(rejected.expect_err("unread body resets the client").kind(), std::io::ErrorKind::ConnectionReset);
    assert_eq!(tunnel.status().last_failure, Some(MachineFailureCode::LocalCapabilityRejected));

    // Correct capability but ambiguous framing: a malformed head, not a capability refusal.
    let malformed = send_and_read(format!(
        "POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\nTransfer-Encoding: chunked\r\n\r\n",
        tunnel.local_capability(), body.len(),
    )).await;
    assert_eq!(malformed.expect_err("unread body resets the client").kind(), std::io::ErrorKind::ConnectionReset);
    assert_eq!(tunnel.status().last_failure, Some(MachineFailureCode::LocalHttpHeadRejected));

    assert_eq!(admission_contacts.load(Ordering::Relaxed), 0);
    assert_eq!(app_contacts.load(Ordering::Relaxed), 0);
    assert_eq!(tunnel.status().streams_opened, 0);
    tunnel.stop_and_wait().await;
    acceptor.stop_and_wait().await;
    client.shutdown().await;
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_http_tunnel_strips_capability_from_keep_alive_and_concurrent_requests() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let application_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind HTTP application");
    let application_port = application_listener
        .local_addr()
        .expect("HTTP application addr")
        .port();
    let application_task = tokio::spawn(async move {
        let mut received = Vec::new();
        let (mut keep_alive, _) = application_listener
            .accept()
            .await
            .expect("accept keep-alive HTTP application connection");
        for request_index in 0..2 {
            received.push(read_http_head_bytewise(&mut keep_alive).await);
            let connection = if request_index == 0 {
                "keep-alive"
            } else {
                "close"
            };
            keep_alive
                .write_all(
                    format!(
                        "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: {connection}\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .expect("write keep-alive HTTP application response");
        }

        let (first, second) =
            tokio::join!(application_listener.accept(), application_listener.accept());
        let (first, _) = first.expect("accept first concurrent HTTP connection");
        let (second, _) = second.expect("accept second concurrent HTTP connection");
        let serve = |mut socket: TcpStream| async move {
            let head = read_http_head_bytewise(&mut socket).await;
            socket
                .write_all(
                    b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("write concurrent HTTP application response");
            head
        };
        let (first_head, second_head) = tokio::join!(serve(first), serve(second));
        received.extend([first_head, second_head]);
        received
    });
    let admission_target = admission_server(
        client.id().to_string(),
        Arc::new(Mutex::new(VecDeque::from([
            vec![application_port.to_string()],
            vec![application_port.to_string()],
            vec![application_port.to_string()],
        ]))),
        Arc::new(AtomicUsize::new(0)),
    )
    .await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let tunnel = MachineHttpTunnel::start(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"kind":"provider_broker","operationId":"http-keep-alive"}"#
                .to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
    )
    .await
    .expect("machine HTTP tunnel");

    let expected_heads = [
        "GET /first HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n",
        "GET /second HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        "GET /concurrent-a HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        "GET /concurrent-b HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    ];
    let mut keep_alive = TcpStream::connect(tunnel.local_addr().expect("HTTP loopback addr"))
        .await
        .expect("connect keep-alive client");
    for expected in &expected_heads[..2] {
        let request = expected.replacen(
            "Connection:",
            &format!(
                "{}: {}\r\nConnection:",
                IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
                tunnel.local_capability()
            ),
            1,
        );
        keep_alive
            .write_all(request.as_bytes())
            .await
            .expect("write keep-alive request");
        let response = read_http_head_bytewise(&mut keep_alive).await;
        assert!(response.starts_with(b"HTTP/1.1 204 No Content\r\n"));
    }

    let local_addr = tunnel.local_addr().expect("HTTP loopback addr");
    let local_capability = tunnel.local_capability().to_owned();
    let request_concurrently = |expected: &'static str| {
        let local_capability = local_capability.clone();
        async move {
            let mut socket = TcpStream::connect(local_addr)
                .await
                .expect("connect concurrent HTTP client");
            let request = expected.replacen(
                "Connection:",
                &format!(
                    "{}: {}\r\nConnection:",
                    IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER, local_capability
                ),
                1,
            );
            socket
                .write_all(request.as_bytes())
                .await
                .expect("write concurrent HTTP request");
            let response = read_http_head_bytewise(&mut socket).await;
            assert!(response.starts_with(b"HTTP/1.1 204 No Content\r\n"));
        }
    };
    tokio::join!(
        request_concurrently(expected_heads[2]),
        request_concurrently(expected_heads[3]),
    );

    let mut received = tokio::time::timeout(Duration::from_secs(5), application_task)
        .await
        .expect("HTTP application completed")
        .expect("HTTP application task");
    received[2..].sort();
    let mut expected = expected_heads.map(|head| head.as_bytes().to_vec());
    expected[2..].sort();
    assert_eq!(
        received, expected,
        "the loopback-only capability must be stripped from every request"
    );
    assert_eq!(tunnel.status().streams_opened, 3);
    tunnel.stop();
    acceptor.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_http_tunnel_preserves_pipelined_content_length_boundaries() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let application_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind pipelined HTTP application");
    let application_port = application_listener
        .local_addr()
        .expect("pipelined HTTP application addr")
        .port();
    let application_task = tokio::spawn(async move {
        let (mut socket, _) = application_listener
            .accept()
            .await
            .expect("accept pipelined HTTP application connection");
        let mut first = read_http_head_bytewise(&mut socket).await;
        let mut first_body = [0u8; 4];
        socket
            .read_exact(&mut first_body)
            .await
            .expect("read pipelined Content-Length body");
        first.extend_from_slice(&first_body);
        let second = read_http_head_bytewise(&mut socket).await;
        socket
            .write_all(
                b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\nHTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await
            .expect("write pipelined HTTP responses");
        [first, second]
    });
    let admission_target = admission_server(
        client.id().to_string(),
        Arc::new(Mutex::new(VecDeque::from([vec![
            application_port.to_string()
        ]]))),
        Arc::new(AtomicUsize::new(0)),
    )
    .await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let tunnel = MachineHttpTunnel::start(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"kind":"provider_broker","operationId":"http-pipelined"}"#
                .to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
    )
    .await
    .expect("machine HTTP tunnel");

    let first_expected =
        "POST /first HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 4\r\nConnection: keep-alive\r\n\r\nbody";
    let second_expected = "GET /second HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    let requests = format!(
        "POST /first HTTP/1.1\r\nHost: 127.0.0.1\r\n{}: {}\r\nContent-Length: 4\r\nConnection: keep-alive\r\n\r\nbodyGET /second HTTP/1.1\r\nHost: 127.0.0.1\r\n{}: {}\r\nConnection: close\r\n\r\n",
        IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
        tunnel.local_capability(),
        IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
        tunnel.local_capability(),
    );
    let mut application = TcpStream::connect(tunnel.local_addr().expect("HTTP loopback addr"))
        .await
        .expect("connect pipelined HTTP client");
    application
        .write_all(requests.as_bytes())
        .await
        .expect("write pipelined HTTP requests");
    application
        .shutdown()
        .await
        .expect("finish pipelined HTTP requests");
    let mut responses = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(5),
        application.read_to_end(&mut responses),
    )
    .await
    .expect("pipelined responses complete")
    .expect("read pipelined responses");
    assert_eq!(
        responses
            .windows(12)
            .filter(|window| *window == b"HTTP/1.1 204")
            .count(),
        2
    );

    let received = tokio::time::timeout(Duration::from_secs(5), application_task)
        .await
        .expect("pipelined HTTP application completed")
        .expect("pipelined HTTP application task");
    assert_eq!(
        received,
        [
            first_expected.as_bytes().to_vec(),
            second_expected.as_bytes().to_vec(),
        ]
    );
    assert_eq!(tunnel.status().streams_opened, 1);
    tunnel.stop_and_wait().await;
    acceptor.stop_and_wait().await;
    client.shutdown().await;
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_http_tunnel_requests_a_fresh_handshake_for_each_new_local_connection() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let contacts = Arc::new(AtomicUsize::new(0));
    let application_addr = echo_server(Arc::clone(&contacts)).await;
    let handshakes = Arc::new(Mutex::new(Vec::new()));
    let admission_target = recording_admission_server(
        client.id().to_string(),
        application_addr.port(),
        Arc::clone(&handshakes),
    )
    .await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let sequence = Arc::new(AtomicUsize::new(0));
    let provider: MachineHandshakeProvider = Arc::new({
        let sequence = Arc::clone(&sequence);
        move || {
            let witness = sequence.fetch_add(1, Ordering::SeqCst) + 1;
            Box::pin(async move {
                if witness <= 2 {
                    // Fresh Home authorization is application work, governed
                    // by its caller's lifetime rather than wire framing.
                    tokio::time::sleep(
                        crate::endpoint::PRE_APPLICATION_CUSTODY_TIMEOUT + Duration::from_secs(1),
                    )
                    .await;
                }
                Ok(format!(
                    r#"{{"v":1,"kind":"provider_broker","witness":{witness}}}"#
                ))
            })
        }
    });
    let tunnel = MachineHttpTunnel::start_with_handshake_provider(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"kind":"provider_broker","witness":0}"#.to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
        provider,
    )
    .await
    .expect("machine HTTP tunnel");

    for body in ["first", "second"] {
        let request = format!(
            "POST / HTTP/1.1\r\nHost: 127.0.0.1\r\n{}: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
            tunnel.local_capability(),
            body.len(),
            body,
        );
        let echoed = exchange_echo(
            tunnel.local_addr().expect("HTTP loopback addr"),
            request.as_bytes(),
        )
        .await;
        assert!(
            echoed.starts_with(b"app-reply:"),
            "{body}: {:?}, {:?}", tunnel.status(), acceptor.status()
        );
    }

    assert_eq!(
        *handshakes.lock().expect("handshakes"),
        vec![
            r#"{"v":1,"kind":"provider_broker","witness":1}"#.to_owned(),
            r#"{"v":1,"kind":"provider_broker","witness":2}"#.to_owned(),
        ],
        "{:?}",
        tunnel.status()
    );
    assert_eq!(sequence.load(Ordering::SeqCst), 2);
    assert_eq!(acceptor.status().connections_accepted, 2,
        "the expired pre-application connection is replaced only when needed");
    tunnel.stop_and_wait().await;
    acceptor.stop_and_wait().await;
    client.shutdown().await;
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_raw_tunnels_reconnect_after_unused_custody_without_changing_stream_contracts() {
    for flow in ["finite_transfer", "workspace_sync"] {
        let server = endpoint(IrohCapProfile::MachineBulk).await;
        let client = endpoint(IrohCapProfile::MachineBulk).await;
        let contacts = Arc::new(AtomicUsize::new(0));
        let application = echo_server(Arc::clone(&contacts)).await;
        let handshakes = Arc::new(Mutex::new(Vec::new()));
        let admission_target = recording_admission_server(
            client.id().to_string(), application.port(), Arc::clone(&handshakes),
        ).await;
        let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target }).unwrap();
        let tunnel = MachineTunnel::start(&client, MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: format!(r#"{{"v":1,"flow":"{flow}"}}"#),
            cap_profile: IrohCapProfile::MachineBulk,
        }).await.unwrap();
        tokio::time::sleep(crate::endpoint::PRE_APPLICATION_CUSTODY_TIMEOUT + Duration::from_secs(1)).await;
        assert!(!tunnel.status().connection_active);
        assert_eq!(acceptor.status().connections_accepted, 1, "no idle redial");
        assert_eq!(acceptor.status().streams_accepted, 0, "no keep-alive stream");
        let mut request = tunnel.local_capability().unwrap_or_default().as_bytes().to_vec();
        request.extend_from_slice(b"delayed request");
        let addr = tunnel.local_addr().unwrap();
        if flow == "finite_transfer" {
            // Two actual requests share one replacement connection.
            let (first, second) = tokio::join!(exchange_echo(addr, &request), exchange_echo(addr, &request));
            assert_eq!(first, b"app-reply:delayed request");
            assert_eq!(second, b"app-reply:delayed request");
            assert_eq!(contacts.load(Ordering::Relaxed), 2);
        } else {
            assert_eq!(exchange_echo(addr, &request).await, b"app-reply:delayed request");
            let mut refused = TcpStream::connect(addr).await.unwrap();
            refused.write_all(&request).await.unwrap();
            refused.shutdown().await.unwrap();
            let mut bytes = Vec::new();
            let result = refused.read_to_end(&mut bytes).await;
            assert!(result.is_ok() || matches!(result, Err(ref error) if error.kind() == std::io::ErrorKind::ConnectionReset));
            assert!(bytes.is_empty(), "workspace is still single-stream");
            assert_eq!(contacts.load(Ordering::Relaxed), 1);
        }
        assert_eq!(acceptor.status().connections_accepted, 2, "one demand-driven replacement");
        assert_eq!(tunnel.status().last_failure, None);
        tunnel.stop_and_wait().await;
        acceptor.stop_and_wait().await;
        client.shutdown().await;
        server.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_discovery_status_identifies_control_timeout_owner() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let admission_target = listener.local_addr().unwrap();
    let stalled_admission = tokio::spawn(async move {
        let (mut socket, _request) = accept_admission_request(&listener).await;
        let mut remaining = Vec::new();
        let _ = socket.read_to_end(&mut remaining).await;
    });
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target }).unwrap();
    let tunnel = MachineHttpTunnel::start(&client, MachineTunnelConfig {
        endpoint_id: server.id().to_string(),
        bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        direct_addresses: vec![direct_addr(&server).await], relay_urls: vec![],
        handshake_json: r#"{"v":1,"kind":"provider_broker"}"#.to_owned(),
        cap_profile: IrohCapProfile::MachineBulk,
    }).await.unwrap();
    let request = format!("GET /endpoint HTTP/1.1\r\nHost: localhost\r\n{}: {}\r\nConnection: close\r\n\r\n",
        IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER, tunnel.local_capability());
    let received = exchange_echo(tunnel.local_addr().unwrap(), request.as_bytes()).await;
    // Observe the real control bound, without changing it or imposing a
    // shorter competing cutoff on the HTTP application request.
    // Wait for the target's admission socket to close too: the initiator's
    // independent decision timer can settle a few microseconds earlier.
    stalled_admission.await.unwrap();
    let target_failure = acceptor.status().last_failure.map(|failure| failure.as_str());
    let local_failure = tunnel.status().last_failure.map(|failure| failure.as_str());
    tunnel.stop_and_wait().await;
    acceptor.stop_and_wait().await;
    client.shutdown().await;
    server.shutdown().await;
    assert!(received.is_empty());
    assert_eq!(target_failure, Some("machine-admission-timeout"));
    assert!(matches!(local_failure,
        Some("machine-stream-decision-timeout" | "machine-admission-rejected")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_http_tunnel_keeps_http_source_reads_alive_beyond_control_window() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let application = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind HTTP source");
    let application_port = application.local_addr().expect("HTTP source addr").port();
    let response = b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    let source_read = tokio::spawn(async move {
        let (mut socket, _) = application.accept().await.expect("accept HTTP source");
        let head = read_http_head_bytewise(&mut socket).await;
        assert!(head.starts_with(b"GET /endpoint HTTP/1.1\r\n"));
        // Private Home source reads happen in HTTP application work after
        // native admission. Keep that response pending beyond the wire budget.
        let started = std::time::Instant::now();
        tokio::time::sleep(crate::machine::MACHINE_CONTROL_TIMEOUT + Duration::from_millis(1)).await;
        assert!(started.elapsed() >= crate::machine::MACHINE_CONTROL_TIMEOUT);
        socket
            .write_all(response)
            .await
            .expect("write HTTP source response");
    });
    let handshakes = Arc::new(Mutex::new(Vec::new()));
    let admission_target = recording_admission_server(
        client.id().to_string(),
        application_port,
        Arc::clone(&handshakes),
    )
    .await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let tunnel = MachineHttpTunnel::start(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"kind":"provider_broker"}"#.to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
    )
    .await
    .expect("machine HTTP tunnel");
    let request = format!(
        "GET /endpoint HTTP/1.1\r\nHost: 127.0.0.1\r\n{}: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
        tunnel.local_capability(),
    );
    let received = exchange_echo(
        tunnel.local_addr().expect("HTTP loopback addr"),
        request.as_bytes(),
    )
    .await;
    source_read.await.expect("HTTP source task");
    assert_eq!(received, response);
    assert_eq!(handshakes.lock().expect("handshakes").len(), 1);
    tunnel.stop_and_wait().await;
    acceptor.stop_and_wait().await;
    client.shutdown().await;
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_http_tunnel_provider_refusal_returns_http_without_opening_a_stream() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let contacts = Arc::new(AtomicUsize::new(0));
    let application_addr = echo_server(Arc::clone(&contacts)).await;
    let handshakes = Arc::new(Mutex::new(Vec::new()));
    let admission_target = recording_admission_server(
        client.id().to_string(),
        application_addr.port(),
        Arc::clone(&handshakes),
    )
    .await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let response_body = serde_json::json!({
        "type": "error",
        "error": {
            "type": "permission_error",
            "code": "broker_unavailable",
            "resourceId": "resource-é",
            "message": "Happier refused this request: broker_unavailable.",
        },
    })
    .to_string();
    let refusal = serde_json::json!({
        "kind": "http_refusal",
        "responseBody": response_body,
    })
    .to_string();
    let invalid_outcomes = [
        serde_json::json!({"kind": "http_refusal", "responseBody": response_body, "status": 200})
            .to_string(),
        serde_json::json!({"kind": "http_refusal", "responseBody": "not JSON"}).to_string(),
        serde_json::json!({"kind": "http_refusal", "responseBody": {}}).to_string(),
    ];
    let invalid_outcome_count = invalid_outcomes.len();
    let sequence = Arc::new(AtomicUsize::new(0));
    let provider: MachineHandshakeProvider = Arc::new(move || {
        let attempt = sequence.fetch_add(1, Ordering::SeqCst);
        let outcome = if attempt == 0 {
            refusal.clone()
        } else {
            invalid_outcomes.get(attempt - 1).cloned().unwrap_or_else(|| {
                r#"{"v":1,"kind":"provider_broker","witness":"recovered"}"#.to_owned()
            })
        };
        Box::pin(async move { Ok(outcome) })
    });
    let tunnel = MachineHttpTunnel::start_with_handshake_provider(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"kind":"provider_broker"}"#.to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
        provider,
    )
    .await
    .expect("machine HTTP tunnel");
    let request = format!(
        "POST / HTTP/1.1\r\n{}: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
        tunnel.local_capability(),
    );
    let request_body = serde_json::json!({"input": "prompt".repeat(16 * 1024)}).to_string();
    let refused_request = format!(
        "POST / HTTP/1.1\r\n{}: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
        tunnel.local_capability(),
        request_body.len(),
        request_body,
    );
    let mut refused = TcpStream::connect(tunnel.local_addr().expect("HTTP addr"))
        .await
        .expect("refused HTTP connect");
    refused
        .write_all(refused_request.as_bytes())
        .await
        .expect("upload request");
    // Real HTTP clients await the response without first sending a TCP FIN.
    let mut first = Vec::new();
    refused
        .read_to_end(&mut first)
        .await
        .expect("HTTP refusal response");
    drop(refused);
    let expected = format!(
        "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        response_body.len(),
        response_body,
    );
    assert_eq!(first, expected.as_bytes());
    assert_eq!(tunnel.status().streams_opened, 0);
    assert!(tunnel.status().connection_active);
    assert_eq!(contacts.load(Ordering::Relaxed), 0);
    assert!(handshakes.lock().expect("handshakes").is_empty());

    for _ in 0..invalid_outcome_count {
        let rejected =
            exchange_echo(tunnel.local_addr().expect("HTTP addr"), request.as_bytes()).await;
        assert!(rejected.is_empty());
        assert_eq!(tunnel.status().streams_opened, 0);
        assert_eq!(contacts.load(Ordering::Relaxed), 0);
        assert!(handshakes.lock().expect("handshakes").is_empty());
    }

    let second = exchange_echo(tunnel.local_addr().expect("HTTP addr"), request.as_bytes()).await;
    assert!(second.starts_with(b"app-reply:"));
    assert_eq!(tunnel.status().streams_opened, 1);
    assert_eq!(contacts.load(Ordering::Relaxed), 1);
    assert_eq!(handshakes.lock().expect("handshakes").len(), 1);
    tunnel.stop_and_wait().await;
    acceptor.stop_and_wait().await;
    client.shutdown().await;
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_http_tunnel_provider_failure_closes_only_that_connection() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let contacts = Arc::new(AtomicUsize::new(0));
    let application_addr = echo_server(Arc::clone(&contacts)).await;
    let handshakes = Arc::new(Mutex::new(Vec::new()));
    let admission_target = recording_admission_server(
        client.id().to_string(),
        application_addr.port(),
        Arc::clone(&handshakes),
    )
    .await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let sequence = Arc::new(AtomicUsize::new(0));
    let provider: MachineHandshakeProvider = Arc::new({
        let sequence = Arc::clone(&sequence);
        move || {
            let attempt = sequence.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if attempt == 0 {
                    return Err(IrohError::Cancelled);
                }
                Ok(r#"{"v":1,"kind":"provider_broker","witness":"recovered"}"#.to_owned())
            })
        }
    });
    let tunnel = MachineHttpTunnel::start_with_handshake_provider(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"kind":"provider_broker"}"#.to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
        provider,
    )
    .await
    .expect("machine HTTP tunnel");

    let first = exchange_echo(
        tunnel.local_addr().expect("HTTP addr"),
        format!(
            "POST / HTTP/1.1\r\n{}: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
            tunnel.local_capability(),
        )
        .as_bytes(),
    )
    .await;
    assert!(first.is_empty());
    let second = exchange_echo(
        tunnel.local_addr().expect("HTTP addr"),
        format!(
            "POST / HTTP/1.1\r\n{}: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
            tunnel.local_capability(),
        )
        .as_bytes(),
    )
    .await;
    assert!(second.starts_with(b"app-reply:"));
    assert_eq!(handshakes.lock().expect("handshakes").len(), 1);
    tunnel.stop_and_wait().await;
    acceptor.stop_and_wait().await;
    client.shutdown().await;
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stopping_machine_http_tunnel_or_local_acceptor_cancels_a_pending_handshake_provider() {
    struct DropWitness(Arc<AtomicUsize>);
    impl Drop for DropWitness {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    for local in [false, true] {
        let server = endpoint(IrohCapProfile::MachineBulk).await;
        let client = endpoint(IrohCapProfile::MachineBulk).await;
        let admission_target = admission_server(
            client.id().to_string(),
            Arc::new(Mutex::new(VecDeque::new())),
            Arc::new(AtomicUsize::new(0)),
        )
        .await;
        let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
            .expect("machine acceptor");
        let started = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let provider: MachineHandshakeProvider = Arc::new({
            let started = Arc::clone(&started);
            let dropped = Arc::clone(&dropped);
            move || {
                started.fetch_add(1, Ordering::SeqCst);
                let witness = DropWitness(Arc::clone(&dropped));
                Box::pin(async move {
                    let _witness = witness;
                    std::future::pending::<()>().await;
                    unreachable!()
                })
            }
        });
        let config = MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"kind":"provider_broker"}"#.to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        };
        let tunnel = if local {
            MachineHttpTunnel::start_with_local_admission(
                &server,
                config,
                acceptor.local_admission(),
                Some(provider),
            )
            .await
        } else {
            MachineHttpTunnel::start_with_handshake_provider(&client, config, provider).await
        }
        .expect("machine HTTP tunnel");
        let mut application = TcpStream::connect(tunnel.local_addr().expect("HTTP addr"))
            .await
            .expect("connect");
        application
            .write_all(
                format!(
                    "POST / HTTP/1.1\r\n{}: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
                    tunnel.local_capability(),
                )
                .as_bytes(),
            )
            .await
            .expect("write request");
        tokio::time::timeout(Duration::from_secs(5), async {
            while started.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("provider starts");
        if local {
            acceptor.stop_and_wait().await;
            let mut byte = [0];
            let closed = tokio::time::timeout(Duration::from_secs(5), application.read(&mut byte))
                .await
                .expect("local stream closes with acceptor");
            assert!(!matches!(closed, Ok(length) if length > 0));
            assert!(!tunnel.status().connection_active);
            tunnel.stop_and_wait().await;
        } else {
            tunnel.stop_and_wait().await;
            acceptor.stop_and_wait().await;
        }
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        client.shutdown().await;
        server.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_http_tunnel_streams_sse_after_a_chunked_request_and_stops_cleanly() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let application_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind streaming HTTP application");
    let application_port = application_listener
        .local_addr()
        .expect("streaming HTTP application addr")
        .port();
    let application_task = tokio::spawn(async move {
        let (mut socket, _) = application_listener
            .accept()
            .await
            .expect("accept streaming HTTP application connection");
        let request_head = read_http_head_bytewise(&mut socket).await;
        let expected_head = b"POST /stream HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n";
        assert_eq!(request_head, expected_head);
        let expected_body = b"4\r\ntest\r\n0\r\n\r\n";
        let mut request_body = vec![0u8; expected_body.len()];
        socket
            .read_exact(&mut request_body)
            .await
            .expect("read complete chunked request body");
        assert_eq!(request_body, expected_body);

        let streamed_response = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n9\r\ndata: a\n\n\r\n";
        socket
            .write_all(streamed_response)
            .await
            .expect("write first SSE event");
        let mut remaining = Vec::new();
        socket
            .read_to_end(&mut remaining)
            .await
            .expect("stream closes when tunnel stops");
        assert!(remaining.is_empty());
    });
    let admission_target = admission_server(
        client.id().to_string(),
        Arc::new(Mutex::new(VecDeque::from([vec![
            application_port.to_string()
        ]]))),
        Arc::new(AtomicUsize::new(0)),
    )
    .await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let tunnel = MachineHttpTunnel::start(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"kind":"provider_broker","operationId":"http-sse"}"#
                .to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
    )
    .await
    .expect("machine HTTP tunnel");

    let mut application = TcpStream::connect(tunnel.local_addr().expect("HTTP loopback addr"))
        .await
        .expect("connect streaming HTTP client");
    let request_head = format!(
        "POST /stream HTTP/1.1\r\nHost: 127.0.0.1\r\n{}: {}\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n",
        IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
        tunnel.local_capability(),
    );
    let split = request_head.len() / 2;
    application
        .write_all(&request_head.as_bytes()[..split])
        .await
        .expect("write fragmented request head prefix");
    application
        .write_all(&request_head.as_bytes()[split..])
        .await
        .expect("write fragmented request head suffix");
    application
        .write_all(b"4\r\nte")
        .await
        .expect("write fragmented chunk prefix");
    application
        .write_all(
            format!(
                "st\r\n0\r\n{}: {}\r\n\r\n",
                IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
                tunnel.local_capability(),
            )
            .as_bytes(),
        )
        .await
        .expect("write chunk suffix and local-only trailer");
    let expected_response = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n9\r\ndata: a\n\n\r\n";
    let mut streamed_response = vec![0u8; expected_response.len()];
    tokio::time::timeout(
        Duration::from_secs(5),
        application.read_exact(&mut streamed_response),
    )
    .await
    .expect("SSE event arrives before request-side close")
    .expect("read first SSE event");
    assert_eq!(streamed_response, expected_response);

    tunnel.stop_and_wait().await;
    let mut byte = [0u8; 1];
    let closed = tokio::time::timeout(Duration::from_secs(5), application.read(&mut byte))
        .await
        .expect("HTTP client closes when tunnel stops");
    assert!(!matches!(closed, Ok(length) if length > 0));
    tokio::time::timeout(Duration::from_secs(5), application_task)
        .await
        .expect("streaming HTTP application settles")
        .expect("streaming HTTP application task");
    acceptor.stop_and_wait().await;
    client.shutdown().await;
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_acceptor_presents_and_strips_the_admission_selected_local_capability() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let target_capability = "e".repeat(64);
    let app_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind capability app");
    let app_port = app_listener.local_addr().expect("app addr").port();
    let app_capability = target_capability.clone();
    tokio::spawn(async move {
        let (mut socket, _) = app_listener.accept().await.expect("accept capability app");
        let mut supplied = [0u8; 64];
        socket
            .read_exact(&mut supplied)
            .await
            .expect("read target local capability");
        assert_eq!(supplied.as_slice(), app_capability.as_bytes());
        let (mut read, mut write) = socket.split();
        let mut payload = Vec::new();
        read.read_to_end(&mut payload)
            .await
            .expect("read app payload");
        write
            .write_all(b"app-reply:")
            .await
            .expect("write app reply");
        write
            .write_all(&payload)
            .await
            .expect("write echoed payload");
    });

    let admission_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind capability admission");
    let admission_target = admission_listener.local_addr().expect("admission addr");
    let expected_remote = client.id().to_string();
    tokio::spawn(async move {
        let (mut socket, _request) = accept_admission_request(&admission_listener).await;
        let response = format!(
            "HTTP/1.1 204 No Content\r\nX-Happier-Iroh-Remote-Endpoint-Id: {expected_remote}\r\n{IROH_MACHINE_APPLICATION_PORT_HEADER}: {app_port}\r\n{IROH_MACHINE_APPLICATION_CAPABILITY_HEADER}: {target_capability}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        socket
            .write_all(response.as_bytes())
            .await
            .expect("write admission response");
    });

    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let tunnel = MachineTunnel::start(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json:
                r#"{"v":1,"kind":"provider_broker","operationId":"target-local-capability"}"#
                    .to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
    )
    .await
    .expect("machine tunnel");
    let echoed = exchange_echo_with_capability(
        tunnel.local_addr().expect("local addr"),
        tunnel
            .local_capability()
            .expect("provider tunnel capability"),
        b"payload-after-two-local-capabilities",
    )
    .await;
    assert_eq!(echoed, b"app-reply:payload-after-two-local-capabilities");
    tunnel.stop();
    acceptor.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn finite_transfer_connects_the_prepared_port_without_an_application_capability_prefix() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let app_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind prepared-transfer app");
    let app_port = app_listener.local_addr().expect("prepared app addr").port();
    tokio::spawn(async move {
        let (mut socket, _) = app_listener.accept().await.expect("accept prepared app");
        let mut payload = Vec::new();
        socket
            .read_to_end(&mut payload)
            .await
            .expect("read prepared-transfer payload");
        socket
            .write_all(&payload)
            .await
            .expect("echo prepared payload");
    });

    let admission_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind admission");
    let admission_target = admission_listener.local_addr().expect("admission addr");
    let expected_remote = client.id().to_string();
    tokio::spawn(async move {
        let (mut socket, _request) = accept_admission_request(&admission_listener).await;
        let response = format!(
            "HTTP/1.1 204 No Content\r\nX-Happier-Iroh-Remote-Endpoint-Id: {expected_remote}\r\n{IROH_MACHINE_APPLICATION_PORT_HEADER}: {app_port}\r\n{IROH_MACHINE_APPLICATION_CAPABILITY_HEADER}: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            "e".repeat(64),
        );
        socket
            .write_all(response.as_bytes())
            .await
            .expect("write admission response");
    });

    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let tunnel = MachineTunnel::start(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"flow":"finite_transfer","operationId":"prepared-direct"}"#
                .to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
    )
    .await
    .expect("finite-transfer tunnel");

    let echoed = exchange_echo(
        tunnel.local_addr().expect("finite loopback addr"),
        b"prepared-transfer-payload",
    )
    .await;
    assert_eq!(echoed, b"prepared-transfer-payload");

    tunnel.stop();
    acceptor.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_tunnel_rejects_an_unauthorized_local_socket_before_opening_a_machine_stream() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let app_contacts = Arc::new(AtomicUsize::new(0));
    let app_port = echo_server(Arc::clone(&app_contacts)).await.port();
    let admission_contacts = Arc::new(AtomicUsize::new(0));
    let admission_target = admission_server(
        client.id().to_string(),
        Arc::new(Mutex::new(VecDeque::from([vec![app_port.to_string()]]))),
        Arc::clone(&admission_contacts),
    )
    .await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let tunnel =
        MachineTunnel::start(
            &client,
            MachineTunnelConfig {
                endpoint_id: server.id().to_string(),
                bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
                direct_addresses: vec![direct_addr(&server).await],
                relay_urls: vec![],
                handshake_json:
                    r#"{"v":1,"kind":"provider_broker","operationId":"op-local-capability"}"#
                        .to_owned(),
                cap_profile: IrohCapProfile::MachineBulk,
            },
        )
        .await
        .expect("machine tunnel");

    let mut scanner = TcpStream::connect(tunnel.local_addr().expect("local addr"))
        .await
        .expect("scanner connect");
    scanner
        .write_all(b"unauthorized-local-process")
        .await
        .expect("scanner write");
    scanner.shutdown().await.expect("scanner half close");
    let mut closed = Vec::new();
    tokio::time::timeout(Duration::from_secs(1), scanner.read_to_end(&mut closed))
        .await
        .expect("scanner connection closes")
        .expect("scanner read");
    assert_eq!(admission_contacts.load(Ordering::Relaxed), 0);
    assert_eq!(app_contacts.load(Ordering::Relaxed), 0);

    let echoed = exchange_echo_with_capability(
        tunnel.local_addr().expect("local addr"),
        tunnel
            .local_capability()
            .expect("provider tunnel capability"),
        b"authorized-after-scanner",
    )
    .await;
    assert_eq!(echoed, b"app-reply:authorized-after-scanner");
    assert_eq!(admission_contacts.load(Ordering::Relaxed), 1);
    assert_eq!(app_contacts.load(Ordering::Relaxed), 1);
    tunnel.stop();
    acceptor.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn machine_admission_keeps_request_write_half_open_for_async_node_response() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let app_contacts = Arc::new(AtomicUsize::new(0));
    let app_port = echo_server(Arc::clone(&app_contacts)).await.port();
    let admission_target =
        node_default_half_close_admission_server(client.id().to_string(), app_port).await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let tunnel = MachineTunnel::start(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"flow":"finite_transfer","operationId":"node-async-op"}"#
                .to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
    )
    .await
    .expect("machine tunnel");

    let echoed = exchange_echo(
        tunnel.local_addr().expect("local addr"),
        b"node-async-admission-bytes",
    )
    .await;
    assert_eq!(
        echoed,
        [b"app-reply:".as_slice(), b"node-async-admission-bytes"].concat()
    );
    assert_eq!(app_contacts.load(Ordering::Relaxed), 1);
    assert_eq!(acceptor.status().streams_accepted, 1);
    tunnel.stop();
    acceptor.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn each_admitted_stream_reaches_only_its_own_selected_application_port() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let app_a_contacts = Arc::new(AtomicUsize::new(0));
    let app_b_contacts = Arc::new(AtomicUsize::new(0));
    let app_a_port = echo_server(Arc::clone(&app_a_contacts)).await.port();
    let app_b_port = echo_server(Arc::clone(&app_b_contacts)).await.port();
    let admission_contacts = Arc::new(AtomicUsize::new(0));
    // One acceptor, one endpoint: each authenticated stream gets its own
    // trusted admission response selecting a different loopback application
    // listener. The second selection is OWS-padded exactly like a normally
    // serialized `Header: value` line (with optional whitespace after the
    // colon and around the value). Exchanges run sequentially, so admission
    // responses resolve in stream order deterministically.
    let admission_target = admission_server(
        client.id().to_string(),
        Arc::new(Mutex::new(VecDeque::from([
            vec![app_a_port.to_string()],
            vec![format!(" {} ", app_b_port)],
        ]))),
        Arc::clone(&admission_contacts),
    )
    .await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("acceptor");
    let tunnel = MachineTunnel::start(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"flow":"finite_transfer","operationId":"op-1"}"#.to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
    )
    .await
    .expect("tunnel");
    let local_addr = tunnel.local_addr().expect("local addr");

    let echoed_a = exchange_echo(local_addr, b"first-stream-payload-a").await;
    assert_eq!(
        echoed_a,
        [
            b"app-reply:".as_slice(),
            b"first-stream-payload-a".as_slice()
        ]
        .concat()
    );
    assert_eq!(app_a_contacts.load(Ordering::Relaxed), 1);
    assert_eq!(app_b_contacts.load(Ordering::Relaxed), 0);

    let echoed_b = exchange_echo(local_addr, b"second-stream-payload-b").await;
    assert_eq!(
        echoed_b,
        [
            b"app-reply:".as_slice(),
            b"second-stream-payload-b".as_slice()
        ]
        .concat()
    );
    assert_eq!(app_a_contacts.load(Ordering::Relaxed), 1);
    assert_eq!(app_b_contacts.load(Ordering::Relaxed), 1);

    assert_eq!(admission_contacts.load(Ordering::Relaxed), 2);
    assert_eq!(acceptor.status().streams_accepted, 2);
    tunnel.stop();
    acceptor.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn invalid_application_port_headers_reject_before_any_application_connection() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let app_contacts = Arc::new(AtomicUsize::new(0));
    let _never_contacted_app = echo_server(Arc::clone(&app_contacts)).await;
    let admission_contacts = Arc::new(AtomicUsize::new(0));
    // Every response approves the handshake (2xx + exact echo) but supplies
    // exactly one invalid application-port selection. Missing, empty, zero,
    // overflow, comma-folded, duplicated, signed, internal whitespace,
    // non-numeric, and non-canonical forms must all reject before any
    // application dial. Edge OWS alone (a normally serialized
    // `Header: value` line) is valid and covered by the positive tests.
    let cases: Vec<Vec<String>> = [
        vec![],
        vec![""],
        vec!["0"],
        vec!["65536"],
        vec!["99999"],
        vec!["8443,8443"],
        vec!["8443", "8443"],
        vec!["+8443"],
        vec!["84 43"],
        vec!["84\t43"],
        vec!["port"],
        vec!["08443"],
    ]
    .into_iter()
    .map(|ports| ports.into_iter().map(str::to_owned).collect())
    .collect();
    let admission_target = admission_server(
        client.id().to_string(),
        Arc::new(Mutex::new(VecDeque::from(cases.clone()))),
        Arc::clone(&admission_contacts),
    )
    .await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("acceptor");
    let server_addr = direct_addr(&server).await;

    for _ in 0..cases.len() {
        let tunnel = MachineTunnel::start(
            &client,
            MachineTunnelConfig {
                endpoint_id: server.id().to_string(),
                bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
                direct_addresses: vec![server_addr],
                relay_urls: vec![],
                handshake_json: r#"{"v":1,"flow":"finite_transfer","operationId":"op-1"}"#.to_owned(),
                cap_profile: IrohCapProfile::MachineBulk,
            },
        )
        .await
        .expect("tunnel");
        let mut socket = TcpStream::connect(tunnel.local_addr().expect("local addr"))
            .await
            .expect("local connect");
        socket
            .write_all(b"must-not-reach-app")
            .await
            .expect("local write");
        let mut byte = [0u8; 1];
        let result =
            tokio::time::timeout(std::time::Duration::from_secs(5), socket.read(&mut byte))
                .await
                .expect("bounded reject");
        assert!(matches!(result, Ok(0) | Err(_)));
        tunnel.stop();
    }
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(admission_contacts.load(Ordering::Relaxed), cases.len());
    assert_eq!(app_contacts.load(Ordering::Relaxed), 0);
    let status = acceptor.status();
    assert_eq!(status.streams_accepted, 0);
    assert_eq!(status.streams_rejected, cases.len() as u64);
    assert_eq!(
        status.last_failure,
        Some(crate::MachineFailureCode::AdmissionRejected)
    );
    acceptor.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn denied_machine_handshake_never_contacts_any_application_listener() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let app_contacts = Arc::new(AtomicUsize::new(0));
    let _never_contacted_app = echo_server(Arc::clone(&app_contacts)).await;
    let admission_contacts = Arc::new(AtomicUsize::new(0));
    // Denial: the admission owner rejects the grant with a non-2xx response.
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind admission");
    let admission_target = listener.local_addr().expect("admission addr");
    let admission_contacts_for_task = Arc::clone(&admission_contacts);
    tokio::spawn(async move {
        loop {
            let (mut socket, _request) = accept_admission_request(&listener).await;
            admission_contacts_for_task.fetch_add(1, Ordering::Relaxed);
            socket
                .write_all(
                    b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("deny response");
        }
    });
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let tunnel = MachineTunnel::start(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"flow":"finite_transfer","operationId":"op-1"}"#.to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
    )
    .await
    .expect("machine tunnel");
    let mut socket = TcpStream::connect(tunnel.local_addr().expect("local addr"))
        .await
        .expect("local connect");
    socket
        .write_all(b"must-not-reach-app")
        .await
        .expect("local write");
    let mut byte = [0u8; 1];
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), socket.read(&mut byte))
        .await
        .expect("bounded reject");
    assert!(matches!(result, Ok(0) | Err(_)));
    assert_eq!(admission_contacts.load(Ordering::Relaxed), 1);
    assert_eq!(app_contacts.load(Ordering::Relaxed), 0);
    assert_eq!(acceptor.status().streams_rejected, 1);
    assert_eq!(
        acceptor.status().last_failure,
        Some(crate::MachineFailureCode::AdmissionRejected)
    );
    tunnel.stop();
    acceptor.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn malformed_machine_control_never_reaches_admission_or_app() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let app_contacts = Arc::new(AtomicUsize::new(0));
    let _never_contacted_app = echo_server(Arc::clone(&app_contacts)).await;
    let admission_contacts = Arc::new(AtomicUsize::new(0));
    let admission_target = admission_server(
        client.id().to_string(),
        Arc::new(Mutex::new(VecDeque::from([vec!["1".to_owned()]]))),
        Arc::clone(&admission_contacts),
    )
    .await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("acceptor");
    let server_addr = direct_addr(&server).await;
    let local_only_refusal = br#"{"kind":"http_refusal","responseBody":"{}"}"#;
    let cases: Vec<Vec<u8>> = vec![
        vec![],
        vec![0x02],
        [
            vec![0x01],
            ((crate::MAX_MACHINE_HANDSHAKE_BYTES + 1) as u32)
                .to_be_bytes()
                .to_vec(),
        ]
        .concat(),
        [vec![0x01], 2u32.to_be_bytes().to_vec(), vec![0xff, 0xfe]].concat(),
        [vec![0x01], 1u32.to_be_bytes().to_vec(), b"[".to_vec()].concat(),
        [
            vec![0x01],
            (local_only_refusal.len() as u32).to_be_bytes().to_vec(),
            local_only_refusal.to_vec(),
        ]
        .concat(),
    ];
    for bytes in cases {
        let connection = client
            .endpoint()
            .connect(
                iroh::EndpointAddr::new(server.id()).with_ip_addr(server_addr),
                crate::MACHINE_ALPN,
            )
            .await
            .expect("machine connection");
        let (mut send, mut recv) = connection.open_bi().await.expect("stream");
        send.write_all(&bytes).await.expect("control bytes");
        send.finish().expect("finish control");
        let mut decision = [0u8; 1];
        let read =
            tokio::time::timeout(std::time::Duration::from_secs(2), recv.read(&mut decision))
                .await
                .expect("bounded reject");
        assert!(matches!(read, Ok(None) | Ok(Some(1)) | Err(_)));
        if matches!(read, Ok(Some(1))) {
            assert_eq!(decision[0], 0);
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(admission_contacts.load(Ordering::Relaxed), 0);
    assert_eq!(app_contacts.load(Ordering::Relaxed), 0);
    assert_eq!(acceptor.status().streams_rejected, 6);
    assert_eq!(
        acceptor.status().last_failure,
        Some(crate::MachineFailureCode::InvalidControl)
    );
    acceptor.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn admission_endpoint_echo_mismatch_never_contacts_any_application_listener() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let app_contacts = Arc::new(AtomicUsize::new(0));
    let _never_contacted_app = echo_server(Arc::clone(&app_contacts)).await;
    let admission_contacts = Arc::new(AtomicUsize::new(0));
    // The admission response echoes a different endpoint identity than the
    // authenticated transport peer; a valid port selection cannot rescue it.
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind admission");
    let admission_target = listener.local_addr().expect("admission addr");
    let wrong_remote = server.id().to_string();
    let admission_contacts_for_task = Arc::clone(&admission_contacts);
    tokio::spawn(async move {
        loop {
            let (mut socket, _request) = accept_admission_request(&listener).await;
            admission_contacts_for_task.fetch_add(1, Ordering::Relaxed);
            let response = format!(
                "HTTP/1.1 204 No Content\r\nX-Happier-Iroh-Remote-Endpoint-Id: {wrong_remote}\r\n{IROH_MACHINE_APPLICATION_PORT_HEADER}: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("echo response");
        }
    });
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("acceptor");
    let tunnel = MachineTunnel::start(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"flow":"finite_transfer","operationId":"op-1"}"#.to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
    )
    .await
    .expect("tunnel");
    let mut socket = TcpStream::connect(tunnel.local_addr().expect("local addr"))
        .await
        .expect("local connect");
    socket
        .write_all(b"must-not-reach-app")
        .await
        .expect("write");
    let mut byte = [0u8; 1];
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), socket.read(&mut byte))
        .await
        .expect("bounded reject");
    assert_eq!(admission_contacts.load(Ordering::Relaxed), 1);
    assert_eq!(app_contacts.load(Ordering::Relaxed), 0);
    assert_eq!(acceptor.status().streams_rejected, 1);
    assert_eq!(
        acceptor.status().last_failure,
        Some(crate::MachineFailureCode::EndpointIdentityMismatch)
    );
    tunnel.stop();
    acceptor.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn duplicate_or_comma_folded_remote_endpoint_echo_rejects_before_any_application_connection()
{
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let app_contacts = Arc::new(AtomicUsize::new(0));
    let _never_contacted_app = echo_server(Arc::clone(&app_contacts)).await;
    let admission_contacts = Arc::new(AtomicUsize::new(0));
    let remote = client.id().to_string();
    // Both echo shapes violate the exact-header contract even though each
    // response is otherwise a valid 2xx admission with a valid application
    // port selection: duplicate echo header lines, then a comma-folded echo
    // value. Neither may reach an application connection.
    let responses = Arc::new(Mutex::new(VecDeque::from([
        format!(
            "HTTP/1.1 204 No Content\r\nX-Happier-Iroh-Remote-Endpoint-Id: {remote}\r\nX-Happier-Iroh-Remote-Endpoint-Id: {remote}\r\n{IROH_MACHINE_APPLICATION_PORT_HEADER}: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        ),
        format!(
            "HTTP/1.1 204 No Content\r\nX-Happier-Iroh-Remote-Endpoint-Id: {remote}, {remote}\r\n{IROH_MACHINE_APPLICATION_PORT_HEADER}: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        ),
    ])));
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind admission");
    let admission_target = listener.local_addr().expect("admission addr");
    let admission_contacts_for_task = Arc::clone(&admission_contacts);
    tokio::spawn(async move {
        loop {
            let (mut socket, _request) = accept_admission_request(&listener).await;
            admission_contacts_for_task.fetch_add(1, Ordering::Relaxed);
            let response = responses
                .lock()
                .expect("response queue")
                .pop_front()
                .expect("queued admission response");
            socket
                .write_all(response.as_bytes())
                .await
                .expect("echo response");
        }
    });
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("acceptor");
    let server_addr = direct_addr(&server).await;
    for _ in 0..2 {
        let tunnel = MachineTunnel::start(
            &client,
            MachineTunnelConfig {
                endpoint_id: server.id().to_string(),
                bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
                direct_addresses: vec![server_addr],
                relay_urls: vec![],
                handshake_json: r#"{"v":1,"flow":"finite_transfer","operationId":"op-1"}"#.to_owned(),
                cap_profile: IrohCapProfile::MachineBulk,
            },
        )
        .await
        .expect("tunnel");
        let mut socket = TcpStream::connect(tunnel.local_addr().expect("local addr"))
            .await
            .expect("local connect");
        socket
            .write_all(b"must-not-reach-app")
            .await
            .expect("local write");
        let mut byte = [0u8; 1];
        let result =
            tokio::time::timeout(std::time::Duration::from_secs(5), socket.read(&mut byte))
                .await
                .expect("bounded reject");
        assert!(matches!(result, Ok(0) | Err(_)));
        tunnel.stop();
    }
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(admission_contacts.load(Ordering::Relaxed), 2);
    assert_eq!(app_contacts.load(Ordering::Relaxed), 0);
    let status = acceptor.status();
    assert_eq!(status.streams_accepted, 0);
    assert_eq!(status.streams_rejected, 2);
    assert_eq!(
        status.last_failure,
        Some(crate::MachineFailureCode::EndpointIdentityMismatch)
    );
    acceptor.stop();
}

#[tokio::test]
async fn machine_acceptor_validates_only_the_loopback_admission_target() {
    let endpoint = endpoint(IrohCapProfile::MachineBulk).await;
    let loopback: SocketAddr = "127.0.0.1:1234".parse().unwrap();
    let non_loopback: SocketAddr = "0.0.0.0:1234".parse().unwrap();
    assert!(MachineAcceptor::start(
        &endpoint,
        MachineAcceptorConfig {
            admission_target: non_loopback,
        },
    )
    .is_err());
    // The application destination is not an acceptor input at all: Rust
    // hard-codes the application host to loopback and takes the port only
    // from the trusted local admission response. A loopback admission target
    // starts cleanly; the acceptor guard drops and stops the task.
    let acceptor = MachineAcceptor::start(
        &endpoint,
        MachineAcceptorConfig {
            admission_target: loopback,
        },
    )
    .expect("loopback admission target is accepted");
    acceptor.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn workspace_sync_accepts_exactly_one_local_socket_for_one_grant() {
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let client = endpoint(IrohCapProfile::MachineBulk).await;
    let admission_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let admission_target = admission_listener.local_addr().unwrap();
    let app_contacts = Arc::new(AtomicUsize::new(0));
    let _never_contacted_app = echo_server(Arc::clone(&app_contacts)).await;
    let acceptor =
        MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target }).unwrap();
    let tunnel = MachineTunnel::start(
        &client,
        MachineTunnelConfig {
            endpoint_id: server.id().to_string(),
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            direct_addresses: vec![direct_addr(&server).await],
            relay_urls: vec![],
            handshake_json: r#"{"v":1,"flow":"workspace_sync","operationId":"workspace"}"#
                .to_owned(),
            cap_profile: IrohCapProfile::MachineBulk,
        },
    )
    .await
    .unwrap();
    let mut sockets = Vec::new();
    for _ in 0..2 {
        let mut socket = TcpStream::connect(tunnel.local_addr().unwrap())
            .await
            .unwrap();
        let _ = socket
            .write_all(
                tunnel
                    .local_capability()
                    .expect("workspace tunnel capability")
                    .as_bytes(),
            )
            .await;
        let _ = socket.write_all(b"held").await;
        sockets.push(socket);
    }
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(tunnel.status().streams_opened, 1);
    assert_eq!(app_contacts.load(Ordering::Relaxed), 0);
    drop(sockets);
    drop(admission_listener);
    tunnel.stop();
    acceptor.stop();
}

/// An admitted machine connection that never opens an application stream is
/// released after the same bounded pre-application custody window. Nothing
/// reaches the admission endpoint, because no stream ever existed to carry a
/// handshake.
#[tokio::test]
async fn an_admitted_machine_connection_that_opens_no_stream_drains_after_the_custody_window() {
    let admission_contacts = Arc::new(AtomicUsize::new(0));
    let admission_target = echo_server(Arc::clone(&admission_contacts)).await;
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let server_addr = direct_addr(&server).await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let client = endpoint(IrohCapProfile::MachineBulk).await;

    let connection = client
        .endpoint()
        .connect(
            iroh::EndpointAddr::new(server.id()).with_ip_addr(server_addr),
            crate::MACHINE_ALPN,
        )
        .await
        .expect("machine dial connects");

    let mut admitted = false;
    for _ in 0..200 {
        if acceptor.status().connections_active == 1 {
            admitted = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        admitted,
        "the connection must be admitted before the custody window is measured"
    );

    // The peer never opens a bidirectional application stream.
    tokio::time::timeout(
        crate::endpoint::PRE_APPLICATION_CUSTODY_TIMEOUT + Duration::from_secs(5),
        connection.closed(),
    )
    .await
    .expect("a machine connection that opens no application stream must be released");

    assert_eq!(
        admission_contacts.load(Ordering::Relaxed),
        0,
        "a connection without a first stream must never reach admission"
    );
    assert_eq!(acceptor.status().streams_accepted, 0);

    acceptor.stop();
    client.shutdown().await;
    server.shutdown().await;
}

/// The first stream remains connection-level pre-admission custody until its
/// signed framing and application admission succeed. A rejected first stream
/// must therefore retire the peer's whole QUIC connection, not leave a socket
/// that can submit further streams indefinitely.
#[tokio::test]
async fn an_invalid_first_machine_stream_closes_the_connection_before_a_second_is_accepted() {
    let admission_contacts = Arc::new(AtomicUsize::new(0));
    let admission_target = echo_server(Arc::clone(&admission_contacts)).await;
    let server = endpoint(IrohCapProfile::MachineBulk).await;
    let server_addr = direct_addr(&server).await;
    let acceptor = MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target })
        .expect("machine acceptor");
    let client = endpoint(IrohCapProfile::MachineBulk).await;

    let connection = client
        .endpoint()
        .connect(
            iroh::EndpointAddr::new(server.id()).with_ip_addr(server_addr),
            crate::MACHINE_ALPN,
        )
        .await
        .expect("machine dial connects");
    let (mut send, mut recv) = connection.open_bi().await.expect("first stream");
    send.write_all(&[crate::TUNNEL_PREAMBLE.wrapping_add(1)])
        .await
        .expect("invalid first preamble");
    send.finish().expect("finish invalid first stream");

    let mut rejection = [0u8; 1];
    match recv.read_exact(&mut rejection).await {
        Ok(()) => assert_eq!(rejection[0], crate::machine::MACHINE_STREAM_REJECT_BYTE),
        Err(_) => {
            // Closing the pre-admission connection is authoritative. QUIC may
            // surface that application close before the best-effort stream
            // rejection byte, so either observation proves fail-closed.
        }
    }
    tokio::time::timeout(Duration::from_secs(1), connection.closed())
        .await
        .expect("invalid first stream must close the whole connection");
    assert!(
        connection.open_bi().await.is_err(),
        "a rejected pre-admission connection must accept no second stream"
    );
    assert_eq!(admission_contacts.load(Ordering::Relaxed), 0);
    assert_eq!(acceptor.status().streams_accepted, 0);

    acceptor.stop();
    client.shutdown().await;
    server.shutdown().await;
}
