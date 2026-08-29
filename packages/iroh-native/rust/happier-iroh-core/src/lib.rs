//! Transport-only primitives shared by native Iroh bindings.
//!
//! This crate deliberately does not depend on an async runtime. The native Iroh
//! integration can adapt its stream halves to [`DuplexStream`], while tests and
//! small host integrations can use the same bounded copier with `std::io` types.

mod endpoint;
mod errors;
mod events;
mod home_tunnel;
mod limits;
mod machine;
mod path;
mod preamble;
mod stream;

#[cfg(test)]
mod home_tunnel_tests;
#[cfg(test)]
mod preamble_tests;

pub use endpoint::{
    validate_endpoint_id, validate_loopback_target, EndpointConfig, EndpointHandle,
    EndpointKeyStore, EndpointManager, EndpointStatus, IrohEndpoint, RelayPolicy,
};
pub use errors::{IrohError, IrohFailureReason, Result};
pub use events::{IrohHomeTunnelEvent, IrohTunnelEvent};
pub use home_tunnel::{HomeAcceptor, HomeAcceptorConfig, HomeTunnel, HomeTunnelConfig};
pub use limits::{
    IrohCapProfile, IrohConnectionPermit, IrohStreamPermit, IrohTunnelLimits, ResourceLimiter,
};
pub use machine::{MachineCarrierStatus, MachineFlow, MachineGrantBinding};
pub use path::{normalize_path, IrohObservedPath, IrohPathSnapshot};
pub use preamble::{read_preamble, write_preamble};
pub use stream::{
    copy_bidirectional, copy_split_bidirectional, CancellationToken, CopyLimits, CopyStats,
    DirectionStats, DuplexStream,
};

pub const HOME_TUNNEL_ALPN: &[u8] = b"happier/home-tunnel/1";
pub const MACHINE_ALPN: &[u8] = b"happier/machine/1";
pub const TUNNEL_PREAMBLE: u8 = 0x01;

/// The only ALPNs understood by this release. Unknown values are never silently
/// treated as a compatible protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IrohAlpn {
    HomeTunnel,
    Machine,
}

impl IrohAlpn {
    pub const fn as_bytes(self) -> &'static [u8] {
        match self {
            Self::HomeTunnel => HOME_TUNNEL_ALPN,
            Self::Machine => MACHINE_ALPN,
        }
    }

    pub fn parse(alpn: &[u8]) -> Result<Self> {
        match alpn {
            HOME_TUNNEL_ALPN => Ok(Self::HomeTunnel),
            MACHINE_ALPN => Ok(Self::Machine),
            _ => Err(IrohError::UnsupportedAlpn),
        }
    }
}

pub fn validate_preamble(byte: u8) -> Result<()> {
    (byte == TUNNEL_PREAMBLE)
        .then_some(())
        .ok_or(IrohError::InvalidPreamble)
}

pub fn validate_alpn(alpn: &[u8]) -> Result<()> {
    IrohAlpn::parse(alpn).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_locked_protocols_and_preamble() {
        assert!(validate_preamble(0x01).is_ok());
        assert_eq!(IrohAlpn::parse(HOME_TUNNEL_ALPN), Ok(IrohAlpn::HomeTunnel));
        assert_eq!(IrohAlpn::parse(MACHINE_ALPN), Ok(IrohAlpn::Machine));
        assert!(validate_alpn(HOME_TUNNEL_ALPN).is_ok());
        assert!(validate_alpn(MACHINE_ALPN).is_ok());
    }

    #[test]
    fn rejects_unknown_protocols_and_preamble() {
        assert_eq!(validate_preamble(0x00), Err(IrohError::InvalidPreamble));
        assert_eq!(
            validate_alpn(b"happier/peer-duplex/1"),
            Err(IrohError::UnsupportedAlpn)
        );
        assert_eq!(
            IrohAlpn::parse(b"happier/home-tunnel/2"),
            Err(IrohError::UnsupportedAlpn)
        );
    }
}
