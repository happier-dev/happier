//! Permission-free native display facts shared by desktop shells and capture.
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

/// Native metadata joined to shell geometry by the exact OS monitor name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformDisplayFacts {
    pub native_name: String,
    pub storage_key: String,
    pub friendly_name: Option<String>,
    /// Unknown when the platform supplies no connector or embedded-display fact.
    pub built_in: Option<bool>,
}

#[cfg(any(all(target_os = "linux", feature = "capture"), test))]
mod x11_identity;

#[cfg(all(target_os = "windows", feature = "capture"))]
mod windows;
#[cfg(all(target_os = "linux", feature = "capture"))]
mod x11;

#[cfg(all(target_os = "windows", feature = "capture"))]
pub use windows::platform_display_facts;
#[cfg(all(target_os = "linux", feature = "capture"))]
pub use x11::platform_display_facts;
