#![cfg(all(feature = "capture", target_os = "linux"))]
use happier_desktop_native::capture::{linux::screenshot, CancelSignal, CaptureError, RgbaFrame};
use std::{collections::HashMap, sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}}};
use zbus::{zvariant::{OwnedObjectPath, OwnedValue, Str}, Connection};

enum Reply { Image(String), Cancelled, DismissedWithResponseTwo, Denied, Pending }
struct Facts {
    reply: Mutex<Reply>, calls: AtomicUsize, sender: Mutex<Option<String>>,
    entered: tokio::sync::Notify,
}
struct Portal(Arc<Facts>);
#[zbus::interface(name = "org.freedesktop.portal.Screenshot")]
impl Portal {
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 { 2 }
    async fn screenshot(&self, parent: &str, options: HashMap<String, OwnedValue>,
        #[zbus(header)] header: zbus::message::Header<'_>, #[zbus(connection)] connection: &Connection,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        assert!(parent.is_empty()); // Tray-only flow has no fabricated parent token.
        assert_eq!(bool::try_from(options.get("interactive").unwrap()).unwrap(), true);
        self.0.calls.fetch_add(1, Ordering::Relaxed);
        let token = <&str>::try_from(options.get("handle_token").unwrap()).unwrap();
        let sender = header.sender().unwrap();
        let path = OwnedObjectPath::try_from(format!("/org/freedesktop/portal/desktop/request/{}/{}",
            sender.as_str().trim_start_matches(':').replace('.', "_"), token)).unwrap();
        *self.0.sender.lock().unwrap() = Some(sender.to_string());
        let response = match &*self.0.reply.lock().unwrap() {
            Reply::Denied => return Err(zbus::fdo::Error::AccessDenied("fixture denial".into())),
            Reply::Pending => None,
            Reply::Cancelled => Some((1u32, HashMap::<String, OwnedValue>::new())),
            Reply::DismissedWithResponseTwo => Some((2u32, HashMap::<String, OwnedValue>::new())),
            Reply::Image(uri) => Some((0u32, HashMap::from([("uri".into(), OwnedValue::from(Str::from(uri.as_str())))]))),
        };
        if let Some(response) = response {
            connection.emit_signal(Some(sender.as_str()), &path, "org.freedesktop.portal.Request", "Response", &response)
                .await.map_err(|_| zbus::fdo::Error::Failed("fixture signal".into()))?;
        }
        self.0.entered.notify_one();
        Ok(path)
    }
}

async fn attempt(cancel: CancelSignal) -> Result<Vec<u8>, CaptureError> {
    tokio::task::spawn_blocking(move || screenshot(&cancel)).await.unwrap()
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires an isolated bus: dbus-run-session -- cargo test --test capture_portal -- --ignored"]
async fn screenshot_transport_reads_one_returned_file_and_retires_cancelled_requests() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("portal returned % file.png");
    let bytes = RgbaFrame { width: 1, height: 1, rgba: vec![11, 23, 37, 255] }.png().unwrap();
    std::fs::write(&path, &bytes).unwrap();
    let facts = Arc::new(Facts { reply: Mutex::new(Reply::Image(url::Url::from_file_path(path).unwrap().to_string())),
        calls: AtomicUsize::new(0), sender: Mutex::new(None), entered: tokio::sync::Notify::new() });
    let service = zbus::connection::Builder::session().unwrap().name("org.freedesktop.portal.Desktop").unwrap()
        .serve_at("/org/freedesktop/portal/desktop", Portal(facts.clone())).unwrap().build().await.unwrap();
    assert_eq!(attempt(CancelSignal::default()).await.unwrap(), bytes);
    assert_eq!(facts.calls.load(Ordering::Relaxed), 1);
    facts.entered.notified().await;

    *facts.reply.lock().unwrap() = Reply::Cancelled;
    assert_eq!(attempt(CancelSignal::default()).await.unwrap_err(), CaptureError::Cancelled);
    facts.entered.notified().await;
    // Recorded GNOME 49 Escape response: non-success code 2, no image URI.
    *facts.reply.lock().unwrap() = Reply::DismissedWithResponseTwo;
    assert_eq!(attempt(CancelSignal::default()).await.unwrap_err(), CaptureError::Cancelled);
    facts.entered.notified().await;
    *facts.reply.lock().unwrap() = Reply::Denied;
    assert_eq!(attempt(CancelSignal::default()).await.unwrap_err(), CaptureError::PortalDenied);

    *facts.reply.lock().unwrap() = Reply::Pending;
    let cancel = CancelSignal::default();
    let pending = tokio::spawn(attempt(cancel.clone()));
    facts.entered.notified().await;
    assert_eq!(facts.calls.load(Ordering::Relaxed), 5);
    cancel.cancel();
    assert_eq!(pending.await.unwrap().unwrap_err(), CaptureError::Cancelled);
    let sender = facts.sender.lock().unwrap().clone().unwrap();
    let dbus = zbus::fdo::DBusProxy::new(&service).await.unwrap();
    assert!(!dbus.name_has_owner(zbus::names::BusName::try_from(sender.as_str()).unwrap()).await.unwrap());
    let cancelled = CancelSignal::default(); cancelled.cancel();
    assert_eq!(attempt(cancelled).await.unwrap_err(), CaptureError::Cancelled);
    assert_eq!(facts.calls.load(Ordering::Relaxed), 5);
    service.close().await.unwrap();
    assert_eq!(attempt(CancelSignal::default()).await.unwrap_err(), CaptureError::PortalUnavailable);
}
