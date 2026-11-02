use std::sync::Arc;
use std::sync::atomic::{self, AtomicBool, AtomicI32};

use parking_lot::Mutex;
use windows::Foundation::Metadata::ApiInformation;
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureDirtyRegionMode, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::Graphics::Direct3D11::{D3D11_TEXTURE2D_DESC, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D};
use windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;
use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};
use windows::core::{HSTRING, IInspectable, Interface};

use crate::capture::GraphicsCaptureApiHandler;
use crate::d3d11::{self, SendDirectX, create_direct3d_device};
use crate::frame::Frame;
use crate::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, GraphicsCaptureItemType,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings,
};

#[derive(thiserror::Error, Eq, PartialEq, Clone, Debug)]
/// Errors that can occur when configuring or running a Windows Graphics Capture session.
pub enum Error {
    /// The Windows Graphics Capture API is not available on this OS.
    #[error("The Graphics Capture API is not supported on this platform.")]
    Unsupported,
    /// Toggling cursor capture isn't supported on this platform/OS build.
    #[error("Toggling cursor capture is not supported by the Graphics Capture API on this platform.")]
    CursorConfigUnsupported,
    /// Toggling the capture border isn't supported on this platform/OS build.
    #[error("Toggling the capture border is not supported by the Graphics Capture API on this platform.")]
    BorderConfigUnsupported,
    /// Capturing secondary (owned) windows isn't supported on this platform/OS build.
    #[error("Capturing secondary windows is not supported by the Graphics Capture API on this platform.")]
    SecondaryWindowsUnsupported,
    /// Setting a minimum frame update interval isn't supported on this platform/OS build.
    #[error("Setting a minimum update interval is not supported by the Graphics Capture API on this platform.")]
    MinimumUpdateIntervalUnsupported,
    /// Dirty region tracking isn't supported on this platform/OS build.
    #[error("Dirty region tracking is not supported by the Graphics Capture API on this platform.")]
    DirtyRegionUnsupported,
    /// Capture has already been started for this session.
    #[error("The capture has already been started.")]
    AlreadyStarted,
    /// Underlying Direct3D (D3D11) error.
    ///
    /// Wraps [`crate::d3d11::Error`].
    #[error("DirectX error: {0}")]
    DirectXError(#[from] d3d11::Error),
    /// Window helper error.
    ///
    /// Wraps [`crate::window::Error`].
    #[error("Window error: {0}")]
    WindowError(#[from] crate::window::Error),
    /// A Windows Runtime/Win32 API call failed.
    ///
    /// Wraps [`windows::core::Error`].
    #[error("Windows API error: {0}")]
    WindowsError(#[from] windows::core::Error),
}

/// Provides a way to gracefully stop the capture session thread.
pub struct InternalCaptureControl {
    stop: Arc<AtomicBool>,
}

impl InternalCaptureControl {
    /// Constructs a new `InternalCaptureControl` struct.
    #[inline]
    #[must_use]
    pub const fn new(stop: Arc<AtomicBool>) -> Self {
        Self { stop }
    }

    /// Signals the capture thread to stop.
    #[inline]
    pub fn stop(self) {
        self.stop.store(true, atomic::Ordering::Relaxed);
    }
}

/// Manages a graphics capture session using the Windows Graphics Capture API.
pub struct GraphicsCaptureApi {
    /// The [`windows::Graphics::Capture::GraphicsCaptureItem`] to be captured (e.g., a window or
    /// monitor).
    item_with_details: GraphicsCaptureItemType,
    /// The Direct3D 11 device used for the capture.
    _d3d_device: ID3D11Device,
    /// The WinRT [`windows::Graphics::DirectX::Direct3D11::IDirect3DDevice`] wrapper.
    _direct3d_device: IDirect3DDevice,
    /// The Direct3D 11 device context.
    _d3d_device_context: ID3D11DeviceContext,
    /// The frame pool that provides frames for the capture session.
    frame_pool: Option<Arc<Direct3D11CaptureFramePool>>,
    /// The graphics capture session itself.
    session: Option<GraphicsCaptureSession>,
    /// An atomic boolean flag to signal the capture thread to stop.
    halt: Arc<AtomicBool>,
    /// A flag indicating whether the capture session is currently active.
    active: bool,
    /// The token for the `Closed` event handler.
    capture_closed_event_token: i64,
    /// The token for the `FrameArrived` event handler.
    frame_arrived_event_token: i64,
}

impl GraphicsCaptureApi {
    /// Constructs a new [`GraphicsCaptureApi`] instance.
    ///
    /// For parameter details, see the type names in the signature; complex behavior is documented
    /// inline below where relevant.
    #[allow(clippy::too_many_arguments)]
    #[inline]
    pub fn new<T: GraphicsCaptureApiHandler<Error = E> + Send + 'static, E: Send + Sync + 'static>(
        d3d_device: ID3D11Device,
        d3d_device_context: ID3D11DeviceContext,
        item_with_details: GraphicsCaptureItemType,
        callback: Arc<Mutex<T>>,
        cursor_capture_settings: CursorCaptureSettings,
        draw_border_settings: DrawBorderSettings,
        secondary_window_settings: SecondaryWindowSettings,
        minimum_update_interval_settings: MinimumUpdateIntervalSettings,
        dirty_region_settings: DirtyRegionSettings,
        color_format: ColorFormat,
        thread_id: u32,
        result: Arc<Mutex<Option<E>>>,
    ) -> Result<Self, Error> {
        // Check support
        if !Self::is_supported()? {
            return Err(Error::Unsupported);
        }

        if cursor_capture_settings != CursorCaptureSettings::Default && !Self::is_cursor_settings_supported()? {
            return Err(Error::CursorConfigUnsupported);
        }

        if draw_border_settings != DrawBorderSettings::Default && !Self::is_border_settings_supported()? {
            return Err(Error::BorderConfigUnsupported);
        }

        if secondary_window_settings != SecondaryWindowSettings::Default && !Self::is_secondary_windows_supported()? {
            return Err(Error::SecondaryWindowsUnsupported);
        }

        if minimum_update_interval_settings != MinimumUpdateIntervalSettings::Default
            && !Self::is_minimum_update_interval_supported()?
        {
            return Err(Error::MinimumUpdateIntervalUnsupported);
        }

        if dirty_region_settings != DirtyRegionSettings::Default && !Self::is_dirty_region_supported()? {
            return Err(Error::DirtyRegionUnsupported);
        }

        // Pre-calculate the title bar height so each frame doesn't need to do it
        let title_bar_height = match item_with_details {
            GraphicsCaptureItemType::Window((_, window)) => Some(window.title_bar_height()?),
            GraphicsCaptureItemType::Monitor(_) => None,
            GraphicsCaptureItemType::Unknown(_) => None,
        };

        let item = match &item_with_details {
            GraphicsCaptureItemType::Window((item, _)) => item,
            GraphicsCaptureItemType::Monitor((item, _)) => item,
            GraphicsCaptureItemType::Unknown((item, _)) => item,
        };

        // Create DirectX devices
        let direct3d_device = create_direct3d_device(&d3d_device)?;

        let pixel_format = DirectXPixelFormat(color_format as i32);

        // Create frame pool
        let frame_pool = Direct3D11CaptureFramePool::Create(&direct3d_device, pixel_format, 1, item.Size()?)?;
        let frame_pool = Arc::new(frame_pool);

        // Create capture session
        let session = frame_pool.CreateCaptureSession(item)?;

        // Indicates if the capture is closed
        let halt = Arc::new(AtomicBool::new(false));

        // Set capture session closed event
        let capture_closed_event_token =
            item.Closed(&TypedEventHandler::<GraphicsCaptureItem, IInspectable>::new({
                // Init
                let callback_closed = callback.clone();
                let halt_closed = halt.clone();
                let result_closed = result.clone();

                move |_, _| {
                    halt_closed.store(true, atomic::Ordering::Relaxed);

                    // Notify the user that the capture session is closed.
                    let callback_closed = callback_closed.lock().on_closed();
                    if let Err(e) = callback_closed {
                        *result_closed.lock() = Some(e);
                    }

                    // Stop the message loop to allow the thread to exit gracefully.
                    unsafe {
                        PostThreadMessageW(thread_id, WM_QUIT, WPARAM::default(), LPARAM::default())?;
                    };

                    Result::Ok(())
                }
            }))?;

        // Set frame pool frame arrived event
        let frame_arrived_event_token = frame_pool.FrameArrived(&TypedEventHandler::<
            Direct3D11CaptureFramePool,
            IInspectable,
        >::new({
            // Init
            let frame_pool_recreate = frame_pool.clone();
            let halt_frame_pool = halt.clone();
            let d3d_device_frame_pool = d3d_device.clone();
            let context = d3d_device_context.clone();
            let result_frame_pool = result;

            let last_size = item.Size()?;
            let last_size = Arc::new((AtomicI32::new(last_size.Width), AtomicI32::new(last_size.Height)));
            let callback_frame_pool = callback;
            let direct3d_device_recreate = SendDirectX::new(direct3d_device.clone());

            move |frame, _| {
                // Return early if the capture is closed
                if halt_frame_pool.load(atomic::Ordering::Relaxed) {
                    return Ok(());
                }

                // Get frame
                let Some(frame_pool) = frame.as_ref() else {
                    return Ok(());
                };
                let frame = frame_pool.TryGetNextFrame()?;

                // Get frame content size
                let frame_content_size = frame.ContentSize()?;

                // Recreate the pool when the capture content changes size. The current frame's
                // surface still has the old pool dimensions, so release it and wait for a frame
                // backed by a correctly sized surface before invoking the callback.
                if frame_content_size.Width != last_size.0.load(atomic::Ordering::Relaxed)
                    || frame_content_size.Height != last_size.1.load(atomic::Ordering::Relaxed)
                {
                    drop(frame);

                    let direct3d_device_recreate = &direct3d_device_recreate;
                    frame_pool_recreate.Recreate(&direct3d_device_recreate.0, pixel_format, 1, frame_content_size)?;

                    last_size.0.store(frame_content_size.Width, atomic::Ordering::Relaxed);
                    last_size.1.store(frame_content_size.Height, atomic::Ordering::Relaxed);

                    return Ok(());
                }

                // Get frame surface
                let frame_surface = frame.Surface()?;

                // Convert surface to texture
                let frame_dxgi_interface = frame_surface.cast::<IDirect3DDxgiInterfaceAccess>()?;
                let frame_texture = unsafe { frame_dxgi_interface.GetInterface::<ID3D11Texture2D>()? };

                // Get texture settings
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                unsafe { frame_texture.GetDesc(&mut desc) }

                // Create a frame
                let mut frame = Frame::new(
                    frame,
                    &d3d_device_frame_pool,
                    frame_surface,
                    frame_texture,
                    &context,
                    desc,
                    color_format,
                    title_bar_height,
                );

                // Init internal capture control
                let stop = Arc::new(AtomicBool::new(false));
                let internal_capture_control = InternalCaptureControl::new(stop.clone());

                // Send the frame to the callback struct
                let result = callback_frame_pool.lock().on_frame_arrived(&mut frame, internal_capture_control);

                // If the user signals to stop or an error occurs, halt the capture.
                if stop.load(atomic::Ordering::Relaxed) || result.is_err() {
                    if let Err(e) = result {
                        *result_frame_pool.lock() = Some(e);
                    }

                    halt_frame_pool.store(true, atomic::Ordering::Relaxed);

                    // Stop the message loop to allow the thread to exit gracefully.
                    unsafe {
                        PostThreadMessageW(thread_id, WM_QUIT, WPARAM::default(), LPARAM::default())?;
                    };
                }

                Result::Ok(())
            }
        }))?;

        if cursor_capture_settings != CursorCaptureSettings::Default {
            if Self::is_cursor_settings_supported()? {
                match cursor_capture_settings {
                    CursorCaptureSettings::Default => (),
                    CursorCaptureSettings::WithCursor => session.SetIsCursorCaptureEnabled(true)?,
                    CursorCaptureSettings::WithoutCursor => session.SetIsCursorCaptureEnabled(false)?,
                };
            } else {
                return Err(Error::CursorConfigUnsupported);
            }
        }

        if draw_border_settings != DrawBorderSettings::Default {
            if Self::is_border_settings_supported()? {
                match draw_border_settings {
                    DrawBorderSettings::Default => (),
                    DrawBorderSettings::WithBorder => {
                        session.SetIsBorderRequired(true)?;
                    }
                    DrawBorderSettings::WithoutBorder => session.SetIsBorderRequired(false)?,
                }
            } else {
                return Err(Error::BorderConfigUnsupported);
            }
        }

        if secondary_window_settings != SecondaryWindowSettings::Default {
            if Self::is_secondary_windows_supported()? {
                match secondary_window_settings {
                    SecondaryWindowSettings::Default => (),
                    SecondaryWindowSettings::Include => session.SetIncludeSecondaryWindows(true)?,
                    SecondaryWindowSettings::Exclude => session.SetIncludeSecondaryWindows(false)?,
                }
            } else {
                return Err(Error::SecondaryWindowsUnsupported);
            }
        }

        if minimum_update_interval_settings != MinimumUpdateIntervalSettings::Default {
            if Self::is_minimum_update_interval_supported()? {
                match minimum_update_interval_settings {
                    MinimumUpdateIntervalSettings::Default => (),
                    MinimumUpdateIntervalSettings::Custom(duration) => {
                        session.SetMinUpdateInterval(duration.into())?;
                    }
                }
            } else {
                return Err(Error::MinimumUpdateIntervalUnsupported);
            }
        }

        if dirty_region_settings != DirtyRegionSettings::Default {
            if Self::is_dirty_region_supported()? {
                match dirty_region_settings {
                    DirtyRegionSettings::Default => (),
                    DirtyRegionSettings::ReportOnly => {
                        session.SetDirtyRegionMode(GraphicsCaptureDirtyRegionMode::ReportOnly)?
                    }
                    DirtyRegionSettings::ReportAndRender => {
                        session.SetDirtyRegionMode(GraphicsCaptureDirtyRegionMode::ReportAndRender)?
                    }
                }
            } else {
                return Err(Error::DirtyRegionUnsupported);
            }
        }

        Ok(Self {
            item_with_details,
            _d3d_device: d3d_device,
            _direct3d_device: direct3d_device,
            _d3d_device_context: d3d_device_context,
            frame_pool: Some(frame_pool),
            session: Some(session),
            halt,
            active: false,
            frame_arrived_event_token,
            capture_closed_event_token,
        })
    }

    /// Starts the capture.
    ///
    /// # Errors
    ///
    /// - [`Error::AlreadyStarted`] when called more than once
    /// - [`Error::WindowsError`] for failures starting the capture session
    #[inline]
    pub fn start_capture(&mut self) -> Result<(), Error> {
        if self.active {
            return Err(Error::AlreadyStarted);
        }

        if let Some(session) = &self.session {
            session.StartCapture()?;
        }
        self.active = true;

        Ok(())
    }

    /// Stops the capture session and cleans up resources.
    #[inline]
    pub fn stop_capture(mut self) {
        self.cleanup();
    }

    /// Gets the halt handle.
    ///
    /// # Returns
    ///
    /// Returns an `Arc<AtomicBool>` that can be used to check if the capture is halted.
    #[inline]
    #[must_use]
    pub fn halt_handle(&self) -> Arc<AtomicBool> {
        self.halt.clone()
    }

    /// Checks if the Windows Graphics Capture API is supported.
    #[inline]
    pub fn is_supported() -> Result<bool, Error> {
        Ok(ApiInformation::IsApiContractPresentByMajor(&HSTRING::from("Windows.Foundation.UniversalApiContract"), 8)?
            && GraphicsCaptureSession::IsSupported()?)
    }

    /// Checks if the cursor capture settings can be changed.
    #[inline]
    pub fn is_cursor_settings_supported() -> Result<bool, Error> {
        Ok(ApiInformation::IsPropertyPresent(
            &HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
            &HSTRING::from("IsCursorCaptureEnabled"),
        )? && Self::is_supported()?)
    }

    /// Checks if the capture border settings can be changed.
    #[inline]
    pub fn is_border_settings_supported() -> Result<bool, Error> {
        Ok(ApiInformation::IsPropertyPresent(
            &HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
            &HSTRING::from("IsBorderRequired"),
        )? && Self::is_supported()?)
    }

    /// Checks if capturing secondary windows is supported.
    #[inline]
    pub fn is_secondary_windows_supported() -> Result<bool, Error> {
        Ok(ApiInformation::IsPropertyPresent(
            &HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
            &HSTRING::from("IncludeSecondaryWindows"),
        )? && Self::is_supported()?)
    }

    /// Checks if setting a minimum update interval is supported.
    #[inline]
    pub fn is_minimum_update_interval_supported() -> Result<bool, Error> {
        Ok(ApiInformation::IsPropertyPresent(
            &HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
            &HSTRING::from("MinUpdateInterval"),
        )? && Self::is_supported()?)
    }

    /// Checks if dirty region tracking is supported.
    #[inline]
    pub fn is_dirty_region_supported() -> Result<bool, Error> {
        Ok(ApiInformation::IsPropertyPresent(
            &HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
            &HSTRING::from("DirtyRegionMode"),
        )? && Self::is_supported()?)
    }

    fn cleanup(&mut self) {
        if let Some(frame_pool) = self.frame_pool.take() {
            let _ = frame_pool.RemoveFrameArrived(self.frame_arrived_event_token);
            let _ = frame_pool.Close();
        }

        if let Some(session) = self.session.take() {
            let _ = session.Close();
        }

        let item = match &self.item_with_details {
            GraphicsCaptureItemType::Window((item, _)) => item,
            GraphicsCaptureItemType::Monitor((item, _)) => item,
            GraphicsCaptureItemType::Unknown((item, _)) => item,
        };

        let _ = item.RemoveClosed(self.capture_closed_event_token);
        self.active = false;
    }
}

impl Drop for GraphicsCaptureApi {
    fn drop(&mut self) {
        self.cleanup();
    }
}
