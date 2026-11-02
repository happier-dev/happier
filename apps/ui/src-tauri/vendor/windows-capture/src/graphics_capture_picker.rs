use windows::Graphics::Capture::GraphicsCaptureItem;
use windows::Win32::Foundation::{ERROR_CLASS_ALREADY_EXISTS, GetLastError, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::IInitializeWithWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, MSG, PM_REMOVE,
    PeekMessageW, RegisterClassExW, TranslateMessage, WM_DESTROY, WNDCLASSEXW, WS_EX_TOOLWINDOW, WS_POPUP, WS_VISIBLE,
};
use windows::core::{Interface, w};
use windows_future::AsyncStatus;

use crate::settings::GraphicsCaptureItemType;
use crate::winrt::WinRT;

#[derive(thiserror::Error, Eq, PartialEq, Clone, Debug)]
/// Errors that can occur while showing or interacting with the Graphics Capture Picker.
pub enum Error {
    /// An error returned by an underlying Windows API call.
    #[error("Windows API error: {0}")]
    WindowsError(#[from] windows::core::Error),
    /// The user canceled the picker (no item selected).
    #[error("User canceled the picker")]
    Canceled,
}

/// Window procedure for the hidden owner window used by the picker.
///
/// Safety: Called by the system with a valid `HWND` and message parameters.
/// Forwards unhandled messages to `DefWindowProcW`.
unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_DESTROY => LRESULT(0),
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// RAII guard that keeps the picker resources alive until the selected item is
/// consumed.
pub struct HwndGuard {
    hwnd: HWND,
    _winrt: WinRT,
}

impl Drop for HwndGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.hwnd);
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                // We just remove them; no need to dispatch at this point.
            }
        }
    }
}

/// The successfully picked graphics capture item and its associated window guard.
pub struct PickedGraphicsCaptureItem {
    /// The selected `GraphicsCaptureItem` (window or monitor).
    pub item: GraphicsCaptureItem,
    /// Keeps the hidden owner `HWND` alive until the picked item is consumed.
    _guard: HwndGuard,
}

impl PickedGraphicsCaptureItem {
    /// Returns the size of the picked item as `(width, height)`.
    pub fn size(&self) -> windows::core::Result<(i32, i32)> {
        let size = self.item.Size()?;
        Ok((size.Width, size.Height))
    }
}

/// Helper for prompting the user to pick a window or monitor using the system
/// Graphics Capture Picker.
pub struct GraphicsCapturePicker;

impl GraphicsCapturePicker {
    /// Shows the system Graphics Capture Picker dialog and returns the chosen item.
    ///
    /// A tiny, off-screen tool window is created as the picker owner and initialized
    /// via `IInitializeWithWindow`. While the picker is visible, a minimal message
    /// pump is run to keep the UI responsive.
    ///
    /// # Returns
    ///
    /// - `Ok(Some(PickedGraphicsCaptureItem))` if the user selects a target
    /// - `Ok(None)` if the picker completes without a result
    ///
    /// # Errors
    /// - [`Error::Canceled`] when the user cancels the picker
    /// - [`Error::WindowsError`] for underlying Windows API failures
    pub fn pick_item() -> Result<Option<PickedGraphicsCaptureItem>, Error> {
        // The picker and the item it returns must be created in an initialized
        // WinRT apartment. Keep this guard with the item so Windows 10 does not
        // disconnect it before capture starts.
        let winrt = WinRT::new()?;

        let hinst = unsafe { GetModuleHandleW(None) }?;
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinst.into(),
            lpszClassName: w!("windows-capture-picker-window"),
            ..Default::default()
        };

        if unsafe { RegisterClassExW(&wc) } == 0 {
            let err = unsafe { GetLastError() };
            if err != ERROR_CLASS_ALREADY_EXISTS {
                return Err(Error::WindowsError(err.into()));
            }
        }

        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOOLWINDOW,
                w!("windows-capture-picker-window"),
                w!("Windows Capture Picker"),
                WS_POPUP | WS_VISIBLE,
                -69000,
                -69000,
                0,
                0,
                None,
                None,
                Some(hinst.into()),
                None,
            )
        }?;

        // Construct the guard immediately so the hidden window is also cleaned
        // up when picker initialization, selection, or result retrieval fails.
        let guard = HwndGuard { hwnd, _winrt: winrt };

        let picker = windows::Graphics::Capture::GraphicsCapturePicker::new()?;
        let initialize_with_window: IInitializeWithWindow = picker.cast()?;
        unsafe { initialize_with_window.Initialize(guard.hwnd) }?;

        let op = picker.PickSingleItemAsync()?;

        loop {
            match op.Status()? {
                AsyncStatus::Started => unsafe {
                    let mut msg = MSG::default();
                    while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                        // Normal UI pump while the picker is up
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                },
                AsyncStatus::Completed => break,
                AsyncStatus::Canceled => return Err(Error::Canceled),
                AsyncStatus::Error => return Err(Error::WindowsError(op.ErrorCode()?.into())),
                _ => {}
            }
        }

        op.GetResults()
            .ok()
            .map_or_else(|| Ok(None), |item| Ok(Some(PickedGraphicsCaptureItem { item, _guard: guard })))
    }
}

impl TryInto<GraphicsCaptureItemType> for PickedGraphicsCaptureItem {
    type Error = windows::core::Error;

    #[inline]
    fn try_into(self) -> Result<GraphicsCaptureItemType, Self::Error> {
        Ok(GraphicsCaptureItemType::Unknown((self.item, self._guard)))
    }
}
