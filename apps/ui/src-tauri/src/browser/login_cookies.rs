pub use super::cookie_types::{CookieCompletion, CookieSameSite, LoginCookie, LoginImportCode};
use super::{
    view_key, with_native_handle, DesktopBrowserPlatform, DesktopBrowserState,
    DesktopBrowserViewKey,
};
use serde::{Deserialize, Serialize};
use tauri::{Manager, Runtime, State, Window};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieApplyRequest {
    pub browser_session_id: String,
    pub view_id: String,
    pub profile_id: String,
    pub cookies: Vec<LoginCookie>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLoginDestination {
    pub browser_session_id: String,
    pub view_id: String,
    pub profile_id: String,
}
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CookieApplyResult {
    Completed { records: Vec<CookieImportRecord> },
    Unavailable { code: LoginImportCode },
}
#[derive(Debug, Serialize, PartialEq)]
pub struct CookieImportRecord {
    domain: String,
    name: String,
    status: CookieImportStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<LoginImportCode>,
}
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum CookieImportStatus {
    Imported,
    Failed,
}

pub(super) struct PendingCookie {
    domain: String,
    name: String,
    completion:
        Result<tokio::sync::oneshot::Receiver<Result<(), LoginImportCode>>, LoginImportCode>,
}
type PendingImport = Result<Vec<PendingCookie>, LoginImportCode>;

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum NativePasskeyAvailability {
    Available,
    Unavailable { code: LoginImportCode },
}

impl DesktopBrowserState {
    // This is an admitted destination lookup, not another authorization decision.
    fn login_destination(
        &self,
        destination: &NativeLoginDestination,
    ) -> Result<DesktopBrowserViewKey, LoginImportCode> {
        let key = view_key(&destination.browser_session_id, &destination.view_id);
        let inner = self.inner.lock().expect("browser state lock poisoned");
        let view = inner
            .views
            .get(&key)
            .ok_or(LoginImportCode::DestinationUnavailable)?;
        if view.profile_id != destination.profile_id {
            return Err(LoginImportCode::ProfileMismatch);
        }
        Ok(key)
    }

    fn start_login_cookie_import(&self, request: CookieApplyRequest) -> PendingImport {
        let key = self.login_destination(&NativeLoginDestination {
            browser_session_id: request.browser_session_id,
            view_id: request.view_id,
            profile_id: request.profile_id,
        })?;
        // All native effects are admitted here against one exact live handle. No source read,
        // permission evaluation, profile fallback or per-cookie re-admission occurs here.
        with_native_handle(&key, |handle| {
            if let Err(code) = handle.login_cookies_available() {
                return Ok(Err(code));
            }
            let pending = request
                .cookies
                .into_iter()
                .map(|cookie| {
                    let (sender, completion) = tokio::sync::oneshot::channel();
                    let callback = Box::new(move |result| {
                        let _ = sender.send(result);
                    });
                    let completion = handle
                        .set_login_cookie(&cookie, callback)
                        .map(|()| completion);
                    PendingCookie {
                        domain: cookie.domain,
                        name: cookie.name,
                        completion,
                    }
                })
                .collect();
            Ok(Ok(pending))
        })
        .map_err(|_| LoginImportCode::DestinationUnavailable)?
    }

    #[cfg(test)]
    pub(super) async fn apply_login_cookies_for_test(
        &self,
        request: CookieApplyRequest,
    ) -> CookieApplyResult {
        finish_cookie_import(self.start_login_cookie_import(request)).await
    }

    pub(super) fn native_passkey_availability(
        &self,
        request: NativeLoginDestination,
    ) -> NativePasskeyAvailability {
        if let Err(code) = self.login_destination(&request) {
            return NativePasskeyAvailability::Unavailable { code };
        }
        native_passkeys_for_platform(self.availability.platform)
    }
}

pub(super) fn native_passkeys_for_platform(
    platform: DesktopBrowserPlatform,
) -> NativePasskeyAvailability {
    match platform {
        // WebView2 runs the site's normal origin-bound Windows Hello/FIDO ceremony. This does
        // not import keys and accepts no credential material or simulated user verification.
        DesktopBrowserPlatform::Windows => NativePasskeyAvailability::Available,
        // The arbitrary-RP browser entitlement is absent from this app's signed entitlement
        // producer. Do not claim availability from WKWebView API presence alone.
        DesktopBrowserPlatform::MacOs => NativePasskeyAvailability::Unavailable {
            code: LoginImportCode::PasskeyImportUnavailable,
        },
        _ => NativePasskeyAvailability::Unavailable {
            code: LoginImportCode::EngineUnsupported,
        },
    }
}

async fn finish_cookie_import(pending: PendingImport) -> CookieApplyResult {
    let pending = match pending {
        Ok(pending) => pending,
        Err(code) => return CookieApplyResult::Unavailable { code },
    };
    let mut records = Vec::with_capacity(pending.len());
    for cookie in pending {
        // Lost native completion is outcome-unknown, never a claim that nothing was written.
        let result = match cookie.completion {
            Ok(completion) => completion
                .await
                .unwrap_or(Err(LoginImportCode::ImportUnknown)),
            Err(code) => Err(code),
        };
        records.push(CookieImportRecord {
            domain: cookie.domain,
            name: cookie.name,
            status: if result.is_ok() {
                CookieImportStatus::Imported
            } else {
                CookieImportStatus::Failed
            },
            code: result.err(),
        });
    }
    CookieApplyResult::Completed { records }
}

pub(super) async fn apply_login_cookies<R: Runtime>(
    window: Window<R>,
    request: CookieApplyRequest,
) -> CookieApplyResult {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let app = window.app_handle().clone();
    // Schedule native calls on their owning event loop, then await OS callbacks off that loop.
    if window
        .run_on_main_thread(move || {
            let state = app.state::<DesktopBrowserState>();
            let _ = sender.send(state.start_login_cookie_import(request));
        })
        .is_err()
    {
        return CookieApplyResult::Unavailable {
            code: LoginImportCode::DestinationUnavailable,
        };
    }
    finish_cookie_import(
        receiver
            .await
            .unwrap_or(Err(LoginImportCode::DestinationUnavailable)),
    )
    .await
}

pub(super) fn get_native_passkey_availability(
    state: State<'_, DesktopBrowserState>,
    request: NativeLoginDestination,
) -> NativePasskeyAvailability {
    state.native_passkey_availability(request)
}
