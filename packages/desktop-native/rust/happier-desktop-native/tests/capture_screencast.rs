#![cfg(all(feature = "capture", target_os = "linux"))]
use happier_desktop_native::capture::{linux::screencast, CancelSignal, CaptureError};
use std::{collections::HashMap, os::fd::{AsRawFd, OwnedFd}, sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}}};
use zbus::{Connection, zvariant::{OwnedObjectPath, OwnedValue, Value}};

struct Facts { serial: Mutex<Option<u64>>, cursor: Mutex<u32>, response: Mutex<u32>, calls: AtomicUsize,
    sender: Mutex<Option<String>>, closed: AtomicUsize, peer: Mutex<Option<std::os::unix::net::UnixStream>>,
    entered: tokio::sync::Notify }
struct Portal(Arc<Facts>);
async fn respond(connection: &Connection, header: zbus::message::Header<'_>, options: &HashMap<String, OwnedValue>,
    response: u32, values: HashMap<&str, Value<'_>>) -> zbus::fdo::Result<OwnedObjectPath> {
    let token = <&str>::try_from(options.get("handle_token").unwrap()).unwrap();
    let sender = header.sender().unwrap();
    let path = OwnedObjectPath::try_from(format!("/org/freedesktop/portal/desktop/request/{}/{}",
        sender.as_str().trim_start_matches(':').replace('.', "_"), token)).unwrap();
    if response != 99 {
        connection.emit_signal(Some(sender.as_str()), &path, "org.freedesktop.portal.Request", "Response", &(response, values))
            .await.map_err(|_| zbus::fdo::Error::Failed("fixture signal".into()))?;
    }
    Ok(path)
}
#[zbus::interface(name = "org.freedesktop.portal.ScreenCast")]
impl Portal {
    #[zbus(property, name = "version")] fn version(&self) -> u32 { 6 }
    #[zbus(property, name = "AvailableCursorModes")] fn cursor(&self) -> u32 { *self.0.cursor.lock().unwrap() }
    #[zbus(property, name = "AvailableSourceTypes")] fn types(&self) -> u32 { 3 }
    async fn create_session(&self, options: HashMap<String, OwnedValue>,
        #[zbus(header)] header: zbus::message::Header<'_>, #[zbus(connection)] connection: &Connection,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        self.0.calls.fetch_add(1, Ordering::SeqCst);
        *self.0.sender.lock().unwrap() = Some(header.sender().unwrap().to_string());
        self.0.entered.notify_one();
        let response = *self.0.response.lock().unwrap();
        respond(connection, header, &options, response,
            HashMap::from([("session_handle", Value::from("/org/freedesktop/portal/desktop/session/test/capture"))])).await
    }
    async fn select_sources(&self, session: OwnedObjectPath, options: HashMap<String, OwnedValue>,
        #[zbus(header)] header: zbus::message::Header<'_>, #[zbus(connection)] connection: &Connection,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        assert_eq!(session.as_str(), "/org/freedesktop/portal/desktop/session/test/capture");
        assert_eq!(u32::try_from(options.get("cursor_mode").unwrap()).unwrap(), 2);
        assert_eq!(u32::try_from(options.get("types").unwrap()).unwrap(), 3);
        assert!(!bool::try_from(options.get("multiple").unwrap()).unwrap());
        respond(connection, header, &options, 0, HashMap::new()).await
    }
    async fn start(&self, _session: OwnedObjectPath, parent: &str, options: HashMap<String, OwnedValue>,
        #[zbus(header)] header: zbus::message::Header<'_>, #[zbus(connection)] connection: &Connection,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        assert!(parent.is_empty());
        let mut props = HashMap::from([("position", Value::from((-20i32, 10i32))), ("size", Value::from((100i32, 80i32))),
            ("source_type", Value::from(1u32))]);
        if let Some(serial) = *self.0.serial.lock().unwrap() { props.insert("pipewire-serial", Value::from(serial)); }
        respond(connection, header, &options, 0, HashMap::from([("streams", Value::from(vec![(42u32, props)]))])).await
    }
    fn open_pipe_wire_remote(&self, _session: OwnedObjectPath, _options: HashMap<String, OwnedValue>) -> zbus::fdo::Result<zbus::zvariant::OwnedFd> {
        let (stream, peer) = std::os::unix::net::UnixStream::pair().unwrap();
        *self.0.peer.lock().unwrap() = Some(peer);
        Ok(zbus::zvariant::OwnedFd::from(OwnedFd::from(stream)))
    }
}
struct PortalSession(Arc<Facts>);
#[zbus::interface(name = "org.freedesktop.portal.Session")]
impl PortalSession { fn close(&self) { self.0.closed.fetch_add(1, Ordering::SeqCst); } }

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires isolated bus: dbus-run-session -- cargo test --test capture_screencast -- --ignored"]
async fn granted_remote_keeps_the_sender_and_fd_until_release_and_preserves_optional_serial() {
    let facts = Arc::new(Facts { serial: Mutex::new(Some(9001)), cursor: Mutex::new(2), response: Mutex::new(0),
        calls: AtomicUsize::new(0), sender: Mutex::new(None), closed: AtomicUsize::new(0), peer: Mutex::new(None),
        entered: tokio::sync::Notify::new() });
    let service = zbus::connection::Builder::session().unwrap().name("org.freedesktop.portal.Desktop").unwrap()
        .serve_at("/org/freedesktop/portal/desktop", Portal(facts.clone())).unwrap()
        .serve_at("/org/freedesktop/portal/desktop/session/test/capture", PortalSession(facts.clone())).unwrap()
        .build().await.unwrap();
    for expected in [Some(9001), None] {
        *facts.serial.lock().unwrap() = expected;
        let grant = tokio::task::spawn_blocking(|| screencast(3, &CancelSignal::default(), Arc::new(|| {}))).await.unwrap().unwrap();
        assert_eq!(grant.stream.serial, expected);
        assert_eq!(grant.stream.node_id, 42);
        assert_eq!(grant.stream.position, Some((-20, 10)));
        assert!(grant.fd.as_raw_fd() >= 0);
        use std::io::{Read, Write};
        let mut duplicate = std::os::unix::net::UnixStream::from(grant.fd.try_clone().unwrap());
        facts.peer.lock().unwrap().as_mut().unwrap().write_all(b"p").unwrap();
        let mut byte = [0]; duplicate.read_exact(&mut byte).unwrap(); assert_eq!(byte, *b"p");
        drop(duplicate);
        let sender = facts.sender.lock().unwrap().clone().unwrap();
        let dbus = zbus::fdo::DBusProxy::new(&service).await.unwrap();
        assert!(dbus.name_has_owner(zbus::names::BusName::try_from(sender.as_str()).unwrap()).await.unwrap());
        tokio::task::spawn_blocking(move || drop(grant)).await.unwrap();
        assert_eq!(facts.peer.lock().unwrap().as_mut().unwrap().read(&mut byte).unwrap(), 0);
        assert!(!dbus.name_has_owner(zbus::names::BusName::try_from(sender.as_str()).unwrap()).await.unwrap());
    }
    assert_eq!(facts.closed.load(Ordering::SeqCst), 2);
    let (closed_tx, closed_rx) = std::sync::mpsc::channel();
    let grant = tokio::task::spawn_blocking(move || screencast(3, &CancelSignal::default(), Arc::new(move || { let _ = closed_tx.send(()); })))
        .await.unwrap().unwrap();
    service.emit_signal(None::<&str>, "/org/freedesktop/portal/desktop/session/test/capture", "org.freedesktop.portal.Session", "Closed",
        &(HashMap::<&str, Value<'_>>::new(),)).await.unwrap();
    tokio::task::spawn_blocking(move || closed_rx.recv().unwrap()).await.unwrap();
    tokio::task::spawn_blocking(move || drop(grant)).await.unwrap();
    assert_eq!(facts.closed.load(Ordering::SeqCst), 3, "source loss pushes one close without a probe loop");
    *facts.response.lock().unwrap() = 1;
    assert!(matches!(tokio::task::spawn_blocking(|| screencast(3, &CancelSignal::default(), Arc::new(|| {}))).await.unwrap(), Err(CaptureError::Cancelled)));
    let count = facts.calls.load(Ordering::SeqCst);
    let cancel = CancelSignal::default(); cancel.cancel();
    assert!(matches!(screencast(3, &cancel, Arc::new(|| {})), Err(CaptureError::Cancelled)));
    assert_eq!(facts.calls.load(Ordering::SeqCst), count);
    *facts.cursor.lock().unwrap() = 1;
    assert!(matches!(tokio::task::spawn_blocking(|| screencast(3, &CancelSignal::default(), Arc::new(|| {}))).await.unwrap(), Err(CaptureError::CursorUnavailable)));
    assert_eq!(facts.calls.load(Ordering::SeqCst), count, "cursor refusal settles before creating another session");
    *facts.cursor.lock().unwrap() = 2;
    *facts.response.lock().unwrap() = 99;
    // Drain the previous notifications; this final request is deliberately pending.
    facts.entered.notified().await;
    let cancel = CancelSignal::default(); let worker_cancel = cancel.clone();
    let pending = tokio::task::spawn_blocking(move || screencast(3, &worker_cancel, Arc::new(|| {})));
    facts.entered.notified().await; cancel.cancel();
    assert!(matches!(pending.await.unwrap(), Err(CaptureError::Cancelled)));
    let sender = facts.sender.lock().unwrap().clone().unwrap();
    let dbus = zbus::fdo::DBusProxy::new(&service).await.unwrap();
    assert!(!dbus.name_has_owner(zbus::names::BusName::try_from(sender.as_str()).unwrap()).await.unwrap());
}
