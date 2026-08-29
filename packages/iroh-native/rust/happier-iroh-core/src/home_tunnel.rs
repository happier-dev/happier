use crate::{
    validate_loopback_target, IrohEndpoint, IrohError, Result, HOME_TUNNEL_ALPN, TUNNEL_PREAMBLE,
};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::str::FromStr;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

#[derive(Debug, Clone, Copy)]
pub struct HomeAcceptorConfig {
    pub target: SocketAddr,
    pub max_connections: usize,
}

impl Default for HomeAcceptorConfig {
    fn default() -> Self {
        Self {
            target: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3000),
            max_connections: 2,
        }
    }
}

/// Iroh-side Home listener. It accepts only the Home ALPN and forwards every
/// stream to the configured loopback Home origin; no peer-selected destination
/// is ever interpreted.
pub struct HomeAcceptor {
    task: JoinHandle<()>,
}

impl HomeAcceptor {
    pub fn start(endpoint: &IrohEndpoint, config: HomeAcceptorConfig) -> Result<Self> {
        validate_loopback_target(&config.target.ip().to_string(), config.target.port())?;
        if config.max_connections == 0 {
            return Err(IrohError::ResourceLimit);
        }
        let endpoint = endpoint.endpoint();
        let task = tokio::spawn(async move {
            while let Some(incoming) = endpoint.accept().await {
                let mut accepting = match incoming.accept() {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                let alpn = match accepting.alpn().await {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if alpn.as_slice() != HOME_TUNNEL_ALPN {
                    continue;
                }
                let connection = match accepting.await {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                let target = config.target;
                tokio::spawn(async move {
                    let (mut send, mut recv) = match connection.accept_bi().await {
                        Ok(value) => value,
                        Err(_) => return,
                    };
                    let mut preamble = [0u8; 1];
                    if recv.read_exact(&mut preamble).await.is_err()
                        || preamble[0] != TUNNEL_PREAMBLE
                    {
                        connection.close(0u32.into(), b"invalid_preamble");
                        return;
                    }
                    let mut socket = match TcpStream::connect(target).await {
                        Ok(value) => value,
                        Err(_) => return,
                    };
                    let (mut socket_read, mut socket_write) = socket.split();
                    let uplink = tokio::io::copy(&mut socket_read, &mut send);
                    let downlink = tokio::io::copy(&mut recv, &mut socket_write);
                    let _ = tokio::join!(uplink, downlink);
                    let _ = send.finish();
                });
            }
        });
        Ok(Self { task })
    }

    pub fn stop(self) {
        self.task.abort();
    }
}

#[derive(Debug, Clone)]
pub struct HomeTunnelConfig {
    pub endpoint_id: String,
    pub bind_addr: SocketAddr,
}

impl Default for HomeTunnelConfig {
    fn default() -> Self {
        Self {
            endpoint_id: String::new(),
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        }
    }
}

/// Client-side loopback dialer. The returned origin is ephemeral and must not
/// be persisted as a Home profile URL.
pub struct HomeTunnel {
    origin: String,
    task: JoinHandle<()>,
}

impl HomeTunnel {
    pub async fn start(endpoint: &IrohEndpoint, config: HomeTunnelConfig) -> Result<Self> {
        validate_loopback_target(
            &config.bind_addr.ip().to_string(),
            config.bind_addr.port().max(1),
        )?;
        let endpoint_id = iroh::EndpointId::from_str(&config.endpoint_id)
            .map_err(|_| IrohError::TransportClosed)?;
        let remote = iroh::EndpointAddr::new(endpoint_id);
        let listener = TcpListener::bind(config.bind_addr)
            .await
            .map_err(|_| IrohError::LoopbackBindFailed)?;
        let local = listener
            .local_addr()
            .map_err(|_| IrohError::LoopbackBindFailed)?;
        let native_endpoint = endpoint.endpoint();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = match listener.accept().await {
                    Ok(value) => value,
                    Err(_) => break,
                };
                let endpoint = native_endpoint.clone();
                let remote = remote.clone();
                tokio::spawn(async move {
                    let connection = match endpoint.connect(remote, HOME_TUNNEL_ALPN).await {
                        Ok(value) => value,
                        Err(_) => return,
                    };
                    let (mut send, mut recv) = match connection.open_bi().await {
                        Ok(value) => value,
                        Err(_) => return,
                    };
                    if send.write_all(&[TUNNEL_PREAMBLE]).await.is_err() {
                        return;
                    }
                    let (mut socket_read, mut socket_write) = socket.split();
                    let uplink = tokio::io::copy(&mut socket_read, &mut send);
                    let downlink = tokio::io::copy(&mut recv, &mut socket_write);
                    let _ = tokio::join!(uplink, downlink);
                    let _ = send.finish();
                });
            }
        });
        Ok(Self {
            origin: format!("http://{}:{}", local.ip(), local.port()),
            task,
        })
    }

    pub fn local_origin(&self) -> Result<String> {
        Ok(self.origin.clone())
    }

    pub fn stop(self) {
        self.task.abort();
    }
}
