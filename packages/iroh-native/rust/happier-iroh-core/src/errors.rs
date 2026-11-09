use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IrohFailureReason {
    UnsupportedAlpn,
    InvalidPreamble,
    InvalidDescriptor,
    EndpointConfigConflict,
    Io,
    Cancelled,
    ResourceLimit,
    LoopbackBindFailed,
    TransportClosed,
    EndpointIdentityMismatch,
    TransportTimeout,
    TransportUnreachable,
}

#[derive(Debug)]
pub enum IrohError {
    UnsupportedAlpn,
    InvalidPreamble,
    /// Descriptor-derived metadata failed strict validation (grammar, bounds,
    /// credentials, or scheme). Never downgraded to a fallback path.
    InvalidDescriptor,
    /// The same endpoint identity key was requested with a different relay or
    /// cap configuration. Failing clearly prevents a silent second owner.
    EndpointConfigConflict,
    Io(std::io::Error),
    Cancelled,
    ResourceLimit,
    LoopbackBindFailed,
    TransportClosed,
    /// The authenticated transport identity of a dialed connection does not
    /// match the requested endpoint descriptor. Raised by the one outgoing
    /// identity guard shared by the Home and machine tunnels
    /// (`endpoint::verified_remote_endpoint_id`) and surfaced under the same
    /// "endpoint-identity-mismatch" classification the machine acceptor path
    /// already reports, so a start-path mismatch fails closed with one code.
    EndpointIdentityMismatch,
    TransportTimeout,
    /// Initial dial has no addressing information; no peer identity was proven.
    TransportUnreachable,
}
impl PartialEq for IrohError {
    fn eq(&self, other: &Self) -> bool {
        self.reason() == other.reason()
    }
}
impl Eq for IrohError {}

impl IrohError {
    pub const fn reason(&self) -> IrohFailureReason {
        match self {
            Self::UnsupportedAlpn => IrohFailureReason::UnsupportedAlpn,
            Self::InvalidPreamble => IrohFailureReason::InvalidPreamble,
            Self::InvalidDescriptor => IrohFailureReason::InvalidDescriptor,
            Self::EndpointConfigConflict => IrohFailureReason::EndpointConfigConflict,
            Self::Io(_) => IrohFailureReason::Io,
            Self::Cancelled => IrohFailureReason::Cancelled,
            Self::ResourceLimit => IrohFailureReason::ResourceLimit,
            Self::LoopbackBindFailed => IrohFailureReason::LoopbackBindFailed,
            Self::TransportClosed => IrohFailureReason::TransportClosed,
            Self::EndpointIdentityMismatch => IrohFailureReason::EndpointIdentityMismatch,
            Self::TransportTimeout => IrohFailureReason::TransportTimeout,
            Self::TransportUnreachable => IrohFailureReason::TransportUnreachable,
        }
    }
}
impl fmt::Display for IrohError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self)
    }
}
impl std::error::Error for IrohError {}
impl From<std::io::Error> for IrohError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<iroh::endpoint::ConnectWithOptsError> for IrohError {
    fn from(error: iroh::endpoint::ConnectWithOptsError) -> Self {
        match error {
            iroh::endpoint::ConnectWithOptsError::InvalidAlpn { .. } => Self::UnsupportedAlpn,
            iroh::endpoint::ConnectWithOptsError::NoAddress { .. } => Self::TransportUnreachable,
            _ => Self::TransportClosed,
        }
    }
}

impl From<iroh::endpoint::ConnectingError> for IrohError {
    fn from(error: iroh::endpoint::ConnectingError) -> Self {
        use iroh::endpoint::{
            AuthenticationError, ConnectingError, ConnectionError, TransportErrorCode,
        };
        // TLS 1.3 alert 120 is no_application_protocol (RFC 8446 §6.2).
        // Iroh 1.1/noq carries it as QUIC CRYPTO_ERROR, locally or from the
        // peer's CONNECTION_CLOSE. Never classify by diagnostic message text.
        let unsupported_alpn = TransportErrorCode::crypto(120);
        match error {
            ConnectingError::ConnectionError {
                source: ConnectionError::TimedOut,
                ..
            } => Self::TransportTimeout,
            ConnectingError::ConnectionError {
                source: ConnectionError::ConnectionClosed(close),
                ..
            } if close.error_code == unsupported_alpn => Self::UnsupportedAlpn,
            ConnectingError::ConnectionError {
                source: ConnectionError::TransportError(error),
                ..
            } if error.code == unsupported_alpn => Self::UnsupportedAlpn,
            ConnectingError::HandshakeFailure {
                source: AuthenticationError::NoAlpn { .. },
                ..
            } => Self::UnsupportedAlpn,
            _ => Self::TransportClosed,
        }
    }
}
pub type Result<T> = std::result::Result<T, IrohError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connecting_timeout_preserves_the_pre_acquisition_reason() {
        let error = iroh::endpoint::ConnectingError::from(iroh::endpoint::ConnectionError::TimedOut);
        assert_eq!(IrohError::from(error), IrohError::TransportTimeout);
    }
}
