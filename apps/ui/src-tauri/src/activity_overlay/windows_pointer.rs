//! DOM shape enter starts the single process-wide raw mouse sink. Native input observes leave.
use super::pointer::{raw_input::RawInputSink, Sample, Tracker};
use std::{cell::RefCell, collections::HashMap, ffi::c_void, sync::Arc};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    UI::{
        Shell::{DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GetAncestor, GetCursorPos, GetWindowRect, GetWindowThreadProcessId, PostMessageW, WindowFromPoint, GA_ROOT, WM_APP, WM_INPUT,
            WM_NCDESTROY,
        },
    },
};

#[repr(C)]
struct RawInputDevice {
    usage_page: u16,
    usage: u16,
    flags: u32,
    target: *mut c_void,
}
#[link(name = "user32")]
unsafe extern "system" {
    fn RegisterRawInputDevices(devices: *const RawInputDevice, count: u32, size: u32) -> i32;
    fn GetRawInputData(input: *mut c_void, command: u32, data: *mut c_void, size: *mut u32, header_size: u32) -> u32;
}
#[repr(C)]
#[derive(Default)]
struct RawInputHeader { kind: u32, size: u32, device: usize, wparam: usize }
#[repr(C)]
#[derive(Default)]
struct RawMouse { flags: u16, padding: u16, button_flags: u16, button_data: u16, raw_buttons: u32, x: i32, y: i32, extra: u32 }
#[repr(C)]
#[derive(Default)]
struct RawMouseInput { header: RawInputHeader, mouse: RawMouse }

fn is_button_press(lparam: LPARAM) -> bool {
    let mut input = RawMouseInput::default();
    let mut size = std::mem::size_of::<RawMouseInput>() as u32;
    let read = unsafe { GetRawInputData(lparam.0 as *mut c_void, 0x10000003, (&mut input as *mut RawMouseInput).cast(), &mut size, std::mem::size_of::<RawInputHeader>() as u32) };
    read == size && input.header.kind == 0 && input.mouse.button_flags & (0x0001 | 0x0004 | 0x0010 | 0x0040 | 0x0100) != 0
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentThreadId() -> u32;
}

struct Connection {
    hwnd: isize,
    tracker: Arc<Tracker>,
    scale: f64,
    outside_press: bool,
}
#[derive(Default)]
struct Connections {
    windows: HashMap<String, Connection>,
    sink: RawInputSink,
    sample_pending: bool,
    press_pending: bool,
}
thread_local! { static CONNECTIONS: RefCell<Connections> = RefCell::new(Connections::default()); }

fn register(target: Option<isize>) -> Result<(), String> {
    let device = RawInputDevice {
        usage_page: 1,
        usage: 2,
        flags: if target.is_some() { 0x100 } else { 1 },
        target: target.map_or(std::ptr::null_mut(), |hwnd| hwnd as *mut c_void),
    };
    if unsafe { RegisterRawInputDevices(&device, 1, std::mem::size_of::<RawInputDevice>() as u32) }
        == 0
    {
        return Err(format!(
            "Overlay raw mouse registration failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

const WM_POINTER_SAMPLE: u32 = WM_APP + 0x45;

fn sample(connection: &Connection) -> Option<bool> {
    let mut point = POINT::default();
    let mut frame = RECT::default();
    if unsafe { GetCursorPos(&mut point) }.is_err()
        || unsafe { GetWindowRect(HWND(connection.hwnd as *mut c_void), &mut frame) }.is_err()
    {
        return None;
    }
    let inside = point.x >= frame.left
        && point.x < frame.right
        && point.y >= frame.top
        && point.y < frame.bottom;
    connection.tracker.observe(Sample {
        inside,
        x: if inside {
            f64::from(point.x - frame.left) / connection.scale
        } else {
            0.0
        },
        y: if inside {
            f64::from(point.y - frame.top) / connection.scale
        } else {
            0.0
        },
    });
    Some(inside)
}

unsafe extern "system" fn pointer_message(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    subclass: usize,
    _: usize,
) -> LRESULT {
    if message == WM_INPUT {
        let pressed = is_button_press(lparam);
        let post = CONNECTIONS.with(|connections| {
            let mut connections = connections.borrow_mut();
            connections.press_pending |= pressed;
            if connections.sample_pending {
                return false;
            }
            connections.sample_pending = true;
            true
        });
        if post {
            if let Err(error) =
                unsafe { PostMessageW(Some(hwnd), WM_POINTER_SAMPLE, WPARAM(0), LPARAM(0)) }
            {
                CONNECTIONS.with(|connections| connections.borrow_mut().sample_pending = false);
                log::warn!("Overlay pointer sample scheduling failed: {error}");
            }
        }
    } else if message == WM_POINTER_SAMPLE {
        CONNECTIONS.with(|connections| {
            let mut connections = connections.borrow_mut();
            connections.sample_pending = false;
            let pressed = std::mem::take(&mut connections.press_pending);
            let mut point = POINT::default();
            let press_window = if pressed && unsafe { GetCursorPos(&mut point) }.is_ok() {
                unsafe { GetAncestor(WindowFromPoint(point), GA_ROOT) }.0 as isize
            } else { 0 };
            let Connections { windows, sink, .. } = &mut *connections;
            for connection in windows.values() {
                if !sink.is_engaged(connection.hwnd) {
                    continue;
                }
                if let Some(inside) = sample(connection) {
                    if pressed && connection.outside_press && (!inside || press_window != connection.hwnd) {
                        connection.tracker.outside_press();
                    }
                    if let Err(error) = sink.observe(connection.hwnd, inside, register) {
                        log::warn!("{error}");
                    }
                }
            }
        });
    } else if message == WM_NCDESTROY {
        unsafe {
            RemoveWindowSubclass(hwnd, Some(pointer_message), subclass);
        }
        CONNECTIONS.with(|connections| {
            let mut connections = connections.borrow_mut();
            connections
                .windows
                .retain(|_, connection| connection.hwnd != hwnd.0 as isize);
            connections.sample_pending = false;
            if let Err(error) = connections
                .sink
                .set_engaged(hwnd.0 as isize, false, register)
            {
                log::warn!("{error}");
            }
            if let Err(error) = connections.sink.set_outside_press(hwnd.0 as isize, false, register) { log::warn!("{error}"); }
        });
    }
    // DefSubclassProc lets DefWindowProc release the raw input message resources.
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

pub(super) fn on_window_thread<R: Runtime, T: Send + 'static>(
    window: &WebviewWindow<R>,
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    if unsafe { GetWindowThreadProcessId(hwnd, None) } == unsafe { GetCurrentThreadId() } {
        return task();
    }
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(task());
        })
        .map_err(|error| error.to_string())?;
    rx.recv()
        .map_err(|_| "Overlay raw mouse registration did not return".to_string())?
}

pub(super) fn install<R: Runtime>(
    window: &WebviewWindow<R>,
    tracker: Arc<Tracker>,
) -> Result<(), String> {
    let native_window = window.clone();
    on_window_thread(window, move || {
        let hwnd = native_window.hwnd().map_err(|error| error.to_string())?;
        if unsafe { GetWindowSubclass(hwnd, Some(pointer_message), 0, None) }.as_bool() {
            return Ok(());
        }
        let scale = native_window
            .scale_factor()
            .map_err(|error| error.to_string())?;
        if !unsafe { SetWindowSubclass(hwnd, Some(pointer_message), 0, 0) }.as_bool() {
            return Err("Overlay pointer message registration failed".to_string());
        }
        CONNECTIONS.with(|connections| {
            connections.borrow_mut().windows.insert(
                native_window.label().to_owned(),
                Connection {
                    hwnd: hwnd.0 as isize,
                    tracker,
                    scale,
                    outside_press: false,
                },
            );
            Ok(())
        })
    })
}

pub(super) fn set_engaged<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    engaged: bool,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(label) else {
        return Ok(());
    };
    let label = label.to_owned();
    on_window_thread(&window, move || {
        CONNECTIONS.with(|connections| {
            let mut connections = connections.borrow_mut();
            if let Some(connection) = connections.windows.get(&label) {
                let hwnd = connection.hwnd;
                return connections.sink.set_engaged(hwnd, engaged, register);
            }
            Ok(())
        })
    })
}

pub(super) fn set_outside_press<R: Runtime>(app: &AppHandle<R>, label: &str, wanted: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window(label) else { return Ok(()); };
    let label = label.to_owned();
    on_window_thread(&window, move || CONNECTIONS.with(|connections| {
        let mut connections = connections.borrow_mut();
        let Some(connection) = connections.windows.get(&label) else { return Ok(()); };
        let hwnd = connection.hwnd;
        connections.sink.set_outside_press(hwnd, wanted, register)?;
        if let Some(connection) = connections.windows.get_mut(&label) { connection.outside_press = wanted; }
        Ok(())
    }))
}

pub(super) fn geometry_changed<R: Runtime>(
    window: &WebviewWindow<R>,
    _: Arc<Tracker>,
) -> Result<(), String> {
    let native_window = window.clone();
    on_window_thread(window, move || {
        CONNECTIONS.with(|connections| {
            let mut connections = connections.borrow_mut();
            if let Some(connection) = connections.windows.get_mut(native_window.label()) {
                connection.scale = native_window
                    .scale_factor()
                    .map_err(|error| error.to_string())?;
                if let Some(inside) = sample(connection) {
                    let hwnd = connection.hwnd;
                    if connection.tracker.position_events || !inside {
                        return connections.sink.set_engaged(hwnd, inside, register);
                    }
                }
            }
            Ok(())
        })
    })
}

pub(super) fn remove(label: &str) {
    CONNECTIONS.with(|connections| {
        let mut connections = connections.borrow_mut();
        if let Some(connection) = connections.windows.remove(label) {
            if let Err(error) = connections.sink.set_outside_press(connection.hwnd, false, register) { log::warn!("{error}"); }
            if let Err(error) = connections
                .sink
                .set_engaged(connection.hwnd, false, register)
            {
                log::warn!("{error}");
            }
        }
    });
}
