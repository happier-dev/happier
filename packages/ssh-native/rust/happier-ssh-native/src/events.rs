use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSshProgressEvent {
    pub request_id: String,
    pub phase: &'static str,
    pub host: String,
    pub port: u16,
}
