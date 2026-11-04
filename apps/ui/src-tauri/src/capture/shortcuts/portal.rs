//! Native Wayland uses only the desktop portal, including under XWayland.
use super::*;
use ashpd::desktop::{
    global_shortcuts::{GlobalShortcuts, NewShortcut, Shortcut},
    CreateSessionOptions,
};
use futures_util::StreamExt;

pub(super) enum Command {
    Configure,
    Close,
}

fn id(key: CaptureBindingKey) -> &'static str {
    match key {
        CaptureBindingKey::CaptureShortcut => "capture",
        CaptureBindingKey::InstantWindowShortcut => "capture-window",
        CaptureBindingKey::RecordingShortcut => "record",
    }
}
fn key(id_value: &str) -> Option<CaptureBindingKey> {
    KEYS.into_iter().find(|key| id(*key) == id_value)
}

fn returned(app: &AppHandle, shortcuts: &[Shortcut], configure_supported: bool) {
    let mut next = snapshot(app);
    next.availability = Availability::Ready;
    next.configure_supported = configure_supported;
    for entry in &mut next.bindings {
        entry.active = shortcuts
            .iter()
            .find(|shortcut| shortcut.id() == id(entry.key))
            .map(|shortcut| shortcut.trigger_description().to_owned())
            .filter(|value| !value.is_empty());
        entry.failure = None;
    }
    publish(app, next);
}

pub(super) fn install(app: &AppHandle, bindings: Bindings) {
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    *app.state::<Shortcuts>().portal.lock().unwrap() = Some(sender);
    let mut next = snapshot(app);
    for entry in &mut next.bindings {
        entry.requested = bindings.get(entry.key).map(str::to_owned);
    }
    publish(app, next);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if run(&app, &bindings, receiver).await.is_err() {
            unavailable(&app, Availability::Unavailable);
        }
        app.state::<Shortcuts>().portal.lock().unwrap().take();
    });
}

async fn run(
    app: &AppHandle,
    bindings: &Bindings,
    mut commands: tokio::sync::mpsc::UnboundedReceiver<Command>,
) -> Result<(), ashpd::Error> {
    // The host Registry and GlobalShortcuts use ashpd's one shared D-Bus
    // connection. Register the installed desktop identity before consent so
    // assignments belong to Happier across launches, including tray-only use.
    ashpd::register_host_app(app.config().identifier.as_str().parse()?).await?;
    let portal = GlobalShortcuts::new().await?;
    let configure_supported = portal.version() >= 2;
    let session = portal
        .create_session(CreateSessionOptions::default())
        .await?;
    let result = async {
        // The Session serializer owns the D-Bus object path. Signals are scoped
        // to this session rather than other applications' portal sessions.
        let path = serde_json::to_value(&session).expect("portal session serializes as an object path");
        let path = path.as_str().expect("portal session path is a string");
        let activated = portal.receive_activated().await?;
        let changed = portal.receive_shortcuts_changed().await?;
        let closed = session.receive_closed().await?;
        futures_util::pin_mut!(activated, changed, closed);
        let shortcuts = KEYS.into_iter().map(|key| {
            let description = match key { CaptureBindingKey::CaptureShortcut => "Capture screenshot",
                CaptureBindingKey::InstantWindowShortcut => "Capture frontmost window",
                CaptureBindingKey::RecordingShortcut => "Record screen" };
            let preferred = bindings.get(key).and_then(registration::portal_hint);
            NewShortcut::new(id(key), description).preferred_trigger(preferred.as_deref())
        }).collect::<Vec<_>>();
        // BindShortcuts is one call per session. The portal owns persistence and
        // returns the actual bindings; ConfigureShortcuts never re-binds here.
        let bind = portal.bind_shortcuts(&session, &shortcuts, None, Default::default());
        futures_util::pin_mut!(bind);
        let response = loop {
            tokio::select! {
                response = &mut bind => break response?.response()?,
                command = commands.recv() => match command {
                    Some(Command::Close) | None => return Ok(()),
                    Some(Command::Configure) => {},
                },
                _ = closed.next() => { unavailable(app, Availability::Closed); return Ok(()); }
            }
        };
        returned(app, response.shortcuts(), configure_supported);
        loop {
            tokio::select! {
                event = activated.next() => {
                    let Some(event) = event else { break; };
                    if event.session_handle().as_str() == path
                        && !app.state::<Shortcuts>().editing.load(Ordering::Acquire) {
                        if let Some(key) = key(event.shortcut_id()) { dispatch(app, key); }
                    }
                }
                event = changed.next() => {
                    let Some(event) = event else { break; };
                    if event.session_handle().as_str() == path { returned(app, event.shortcuts(), configure_supported); }
                }
                _ = closed.next() => { unavailable(app, Availability::Closed); return Ok(()); }
                command = commands.recv() => {
                    match command {
                        Some(Command::Configure) => {
                            if portal.configure_shortcuts(&session, None, Default::default()).await.is_err() {
                                let mut next = snapshot(app);
                                for entry in &mut next.bindings { entry.failure = Some(ShortcutFailure::Unavailable); }
                                publish(app, next);
                            }
                        }
                        Some(Command::Close) | None => break,
                    }
                }
            }
        }
        unavailable(app, Availability::Closed);
        Ok(())
    }.await;
    // Explicit Close releases consent/session resources on shutdown and errors.
    let _ = session.close().await;
    result
}
