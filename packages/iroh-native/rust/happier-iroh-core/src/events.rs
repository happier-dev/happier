use crate::errors::IrohFailureReason;
use crate::path::IrohPathSnapshot;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IrohHomeTunnelEvent {
    Ready {
        lease_id: String,
        snapshot_generation: u64,
        home_server_identity_id: String,
        runtime_origin: String,
        at_ms: u64,
    },
    PathChanged {
        lease_id: String,
        snapshot_generation: u64,
        home_server_identity_id: String,
        snapshot: IrohPathSnapshot,
    },
    Degraded {
        lease_id: String,
        snapshot_generation: u64,
        home_server_identity_id: String,
        reason: IrohFailureReason,
        at_ms: u64,
    },
    Closed {
        lease_id: String,
        snapshot_generation: u64,
        home_server_identity_id: String,
        reason: String,
        at_ms: u64,
    },
    Error {
        lease_id: Option<String>,
        snapshot_generation: u64,
        home_server_identity_id: Option<String>,
        reason: IrohFailureReason,
        at_ms: u64,
    },
}
pub type IrohTunnelEvent = IrohHomeTunnelEvent;
