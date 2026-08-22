//! macOS window configuration driven by a raw content-view handle.
//!
//! Electron drives `canBecomeKeyWindow` and `canBecomeMainWindow` from a single
//! `focusable` boolean, exposes no `Stationary` / `IgnoresCycle` collection
//! behaviour, no arbitrary integer window level and no `hidesOnDeactivate`.
//! Happier's overlay needs `canBecomeKeyWindow == true` together with
//! `canBecomeMainWindow == false`, which no shell-level flag can express.
//!
//! The split is installed by allocating a subclass of the window's *live* class
//! with zero extra instance bytes and isa-swizzling the instance into it. The
//! zero-extra-bytes constraint is what makes the swizzle sound: instance size is
//! unchanged, so the shell's own ivars and AppKit hooks stay exactly where the
//! window expects them. Re-classing an Electron window into an unrelated
//! `NSPanel` subclass (the technique `tauri-nspanel` uses on a Tauri window)
//! would instead orphan Chromium's ivars, and is deliberately not done here.

use std::ffi::CString;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::{sel, ClassType};
use objc2_app_kit::{NSPanel, NSView, NSWindow, NSWindowCollectionBehavior};

use crate::handle::decode_view_address;

/// Prefix of the runtime-allocated subclass that carries the key/main split.
const SPLIT_CLASS_PREFIX: &str = "HappierDesktopKeyMainSplit_";

/// Read-back of the window state this crate can influence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowFacts {
    pub view_class: String,
    pub window_class: String,
    pub level: i64,
    pub collection_behavior: u64,
    pub style_mask: u64,
    pub is_panel: bool,
    pub opaque: bool,
    pub has_shadow: bool,
    pub hides_on_deactivate: bool,
    pub can_become_key_window: bool,
    pub can_become_main_window: bool,
    pub has_key_main_split: bool,
}

/// Requested window configuration. Every field is optional; `None` leaves the
/// current value untouched so a caller can drive one property without having to
/// restate the rest.
#[derive(Debug, Clone, Copy, Default)]
pub struct WindowConfiguration {
    pub can_join_all_spaces: Option<bool>,
    pub full_screen_auxiliary: Option<bool>,
    pub stationary: Option<bool>,
    pub ignores_cycle: Option<bool>,
    pub level: Option<i64>,
    pub hides_on_deactivate: Option<bool>,
    pub split_key_and_main: Option<bool>,
}

extern "C" fn imp_can_become_key_window(_this: &AnyObject, _cmd: Sel) -> Bool {
    Bool::YES
}

extern "C" fn imp_can_become_main_window(_this: &AnyObject, _cmd: Sel) -> Bool {
    Bool::NO
}

fn class_name(class: &AnyClass) -> String {
    class.name().to_string_lossy().into_owned()
}

fn is_kind_of(class: &AnyClass, ancestor: &AnyClass) -> bool {
    let mut candidate = Some(class);
    while let Some(current) = candidate {
        if core::ptr::eq(current, ancestor) {
            return true;
        }
        candidate = current.superclass();
    }
    false
}

fn as_any_object(window: &NSWindow) -> &AnyObject {
    let ptr: *const NSWindow = window;
    // SAFETY: every Objective-C object pointer is a valid `AnyObject` pointer.
    unsafe { &*ptr.cast::<AnyObject>() }
}

/// Resolve the `NSWindow` that owns the content view a shell handed us.
///
/// # Safety
///
/// `bytes` must carry a live `NSView *` owned by the calling shell, and this must
/// run on the main thread. Shape errors (short buffer, null, misaligned) and a
/// pointer that is not an `NSView` are rejected as typed errors rather than
/// dereferenced; a pointer that is well-formed but stale cannot be detected and
/// remains the caller's contract.
unsafe fn window_from_handle(bytes: &[u8]) -> Result<(String, Retained<NSWindow>), String> {
    let address = decode_view_address(bytes).map_err(|error| error.message())?;

    let object: &AnyObject = unsafe { &*address.as_ptr().cast::<AnyObject>() };
    let object_class = object.class();
    if !is_kind_of(object_class, NSView::class()) {
        return Err(format!(
            "native window handle points at a {}, which is not an NSView",
            class_name(object_class)
        ));
    }

    let view: Retained<NSView> = unsafe { Retained::retain(address.as_ptr().cast::<NSView>()) }
        .ok_or_else(|| "native window handle could not be retained".to_owned())?;
    let window = view
        .window()
        .ok_or_else(|| "the content view is not attached to an NSWindow".to_owned())?;

    Ok((class_name(object_class), window))
}

/// Install (or reuse) the runtime subclass that reports `canBecomeKeyWindow` and
/// withholds `canBecomeMainWindow`.
fn apply_key_main_split(window: &NSWindow) -> Result<(), String> {
    let object = as_any_object(window);
    let current = object.class();
    let current_name = class_name(current);
    if current_name.starts_with(SPLIT_CLASS_PREFIX) {
        return Ok(());
    }

    let subclass_name = format!("{SPLIT_CLASS_PREFIX}{current_name}");
    let c_name = CString::new(subclass_name.as_str())
        .map_err(|_| format!("window class name {current_name} is not representable"))?;

    let subclass: &'static AnyClass = match AnyClass::get(c_name.as_c_str()) {
        Some(existing) => existing,
        None => {
            // `ClassBuilder::new` is `objc_allocateClassPair(current, name, 0)`:
            // zero extra instance bytes, so instance size is preserved.
            let mut builder = ClassBuilder::new(c_name.as_c_str(), current).ok_or_else(|| {
                format!("failed to allocate the Objective-C class pair {subclass_name}")
            })?;
            // SAFETY: both selectors are declared by NSWindow as `- (BOOL)`, which
            // matches these implementations' signatures.
            unsafe {
                builder.add_method(
                    sel!(canBecomeKeyWindow),
                    imp_can_become_key_window as extern "C" fn(_, _) -> _,
                );
                builder.add_method(
                    sel!(canBecomeMainWindow),
                    imp_can_become_main_window as extern "C" fn(_, _) -> _,
                );
            }
            builder.register()
        }
    };

    if subclass.instance_size() != current.instance_size() {
        return Err(format!(
            "refusing to re-class {current_name}: instance size {} does not match subclass size {}",
            current.instance_size(),
            subclass.instance_size()
        ));
    }

    // SAFETY: `subclass` is a direct subclass of the window's live class, adds no
    // ivars, and overrides two methods with matching signatures.
    let _previous = unsafe { AnyObject::set_class(object, subclass) };

    if !core::ptr::eq(object.class(), subclass) {
        return Err(format!(
            "re-classing {current_name} did not take effect; window is still a {}",
            class_name(object.class())
        ));
    }
    Ok(())
}

fn toggle(
    behavior: NSWindowCollectionBehavior,
    flag: NSWindowCollectionBehavior,
    requested: Option<bool>,
) -> NSWindowCollectionBehavior {
    match requested {
        Some(true) => behavior | flag,
        Some(false) => behavior & !flag,
        None => behavior,
    }
}

fn read_facts(view_class: String, window: &NSWindow) -> WindowFacts {
    let object = as_any_object(window);
    let window_class = class_name(object.class());
    // SAFETY: read-only AppKit accessors on a live window, on the main thread.
    unsafe {
        WindowFacts {
            has_key_main_split: window_class.starts_with(SPLIT_CLASS_PREFIX),
            view_class,
            window_class,
            level: window.level() as i64,
            collection_behavior: window.collectionBehavior().0 as u64,
            style_mask: window.styleMask().0 as u64,
            is_panel: is_kind_of(object.class(), NSPanel::class()),
            opaque: window.isOpaque(),
            has_shadow: window.hasShadow(),
            hides_on_deactivate: window.hidesOnDeactivate(),
            can_become_key_window: window.canBecomeKeyWindow(),
            can_become_main_window: window.canBecomeMainWindow(),
        }
    }
}

/// Read the current window state without changing it.
///
/// # Safety
///
/// See [`window_from_handle`].
pub unsafe fn inspect(bytes: &[u8]) -> Result<WindowFacts, String> {
    let (view_class, window) = unsafe { window_from_handle(bytes)? };
    Ok(read_facts(view_class, &window))
}

/// Apply `configuration` and return the resulting state.
///
/// # Safety
///
/// See [`window_from_handle`].
pub unsafe fn configure(
    bytes: &[u8],
    configuration: &WindowConfiguration,
) -> Result<WindowFacts, String> {
    let (view_class, window) = unsafe { window_from_handle(bytes)? };

    // SAFETY: mutating AppKit accessors on a live window, on the main thread.
    unsafe {
        let mut behavior = window.collectionBehavior();
        behavior = toggle(
            behavior,
            NSWindowCollectionBehavior::CanJoinAllSpaces,
            configuration.can_join_all_spaces,
        );
        behavior = toggle(
            behavior,
            NSWindowCollectionBehavior::FullScreenAuxiliary,
            configuration.full_screen_auxiliary,
        );
        behavior = toggle(
            behavior,
            NSWindowCollectionBehavior::Stationary,
            configuration.stationary,
        );
        behavior = toggle(
            behavior,
            NSWindowCollectionBehavior::IgnoresCycle,
            configuration.ignores_cycle,
        );
        window.setCollectionBehavior(behavior);

        if let Some(hides_on_deactivate) = configuration.hides_on_deactivate {
            window.setHidesOnDeactivate(hides_on_deactivate);
        }
    }

    if let Some(level) = configuration.level {
        let level = isize::try_from(level)
            .map_err(|_| format!("window level {level} is out of range for NSWindowLevel"))?;
        window.setLevel(level);
    }

    if configuration.split_key_and_main == Some(true) {
        apply_key_main_split(&window)?;
    }

    Ok(read_facts(view_class, &window))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_handle_is_rejected_before_any_dereference() {
        // SAFETY: the buffer is deliberately invalid; the guard must reject it
        // without constructing a pointer.
        let error = unsafe { inspect(&[0u8; 3]) }.expect_err("short handle must be rejected");
        assert!(error.contains("at least"), "unexpected error: {error}");
    }

    #[test]
    fn a_null_handle_is_rejected_before_any_dereference() {
        // SAFETY: as above.
        let error = unsafe { inspect(&[0u8; 8]) }.expect_err("null handle must be rejected");
        assert!(error.contains("null"), "unexpected error: {error}");
    }

    #[test]
    fn a_misaligned_handle_is_rejected_before_any_dereference() {
        let address: usize = 0x0000_6000_0123_4561;
        // SAFETY: as above.
        let error = unsafe { configure(&address.to_ne_bytes(), &WindowConfiguration::default()) }
            .expect_err("misaligned handle must be rejected");
        assert!(error.contains("misaligned"), "unexpected error: {error}");
    }

    #[test]
    fn toggling_sets_and_clears_exactly_the_requested_flag() {
        let none = NSWindowCollectionBehavior(0);
        let stationary = toggle(none, NSWindowCollectionBehavior::Stationary, Some(true));
        assert_eq!(stationary, NSWindowCollectionBehavior::Stationary);

        let both = toggle(
            stationary,
            NSWindowCollectionBehavior::IgnoresCycle,
            Some(true),
        );
        assert!(both.contains(NSWindowCollectionBehavior::Stationary));
        assert!(both.contains(NSWindowCollectionBehavior::IgnoresCycle));

        let cleared = toggle(both, NSWindowCollectionBehavior::Stationary, Some(false));
        assert!(!cleared.contains(NSWindowCollectionBehavior::Stationary));
        assert!(cleared.contains(NSWindowCollectionBehavior::IgnoresCycle));

        assert_eq!(
            toggle(cleared, NSWindowCollectionBehavior::Stationary, None),
            cleared
        );
    }

    #[test]
    fn nswindow_is_recognised_as_a_kind_of_nsresponder_but_not_a_panel() {
        assert!(is_kind_of(NSWindow::class(), NSWindow::class()));
        assert!(is_kind_of(NSPanel::class(), NSWindow::class()));
        assert!(!is_kind_of(NSWindow::class(), NSPanel::class()));
    }
}
