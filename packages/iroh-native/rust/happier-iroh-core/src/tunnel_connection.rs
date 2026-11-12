use crate::{verified_remote_endpoint_id, IrohAlpn, IrohCapProfile, IrohError, Result};
use std::sync::Mutex;

/// Authenticated connection custody shared by native tunnel listeners. A local
/// stream reuses a healthy connection or replaces a closed one on demand; no
/// idle reconnect task or retry policy runs beside the listener's lifecycle.
pub(crate) struct TunnelConnection {
    endpoint: iroh::Endpoint,
    remote: iroh::EndpointAddr,
    remote_id: iroh::EndpointId,
    alpn: IrohAlpn,
    cap_profile: IrohCapProfile,
    current: Mutex<iroh::endpoint::Connection>,
    dial: tokio::sync::Mutex<()>,
}

impl TunnelConnection {
    pub(crate) async fn connect(
        endpoint: iroh::Endpoint,
        remote: iroh::EndpointAddr,
        remote_id: iroh::EndpointId,
        alpn: IrohAlpn,
        cap_profile: IrohCapProfile,
    ) -> Result<Self> {
        let connection =
            dial_connection(&endpoint, remote.clone(), remote_id, alpn, cap_profile).await?;
        Ok(Self {
            endpoint,
            remote,
            remote_id,
            alpn,
            cap_profile,
            current: Mutex::new(connection),
            dial: tokio::sync::Mutex::new(()),
        })
    }

    pub(crate) fn current(&self) -> iroh::endpoint::Connection {
        self.current.lock().expect("tunnel connection").clone()
    }

    pub(crate) async fn for_local_stream(&self) -> Result<iroh::endpoint::Connection> {
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
        let connection = dial_connection(
            &self.endpoint,
            self.remote.clone(),
            self.remote_id,
            self.alpn,
            self.cap_profile,
        )
        .await?;
        *self.current.lock().expect("tunnel connection") = connection.clone();
        Ok(connection)
    }

    pub(crate) fn close(&self, reason: &[u8]) {
        self.current().close(0u32.into(), reason);
    }
}

async fn dial_connection(
    endpoint: &iroh::Endpoint,
    remote: iroh::EndpointAddr,
    remote_id: iroh::EndpointId,
    alpn: IrohAlpn,
    cap_profile: IrohCapProfile,
) -> Result<iroh::endpoint::Connection> {
    let connecting = endpoint
        .connect_with_opts(
            remote,
            alpn.as_bytes(),
            iroh::endpoint::ConnectOptions::new()
                .with_transport_config(cap_profile.transport_config()?),
        )
        .await
        .map_err(IrohError::from)?;
    let connection = connecting.await.map_err(IrohError::from)?;
    verified_remote_endpoint_id(connection.remote_id(), remote_id)?;
    Ok(connection)
}
