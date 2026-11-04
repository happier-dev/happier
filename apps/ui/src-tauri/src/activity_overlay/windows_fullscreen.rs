//! An appbar notice owns fullscreen transitions; no periodic foreground probes.
trait AppBar {
    fn register(&mut self) -> Result<(), String>;
    fn unregister(&mut self);
    fn visible(&mut self, visible: bool);
}

#[derive(Default)]
struct Lifetime {
    registered: bool,
    wanted: bool,
    fullscreen: bool,
}

impl Lifetime {
    fn configure(
        &mut self,
        native: &mut impl AppBar,
        wanted: bool,
        above: bool,
    ) -> Result<(), String> {
        self.wanted = wanted;
        if wanted && !above {
            if !self.registered {
                native.register()?;
                self.registered = true;
            }
        } else {
            self.close(native);
            if self.fullscreen && wanted {
                native.visible(true);
            }
            self.fullscreen = false;
        }
        Ok(())
    }
    fn notice(&mut self, native: &mut impl AppBar, fullscreen: bool) {
        if !self.registered || self.fullscreen == fullscreen {
            return;
        }
        self.fullscreen = fullscreen;
        if self.wanted {
            native.visible(!fullscreen);
        }
    }
    fn close(&mut self, native: &mut impl AppBar) {
        if self.registered {
            native.unregister();
            self.registered = false;
        }
    }
}

// TAURI ADAPTER
#[cfg(target_os = "windows")]
mod native {
    use super::*;
    use tauri::{Manager, Runtime, WebviewWindow};
    use windows::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::{
            Shell::{
                DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SHAppBarMessage,
                SetWindowSubclass, ABM_NEW, ABM_REMOVE, ABN_FULLSCREENAPP, APPBARDATA,
            },
            WindowsAndMessaging::{WM_APP, WM_NCDESTROY},
        },
    };
    const NOTICE: u32 = WM_APP + 0x46;
    struct Boundary {
        hwnd: HWND,
        changed: Box<dyn Fn() + Send + Sync>,
    }
    impl AppBar for Boundary {
        fn register(&mut self) -> Result<(), String> {
            let mut data = APPBARDATA {
                cbSize: std::mem::size_of::<APPBARDATA>() as u32,
                hWnd: self.hwnd,
                uCallbackMessage: NOTICE,
                ..Default::default()
            };
            if unsafe { SHAppBarMessage(ABM_NEW, &mut data) } == 0 {
                return Err("Overlay fullscreen notifications unavailable".into());
            }
            Ok(())
        }
        fn unregister(&mut self) {
            let mut data = APPBARDATA {
                cbSize: std::mem::size_of::<APPBARDATA>() as u32,
                hWnd: self.hwnd,
                ..Default::default()
            };
            unsafe {
                SHAppBarMessage(ABM_REMOVE, &mut data);
            }
        }
        fn visible(&mut self, _: bool) {
            (self.changed)();
        }
    }
    struct Connection {
        lifetime: Lifetime,
        boundary: Boundary,
    }
    unsafe extern "system" fn message(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        data: usize,
    ) -> LRESULT {
        let connection = unsafe { &mut *(data as *mut Connection) };
        if msg == NOTICE && wparam.0 == ABN_FULLSCREENAPP as usize {
            connection
                .lifetime
                .notice(&mut connection.boundary, lparam.0 != 0);
        } else if msg == WM_NCDESTROY {
            connection.lifetime.close(&mut connection.boundary);
            unsafe {
                RemoveWindowSubclass(hwnd, Some(message), id);
                drop(Box::from_raw(data as *mut Connection));
            }
        }
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    pub(in crate::activity_overlay) fn configure<R: Runtime>(
        window: &WebviewWindow<R>,
        wanted: bool,
        above: bool,
    ) -> Result<bool, String> {
        let native_window = window.clone();
        let task = move || {
            let hwnd = native_window.hwnd().map_err(|error| error.to_string())?;
            let mut data = 0;
            if !unsafe { GetWindowSubclass(hwnd, Some(message), 0, Some(&mut data)) }.as_bool() {
                if !wanted || above {
                    return Ok(wanted);
                }
                let app = native_window.app_handle().clone();
                let changed = Box::new(move || {
                    let app = app.clone();
                    // Never wait for GUI-thread work while processing a native notice.
                    tauri::async_runtime::spawn_blocking(move || {
                        if let Some(state) = app.try_state::<super::super::ActivityOverlayState>() {
                            if let Err(error) =
                                super::super::window_lifecycle::apply_overlay_state(&app, &state)
                            {
                                log::warn!("Overlay fullscreen transition failed: {error}");
                            }
                        }
                    });
                });
                let connection = Box::new(Connection {
                    lifetime: Lifetime::default(),
                    boundary: Boundary { hwnd, changed },
                });
                data = Box::into_raw(connection) as usize;
                if !unsafe { SetWindowSubclass(hwnd, Some(message), 0, data) }.as_bool() {
                    unsafe {
                        drop(Box::from_raw(data as *mut Connection));
                    }
                    return Err("Overlay fullscreen message registration failed".into());
                }
            }
            let connection = unsafe { &mut *(data as *mut Connection) };
            connection
                .lifetime
                .configure(&mut connection.boundary, wanted, above)?;
            Ok(wanted && !connection.lifetime.fullscreen)
        };
        // HWND thread affinity is the authority; direct execution avoids waiting
        // on our own GUI thread when a lifecycle caller already runs there.
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetCurrentThreadId() -> u32;
        }
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        if unsafe {
            windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(hwnd, None)
                == GetCurrentThreadId()
        } {
            return task();
        }
        let (tx, rx) = std::sync::mpsc::channel();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(task());
            })
            .map_err(|error| error.to_string())?;
        rx.recv()
            .map_err(|_| "Overlay fullscreen policy did not return".to_string())?
    }
}

#[cfg(target_os = "windows")]
pub(super) use native::configure;

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Native {
        registrations: usize,
        removals: usize,
        visibility: Vec<bool>,
    }
    impl AppBar for Native {
        fn register(&mut self) -> Result<(), String> {
            self.registrations += 1;
            Ok(())
        }
        fn unregister(&mut self) {
            self.removals += 1;
        }
        fn visible(&mut self, visible: bool) {
            self.visibility.push(visible);
        }
    }

    #[test]
    fn fullscreen_notice_lifetime_is_visible_off_only_and_has_no_idle_work() {
        let mut lifetime = Lifetime::default();
        let mut native = Native::default();
        lifetime.configure(&mut native, true, false).unwrap();
        for _ in 0..1000 {
            lifetime.configure(&mut native, true, false).unwrap();
        }
        assert_eq!(native.registrations, 1);
        assert!(native.visibility.is_empty());
        for fullscreen in [true, true, false, false] {
            lifetime.notice(&mut native, fullscreen);
        }
        assert_eq!(native.visibility, [false, true]);
        lifetime.notice(&mut native, true);
        lifetime.configure(&mut native, true, true).unwrap();
        assert_eq!(native.removals, 1);
        assert_eq!(native.visibility, [false, true, false, true]);
        lifetime.notice(&mut native, true);
        lifetime.configure(&mut native, false, false).unwrap();
        lifetime.close(&mut native);
        assert_eq!(native.removals, 1);
        lifetime.configure(&mut native, true, false).unwrap();
        lifetime.close(&mut native);
        lifetime.close(&mut native);
        assert_eq!(native.registrations, 2);
        assert_eq!(native.removals, 2);
    }
}
