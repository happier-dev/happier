use crate::{IrohError, IrohPathSnapshot, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MachineFlow {
    FileTransfer,
    AttachmentTransfer,
    WorkspaceSync,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineGrantBinding {
    pub flow: MachineFlow,
    pub source_machine_id: String,
    pub target_machine_id: String,
    pub source_endpoint_id: String,
    pub target_endpoint_id: String,
    pub expires_at_ms: u64,
    pub nonce: Vec<u8>,
}

impl MachineGrantBinding {
    pub fn validate(
        &self,
        now_ms: u64,
        expected_source_endpoint: &str,
        expected_target_endpoint: &str,
    ) -> Result<()> {
        if self.source_machine_id.is_empty()
            || self.target_machine_id.is_empty()
            || self.nonce.is_empty()
        {
            return Err(IrohError::TransportClosed);
        }
        if self.source_endpoint_id != expected_source_endpoint
            || self.target_endpoint_id != expected_target_endpoint
        {
            return Err(IrohError::TransportClosed);
        }
        if now_ms >= self.expires_at_ms {
            return Err(IrohError::TransportTimeout);
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct MachineCarrierStatus {
    pub flow: MachineFlow,
    pub path: IrohPathSnapshot,
    pub active: bool,
}
