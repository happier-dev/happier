//! Route AppKit's native Quit request into the existing desktop shutdown owner.
use block2::RcBlock;
use objc2::{Encode, MainThreadMarker, msg_send, sel, rc::Retained, runtime::{AnyClass, AnyObject}};
use objc2_app_kit::NSApplication;
use objc2_foundation::NSOperationQueue;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub(super) enum NativeTermination { #[default] Idle, Pending, ReplyQueued }

impl NativeTermination {
    fn request(&mut self) { if matches!(self, Self::Idle) { *self = Self::Pending; } }
    fn queue_reply(&mut self) -> bool {
        if !matches!(self, Self::Pending) { return false; }
        *self = Self::ReplyQueued;
        true
    }
}

fn install_termination_handler(delegate: &AnyObject, on_quit: impl Fn() + Send + Sync + 'static,
    has_system_quit_reason: impl Fn() -> bool + Send + Sync + 'static) -> bool {
    let block = RcBlock::new(move |_delegate: *mut AnyObject, _sender: *mut AnyObject| -> usize {
        // AERegistry.h defines this optional attribute only for quit-all, shutdown, restart or
        // logout. Preserve their native path: the login-start preference must not cancel logout.
        if has_system_quit_reason() { return 1; } // NSTerminateNow
        on_quit();
        2 // NSTerminateLater: the person quit; the existing owner will answer.
    });
    let encoding = std::ffi::CString::new(format!("{}@:@", usize::ENCODING)).unwrap();
    // SAFETY: The block's ABI is (receiver, sender)->NSUInteger; the Objective-C IMP supplies
    // its selector itself. AppKit declares this exact signature for applicationShouldTerminate:.
    // libobjc copies the block, keeping the existing app handle alive for the delegate lifetime.
    unsafe {
        let implementation = objc2::ffi::imp_implementationWithBlock(RcBlock::as_ptr(&block).cast());
        let installed = objc2::ffi::class_addMethod(delegate.class() as *const AnyClass as *mut AnyClass,
            sel!(applicationShouldTerminate:), implementation, encoding.as_ptr()).as_bool();
        if !installed { objc2::ffi::imp_removeBlock(implementation); }
        installed
    }
}

fn current_event_has_system_quit_reason() -> bool {
    let class = AnyClass::get(c"NSAppleEventManager").expect("Foundation supplies NSAppleEventManager");
    // SAFETY: These are Foundation's declared Objective-C selectors. The optional keyAEQuitReason
    // attribute ('why?') is the OS producer's system-termination fact; no contents are disclosed.
    unsafe {
        let manager: Retained<AnyObject> = msg_send![class, sharedAppleEventManager];
        let event: Option<Retained<AnyObject>> = msg_send![&manager, currentAppleEvent];
        event.is_some_and(|event| {
            let reason: Option<Retained<AnyObject>> = msg_send![&event,
                attributeDescriptorForKeyword: u32::from_be_bytes(*b"why?")];
            reason.is_some()
        })
    }
}

pub(crate) fn install(app: &AppHandle) {
    let application = NSApplication::sharedApplication(MainThreadMarker::new().expect("desktop setup is on the main thread"));
    // SAFETY: NSApplication's delegate is an Objective-C object retained for this installation.
    let delegate: Option<Retained<AnyObject>> = unsafe { msg_send![&application, delegate] };
    let delegate = delegate.expect("Tauri installs its AppKit delegate before desktop setup");
    let handle = app.clone();
    assert!(install_termination_handler(&delegate, move || {
        handle.state::<super::DesktopShutdownState>().native_termination.lock().unwrap().request();
        super::request_quit(&handle, super::QuitIntent::Quit);
    }, current_event_has_system_quit_reason), "the pinned Tauri delegate must leave applicationShouldTerminate: to the desktop lifecycle owner");
}

/// Reply only after the existing Quit owner settles. A pending AppKit termination keeps the
/// runtime alive until this response, including a cancelled Quit that keeps menu-bar mode.
pub(super) fn reply(app: &AppHandle, terminate: bool) -> bool {
    let state = app.state::<super::DesktopShutdownState>();
    {
        let mut pending = state.native_termination.lock().unwrap();
        if matches!(*pending, NativeTermination::Idle) { return false; }
        if !pending.queue_reply() { return true; }
    }
    let handle = app.clone();
    // A Tauri main-thread task is still inside Tao's event callback. AppKit termination must run
    // from the native queue instead, after Tao releases its borrowed callback (AppState::exit).
    let reply = RcBlock::new(move || {
        if !terminate {
            *handle.state::<super::DesktopShutdownState>().native_termination.lock().unwrap() = NativeTermination::Idle;
        }
        let application = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
        application.replyToApplicationShouldTerminate(terminate);
    });
    // SAFETY: NSOperationQueue copies the block and runs it asynchronously on the main queue.
    unsafe { NSOperationQueue::mainQueue().addOperationWithBlock(&reply); }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}};
    use objc2::{ClassType, runtime::ClassBuilder};
    use objc2_foundation::NSObject;

    #[test]
    fn native_termination_reaches_the_quit_handler_before_appkit_can_exit() {
        let class = ClassBuilder::new(c"HappierQuitAdapterTestDelegate", NSObject::class()).unwrap().register();
        let delegate: Retained<AnyObject> = unsafe { msg_send![class, new] };
        let requests = Arc::new(AtomicUsize::new(0));
        let received = requests.clone();
        // Only the current OS Apple-event attribute is substituted; Objective-C dispatch is real.
        let system_quit = Arc::new(AtomicBool::new(false));
        let event = system_quit.clone();
        assert!(install_termination_handler(&delegate,
            move || { received.fetch_add(1, Ordering::SeqCst); }, move || event.load(Ordering::SeqCst)));
        assert!(delegate.class().instance_method(sel!(applicationShouldTerminate:)).is_some());
        let reply: usize = unsafe { msg_send![&delegate, applicationShouldTerminate: &*delegate] };
        assert_eq!(reply, 2); // Defer native termination until the existing owner replies.
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        system_quit.store(true, Ordering::SeqCst);
        let reply: usize = unsafe { msg_send![&delegate, applicationShouldTerminate: &*delegate] };
        assert_eq!(reply, 1); // A system-ending event follows its incumbent native path.
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }
}
