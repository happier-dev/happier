#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IrohObservedPath {
    Direct,
    Relay,
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IrohPathSnapshot {
    pub observed_path: IrohObservedPath,
    pub is_relay: bool,
    pub remote_endpoint_id: String,
    pub at_ms: u64,
}
impl IrohPathSnapshot {
    pub fn new(
        observed_path: IrohObservedPath,
        remote_endpoint_id: impl Into<String>,
        at_ms: u64,
    ) -> Self {
        Self {
            is_relay: matches!(observed_path, IrohObservedPath::Relay),
            observed_path,
            remote_endpoint_id: remote_endpoint_id.into(),
            at_ms,
        }
    }
}
pub fn normalize_path(value: &str) -> IrohObservedPath {
    match value {
        "direct" => IrohObservedPath::Direct,
        "relay" => IrohObservedPath::Relay,
        _ => IrohObservedPath::Unknown,
    }
}
