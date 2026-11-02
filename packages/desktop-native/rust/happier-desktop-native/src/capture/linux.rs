//! Native Linux session selection and the finite Screenshot portal request.
use super::{CancelSignal, CaptureError};
use std::path::PathBuf;
use ashpd::desktop::screenshot::{ScreenshotOptions, ScreenshotProxy};

#[path = "x11.rs"]
mod x11;
pub(super) use x11::native_monitor_frames;
pub use x11::X11CaptureBackend;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopSession { X11, Wayland }

/// The shell passes the actual GDK display type, never DISPLAY under XWayland.
pub fn session_from_gdk(display_type: &str) -> Result<DesktopSession, CaptureError> {
    match display_type {
        "GdkWaylandDisplay" => Ok(DesktopSession::Wayland),
        "GdkX11Display" => Ok(DesktopSession::X11),
        _ => Err(CaptureError::UnsupportedPlatform),
    }
}

pub fn portal_file(uri: &str) -> Result<PathBuf, CaptureError> {
    let uri = url::Url::parse(uri).map_err(|_| CaptureError::InvalidPortalUri)?;
    if uri.scheme() != "file" || uri.query().is_some() || uri.fragment().is_some() {
        return Err(CaptureError::InvalidPortalUri);
    }
    uri.to_file_path().map_err(|_| CaptureError::InvalidPortalUri)
}

fn portal_error(error: ashpd::Error) -> CaptureError {
    use ashpd::{desktop::ResponseError, Error, PortalError};
    match error {
        Error::Response(ResponseError::Cancelled) | Error::Portal(PortalError::Cancelled(_)) => CaptureError::Cancelled,
        Error::Portal(PortalError::NotAllowed(_)) => CaptureError::PortalDenied,
        Error::PortalNotFound(_) | Error::RequiresVersion(_, _) => CaptureError::PortalUnavailable,
        Error::Zbus(zbus::Error::MethodError(name, _, _)) |
        Error::Portal(PortalError::ZBus(zbus::Error::MethodError(name, _, _)))
            if name.as_str() == "org.freedesktop.DBus.Error.AccessDenied" => CaptureError::PortalDenied,
        Error::Zbus(_) | Error::Portal(PortalError::ZBus(_)) => CaptureError::PortalUnavailable,
        _ => CaptureError::NativeFailure,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenCastStream {
    pub node_id: u32,
    pub serial: Option<u64>,
    pub position: Option<(i32, i32)>,
    pub size: Option<(i32, i32)>,
    pub source_type: Option<u32>,
}

pub struct ScreenCastGrant {
    pub fd: std::os::fd::OwnedFd,
    pub stream: ScreenCastStream,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Drop for ScreenCastGrant {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() { let _ = stop.send(()); }
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
    }
}

fn bus_error(error: zbus::Error) -> CaptureError { portal_error(ashpd::Error::Zbus(error)) }

/// One ScreenCast request reader retains v6's pipewire-serial, which ashpd
/// 0.13.13's Stream projection does not expose. Screenshot keeps its own ABI.
async fn cast_request<B: serde::Serialize + zbus::zvariant::DynamicType>(proxy: &zbus::Proxy<'_>,
    method: &str, token: &str, body: &B) -> Result<std::collections::HashMap<String, zbus::zvariant::OwnedValue>, CaptureError> {
    use futures_util::StreamExt;
    let sender = proxy.connection().unique_name().ok_or(CaptureError::PortalUnavailable)?;
    let path = format!("/org/freedesktop/portal/desktop/request/{}/{}", sender.as_str().trim_start_matches(':').replace('.', "_"), token);
    let request = zbus::Proxy::new(proxy.connection(), "org.freedesktop.portal.Desktop", path.as_str(),
        "org.freedesktop.portal.Request").await.map_err(bus_error)?;
    let mut responses = request.receive_signal("Response").await.map_err(bus_error)?;
    let returned: zbus::zvariant::OwnedObjectPath = proxy.call(method, body).await.map_err(bus_error)?;
    if returned.as_str() != path { return Err(CaptureError::PortalUnavailable); }
    let response = responses.next().await.ok_or(CaptureError::PortalUnavailable)?;
    let (code, values): (u32, std::collections::HashMap<String, zbus::zvariant::OwnedValue>) =
        response.body().deserialize().map_err(bus_error)?;
    match code { 0 => Ok(values), 1 => Err(CaptureError::Cancelled), _ => Err(CaptureError::PortalDenied) }
}

/// Explicit start only: no bus connection, portal request or worker exists idle.
/// types is the ScreenCast source mask (monitor=1, window=2); never virtual.
pub fn screencast(types: u32, cancel: &CancelSignal,
    closed: std::sync::Arc<dyn Fn() + Send + Sync>) -> Result<ScreenCastGrant, CaptureError> {
    if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
    if types == 0 || types & !3 != 0 { return Err(CaptureError::UnsupportedTarget); }
    let (complete_tx, complete_rx) = std::sync::mpsc::channel();
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    let cancel_tx = std::sync::Mutex::new(Some(cancel_tx));
    cancel.on_cancel(move || { if let Some(tx) = cancel_tx.lock().unwrap().take() { let _ = tx.send(()); } });
    let (stop, mut stopped) = tokio::sync::oneshot::channel();
    let worker = std::thread::spawn(move || {
        use futures_util::StreamExt;
        use std::collections::HashMap;
        use zbus::zvariant::{OwnedFd, OwnedObjectPath, OwnedValue, Value};
        let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(runtime) => runtime, Err(_) => { let _ = complete_tx.send(Err(CaptureError::NativeFailure)); return; }
        };
        runtime.block_on(async move {
            let connection = tokio::select! {
                biased;
                _ = &mut cancel_rx => { let _ = complete_tx.send(Err(CaptureError::Cancelled)); return; },
                connection = zbus::Connection::session() => match connection {
                    Ok(connection) => connection, Err(error) => { let _ = complete_tx.send(Err(bus_error(error))); return; }
                },
            };
            let granted = tokio::select! {
                biased;
                _ = &mut cancel_rx => Err(CaptureError::Cancelled),
                grant = async {
                    let proxy = zbus::Proxy::new(&connection, "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
                        "org.freedesktop.portal.ScreenCast").await.map_err(bus_error)?;
                    let version: u32 = proxy.get_property("version").await.map_err(bus_error)?;
                    if version < 2 { return Err(CaptureError::CursorUnavailable); }
                    let cursors: u32 = proxy.get_property("AvailableCursorModes").await.map_err(bus_error)?;
                    if cursors & 2 == 0 { return Err(CaptureError::CursorUnavailable); }
                    let available: u32 = proxy.get_property("AvailableSourceTypes").await.map_err(bus_error)?;
                    let types = types & available;
                    if types == 0 { return Err(CaptureError::UnsupportedTarget); }
                    let options = HashMap::from([("handle_token", Value::from("create")), ("session_handle_token", Value::from("capture"))]);
                    let created = cast_request(&proxy, "CreateSession", "create", &(options,)).await?;
                    let session = created.get("session_handle").and_then(|v| <&str>::try_from(v).ok()).ok_or(CaptureError::PortalUnavailable)?;
                    let session = OwnedObjectPath::try_from(session.to_owned()).map_err(|_| CaptureError::PortalUnavailable)?;
                    let options = HashMap::from([("handle_token", Value::from("select")), ("types", Value::from(types)),
                        ("multiple", Value::from(false)), ("cursor_mode", Value::from(2u32))]);
                    cast_request(&proxy, "SelectSources", "select", &(&session, options)).await?;
                    let options = HashMap::from([("handle_token", Value::from("start"))]);
                    let mut response = cast_request(&proxy, "Start", "start", &(&session, "", options)).await?;
                    let mut streams = Vec::<(u32, HashMap<String, OwnedValue>)>::try_from(response.remove("streams").ok_or(CaptureError::PortalUnavailable)?)
                        .map_err(|_| CaptureError::PortalUnavailable)?;
                    if streams.len() != 1 { return Err(CaptureError::UnsupportedTarget); }
                    let (node_id, mut props) = streams.remove(0);
                    let stream = ScreenCastStream { node_id,
                        serial: props.remove("pipewire-serial").map(u64::try_from).transpose().map_err(|_| CaptureError::PortalUnavailable)?,
                        position: props.remove("position").map(<(i32,i32)>::try_from).transpose().map_err(|_| CaptureError::PortalUnavailable)?,
                        size: props.remove("size").map(<(i32,i32)>::try_from).transpose().map_err(|_| CaptureError::PortalUnavailable)?,
                        source_type: props.remove("source_type").map(u32::try_from).transpose().map_err(|_| CaptureError::PortalUnavailable)? };
                    let fd: OwnedFd = proxy.call("OpenPipeWireRemote", &(&session, HashMap::<&str, Value<'_>>::new())).await.map_err(bus_error)?;
                    Ok((std::os::fd::OwnedFd::from(fd), stream, session))
                } => grant,
            };
            match granted {
                Ok((fd, stream, session)) => {
                    let session_proxy = zbus::Proxy::new(&connection, "org.freedesktop.portal.Desktop", session,
                        "org.freedesktop.portal.Session").await;
                    if let Ok(proxy) = session_proxy {
                        match proxy.receive_signal("Closed").await {
                            Ok(mut closed_signals) => {
                                if complete_tx.send(Ok((fd, stream))).is_ok() {
                                    tokio::select! { biased; _ = &mut stopped => {}, _ = closed_signals.next() => closed(), }
                                }
                                let _: Result<(), _> = proxy.call("Close", &()).await;
                            },
                            Err(error) => { let _ = complete_tx.send(Err(bus_error(error))); },
                        }
                    } else { let _ = complete_tx.send(Err(CaptureError::PortalUnavailable)); }
                },
                Err(error) => { let _ = complete_tx.send(Err(error)); },
            }
            // Closes an in-flight Request as well as sessions on cancellation/error.
            let _ = connection.close().await;
        });
    });
    let result = complete_rx.recv().map_err(|_| CaptureError::NativeFailure).and_then(|r| r);
    cancel.clear_wake();
    match result {
        Ok((fd, stream)) => {
            let grant = ScreenCastGrant { fd, stream, stop: Some(stop), worker: Some(worker) };
            if cancel.is_cancelled() { drop(grant); Err(CaptureError::Cancelled) } else { Ok(grant) }
        },
        Err(error) => { let _ = stop.send(()); let _ = worker.join(); Err(error) },
    }
}

/// Runs on the shell's existing blocking executor. One attempt owns one bus
/// connection and one Screenshot request; no portal resources survive settlement.
pub fn screenshot(cancel: &CancelSignal) -> Result<Vec<u8>, CaptureError> {
    if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()
        .map_err(|_| CaptureError::NativeFailure)?;
    runtime.block_on(async {
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        let tx = std::sync::Mutex::new(Some(tx));
        cancel.on_cancel(move || { if let Some(tx) = tx.lock().unwrap().take() { let _ = tx.send(()); } });
        let result = async {
            let connection = tokio::select! {
                biased;
                _ = &mut rx => return Err(CaptureError::Cancelled),
                connection = zbus::Connection::session() => connection.map_err(|_| CaptureError::PortalUnavailable)?,
            };
            let result = tokio::select! {
                biased;
                _ = &mut rx => Err(CaptureError::Cancelled),
                result = async {
                    let proxy = ScreenshotProxy::with_connection(connection.clone()).await.map_err(portal_error)?;
                    if proxy.version() < 2 { return Err(CaptureError::PortalUnavailable); }
                    // GNOME 49 reports Escape as response 2 with no image. For
                    // this person-started picker only, a non-success response is
                    // cancellation; a rare real failure is retriable the same way.
                    let screenshot_response_error = |error| match error {
                        ashpd::Error::Response(_) => CaptureError::Cancelled,
                        error => portal_error(error),
                    };
                    let request = proxy.screenshot(None, ScreenshotOptions::default().set_interactive(true).set_modal(false))
                        .await.map_err(screenshot_response_error)?;
                    let response = request.response().map_err(screenshot_response_error)?;
                    let path = portal_file(response.uri().as_str())?;
                    if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
                    std::fs::read(path).map_err(|_| CaptureError::FileIo)
                } => result,
            };
            // ashpd 0.13's send waits for Response before exposing Request::close.
            // Retiring this attempt's dedicated sender closes its pending Request:
            // xdg-desktop-portal 1.20.3 peer_died_cb -> close_requests_for_sender.
            let _ = connection.close().await;
            result
        }.await;
        cancel.clear_wake();
        if cancel.is_cancelled() { Err(CaptureError::Cancelled) } else { result }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_wayland_never_selects_x11_from_a_coexisting_display_variable() {
        assert_eq!(session_from_gdk("GdkWaylandDisplay"), Ok(DesktopSession::Wayland));
        assert_eq!(session_from_gdk("GdkX11Display"), Ok(DesktopSession::X11));
        assert_eq!(session_from_gdk("OtherDisplay"), Err(CaptureError::UnsupportedPlatform));
    }
    #[test]
    fn portal_uri_is_a_local_file_and_decodes_escaped_filename_once() {
        assert_eq!(portal_file("file:///tmp/capture%20%2520.png").unwrap(), PathBuf::from("/tmp/capture %20.png"));
        for uri in ["https://example.test/capture.png", "file://other-host/tmp/capture.png", "not a URI",
            "file:///tmp/capture.png?download=1", "file:///tmp/capture.png#fragment"] {
            assert_eq!(portal_file(uri), Err(CaptureError::InvalidPortalUri));
        }
    }
}
