//! Metadata-only pre-portal context; extraction remains the xa11y owner.
use super::{
    AtspiWindowIdentity, FrontmostMetadata, FrontmostWindowContext, WindowTextUnavailable,
};
use zbus::{
    blocking::{Connection, Proxy},
    zvariant::OwnedObjectPath,
};

struct AtspiMetadata(Connection);
impl AtspiMetadata {
    fn proxy<'a>(
        &'a self,
        identity: &'a AtspiWindowIdentity,
    ) -> Result<Proxy<'a>, WindowTextUnavailable> {
        Proxy::new(
            &self.0,
            identity.bus_name.as_str(),
            identity.object_path.as_str(),
            "org.a11y.atspi.Accessible",
        )
        .map_err(|_| WindowTextUnavailable::ProviderUnavailable)
    }
}
impl FrontmostMetadata for AtspiMetadata {
    fn children(
        &self,
        identity: &AtspiWindowIdentity,
    ) -> Result<Vec<AtspiWindowIdentity>, WindowTextUnavailable> {
        let children: Vec<(String, OwnedObjectPath)> = self
            .proxy(identity)?
            .call("GetChildren", &())
            .map_err(|_| WindowTextUnavailable::ProviderUnavailable)?;
        Ok(children
            .into_iter()
            .filter(|(bus, path)| !bus.is_empty() && path.as_str() != "/org/a11y/atspi/null")
            .map(|(bus_name, path)| AtspiWindowIdentity {
                bus_name,
                object_path: path.to_string(),
            })
            .collect())
    }
    fn role(&self, identity: &AtspiWindowIdentity) -> Result<u32, WindowTextUnavailable> {
        self.proxy(identity)?
            .call("GetRole", &())
            .map_err(|_| WindowTextUnavailable::ProviderUnavailable)
    }
    fn active(&self, identity: &AtspiWindowIdentity) -> Result<bool, WindowTextUnavailable> {
        let states: Vec<u32> = self
            .proxy(identity)?
            .call("GetState", &())
            .map_err(|_| WindowTextUnavailable::ProviderUnavailable)?;
        // AtspiStateType::ACTIVE = 1, carried in the first 32-bit state word.
        Ok(states.first().is_some_and(|states| states & (1 << 1) != 0))
    }
    fn name(&self, identity: &AtspiWindowIdentity) -> Option<String> {
        self.proxy(identity).ok()?.get_property("Name").ok()
    }
    fn process_id(&self, identity: &AtspiWindowIdentity) -> Option<u32> {
        Proxy::new(
            &self.0,
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
        )
        .ok()?
        .call("GetConnectionUnixProcessID", &(identity.bus_name.as_str(),))
        .ok()
    }
}

/// Finite identity probe before the system picker can change focus. Unlike
/// xa11y's public get_children(app), this never builds ElementData snapshots,
/// calls Text/Value interfaces, or descends into a window. Only native identity
/// and app/window names survive; the bus connection is dropped on return.
pub fn native_frontmost_context() -> Option<FrontmostWindowContext> {
    let session = Connection::session().ok()?;
    let address: String = Proxy::new(&session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus")
        .ok()?
        .call("GetAddress", &())
        .ok()?;
    let connection = zbus::blocking::connection::Builder::address(address.as_str())
        .ok()?
        .build()
        .ok()?;
    super::frontmost_context(&AtspiMetadata(connection))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    };

    struct AccessibilityBus(String);
    #[zbus::interface(name = "org.a11y.Bus")]
    impl AccessibilityBus {
        fn get_address(&self) -> &str {
            &self.0
        }
    }

    struct Accessible {
        path: &'static str,
        active: Arc<AtomicBool>,
        calls: Arc<Mutex<Vec<(&'static str, &'static str)>>>,
    }
    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl Accessible {
        fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
            self.calls.lock().unwrap().push((self.path, "GetChildren"));
            let paths = match self.path {
                "/org/a11y/atspi/accessible/root" => vec!["/app"],
                "/app" => vec!["/chosen", "/sibling", "/password"],
                _ => panic!("preportal metadata must not descend into windows/controls"),
            };
            paths
                .into_iter()
                .map(|path| {
                    (
                        "org.a11y.atspi.Registry".into(),
                        OwnedObjectPath::try_from(path).unwrap(),
                    )
                })
                .collect()
        }
        fn get_role(&self) -> u32 {
            self.calls.lock().unwrap().push((self.path, "GetRole"));
            match self.path {
                "/password" => 40,
                "/app" => 75,
                _ => 23,
            }
        }
        fn get_role_name(&self) -> &str {
            match self.path {
                "/password" => "password text",
                "/app" => "application",
                _ => "frame",
            }
        }
        fn get_interfaces(&self) -> Vec<&str> {
            vec![
                "org.a11y.atspi.Accessible",
                "org.a11y.atspi.Text",
                "org.a11y.atspi.Value",
            ]
        }
        fn get_state(&self) -> Vec<u32> {
            self.calls.lock().unwrap().push((self.path, "GetState"));
            vec![
                if self.path == "/chosen" && self.active.load(Ordering::Acquire) {
                    1 << 1
                } else {
                    0
                },
                0,
            ]
        }
        #[zbus(property)]
        fn name(&self) -> &str {
            self.calls.lock().unwrap().push((self.path, "Name"));
            match self.path {
                "/app" => "Fixture Wayland app",
                "/chosen" => "Fixture chosen window",
                _ => "must not read this control label",
            }
        }
    }
    struct TextSentinel(Arc<AtomicUsize>);
    #[zbus::interface(name = "org.a11y.atspi.Text")]
    impl TextSentinel {
        fn get_text(&self, _start: i32, _end: i32) -> &str {
            self.0.fetch_add(1, Ordering::Relaxed);
            "protected fixture sentinel"
        }
    }
    struct ValueSentinel(Arc<AtomicUsize>);
    #[zbus::interface(name = "org.a11y.atspi.Value")]
    impl ValueSentinel {
        #[zbus(property)]
        fn current_value(&self) -> f64 {
            self.0.fetch_add(1, Ordering::Relaxed);
            42.0
        }
    }

    struct FixtureControl {
        active: Arc<AtomicBool>,
        calls: Arc<Mutex<Vec<(&'static str, &'static str)>>>,
        text_reads: Arc<AtomicUsize>,
        value_reads: Arc<AtomicUsize>,
        own_excluded: bool,
    }
    #[zbus::interface(name = "dev.happier.CaptureFixture")]
    impl FixtureControl {
        fn set_active(&self, active: bool) {
            self.active.store(active, Ordering::Release);
        }
        fn counts(&self) -> (Vec<(String, String)>, u32, u32, bool) {
            (
                self.calls
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|(path, method)| (path.to_string(), method.to_string()))
                    .collect(),
                self.text_reads.load(Ordering::Relaxed) as u32,
                self.value_reads.load(Ordering::Relaxed) as u32,
                self.own_excluded,
            )
        }
    }

    // Owned child of the test below: a real external application PID rather
    // than weakening the production exclusion of Happier's own process.
    #[test]
    #[ignore = "fixture server launched only by the isolated raw AT-SPI test"]
    fn raw_atspi_fixture_server() {
        use std::io::{Read, Write};
        if std::env::var("HAPPIER_CAPTURE_ATSPI_SERVER").as_deref() != Ok("1") {
            return;
        }
        assert_eq!(
            std::env::var("HAPPIER_CAPTURE_ATSPI_FIXTURE").as_deref(),
            Ok("1")
        );
        let active = Arc::new(AtomicBool::new(true));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let text_reads = Arc::new(AtomicUsize::new(0));
        let value_reads = Arc::new(AtomicUsize::new(0));
        let mut builder = zbus::blocking::connection::Builder::session()
            .unwrap()
            .name("org.a11y.Bus")
            .unwrap()
            .name("org.a11y.atspi.Registry")
            .unwrap()
            .serve_at(
                "/org/a11y/bus",
                AccessibilityBus(std::env::var("DBUS_SESSION_BUS_ADDRESS").unwrap()),
            )
            .unwrap();
        for path in [
            "/org/a11y/atspi/accessible/root",
            "/app",
            "/chosen",
            "/sibling",
            "/password",
        ] {
            builder = builder
                .serve_at(
                    path,
                    Accessible {
                        path,
                        active: active.clone(),
                        calls: calls.clone(),
                    },
                )
                .unwrap()
                .serve_at(path, TextSentinel(text_reads.clone()))
                .unwrap()
                .serve_at(path, ValueSentinel(value_reads.clone()))
                .unwrap();
        }
        let server = builder.build().unwrap();
        let own_excluded = native_frontmost_context().is_none();
        calls.lock().unwrap().clear();
        server
            .object_server()
            .at(
                "/control",
                FixtureControl {
                    active,
                    calls,
                    text_reads,
                    value_reads,
                    own_excluded,
                },
            )
            .unwrap();
        println!("HAPPIER_ATSPI_FIXTURE_READY");
        std::io::stdout().flush().unwrap();
        // Parent closes its owned pipe on success or panic; no timer or orphan.
        let mut stop = Vec::new();
        std::io::stdin().read_to_end(&mut stop).unwrap();
    }

    /// Run under an isolated bus, never the user's accessibility registry:
    /// dbus-run-session -- env HAPPIER_CAPTURE_ATSPI_FIXTURE=1 cargo test
    /// --locked --features capture --lib raw_atspi_metadata_probe -- --ignored
    #[test]
    #[ignore = "requires an isolated dbus-run-session; integration owner supplies it"]
    fn raw_atspi_metadata_probe_never_reads_text_values_or_window_descendants() {
        use std::{
            io::{BufRead, BufReader},
            process::{Command, Stdio},
        };
        assert_eq!(
            std::env::var("HAPPIER_CAPTURE_ATSPI_FIXTURE").as_deref(),
            Ok("1")
        );
        struct Server(std::process::Child);
        impl Drop for Server {
            fn drop(&mut self) {
                self.0.stdin.take();
                let _ = self.0.wait();
            }
        }
        let mut server = Server(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "capture::window_text::linux::tests::raw_atspi_fixture_server",
                    "--ignored",
                    "--nocapture",
                ])
                .env("HAPPIER_CAPTURE_ATSPI_SERVER", "1")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut output = BufReader::new(server.0.stdout.take().unwrap()).lines();
        assert!(
            output
                .by_ref()
                .any(|line| line.unwrap().contains("HAPPIER_ATSPI_FIXTURE_READY")),
            "fixture server failed before readiness"
        );
        let connection = Connection::session().unwrap();
        let control = Proxy::new(
            &connection,
            "org.a11y.atspi.Registry",
            "/control",
            "dev.happier.CaptureFixture",
        )
        .unwrap();
        let context = native_frontmost_context().expect("usable ACTIVE native window");
        assert_eq!(context.process_id, server.0.id());
        assert_eq!(context.identity.object_path, "/chosen");
        assert_eq!(
            context.window_title.as_deref(),
            Some("Fixture chosen window")
        );
        assert_eq!(context.app_name.as_deref(), Some("Fixture Wayland app"));
        let (calls, text_reads, value_reads, own_excluded): (
            Vec<(String, String)>,
            u32,
            u32,
            bool,
        ) = control.call("Counts", &()).unwrap();
        assert!(
            own_excluded,
            "the fixture's own process cannot select itself"
        );
        assert_eq!(text_reads, 0);
        assert_eq!(value_reads, 0);
        assert!(!calls.contains(&("/password".into(), "Name".into())));
        assert_eq!(
            calls
                .iter()
                .filter(|(_, method)| method == "GetChildren")
                .count(),
            2
        );
        control.call::<_, _, ()>("SetActive", &(false,)).unwrap();
        assert_eq!(native_frontmost_context(), None);
        let (_, text_reads, value_reads, _): (Vec<(String, String)>, u32, u32, bool) =
            control.call("Counts", &()).unwrap();
        assert_eq!(text_reads, 0);
        assert_eq!(value_reads, 0);
    }
}
