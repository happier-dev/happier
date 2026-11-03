use serde::{Deserialize, Serialize};

// Private native operand; never derive Debug for credential-bearing data.
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoginCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub same_site: Option<CookieSameSite>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum CookieSameSite {
    None,
    Lax,
    Strict,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LoginImportCode {
    DestinationUnavailable,
    ProfileMismatch,
    EngineUnsupported,
    ImportFailed,
    ImportUnknown,
    SourceFormatUnsupported,
    PasskeyImportUnavailable,
}

pub type CookieCompletion = Box<dyn FnOnce(Result<(), LoginImportCode>) + Send>;
