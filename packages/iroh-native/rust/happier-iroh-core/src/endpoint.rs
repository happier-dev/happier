use crate::{IrohError, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
pub struct EndpointConfig {
    pub key_path: Option<PathBuf>,
    pub relay_policy: RelayPolicy,
    pub max_connections: usize,
    pub max_streams: usize,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayPolicy {
    Automatic,
    Disabled,
}
impl Default for RelayPolicy {
    fn default() -> Self {
        Self::Automatic
    }
}
impl Default for EndpointConfig {
    fn default() -> Self {
        Self {
            key_path: None,
            relay_policy: RelayPolicy::Automatic,
            max_connections: 64,
            max_streams: 256,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointStatus {
    Created,
    Running,
    Closed,
}
#[derive(Debug, Clone)]
pub struct EndpointHandle {
    id: u64,
    status: Arc<Mutex<EndpointStatus>>,
}
impl EndpointHandle {
    pub fn id(&self) -> u64 {
        self.id
    }
    pub fn status(&self) -> EndpointStatus {
        self.status
            .lock()
            .map(|s| *s)
            .unwrap_or(EndpointStatus::Closed)
    }
    pub fn shutdown(&self) {
        if let Ok(mut s) = self.status.lock() {
            *s = EndpointStatus::Closed;
        }
    }
}
#[derive(Default)]
pub struct EndpointManager {
    next_id: Mutex<u64>,
}
impl EndpointManager {
    pub fn create(&self, config: &EndpointConfig) -> Result<EndpointHandle> {
        if let Some(path) = &config.key_path {
            EndpointKeyStore::ensure(path)?;
        }
        let mut next = self
            .next_id
            .lock()
            .map_err(|_| IrohError::TransportClosed)?;
        *next += 1;
        Ok(EndpointHandle {
            id: *next,
            status: Arc::new(Mutex::new(EndpointStatus::Running)),
        })
    }
}

/// A bound Iroh endpoint shared by the Home acceptor and client dialer.
/// Endpoint construction is asynchronous because Iroh binds its UDP socket and
/// initializes relay/address-discovery workers during `bind`.
pub struct IrohEndpoint {
    inner: iroh::Endpoint,
}

impl IrohEndpoint {
    pub async fn bind(config: &EndpointConfig) -> Result<Self> {
        if config.max_connections == 0 || config.max_streams == 0 {
            return Err(IrohError::ResourceLimit);
        }
        let key = if let Some(path) = &config.key_path {
            EndpointKeyStore::ensure(path)?
        } else {
            let mut key = vec![0u8; 32];
            getrandom::fill(&mut key).map_err(|_| IrohError::TransportClosed)?;
            key
        };
        let key: [u8; 32] = key.try_into().map_err(|_| IrohError::TransportClosed)?;
        let relay_mode = match config.relay_policy {
            RelayPolicy::Automatic => iroh::RelayMode::Default,
            RelayPolicy::Disabled => iroh::RelayMode::Disabled,
        };
        let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(iroh::SecretKey::from_bytes(&key))
            .alpns(vec![
                crate::HOME_TUNNEL_ALPN.to_vec(),
                crate::MACHINE_ALPN.to_vec(),
            ])
            .relay_mode(relay_mode)
            .bind()
            .await
            .map_err(|_| IrohError::TransportClosed)?;
        Ok(Self { inner: endpoint })
    }

    pub fn id(&self) -> iroh::EndpointId {
        self.inner.id()
    }

    pub fn endpoint(&self) -> iroh::Endpoint {
        self.inner.clone()
    }

    pub async fn shutdown(self) {
        self.inner.close().await;
        self.inner.closed().await;
    }
}

/// The Home acceptor is deliberately restricted to its own loopback listener.
pub fn validate_loopback_target(host: &str, port: u16) -> Result<()> {
    if (host == "127.0.0.1" || host == "localhost") && port != 0 {
        Ok(())
    } else {
        Err(IrohError::LoopbackBindFailed)
    }
}

pub fn validate_endpoint_id(value: &str) -> Result<()> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(());
    }
    iroh::EndpointId::from_str(value)
        .map(|_| ())
        .map_err(|_| IrohError::TransportClosed)
}

/// File-backed key seam. Callers provide the key bytes; this module never logs or serializes them.
pub struct EndpointKeyStore;
impl EndpointKeyStore {
    pub fn ensure(path: &Path) -> Result<Vec<u8>> {
        if let Ok(bytes) = fs::read(path) {
            if bytes.len() != 32 {
                return Err(IrohError::TransportClosed);
            }
            return Ok(bytes);
        }
        let mut key = vec![0u8; 32];
        getrandom::fill(&mut key).map_err(|_| IrohError::TransportClosed)?;
        Self::write_atomic(path, &key)?;
        Ok(key)
    }

    pub fn load(path: &Path) -> Result<Vec<u8>> {
        let bytes = fs::read(path).map_err(IrohError::from)?;
        if bytes.len() != 32 {
            return Err(IrohError::TransportClosed);
        }
        Ok(bytes)
    }
    pub fn write_atomic(path: &Path, key: &[u8]) -> Result<()> {
        if key.len() != 32 {
            return Err(IrohError::TransportClosed);
        }
        let parent = path.parent().ok_or(IrohError::TransportClosed)?;
        fs::create_dir_all(parent)?;
        let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
        fs::write(&tmp, key)?;
        fs::rename(&tmp, path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_store_rejects_wrong_length_and_round_trips_exact_bytes() {
        let path = std::env::temp_dir().join(format!("happier-iroh-key-{}", std::process::id()));
        assert_eq!(
            EndpointKeyStore::write_atomic(&path, &[1, 2]),
            Err(IrohError::TransportClosed)
        );
        let key = vec![7u8; 32];
        EndpointKeyStore::write_atomic(&path, &key).unwrap();
        assert_eq!(EndpointKeyStore::load(&path).unwrap(), key);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn endpoint_id_accepts_canonical_iroh_and_protocol_hex_forms() {
        let key = iroh::SecretKey::from_bytes(&[3u8; 32]);
        assert!(validate_endpoint_id(&key.public().to_string()).is_ok());
        assert!(validate_endpoint_id(&"a".repeat(64)).is_ok());
        assert!(validate_endpoint_id("not-an-endpoint").is_err());
    }
}
