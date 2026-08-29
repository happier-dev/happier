use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IrohFailureReason {
    UnsupportedAlpn,
    InvalidPreamble,
    Io,
    Cancelled,
    ResourceLimit,
    LoopbackBindFailed,
    TransportClosed,
    TransportTimeout,
}

#[derive(Debug)]
pub enum IrohError {
    UnsupportedAlpn,
    InvalidPreamble,
    Io(std::io::Error),
    Cancelled,
    ResourceLimit,
    LoopbackBindFailed,
    TransportClosed,
    TransportTimeout,
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
            Self::Io(_) => IrohFailureReason::Io,
            Self::Cancelled => IrohFailureReason::Cancelled,
            Self::ResourceLimit => IrohFailureReason::ResourceLimit,
            Self::LoopbackBindFailed => IrohFailureReason::LoopbackBindFailed,
            Self::TransportClosed => IrohFailureReason::TransportClosed,
            Self::TransportTimeout => IrohFailureReason::TransportTimeout,
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
pub type Result<T> = std::result::Result<T, IrohError>;
