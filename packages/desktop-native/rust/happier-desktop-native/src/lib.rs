//! Shell-independent desktop primitives. AppKit calls require the main thread.
#[cfg(feature = "capture")]
pub mod capture;
pub mod display;
pub mod geometry;
pub mod handle;
#[cfg(all(target_os = "linux", feature = "capture"))]
pub mod pointer;
#[cfg(feature = "node-bindings")]
mod node_bindings;
#[cfg(target_os = "macos")]
pub mod window;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopError {
    MainThreadRequired,
    UnsupportedPlatform,
}

#[cfg(target_os = "macos")]
pub fn main_thread() -> Result<objc2::MainThreadMarker, DesktopError> {
    objc2::MainThreadMarker::new().ok_or(DesktopError::MainThreadRequired)
}

#[cfg(target_os = "macos")]
pub fn list_displays() -> Result<Vec<display::Display>, DesktopError> {
    let mtm = main_thread()?;
    Ok(display::list_displays(mtm))
}

#[cfg(not(target_os = "macos"))]
pub fn list_displays() -> Result<(), DesktopError> {
    Err(DesktopError::UnsupportedPlatform)
}
