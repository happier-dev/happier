//! Utilities for querying and working with display monitors.
//!
//! Provides [`Monitor`] for retrieving monitor metadata such as friendly name,
//! device name, resolution, refresh rate, and converting a monitor into a capture item.
//!
//! Common tasks include:
//! - Enumerating monitors via [`Monitor::enumerate`].
//! - Selecting by one-based index via [`Monitor::from_index`].
//! - Getting the primary monitor via [`Monitor::primary`].
//!
//! To acquire a [`crate::GraphicsCaptureItem`] for a monitor, use the implementation of
//! [`crate::settings::TryIntoCaptureItemWithDetails`] for [`Monitor`].
use std::mem;
use std::num::ParseIntError;
use std::string::FromUtf16Error;

use windows::Graphics::Capture::GraphicsCaptureItem;
use windows::Win32::Devices::Display::{
    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
    DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
    DISPLAYCONFIG_SOURCE_DEVICE_NAME, DISPLAYCONFIG_TARGET_DEVICE_NAME, DISPLAYCONFIG_TARGET_DEVICE_NAME_FLAGS,
    DISPLAYCONFIG_VIDEO_OUTPUT_TECHNOLOGY, DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes,
    QDC_ONLY_ACTIVE_PATHS, QueryDisplayConfig,
};
use windows::Win32::Foundation::{LPARAM, POINT, RECT, TRUE};
use windows::Win32::Graphics::Gdi::{
    DEVMODEW, DISPLAY_DEVICE_STATE_FLAGS, DISPLAY_DEVICEW, ENUM_CURRENT_SETTINGS, EnumDisplayDevicesW,
    EnumDisplayMonitors, EnumDisplaySettingsW, GetMonitorInfoW, HDC, HMONITOR, MONITOR_DEFAULTTONULL, MONITORINFO,
    MONITORINFOEXW, MonitorFromPoint,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::core::{BOOL, HSTRING, PCWSTR};

use crate::settings::GraphicsCaptureItemType;

#[derive(thiserror::Error, Debug)]
/// Errors that can occur when querying monitors or converting them into capture items.
pub enum Error {
    /// No monitor matched the query.
    ///
    /// Returned by methods like [`Monitor::primary`] or [`Monitor::from_index`] when no monitor
    /// is found.
    #[error("Failed to find the specified monitor.")]
    NotFound,
    /// Failed to retrieve the monitor's friendly name via DisplayConfig.
    #[error("Failed to get the monitor's name.")]
    NameNotFound,
    /// The provided monitor index was less than 1.
    #[error("The monitor index must be greater than zero.")]
    IndexIsLowerThanOne,
    /// A call to `GetMonitorInfoW` failed.
    #[error("Failed to get monitor information.")]
    FailedToGetMonitorInfo,
    /// A call to `EnumDisplaySettingsW` failed.
    #[error("Failed to get the monitor's display settings.")]
    FailedToGetMonitorSettings,
    /// A call to `EnumDisplayDevicesW` failed.
    #[error("Failed to get the monitor's device name.")]
    FailedToGetMonitorName,
    /// Parsing the numeric index from a device name (for example, `\\.\DISPLAY1`) failed.
    ///
    /// Wraps [`std::num::ParseIntError`].
    #[error("Failed to parse the monitor index: {0}")]
    FailedToParseMonitorIndex(#[from] ParseIntError),
    /// Converting a UTF-16 Windows string to `String` failed.
    ///
    /// Wraps [`std::string::FromUtf16Error`].
    #[error("Failed to convert a Windows string: {0}")]
    FailedToConvertWindowsString(#[from] FromUtf16Error),
    /// A Windows Runtime/Win32 API call failed.
    ///
    /// Wraps [`windows::core::Error`].
    #[error("A Windows API call failed: {0}")]
    WindowsError(#[from] windows::core::Error),
}

/// Represents a display monitor.
///
/// # Examples
/// ```no_run
/// use windows_capture::monitor::Monitor;
///
/// // Primary monitor
/// let primary = Monitor::primary().unwrap();
/// println!("Primary: {}", primary.name().unwrap());
/// ```
///
/// ```no_run
/// use windows_capture::monitor::Monitor;
///
/// // Enumerate all active monitors
/// let monitors = Monitor::enumerate().unwrap();
/// for (i, m) in monitors.iter().enumerate() {
///     println!("Monitor #{}: {}", i + 1, m.name().unwrap_or_default());
/// }
/// ```
///
/// ```no_run
/// use windows_capture::monitor::Monitor;
///
/// // Select by one-based index (e.g., 2nd monitor)
/// let m2 = Monitor::from_index(2).unwrap();
/// println!("Second monitor size: {}x{}", m2.width().unwrap(), m2.height().unwrap());
/// ```
///
/// See also: [`crate::settings::TryIntoCaptureItemWithDetails`].
#[derive(Eq, PartialEq, Clone, Copy, Debug)]
pub struct Monitor {
    monitor: HMONITOR,
}

unsafe impl Send for Monitor {}

impl Monitor {
    /// Returns the primary monitor.
    ///
    /// # Errors
    ///
    /// - [`Error::NotFound`] when no primary monitor can be found
    #[inline]
    pub fn primary() -> Result<Self, Error> {
        let point = POINT { x: 0, y: 0 };
        let monitor = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONULL) };

        if monitor.is_invalid() {
            return Err(Error::NotFound);
        }

        Ok(Self { monitor })
    }

    /// Returns the monitor at the specified index.
    ///
    /// # Errors
    ///
    /// - [`Error::IndexIsLowerThanOne`] when `index` is less than 1
    /// - [`Error::NotFound`] when no monitor exists at the specified `index`
    /// - [`Error::WindowsError`] when monitor enumeration fails
    #[inline]
    pub fn from_index(index: usize) -> Result<Self, Error> {
        if index < 1 {
            return Err(Error::IndexIsLowerThanOne);
        }

        let monitor = Self::enumerate()?;
        let monitor = match monitor.get(index - 1) {
            Some(monitor) => *monitor,
            None => return Err(Error::NotFound),
        };

        Ok(monitor)
    }

    /// Returns the one-based index of the monitor.
    ///
    /// # Errors
    ///
    /// - [`Error::FailedToGetMonitorInfo`] when `GetMonitorInfoW` fails
    /// - [`Error::FailedToConvertWindowsString`] when converting the device name from UTF-16 fails
    /// - [`Error::FailedToParseMonitorIndex`] when parsing the numeric index from the device name
    ///   fails
    #[inline]
    pub fn index(&self) -> Result<usize, Error> {
        let device_name = self.device_name()?;
        Ok(device_name.replace("\\\\.\\DISPLAY", "").parse()?)
    }

    /// Returns the friendly name of the monitor.
    ///
    /// # Errors
    ///
    /// - [`Error::WindowsError`] when Display Configuration API calls fail
    /// - [`Error::FailedToConvertWindowsString`] when converting wide strings to `String` fails
    /// - [`Error::NameNotFound`] when no matching path/device name is found for this monitor
    #[inline]
    pub fn name(&self) -> Result<String, Error> {
        let device_name = self.device_name()?;
        let mut number_of_paths = 0;
        let mut number_of_modes = 0;
        unsafe {
            GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut number_of_paths, &mut number_of_modes).ok()?;
        };

        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); number_of_paths as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); number_of_modes as usize];
        unsafe {
            QueryDisplayConfig(
                QDC_ONLY_ACTIVE_PATHS,
                &mut number_of_paths,
                paths.as_mut_ptr(),
                &mut number_of_modes,
                modes.as_mut_ptr(),
                None,
            )
        }
        .ok()?;

        for path in &paths {
            let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                    size: std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                    adapterId: path.sourceInfo.adapterId,
                    id: path.sourceInfo.id,
                },
                viewGdiDeviceName: [0; 32],
            };

            if unsafe { DisplayConfigGetDeviceInfo(&mut source.header) } != 0 {
                continue;
            }

            let view_gdi_device_name = String::from_utf16(
                &source
                    .viewGdiDeviceName
                    .as_slice()
                    .iter()
                    .take_while(|ch| **ch != 0x0000)
                    .copied()
                    .collect::<Vec<u16>>(),
            )?;

            if view_gdi_device_name == device_name {
                let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME {
                    header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                        r#type: DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
                        size: std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32,
                        adapterId: path.sourceInfo.adapterId,
                        id: path.targetInfo.id,
                    },
                    flags: DISPLAYCONFIG_TARGET_DEVICE_NAME_FLAGS::default(),
                    outputTechnology: DISPLAYCONFIG_VIDEO_OUTPUT_TECHNOLOGY::default(),
                    edidManufactureId: 0,
                    edidProductCodeId: 0,
                    connectorInstance: 0,
                    monitorFriendlyDeviceName: [0; 64],
                    monitorDevicePath: [0; 128],
                };

                if unsafe { DisplayConfigGetDeviceInfo(&mut target.header) } != 0 {
                    continue;
                }
                return Ok(String::from_utf16(
                    &target
                        .monitorFriendlyDeviceName
                        .as_slice()
                        .iter()
                        .take_while(|ch| **ch != 0x0000)
                        .copied()
                        .collect::<Vec<u16>>(),
                )?);
            }
        }

        Err(Error::NameNotFound)
    }

    /// Returns the device name of the monitor (for example, `\\.\DISPLAY1`).
    ///
    /// # Errors
    ///
    /// - [`Error::FailedToGetMonitorInfo`] when `GetMonitorInfoW` fails
    /// - [`Error::FailedToConvertWindowsString`] when converting the device name from UTF-16 fails
    #[inline]
    pub fn device_name(&self) -> Result<String, Error> {
        let mut monitor_info = MONITORINFOEXW {
            monitorInfo: MONITORINFO {
                cbSize: u32::try_from(mem::size_of::<MONITORINFOEXW>()).unwrap(),
                rcMonitor: RECT::default(),
                rcWork: RECT::default(),
                dwFlags: 0,
            },
            szDevice: [0; 32],
        };
        if unsafe { !GetMonitorInfoW(HMONITOR(self.as_raw_hmonitor()), (&raw mut monitor_info).cast()).as_bool() } {
            return Err(Error::FailedToGetMonitorInfo);
        }

        let device_name = String::from_utf16(
            &monitor_info.szDevice.as_slice().iter().take_while(|ch| **ch != 0x0000).copied().collect::<Vec<u16>>(),
        )?;

        Ok(device_name)
    }

    /// Returns the device string of the monitor (for example, `NVIDIA GeForce RTX 4090`).
    ///
    /// # Errors
    ///
    /// - [`Error::FailedToGetMonitorInfo`] when `GetMonitorInfoW` fails
    /// - [`Error::FailedToGetMonitorName`] when `EnumDisplayDevicesW` fails
    /// - [`Error::FailedToConvertWindowsString`] when converting the device string from UTF-16
    ///   fails
    #[inline]
    pub fn device_string(&self) -> Result<String, Error> {
        let mut monitor_info = MONITORINFOEXW {
            monitorInfo: MONITORINFO {
                cbSize: u32::try_from(mem::size_of::<MONITORINFOEXW>()).unwrap(),
                rcMonitor: RECT::default(),
                rcWork: RECT::default(),
                dwFlags: 0,
            },
            szDevice: [0; 32],
        };
        if unsafe { !GetMonitorInfoW(HMONITOR(self.as_raw_hmonitor()), (&raw mut monitor_info).cast()).as_bool() } {
            return Err(Error::FailedToGetMonitorInfo);
        }

        let mut display_device = DISPLAY_DEVICEW {
            cb: u32::try_from(mem::size_of::<DISPLAY_DEVICEW>()).unwrap(),
            DeviceName: [0; 32],
            DeviceString: [0; 128],
            StateFlags: DISPLAY_DEVICE_STATE_FLAGS::default(),
            DeviceID: [0; 128],
            DeviceKey: [0; 128],
        };

        if unsafe {
            !EnumDisplayDevicesW(PCWSTR::from_raw(monitor_info.szDevice.as_mut_ptr()), 0, &mut display_device, 0)
                .as_bool()
        } {
            return Err(Error::FailedToGetMonitorName);
        }

        let device_string = String::from_utf16(
            &display_device
                .DeviceString
                .as_slice()
                .iter()
                .take_while(|ch| **ch != 0x0000)
                .copied()
                .collect::<Vec<u16>>(),
        )?;

        Ok(device_string)
    }

    /// Returns the refresh rate of the monitor in hertz (Hz).
    ///
    /// # Errors
    ///
    /// - [`Error::FailedToGetMonitorSettings`] when `EnumDisplaySettingsW` fails
    /// - [`Error::FailedToGetMonitorInfo`] when `GetMonitorInfoW` fails while resolving the device
    ///   name
    /// - [`Error::FailedToConvertWindowsString`] when converting the device name from UTF-16 fails
    #[inline]
    pub fn refresh_rate(&self) -> Result<u32, Error> {
        let mut device_mode =
            DEVMODEW { dmSize: u16::try_from(mem::size_of::<DEVMODEW>()).unwrap(), ..DEVMODEW::default() };
        let name = HSTRING::from(self.device_name()?);
        if unsafe { !EnumDisplaySettingsW(PCWSTR(name.as_ptr()), ENUM_CURRENT_SETTINGS, &mut device_mode).as_bool() } {
            return Err(Error::FailedToGetMonitorSettings);
        }

        Ok(device_mode.dmDisplayFrequency)
    }

    /// Returns the width of the monitor in pixels.
    ///
    /// # Errors
    ///
    /// - [`Error::FailedToGetMonitorSettings`] when `EnumDisplaySettingsW` fails
    /// - [`Error::FailedToGetMonitorInfo`] when `GetMonitorInfoW` fails while resolving the device
    ///   name
    /// - [`Error::FailedToConvertWindowsString`] when converting the device name from UTF-16 fails
    #[inline]
    pub fn width(&self) -> Result<u32, Error> {
        let mut device_mode =
            DEVMODEW { dmSize: u16::try_from(mem::size_of::<DEVMODEW>()).unwrap(), ..DEVMODEW::default() };
        let name = HSTRING::from(self.device_name()?);
        if unsafe { !EnumDisplaySettingsW(PCWSTR(name.as_ptr()), ENUM_CURRENT_SETTINGS, &mut device_mode).as_bool() } {
            return Err(Error::FailedToGetMonitorSettings);
        }

        Ok(device_mode.dmPelsWidth)
    }

    /// Returns the height of the monitor in pixels.
    ///
    /// # Errors
    ///
    /// - [`Error::FailedToGetMonitorSettings`] when `EnumDisplaySettingsW` fails
    /// - [`Error::FailedToGetMonitorInfo`] when `GetMonitorInfoW` fails while resolving the device
    ///   name
    /// - [`Error::FailedToConvertWindowsString`] when converting the device name from UTF-16 fails
    #[inline]
    pub fn height(&self) -> Result<u32, Error> {
        let mut device_mode =
            DEVMODEW { dmSize: u16::try_from(mem::size_of::<DEVMODEW>()).unwrap(), ..DEVMODEW::default() };
        let name = HSTRING::from(self.device_name()?);
        if unsafe { !EnumDisplaySettingsW(PCWSTR(name.as_ptr()), ENUM_CURRENT_SETTINGS, &mut device_mode).as_bool() } {
            return Err(Error::FailedToGetMonitorSettings);
        }

        Ok(device_mode.dmPelsHeight)
    }

    /// Returns a list of all available monitors.
    ///
    /// # Errors
    ///
    /// - [`Error::WindowsError`] when `EnumDisplayMonitors` fails
    #[inline]
    pub fn enumerate() -> Result<Vec<Self>, Error> {
        let mut monitors: Vec<Self> = Vec::new();

        unsafe {
            EnumDisplayMonitors(None, None, Some(Self::enum_monitors_callback), LPARAM(&raw mut monitors as isize))
                .ok()?;
        };

        Ok(monitors)
    }

    /// Constructs a `Monitor` instance from a raw `HMONITOR` handle.
    #[inline]
    #[must_use]
    pub const fn from_raw_hmonitor(monitor: *mut std::ffi::c_void) -> Self {
        Self { monitor: HMONITOR(monitor) }
    }

    /// Returns the raw `HMONITOR` handle of the monitor.
    #[inline]
    #[must_use]
    pub const fn as_raw_hmonitor(&self) -> *mut std::ffi::c_void {
        self.monitor.0
    }

    // Callback used for enumerating all monitors.
    #[inline]
    unsafe extern "system" fn enum_monitors_callback(monitor: HMONITOR, _: HDC, _: *mut RECT, vec: LPARAM) -> BOOL {
        let monitors = unsafe { &mut *(vec.0 as *mut Vec<Self>) };

        monitors.push(Self { monitor });

        TRUE
    }
}

impl TryInto<GraphicsCaptureItemType> for Monitor {
    type Error = windows::core::Error;

    #[inline]
    fn try_into(self) -> Result<GraphicsCaptureItemType, Self::Error> {
        let monitor = HMONITOR(self.as_raw_hmonitor());

        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        let item = unsafe { interop.CreateForMonitor(monitor)? };

        Ok(GraphicsCaptureItemType::Monitor((item, self)))
    }
}
