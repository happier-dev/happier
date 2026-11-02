//! Chain the host Xlib handler; suppress only this selected drawable's closure.
use super::*;
use std::{cell::Cell, sync::{Mutex, atomic::{AtomicU64, AtomicU8, Ordering}}};
use ::x11::xlib::{self, Display, XErrorEvent};
type Handler = Option<unsafe extern "C" fn(*mut Display, *mut XErrorEvent) -> std::os::raw::c_int>;

// The shared recorder admits one active capture. This is its native callback
// context, not a second capture registry or per-frame window admission check.
static SELECTED: AtomicU64 = AtomicU64::new(0);
static DAMAGE_REQUEST: AtomicU8 = AtomicU8::new(0);
static DAMAGE_ERROR: AtomicU8 = AtomicU8::new(0);
static PREVIOUS: Mutex<Handler> = Mutex::new(None);
thread_local! { static TEARDOWN: Cell<bool> = const { Cell::new(false) }; }

pub(in crate::capture::recording::linux) fn teardown<T>(operation: impl FnOnce() -> T) -> T {
    struct Reset(bool);
    impl Drop for Reset { fn drop(&mut self) { TEARDOWN.set(self.0); } }
    let _reset = Reset(TEARDOWN.replace(true)); operation()
}

unsafe extern "C" fn handler(display: *mut Display, event: *mut XErrorEvent) -> std::os::raw::c_int {
    // SAFETY: Xlib supplies a live event for the duration of this ABI callback.
    let error = unsafe { &*event };
    let selected = SELECTED.load(Ordering::Acquire);
    if selected != 0 && error.error_code == xlib::BadWindow && error.resourceid == selected { return 0; }
    let teardown = TEARDOWN.try_with(Cell::get).unwrap_or(false);
    if selected != 0 && teardown && error.error_code == DAMAGE_ERROR.load(Ordering::Acquire)
        && error.request_code == DAMAGE_REQUEST.load(Ordering::Acquire) && error.minor_code == 2 { return 0; }
    // Installation holds this slot until Xlib's returned previous callback is
    // published. Copy it and release the lock before invoking the host handler.
    let previous = *PREVIOUS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // None is only the never-installed initial state: Xlib returns a non-null
    // default callback, published before an installed upcall can acquire the lock.
    // SAFETY: The supplied callback has the identical Xlib binding ABI.
    previous.map_or(1, |previous| unsafe { previous(display, event) })
}

fn address(handler: Handler) -> *mut () { handler.map_or(std::ptr::null_mut(), |handler| handler as *mut ()) }

pub(in crate::capture::recording::linux) struct ErrorTrap { previous: Handler }
impl ErrorTrap {
    pub(in crate::capture::recording::linux) fn install(connection: &RustConnection, id: u32) -> Result<Self, CaptureError> {
        let damage = connection.query_extension(b"DAMAGE").map_err(|_| CaptureError::NativeFailure)?.reply().map_err(|_| CaptureError::NativeFailure)?;
        debug_assert_eq!(SELECTED.load(Ordering::Acquire), 0, "the shared recorder owns single capture admission");
        SELECTED.store(u64::from(id), Ordering::Release);
        DAMAGE_REQUEST.store(damage.major_opcode, Ordering::Release); DAMAGE_ERROR.store(damage.first_error, Ordering::Release);
        // Xlib's error upcall holds no global Xlib mutex (XlibInt.c::_XError),
        // so the publication slot cannot invert XSetErrorHandler's lock order.
        let mut published = PREVIOUS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // SAFETY: Xlib owns the process callback pointer. The function has the
        // exact binding ABI and cannot unwind through the C boundary.
        let previous = unsafe { xlib::XSetErrorHandler(Some(handler)) };
        *published = previous;
        Ok(Self { previous })
    }
}
impl Drop for ErrorTrap {
    fn drop(&mut self) {
        // Xlib exposes exchange, not compare-and-swap. Preserve an ordinary
        // handler installed later by GTK; concurrent handler mutation is not an
        // Xlib-supported restoration guarantee.
        unsafe {
            let observed = xlib::XSetErrorHandler(Some(handler));
            xlib::XSetErrorHandler(if address(observed) == address(Some(handler)) { self.previous } else { observed });
        }
        SELECTED.store(0, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    static FORWARDED: AtomicUsize = AtomicUsize::new(0);
    unsafe extern "C" fn previous(_: *mut Display, _: *mut XErrorEvent) -> i32 { FORWARDED.fetch_add(1, Ordering::SeqCst); 0 }
    unsafe extern "C" fn later(_: *mut Display, _: *mut XErrorEvent) -> i32 { 0 }

    #[test]
    #[ignore = "requires serial Xvfb: xvfb-run -a cargo test --lib xlib_errors -- --ignored --test-threads=1"]
    fn xlib_errors_chain_unrelated_windows_and_preserve_later_handlers() {
        let (connection, screen) = x11rb::connect(None).unwrap(); let root = connection.setup().roots[screen].root;
        let selected = connection.generate_id().unwrap(); let unrelated = connection.generate_id().unwrap();
        for id in [selected, unrelated] {
            connection.create_window(0, id, root, 0, 0, 8, 8, 0, x11rb::protocol::xproto::WindowClass::INPUT_OUTPUT, 0,
                &x11rb::protocol::xproto::CreateWindowAux::new()).unwrap().check().unwrap();
            connection.destroy_window(id).unwrap().check().unwrap();
        }
        FORWARDED.store(0, Ordering::SeqCst);
        unsafe {
            let original = xlib::XSetErrorHandler(Some(previous));
            let display = xlib::XOpenDisplay(std::ptr::null()); assert!(!display.is_null());
            let trap = ErrorTrap::install(&connection, selected).unwrap();
            let mut attributes = std::mem::MaybeUninit::uninit();
            assert_eq!(xlib::XGetWindowAttributes(display, selected.into(), attributes.as_mut_ptr()), 0);
            assert_eq!(FORWARDED.load(Ordering::SeqCst), 0, "selected closed drawable escaped the capture trap");
            assert_eq!(xlib::XGetWindowAttributes(display, unrelated.into(), attributes.as_mut_ptr()), 0);
            assert_eq!(FORWARDED.load(Ordering::SeqCst), 1, "unrelated Xlib errors must reach the host handler");
            drop(trap);
            assert_eq!(address(xlib::XSetErrorHandler(Some(previous))), address(Some(previous)));
            let trap = ErrorTrap::install(&connection, selected).unwrap();
            xlib::XSetErrorHandler(Some(later)); drop(trap);
            assert_eq!(address(xlib::XSetErrorHandler(original)), address(Some(later)), "capture cleanup replaced a later host handler");
            xlib::XCloseDisplay(display);
        }
    }
}
