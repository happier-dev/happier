use objc2_app_kit::NSWindow;
use objc2_foundation::NSString;

/// AppKit owns the frame in this app's defaults domain, including display-change adjustment.
/// Call on the main thread before showing the window; visibility and chrome stay Tauri-owned.
pub(crate) fn restore_and_track_frame(window: &NSWindow, name: &str) -> bool {
    let name = NSString::from_str(name);
    // A missing saved frame is an ordinary first launch: keep the configured frame.
    window.setFrameUsingName(&name);
    window.setFrameAutosaveName(&name)
}
