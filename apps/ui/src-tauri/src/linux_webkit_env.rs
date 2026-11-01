//! Process-environment defaults that WebKitGTK reads while it initialises, so they must be set
//! before Tauri creates the GTK app: first thing in `run()`, before the app starts any threads.
//! WebKit's web processes are spawned later and inherit them, which they need.

use std::ffi::OsStr;
use std::path::Path;

const NVIDIA_EXPLICIT_SYNC_VAR: &str = "__NV_DISABLE_EXPLICIT_SYNC";
const NVIDIA_DRIVER_VERSION_PATH: &str = "/proc/driver/nvidia/version";

/// Mitigation, not a root-cause fix: on the NVIDIA proprietary driver under Wayland, current
/// WebKitGTK (reproduced with 2.54.1 + driver 615.78.08 on KDE Plasma 6) aborts at startup with
/// "Error 71 (Protocol error) dispatching to Wayland display", so the window never appears.
/// Turning off the driver's explicit sync avoids it. Upstream: tauri-apps/tauri#10702. Remove
/// this once WebKitGTK/NVIDIA fix explicit sync.
///
/// An explicit user value always wins, and nothing changes off NVIDIA or when Wayland cannot be
/// used. Over-applying (a hybrid laptop rendering on the iGPU, or a GDK fallback to X11) only
/// turns off an NVIDIA Wayland feature that process is not using.
fn needs_nvidia_explicit_sync_workaround(
    user_value: Option<&OsStr>,
    nvidia_driver_loaded: bool,
    wayland_display: Option<&OsStr>,
    wayland_socket: Option<&OsStr>,
    default_wayland_socket_present: bool,
    gdk_backend: Option<&OsStr>,
) -> bool {
    let wayland_reachable = match wayland_display {
        Some(display) => !display.is_empty(),
        None => default_wayland_socket_present,
    } || wayland_socket.is_some();
    // GDK_BACKEND is a priority list; GDK may fall back to any entry, so only a list that leaves
    // Wayland out entirely rules it out.
    let gdk_may_use_wayland = gdk_backend
        .and_then(OsStr::to_str)
        .map_or(true, |backends| {
            backends
                .split(',')
                .any(|backend| matches!(backend.trim(), "wayland" | "*"))
        });
    user_value.is_none() && nvidia_driver_loaded && wayland_reachable && gdk_may_use_wayland
}

/// libwayland connects to `$XDG_RUNTIME_DIR/wayland-0` when `WAYLAND_DISPLAY` is unset, and GDK
/// tries Wayland first, so a session launched without `WAYLAND_DISPLAY` still lands on Wayland.
fn default_wayland_socket_present() -> bool {
    std::env::var_os("XDG_RUNTIME_DIR")
        .is_some_and(|runtime_dir| Path::new(&runtime_dir).join("wayland-0").exists())
}

/// Sets `__NV_DISABLE_EXPLICIT_SYNC=1` when the workaround above applies. Call it before Tauri
/// creates the GTK app, while the process has no other threads that could read the environment.
pub fn apply_before_gtk_init() {
    let user_value = std::env::var_os(NVIDIA_EXPLICIT_SYNC_VAR);
    let wayland_display = std::env::var_os("WAYLAND_DISPLAY");
    let wayland_socket = std::env::var_os("WAYLAND_SOCKET");
    let gdk_backend = std::env::var_os("GDK_BACKEND");
    if needs_nvidia_explicit_sync_workaround(
        user_value.as_deref(),
        Path::new(NVIDIA_DRIVER_VERSION_PATH).exists(),
        wayland_display.as_deref(),
        wayland_socket.as_deref(),
        default_wayland_socket_present(),
        gdk_backend.as_deref(),
    ) {
        disable_nvidia_explicit_sync();
    }
}

fn disable_nvidia_explicit_sync() {
    std::env::set_var(NVIDIA_EXPLICIT_SYNC_VAR, "1");
    // Tauri's logger is not installed yet; stderr also reaches desktop session logs.
    eprintln!(
        "Happier: applying NVIDIA Wayland startup mitigation (__NV_DISABLE_EXPLICIT_SYNC=1); \
         an explicit user value overrides this default (tauri-apps/tauri#10702)"
    );
}

#[cfg(test)]
mod tests {
    use super::needs_nvidia_explicit_sync_workaround;
    use std::ffi::OsStr;

    struct Case<'a> {
        user_value: Option<&'a str>,
        nvidia: bool,
        wayland_display: Option<&'a str>,
        wayland_socket: Option<&'a str>,
        default_socket: bool,
        gdk_backend: Option<&'a str>,
    }

    const NVIDIA_WAYLAND: Case<'static> = Case {
        user_value: None,
        nvidia: true,
        wayland_display: Some("wayland-0"),
        wayland_socket: None,
        default_socket: false,
        gdk_backend: None,
    };

    fn needs(case: Case) -> bool {
        needs_nvidia_explicit_sync_workaround(
            case.user_value.map(OsStr::new),
            case.nvidia,
            case.wayland_display.map(OsStr::new),
            case.wayland_socket.map(OsStr::new),
            case.default_socket,
            case.gdk_backend.map(OsStr::new),
        )
    }

    #[test]
    fn applies_on_nvidia_wayland_when_unset() {
        assert!(needs(NVIDIA_WAYLAND));
        for backend in ["wayland", "wayland,x11", "x11,wayland", "*"] {
            assert!(
                needs(Case {
                    gdk_backend: Some(backend),
                    ..NVIDIA_WAYLAND
                }),
                "GDK_BACKEND={backend}"
            );
        }
    }

    #[test]
    fn applies_when_wayland_arrives_as_an_inherited_socket() {
        assert!(needs(Case {
            wayland_display: None,
            wayland_socket: Some("3"),
            ..NVIDIA_WAYLAND
        }));
    }

    #[test]
    fn applies_when_wayland_is_only_the_default_socket() {
        assert!(needs(Case {
            wayland_display: None,
            default_socket: true,
            ..NVIDIA_WAYLAND
        }));
    }

    #[test]
    fn an_explicit_user_value_wins() {
        for value in ["0", "1", ""] {
            assert!(
                !needs(Case {
                    user_value: Some(value),
                    ..NVIDIA_WAYLAND
                }),
                "__NV_DISABLE_EXPLICIT_SYNC={value:?}"
            );
        }
    }

    #[test]
    fn leaves_other_drivers_alone() {
        assert!(!needs(Case {
            nvidia: false,
            ..NVIDIA_WAYLAND
        }));
    }

    #[test]
    fn leaves_x11_sessions_alone() {
        assert!(!needs(Case {
            wayland_display: None,
            ..NVIDIA_WAYLAND
        }));
        // libwayland only falls back to wayland-0 when WAYLAND_DISPLAY is unset, not empty.
        assert!(!needs(Case {
            wayland_display: Some(""),
            default_socket: true,
            ..NVIDIA_WAYLAND
        }));
        for backend in ["x11", "broadway"] {
            assert!(
                !needs(Case {
                    gdk_backend: Some(backend),
                    ..NVIDIA_WAYLAND
                }),
                "GDK_BACKEND={backend}"
            );
        }
    }

    #[test]
    fn workaround_sets_an_inherited_default_and_reports_activation() {
        const CHILD: &str = "HAPPIER_TEST_NVIDIA_EXPLICIT_SYNC_CHILD";
        if std::env::var_os(CHILD).is_some() {
            super::disable_nvidia_explicit_sync();
            let inherited = std::process::Command::new("/bin/sh")
                .args(["-c", "test \"$__NV_DISABLE_EXPLICIT_SYNC\" = 1"])
                .status()
                .expect("start the child that inherits the WebKit environment");
            assert!(inherited.success());
            return;
        }

        // Environment mutation runs in a separate process, away from other test threads.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", std::thread::current().name().unwrap(), "--nocapture"])
            .env(CHILD, "1")
            .env_remove(super::NVIDIA_EXPLICIT_SYNC_VAR)
            .output()
            .expect("start the isolated workaround test");
        assert!(output.status.success(), "{output:?}");
        assert!(
            !output.stderr.is_empty(),
            "activating the graphics mitigation must be observable before GTK starts"
        );
    }
}
