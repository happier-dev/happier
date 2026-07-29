use super::types::{
    DesktopBrowserAvailability, DesktopBrowserDisabledReason, DesktopBrowserPlatform,
    DesktopBrowserPrimitive, DesktopBrowserSupport,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DesktopBrowserRuntimeSupport {
    pub macos_custom_data_store_identifiers: bool,
    /// Whether Wry child-embedding (`build_as_child`) is verified for the current platform by
    /// recorded manual QA (open → navigate → resize → z-order → close, no bleed/crash). Seeded from
    /// the BRW-12 spike evidence in `.project/reviews/browser-desktop-shell-spike/`. macOS rides its
    /// own WK-data-store gate and ignores this flag; Windows/X11 advertise `available` ONLY when this
    /// is true, so an unverified platform stays honestly fail-closed instead of over-claiming.
    pub child_embedding_verified: bool,
}

pub(crate) fn resolve_current_desktop_browser_platform() -> DesktopBrowserPlatform {
    if cfg!(target_os = "macos") {
        return DesktopBrowserPlatform::MacOs;
    }
    if cfg!(target_os = "windows") {
        return DesktopBrowserPlatform::Windows;
    }
    if cfg!(target_os = "linux") {
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            return DesktopBrowserPlatform::LinuxWayland;
        }
        if std::env::var_os("DISPLAY").is_some() {
            return DesktopBrowserPlatform::LinuxX11;
        }
        return DesktopBrowserPlatform::LinuxUnknown;
    }
    DesktopBrowserPlatform::Unsupported
}

pub(crate) fn resolve_current_desktop_browser_strategy() -> DesktopBrowserAvailability {
    resolve_desktop_browser_strategy(resolve_current_desktop_browser_platform())
}

pub(crate) fn resolve_desktop_browser_strategy(
    platform: DesktopBrowserPlatform,
) -> DesktopBrowserAvailability {
    resolve_desktop_browser_strategy_for_runtime(
        platform,
        resolve_current_desktop_browser_runtime_support(),
    )
}

pub(crate) fn resolve_desktop_browser_strategy_for_runtime(
    platform: DesktopBrowserPlatform,
    runtime_support: DesktopBrowserRuntimeSupport,
) -> DesktopBrowserAvailability {
    match platform {
        DesktopBrowserPlatform::MacOs if runtime_support.macos_custom_data_store_identifiers => {
            native_child_view_availability(platform, DesktopBrowserPrimitive::MacOsNsViewWebKit)
        }
        DesktopBrowserPlatform::MacOs => DesktopBrowserAvailability::unavailable(
            platform,
            DesktopBrowserPrimitive::MacOsNsViewWebKit,
            DesktopBrowserDisabledReason::NativeChildViewUnimplemented,
        ),
        DesktopBrowserPlatform::Windows if runtime_support.child_embedding_verified => {
            native_child_view_availability(platform, DesktopBrowserPrimitive::WindowsHwndWebView2)
        }
        DesktopBrowserPlatform::Windows => DesktopBrowserAvailability::unavailable(
            platform,
            DesktopBrowserPrimitive::WindowsHwndWebView2,
            DesktopBrowserDisabledReason::NativeChildViewUnimplemented,
        ),
        DesktopBrowserPlatform::LinuxX11 if runtime_support.child_embedding_verified => {
            native_child_view_availability(
                platform,
                DesktopBrowserPrimitive::LinuxX11ChildEmbedding,
            )
        }
        DesktopBrowserPlatform::LinuxX11 => DesktopBrowserAvailability::unavailable(
            platform,
            DesktopBrowserPrimitive::LinuxX11ChildEmbedding,
            DesktopBrowserDisabledReason::LinuxX11ChildEmbeddingUnimplemented,
        ),
        DesktopBrowserPlatform::LinuxWayland => DesktopBrowserAvailability::unavailable(
            platform,
            DesktopBrowserPrimitive::LinuxWaylandGtkEmbedding,
            DesktopBrowserDisabledReason::LinuxWaylandGtkEmbeddingUnimplemented,
        ),
        DesktopBrowserPlatform::LinuxUnknown => DesktopBrowserAvailability::unavailable(
            platform,
            DesktopBrowserPrimitive::Disabled,
            DesktopBrowserDisabledReason::LinuxDisplayUnavailable,
        ),
        DesktopBrowserPlatform::Unsupported => DesktopBrowserAvailability::unavailable(
            platform,
            DesktopBrowserPrimitive::Disabled,
            DesktopBrowserDisabledReason::UnsupportedPlatform,
        ),
    }
}

fn native_child_view_availability(
    platform: DesktopBrowserPlatform,
    primitive: DesktopBrowserPrimitive,
) -> DesktopBrowserAvailability {
    DesktopBrowserAvailability::available(
        platform,
        primitive,
        DesktopBrowserSupport {
            navigation: true,
            page_info_diagnostics: true,
            native_devtools: native_devtools_supported(),
            capture: native_capture_supported(platform),
            ..DesktopBrowserSupport::default()
        },
    )
}

fn native_capture_supported(platform: DesktopBrowserPlatform) -> bool {
    matches!(platform, DesktopBrowserPlatform::MacOs)
}

/// Per-platform child-embedding verification, seeded from recorded manual-QA evidence in
/// `.project/reviews/browser-desktop-shell-spike/`. Flipping a platform to `true` is the one
/// auditable edit that turns its `available` bit on — and it must be backed by a passing QA run
/// (open → navigate → resize → z-order → close, no bleed/crash), never set speculatively.
///
/// Current evidence (BRW-12 spike): macOS is verified-sound (it rides its own WK-data-store gate
/// below, so it is not listed here). Windows (WebView2 child lifecycle) and X11 (`build_as_child`
/// against a Tauri-window handle, not an adapter-owned `gtk::Fixed`) have NO recorded passing QA,
/// so both stay `false` and fall closed to an honest typed-unavailable rather than over-claiming.
pub(crate) fn child_embedding_verified_for(platform: DesktopBrowserPlatform) -> bool {
    match platform {
        // No recorded manual-QA evidence yet for either child-embedding path.
        DesktopBrowserPlatform::Windows | DesktopBrowserPlatform::LinuxX11 => false,
        // macOS uses `macos_custom_data_store_identifiers`; the remaining platforms are unavailable
        // for unrelated reasons (Wayland GTK path, no display, unsupported).
        DesktopBrowserPlatform::MacOs
        | DesktopBrowserPlatform::LinuxWayland
        | DesktopBrowserPlatform::LinuxUnknown
        | DesktopBrowserPlatform::Unsupported => false,
    }
}

fn resolve_current_desktop_browser_runtime_support() -> DesktopBrowserRuntimeSupport {
    DesktopBrowserRuntimeSupport {
        macos_custom_data_store_identifiers: macos_custom_data_store_identifiers_supported(),
        child_embedding_verified: child_embedding_verified_for(
            resolve_current_desktop_browser_platform(),
        ),
    }
}

#[cfg(target_os = "macos")]
fn macos_custom_data_store_identifiers_supported() -> bool {
    use objc2_foundation::NSProcessInfo;

    let process_info = NSProcessInfo::processInfo();
    let version = process_info.operatingSystemVersion();
    version.majorVersion >= 14
}

#[cfg(not(target_os = "macos"))]
fn macos_custom_data_store_identifiers_supported() -> bool {
    false
}

pub(crate) fn native_devtools_supported() -> bool {
    cfg!(any(debug_assertions, feature = "devtools"))
}
