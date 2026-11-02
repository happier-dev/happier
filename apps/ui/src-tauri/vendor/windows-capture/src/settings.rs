use std::time::Duration;

use windows::Graphics::Capture::GraphicsCaptureItem;

use crate::graphics_capture_picker::HwndGuard;
use crate::monitor::Monitor;
use crate::window::Window;

/// An enumeration of item types that can be captured.
///
/// Wraps the WinRT [`GraphicsCaptureItem`] together with additional details about the source:
/// - [`Monitor`] for display monitors,
/// - [`Window`] for top-level windows,
/// - [`crate::graphics_capture_picker::HwndGuard`] for unknown HWND-based sources.
pub enum GraphicsCaptureItemType {
    /// A display monitor. Contains the [`GraphicsCaptureItem`] and its [`Monitor`] details.
    Monitor((GraphicsCaptureItem, Monitor)),
    /// An application window. Contains the [`GraphicsCaptureItem`] and its [`Window`] details.
    Window((GraphicsCaptureItem, Window)),
    /// An unknown capture item type (typically created from an HWND). Contains the
    /// [`GraphicsCaptureItem`] and the associated
    /// [`crate::graphics_capture_picker::HwndGuard`].
    Unknown((GraphicsCaptureItem, HwndGuard)),
}

/// Specifies the pixel format for the captured frame.
#[derive(Eq, PartialEq, Clone, Copy, Debug)]
pub enum ColorFormat {
    /// 16-bit floating-point RGBA format.
    Rgba16F = 10,
    /// 8-bit unsigned integer RGBA format.
    Rgba8 = 28,
    /// 8-bit unsigned integer BGRA format.
    Bgra8 = 87,
}

impl Default for ColorFormat {
    /// The default color format is [`ColorFormat::Rgba8`].
    #[inline]
    fn default() -> Self {
        Self::Rgba8
    }
}

/// Defines whether the cursor should be visible in the captured output.
#[derive(Eq, PartialEq, Clone, Copy, Debug)]
pub enum CursorCaptureSettings {
    /// Use the system's default behavior for cursor visibility.
    Default,
    /// Ensure the cursor is always visible in the capture.
    WithCursor,
    /// Ensure the cursor is never visible in the capture.
    WithoutCursor,
}

/// Defines whether a border should be drawn around the captured item.
#[derive(Eq, PartialEq, Clone, Copy, Debug)]
pub enum DrawBorderSettings {
    /// Use the system's default behavior for the capture border.
    Default,
    /// Draw a border around the captured item.
    WithBorder,
    /// Do not draw a border around the captured item.
    WithoutBorder,
}

/// Defines whether to include or exclude secondary windows in the capture.
#[derive(Eq, PartialEq, Clone, Copy, Debug)]
pub enum SecondaryWindowSettings {
    /// Use the system's default behavior for capturing secondary windows.
    Default,
    /// Include secondary windows in the capture.
    Include,
    /// Exclude secondary windows from the capture.
    Exclude,
}

/// Controls the minimum interval between frame updates requested from Windows Graphics Capture.
///
/// This is an OS-side throttle, not a target frame rate. A custom interval limits how frequently
/// updates are eligible for delivery, but it does not make Windows produce frames periodically or
/// guarantee a constant rate. The actual rate can be lower and depends on source/compositor
/// updates, display timing, system load, and how quickly captured frames are consumed.
///
/// Consumers that require a fixed cadence must pace the output themselves, dropping excess frames
/// or duplicating the latest frame when necessary. [`crate::frame::Frame::timestamp`] provides the
/// capture timestamp for that purpose.
#[derive(Eq, PartialEq, Clone, Copy, Debug)]
pub enum MinimumUpdateIntervalSettings {
    /// Leave the Windows Graphics Capture update interval unchanged.
    Default,
    /// Request a custom minimum interval between eligible frame updates.
    Custom(Duration),
}

/// Defines how the system should handle dirty regions, which are areas of the screen that have
/// changed.
#[derive(Eq, PartialEq, Clone, Copy, Debug)]
pub enum DirtyRegionSettings {
    /// Use the system's default behavior for dirty regions.
    Default,
    /// Only report the dirty regions without rendering them separately.
    ReportOnly,
    /// Report and render the dirty regions.
    ReportAndRender,
}

/// Represents the settings for a screen capture session.
#[derive(Eq, PartialEq, Clone, Debug)]
pub struct Settings<Flags, T: TryInto<GraphicsCaptureItemType>> {
    /// The item to be captured (e.g., a `Window` or `Monitor`).
    pub(crate) item: T,
    /// Specifies whether the cursor should be captured.
    pub(crate) cursor_capture_settings: CursorCaptureSettings,
    /// Specifies whether a border should be drawn around the captured item.
    pub(crate) draw_border_settings: DrawBorderSettings,
    /// Specifies whether to include secondary windows in the capture.
    pub(crate) secondary_window_settings: SecondaryWindowSettings,
    /// Specifies the minimum time between frame updates.
    pub(crate) minimum_update_interval_settings: MinimumUpdateIntervalSettings,
    /// Specifies how to handle dirty regions.
    pub(crate) dirty_region_settings: DirtyRegionSettings,
    /// The pixel format for the captured frames.
    pub(crate) color_format: ColorFormat,
    /// User-defined flags that can be passed to the capture implementation.
    pub(crate) flags: Flags,
}

impl<Flags, T: TryInto<GraphicsCaptureItemType>> Settings<Flags, T> {
    /// Constructs a new [`Settings`] configuration.
    #[inline]
    #[must_use]
    #[allow(clippy::too_many_arguments)]
    pub const fn new(
        item: T,
        cursor_capture_settings: CursorCaptureSettings,
        draw_border_settings: DrawBorderSettings,
        secondary_window_settings: SecondaryWindowSettings,
        minimum_update_interval_settings: MinimumUpdateIntervalSettings,
        dirty_region_settings: DirtyRegionSettings,
        color_format: ColorFormat,
        flags: Flags,
    ) -> Self {
        Self {
            item,
            cursor_capture_settings,
            draw_border_settings,
            secondary_window_settings,
            minimum_update_interval_settings,
            dirty_region_settings,
            color_format,
            flags,
        }
    }

    /// Returns a reference to the capture item.
    #[inline]
    #[must_use]
    pub const fn item(&self) -> &T {
        &self.item
    }

    /// Returns the cursor capture settings.
    #[inline]
    #[must_use]
    pub const fn cursor_capture(&self) -> CursorCaptureSettings {
        self.cursor_capture_settings
    }

    /// Returns the draw border settings.
    #[inline]
    #[must_use]
    pub const fn draw_border(&self) -> DrawBorderSettings {
        self.draw_border_settings
    }

    /// Returns the secondary window settings.
    #[inline]
    #[must_use]
    pub const fn secondary_window(&self) -> SecondaryWindowSettings {
        self.secondary_window_settings
    }

    /// Returns the minimum update interval settings.
    #[inline]
    #[must_use]
    pub const fn minimum_update_interval(&self) -> MinimumUpdateIntervalSettings {
        self.minimum_update_interval_settings
    }

    /// Returns the dirty region settings.
    #[inline]
    #[must_use]
    pub const fn dirty_region(&self) -> DirtyRegionSettings {
        self.dirty_region_settings
    }

    /// Returns the color format.
    #[inline]
    #[must_use]
    pub const fn color_format(&self) -> ColorFormat {
        self.color_format
    }

    /// Returns a reference to the flags.
    #[inline]
    #[must_use]
    pub const fn flags(&self) -> &Flags {
        &self.flags
    }
}
