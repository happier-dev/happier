//! The latest working application, independent of the capture program's own panels.
use std::sync::atomic::{AtomicU32, Ordering};

#[derive(Default)]
struct RecentApplication(AtomicU32);

impl RecentApplication {
    fn observe(&self, pid: u32, own_pid: u32) {
        if pid != 0 && pid != own_pid { self.0.store(pid, Ordering::Relaxed); }
    }

    fn resolve(&self, current: u32, own_pid: u32) -> Option<u32> {
        self.observe(current, own_pid);
        let pid = self.0.load(Ordering::Relaxed);
        (pid != 0).then_some(pid)
    }
}

static RECENT: RecentApplication = RecentApplication(AtomicU32::new(0));
static OBSERVING: std::sync::Once = std::sync::Once::new();

fn workspace() -> *mut objc2::runtime::AnyObject {
    let class = objc2::runtime::AnyClass::get(c"NSWorkspace").expect("AppKit workspace");
    unsafe { objc2::msg_send![class, sharedWorkspace] }
}

fn current_process_id() -> u32 {
    unsafe {
        let app: *mut objc2::runtime::AnyObject = objc2::msg_send![workspace(), frontmostApplication];
        if app.is_null() { return 0; }
        let pid: i32 = objc2::msg_send![app, processIdentifier];
        pid as u32
    }
}

/// Subscribe before the shell can activate. Panels must not replace the last working app.
pub(super) fn initialize() {
    OBSERVING.call_once(|| unsafe {
        let center: *mut objc2::runtime::AnyObject = objc2::msg_send![workspace(), notificationCenter];
        let block = block2::RcBlock::new(|notification: *mut objc2::runtime::AnyObject| {
            let info: *mut objc2::runtime::AnyObject = objc2::msg_send![notification, userInfo];
            let app: *mut objc2::runtime::AnyObject = objc2::msg_send![info,
                objectForKey: &*objc2_foundation::NSString::from_str("NSWorkspaceApplicationKey")];
            if !app.is_null() {
                let pid: i32 = objc2::msg_send![app, processIdentifier];
                RECENT.observe(pid as u32, std::process::id());
            }
        });
        // NSNotificationCenter retains the observer and copied block for the process lifetime.
        let _: *mut objc2::runtime::AnyObject = objc2::msg_send![center,
            addObserverForName: &*objc2_foundation::NSString::from_str("NSWorkspaceDidActivateApplicationNotification"),
            object: std::ptr::null::<objc2::runtime::AnyObject>(),
            queue: std::ptr::null::<objc2::runtime::AnyObject>(), usingBlock: &*block];
        RECENT.observe(current_process_id(), std::process::id());
    });
}

pub(super) fn process_id() -> Option<u32> {
    initialize();
    RECENT.resolve(current_process_id(), std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_panels_leave_the_most_recent_working_application_as_the_capture_target() {
        let recent = RecentApplication::default();
        recent.observe(42, 100);
        recent.observe(100, 100);
        assert_eq!(recent.resolve(100, 100), Some(42));
        recent.observe(55, 100);
        recent.observe(100, 100);
        assert_eq!(recent.resolve(100, 100), Some(55));
        assert_eq!(recent.resolve(77, 100), Some(77));
        assert_eq!(RecentApplication::default().resolve(100, 100), None);
    }

    #[test]
    fn native_workspace_activation_notification_updates_the_same_frontmost_owner() {
        initialize();
        unsafe {
            let working: *mut objc2::runtime::AnyObject = objc2::msg_send![workspace(), frontmostApplication];
            assert!(!working.is_null(), "this AppKit test needs a logged-in desktop");
            let pid: i32 = objc2::msg_send![working, processIdentifier];
            assert_ne!(pid as u32, std::process::id());
            RECENT.0.store(0, Ordering::Relaxed);
            let dictionary = objc2::runtime::AnyClass::get(c"NSDictionary").unwrap();
            let info: *mut objc2::runtime::AnyObject = objc2::msg_send![dictionary,
                dictionaryWithObject: working, forKey: &*objc2_foundation::NSString::from_str("NSWorkspaceApplicationKey")];
            let center: *mut objc2::runtime::AnyObject = objc2::msg_send![workspace(), notificationCenter];
            let _: () = objc2::msg_send![center,
                postNotificationName: &*objc2_foundation::NSString::from_str("NSWorkspaceDidActivateApplicationNotification"),
                object: std::ptr::null::<objc2::runtime::AnyObject>(), userInfo: info];
            assert_eq!(RECENT.resolve(std::process::id(), std::process::id()), Some(pid as u32));
        }
    }
}
