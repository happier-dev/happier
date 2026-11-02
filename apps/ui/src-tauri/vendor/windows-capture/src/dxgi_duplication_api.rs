//! DXGI Desktop Duplication API wrapper.
//!
//! This module provides [`DxgiDuplicationApi`] to capture a monitor using the
//! Windows DXGI Desktop Duplication API. It integrates with [`crate::monitor::Monitor`]
//! to select the target output and exposes CPU-readable frames via [`crate::frame::FrameBuffer`].
//!
//! # Example
//! ```no_run
//! use windows_capture::dxgi_duplication_api::DxgiDuplicationApi;
//! use windows_capture::encoder::ImageFormat;
//! use windows_capture::monitor::Monitor;
//!
//! fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     // Select the primary monitor
//!     let monitor = Monitor::primary()?;
//!
//!     // Create a duplication session for this monitor
//!     let mut dup = DxgiDuplicationApi::new(monitor)?;
//!
//!     // Try to grab one frame within ~33ms (about 30 FPS budget)
//!     let mut frame = dup.acquire_next_frame(33)?;
//!
//!     // Map the GPU image into CPU memory and save a PNG
//!     let mut buffer = frame.buffer()?;
//!     buffer.save_as_image("dup.png", ImageFormat::Png)?;
//!     Ok(())
//! }
//! ```
use std::path::Path;
use std::{fs, io};

use rayon::iter::{IntoParallelIterator, ParallelIterator};
use windows::Win32::Foundation::E_ACCESSDENIED;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BOX, D3D11_TEXTURE2D_DESC, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_R16G16B16A16_FLOAT,
};
use windows::Win32::Graphics::Dxgi::{
    DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_NOT_FOUND, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_DESC, DXGI_OUTDUPL_FRAME_INFO,
    IDXGIDevice4, IDXGIOutput6, IDXGIOutputDuplication,
};
use windows::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext};
use windows::core::Interface;

use crate::d3d11::{MappedStagingTexture, StagingTexture, create_d3d_device, unmap_staging_texture};
use crate::encoder::{ImageEncoder, ImageEncoderError, ImageEncoderPixelFormat, ImageFormat};
use crate::monitor::Monitor;

/// Errors that can occur while using the DXGI Desktop Duplication API wrapper.
#[derive(thiserror::Error, Debug)]
pub enum Error {
    /// The crop rectangle is invalid (start >= end on either axis).
    #[error("Invalid crop size")]
    InvalidSize,
    /// Failed to find a DXGI output that corresponds to the provided monitor.
    #[error("Failed to find DXGI output for the specified monitor")]
    OutputNotFound,
    /// AcquireNextFrame timed out without a new frame becoming available.
    #[error("AcquireNextFrame timed out")]
    Timeout,
    /// The duplication access was lost and must be recreated.
    #[error("Duplication access lost; the duplication must be recreated")]
    AccessLost,
    /// DirectX device creation or related error.
    #[error("DirectX error: {0}")]
    DirectXError(#[from] crate::d3d11::Error),
    /// Invalid or mismatched staging texture supplied to [`DxgiDuplicationFrame::buffer_with`].
    #[error("Invalid staging texture: {0}")]
    InvalidStagingTexture(&'static str),
    /// A DXGI/D3D call reported success but did not populate the requested output value.
    #[error("Windows API succeeded but did not return {0}")]
    UnexpectedNullResult(&'static str),
    /// Image encoding failed.
    ///
    /// Wraps [`crate::encoder::ImageEncoderError`].
    #[error("Failed to encode the image buffer to image bytes with the specified format: {0}")]
    ImageEncoderError(#[from] crate::encoder::ImageEncoderError),
    /// An I/O error occurred while writing the image to disk.
    ///
    /// Wraps [`std::io::Error`].
    #[error("I/O error: {0}")]
    IoError(#[from] io::Error),
    /// Windows API error.
    #[error("Windows API error: {0}")]
    WindowsError(#[from] windows::core::Error),
}

/// Supported DXGI formats for duplication.
#[derive(Eq, PartialEq, Clone, Copy, Debug)]
pub enum DxgiDuplicationFormat {
    /// 16-bit float RGBA format.
    Rgba16F,
    /// 8-bit RGBA format.
    Rgba8,
    /// 8-bit BGRA format.
    Bgra8,
}

const DEFAULT_DUPLICATION_FORMATS: [DXGI_FORMAT; 3] =
    [DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_B8G8R8A8_UNORM];

/// A minimal, ergonomic wrapper around the DXGI Desktop Duplication API for capturing a monitor.
///
/// This wrapper focuses on staying close to the native API while providing a simple Rust interface.
/// It integrates with [`crate::monitor::Monitor`] to select the target output.
pub struct DxgiDuplicationApi {
    /// Direct3D 11 device used for duplication operations.
    d3d_device: ID3D11Device,
    /// Direct3D 11 device context used for copy/map operations.
    d3d_device_context: ID3D11DeviceContext,
    /// The duplication interface used to acquire frames.
    duplication: IDXGIOutputDuplication,
    /// Description of the duplication, including format and dimensions.
    duplication_desc: DXGI_OUTDUPL_DESC,
    /// The DXGI device associated with the Direct3D device.
    dxgi_device: IDXGIDevice4,
    /// The DXGI output associated with this duplication.
    output: IDXGIOutput6,
    /// Whether the internal staging texture is currently holding a frame.
    is_holding_frame: bool,
}

fn enable_per_monitor_dpi_awareness() -> Result<(), Error> {
    match unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) } {
        Ok(()) => Ok(()),
        Err(error) if error.code() == E_ACCESSDENIED => Ok(()),
        Err(error) => Err(Error::WindowsError(error)),
    }
}

fn find_output_for_monitor(dxgi_device: &IDXGIDevice4, monitor: Monitor) -> Result<IDXGIOutput6, Error> {
    let adapter = unsafe { dxgi_device.GetAdapter()? };
    let mut index = 0u32;

    loop {
        match unsafe { adapter.EnumOutputs(index) } {
            Ok(output) => {
                let desc = unsafe { output.GetDesc()? };
                if desc.Monitor.0 == monitor.as_raw_hmonitor() {
                    return Ok(output.cast::<IDXGIOutput6>()?);
                }
                index += 1;
            }
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => return Err(Error::OutputNotFound),
            Err(error) => return Err(Error::WindowsError(error)),
        }
    }
}

fn map_supported_formats(supported_formats: &[DxgiDuplicationFormat]) -> Vec<DXGI_FORMAT> {
    let mut supported_formats = supported_formats
        .iter()
        .map(|format| match format {
            DxgiDuplicationFormat::Rgba16F => DXGI_FORMAT_R16G16B16A16_FLOAT,
            DxgiDuplicationFormat::Rgba8 => DXGI_FORMAT_R8G8B8A8_UNORM,
            DxgiDuplicationFormat::Bgra8 => DXGI_FORMAT_B8G8R8A8_UNORM,
        })
        .collect::<Vec<_>>();

    if !supported_formats.contains(&DXGI_FORMAT_B8G8R8A8_UNORM) {
        supported_formats.push(DXGI_FORMAT_B8G8R8A8_UNORM);
    }

    supported_formats
}

impl DxgiDuplicationApi {
    fn release_frame_if_needed(&mut self) -> Result<(), Error> {
        if !self.is_holding_frame {
            return Ok(());
        }

        match unsafe { self.duplication.ReleaseFrame() } {
            Ok(()) => {
                self.is_holding_frame = false;
                Ok(())
            }
            Err(error) if error.code() == DXGI_ERROR_ACCESS_LOST => Err(Error::AccessLost),
            Err(error) => Err(Error::WindowsError(error)),
        }
    }

    fn recreate_with_formats(mut self, supported_formats: &[DXGI_FORMAT]) -> Result<Self, Error> {
        let _ = self.release_frame_if_needed();

        // Keep the device/output alive, but release the existing duplication interface before
        // asking DXGI for its replacement. `DuplicateOutput1` may reject a second live
        // duplication for the same output.
        let d3d_device = self.d3d_device.clone();
        let d3d_device_context = self.d3d_device_context.clone();
        let dxgi_device = self.dxgi_device.clone();
        let output = self.output.clone();
        drop(self);

        let duplication = unsafe { output.DuplicateOutput1(&d3d_device, 0, supported_formats)? };
        let duplication_desc = unsafe { duplication.GetDesc() };

        Ok(Self {
            d3d_device,
            d3d_device_context,
            duplication,
            duplication_desc,
            dxgi_device,
            output,
            is_holding_frame: false,
        })
    }

    /// Constructs a new duplication session for the specified monitor.
    ///
    /// Internally creates a Direct3D 11 device and immediate context using the crate's d3d11
    /// module.
    pub fn new(monitor: Monitor) -> Result<Self, Error> {
        // Create D3D11 device and context.
        let (d3d_device, d3d_device_context) = create_d3d_device()?;

        let dxgi_device = d3d_device.cast::<IDXGIDevice4>()?;
        let output = find_output_for_monitor(&dxgi_device, monitor)?;
        enable_per_monitor_dpi_awareness()?;

        // Restrict the duplication to the crate-supported DXGI formats.
        let duplication = unsafe { output.DuplicateOutput1(&d3d_device, 0, &DEFAULT_DUPLICATION_FORMATS)? };

        // Get the duplication description to determine the format for our internal texture.
        let duplication_desc = unsafe { duplication.GetDesc() };

        Ok(Self {
            d3d_device,
            d3d_device_context,
            duplication,
            duplication_desc,
            dxgi_device,
            output,
            is_holding_frame: false,
        })
    }

    /// Constructs a new duplication session for the specified monitor, using a custom list of
    /// supported DXGI formats.
    ///
    /// This method lets callers prefer any subset of the crate-supported DXGI formats.
    /// `Bgra8` is inserted because it is widely supported and serves as a reliable fallback.
    pub fn new_options(monitor: Monitor, supported_formats: &[DxgiDuplicationFormat]) -> Result<Self, Error> {
        // Create D3D11 device and context.
        let (d3d_device, d3d_device_context) = create_d3d_device()?;

        let dxgi_device = d3d_device.cast::<IDXGIDevice4>()?;
        let output = find_output_for_monitor(&dxgi_device, monitor)?;
        let supported_formats = map_supported_formats(supported_formats);
        enable_per_monitor_dpi_awareness()?;

        // Create the duplication for this output using the supplied D3D11 device.
        let duplication = unsafe { output.DuplicateOutput1(&d3d_device, 0, &supported_formats)? };

        // Get the duplication description to determine the format for our internal texture.
        let duplication_desc = unsafe { duplication.GetDesc() };

        Ok(Self {
            d3d_device,
            d3d_device_context,
            duplication,
            duplication_desc,
            dxgi_device,
            output,
            is_holding_frame: false,
        })
    }

    /// Recreates the duplication interface, mostly used after receiving an [`Error::AccessLost`]
    /// error from [`DxgiDuplicationApi::acquire_next_frame`].
    pub fn recreate(self) -> Result<Self, Error> {
        self.recreate_with_formats(&DEFAULT_DUPLICATION_FORMATS)
    }

    /// Recreates the duplication interface with a custom list of supported DXGI formats, mostly
    /// used after receiving an [`Error::AccessLost`] error from
    /// [`DxgiDuplicationApi::acquire_next_frame`].
    pub fn recreate_options(self, supported_formats: &[DxgiDuplicationFormat]) -> Result<Self, Error> {
        let supported_formats = map_supported_formats(supported_formats);
        self.recreate_with_formats(&supported_formats)
    }

    /// Gets the underlying [`windows::Win32::Graphics::Direct3D11::ID3D11Device`] associated with
    /// this object.
    #[inline]
    #[must_use]
    pub const fn device(&self) -> &ID3D11Device {
        &self.d3d_device
    }

    /// Gets the underlying [`windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext`] used for
    /// GPU operations.
    #[inline]
    #[must_use]
    pub const fn device_context(&self) -> &ID3D11DeviceContext {
        &self.d3d_device_context
    }

    /// Gets the underlying [`windows::Win32::Graphics::Dxgi::IDXGIOutputDuplication`] interface.
    #[inline]
    #[must_use]
    pub const fn duplication(&self) -> &IDXGIOutputDuplication {
        &self.duplication
    }

    /// Gets the [`windows::Win32::Graphics::Dxgi::DXGI_OUTDUPL_DESC`] of the duplication.
    #[inline]
    #[must_use]
    pub const fn duplication_desc(&self) -> &DXGI_OUTDUPL_DESC {
        &self.duplication_desc
    }

    /// Gets the underlying [`windows::Win32::Graphics::Dxgi::IDXGIDevice4`] interface.
    #[inline]
    #[must_use]
    pub const fn dxgi_device(&self) -> &IDXGIDevice4 {
        &self.dxgi_device
    }

    /// Gets the underlying [`windows::Win32::Graphics::Dxgi::IDXGIOutput6`] interface.
    #[inline]
    #[must_use]
    pub const fn output(&self) -> &IDXGIOutput6 {
        &self.output
    }

    /// Gets the width of the duplication.
    #[inline]
    #[must_use]
    pub const fn width(&self) -> u32 {
        self.duplication_desc.ModeDesc.Width
    }

    /// Gets the height of the duplication.
    #[inline]
    #[must_use]
    pub const fn height(&self) -> u32 {
        self.duplication_desc.ModeDesc.Height
    }

    /// Gets the pixel format of the duplication.
    #[inline]
    #[must_use]
    pub const fn format(&self) -> DxgiDuplicationFormat {
        match self.duplication_desc.ModeDesc.Format {
            DXGI_FORMAT_R16G16B16A16_FLOAT => DxgiDuplicationFormat::Rgba16F,
            DXGI_FORMAT_R8G8B8A8_UNORM => DxgiDuplicationFormat::Rgba8,
            DXGI_FORMAT_B8G8R8A8_UNORM => DxgiDuplicationFormat::Bgra8,
            _ => unreachable!(),
        }
    }

    /// Gets the refresh rate of the duplication as (numerator, denominator).
    #[inline]
    #[must_use]
    pub const fn refresh_rate(&self) -> (u32, u32) {
        (self.duplication_desc.ModeDesc.RefreshRate.Numerator, self.duplication_desc.ModeDesc.RefreshRate.Denominator)
    }

    /// Acquires the next frame and updates the internal texture.
    ///
    /// This call will block up to `timeout_ms` milliseconds. If no new frame arrives within
    /// the timeout, [`Error::Timeout`] is returned. If duplication access is lost,
    /// [`Error::AccessLost`] is returned and a new duplication should be recreated.
    ///
    /// Main reasons for [`Error::AccessLost`] include:
    /// - The display mode of the output changed (e.g. resolution or color format change).
    /// - The user switched to a different desktop (e.g. via Ctrl+Alt+Del or Fast User Switching).
    /// - Switch from DWM on, DWM off, or other full-screen application
    ///
    /// The returned [`DxgiDuplicationFrame`] allows you to map the current full desktop image via
    /// [`DxgiDuplicationFrame::buffer`]. It contains the list of dirty rectangles reported for this
    /// frame.
    ///
    /// # Errors
    /// - [`Error::Timeout`] when no frame arrives within `timeout_ms`
    /// - [`Error::AccessLost`] when duplication access is lost and must be recreated
    /// - [`Error::WindowsError`] for other Windows API failures during frame acquisition
    #[inline]
    pub fn acquire_next_frame(&mut self, timeout_ms: u32) -> Result<DxgiDuplicationFrame<'_>, Error> {
        let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource = None;

        // Release the previous frame if we were holding one
        self.release_frame_if_needed()?;

        // Acquire frame
        match unsafe { self.duplication.AcquireNextFrame(timeout_ms, &mut frame_info, &mut resource) } {
            Ok(()) => (),
            Err(e) => {
                if e.code() == DXGI_ERROR_WAIT_TIMEOUT {
                    return Err(Error::Timeout);
                } else if e.code() == DXGI_ERROR_ACCESS_LOST {
                    return Err(Error::AccessLost);
                } else {
                    return Err(Error::WindowsError(e));
                }
            }
        }
        self.is_holding_frame = true;

        let resource = resource.ok_or(Error::UnexpectedNullResult("an acquired DXGI frame resource"))?;

        // Convert the resource to an ID3D11Texture2D.
        let frame_texture = resource.cast::<ID3D11Texture2D>()?;

        // Obtain texture description to get size/format details.
        let mut frame_desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { frame_texture.GetDesc(&mut frame_desc) };

        Ok(DxgiDuplicationFrame {
            d3d_device: &self.d3d_device,
            d3d_device_context: &self.d3d_device_context,
            duplication: &self.duplication,
            texture: frame_texture,
            texture_desc: frame_desc,
            frame_info,
        })
    }
}

impl Drop for DxgiDuplicationApi {
    fn drop(&mut self) {
        let _ = self.release_frame_if_needed();
    }
}

/// Represents a pre-assembled full desktop image for the current frame,
/// backed by the internal GPU texture.
/// Call [`DxgiDuplicationFrame::buffer`] to obtain a CPU-readable [`crate::frame::FrameBuffer`].
pub struct DxgiDuplicationFrame<'a> {
    d3d_device: &'a ID3D11Device,
    d3d_device_context: &'a ID3D11DeviceContext,
    duplication: &'a IDXGIOutputDuplication,
    texture: ID3D11Texture2D,
    texture_desc: D3D11_TEXTURE2D_DESC,
    frame_info: DXGI_OUTDUPL_FRAME_INFO,
}

impl<'a> DxgiDuplicationFrame<'a> {
    /// Gets the width of the frame.
    #[inline]
    #[must_use]
    pub const fn width(&self) -> u32 {
        self.texture_desc.Width
    }

    /// Gets the height of the frame.
    #[inline]
    #[must_use]
    pub const fn height(&self) -> u32 {
        self.texture_desc.Height
    }

    /// Gets the pixel format of the frame.
    #[inline]
    #[must_use]
    pub const fn format(&self) -> DxgiDuplicationFormat {
        match self.texture_desc.Format {
            DXGI_FORMAT_R16G16B16A16_FLOAT => DxgiDuplicationFormat::Rgba16F,
            DXGI_FORMAT_R8G8B8A8_UNORM => DxgiDuplicationFormat::Rgba8,
            DXGI_FORMAT_B8G8R8A8_UNORM => DxgiDuplicationFormat::Bgra8,
            _ => unreachable!(),
        }
    }

    /// Gets the underlying Direct3D device associated with this frame.
    #[inline]
    #[must_use]
    pub const fn device(&self) -> &ID3D11Device {
        self.d3d_device
    }

    /// Gets the underlying Direct3D device context used for GPU operations.
    #[inline]
    #[must_use]
    pub const fn device_context(&self) -> &ID3D11DeviceContext {
        self.d3d_device_context
    }

    /// Gets the underlying IDXGIOutputDuplication interface.
    #[inline]
    #[must_use]
    pub const fn duplication(&self) -> &IDXGIOutputDuplication {
        self.duplication
    }

    /// Gets the underlying [`windows::Win32::Graphics::Direct3D11::ID3D11Texture2D`] interface.
    #[inline]
    #[must_use]
    pub const fn texture(&self) -> &ID3D11Texture2D {
        &self.texture
    }

    /// Gets the [`windows::Win32::Graphics::Direct3D11::D3D11_TEXTURE2D_DESC`] of the underlying
    /// texture.
    #[inline]
    #[must_use]
    pub const fn texture_desc(&self) -> &D3D11_TEXTURE2D_DESC {
        &self.texture_desc
    }

    /// Gets the frame information for the current frame.
    #[inline]
    #[must_use]
    pub const fn frame_info(&self) -> &DXGI_OUTDUPL_FRAME_INFO {
        &self.frame_info
    }

    /// Maps the internal frame into CPU accessible memory and returns a
    /// [`crate::frame::FrameBuffer`].
    ///
    /// This creates a staging texture, copies the internal texture into it,
    /// and maps it for CPU read/write. The returned buffer may include row padding;
    /// you can use [`crate::frame::FrameBuffer::as_nopadding_buffer`] to obtain a packed
    /// representation.
    #[inline]
    pub fn buffer<'b>(&'b mut self) -> Result<DxgiDuplicationFrameBuffer<'b>, Error> {
        let staging = StagingTexture::new(
            self.d3d_device,
            self.texture_desc.Width,
            self.texture_desc.Height,
            self.texture_desc.Format,
        )?;

        // Copy from the internal GPU texture into the staging texture
        unsafe {
            self.d3d_device_context.CopyResource(staging.texture(), &self.texture);
        }

        let mapped_texture = MappedStagingTexture::map_owned(self.d3d_device_context, staging)?;

        Ok(DxgiDuplicationFrameBuffer::from_mapped(
            mapped_texture,
            self.texture_desc.Width,
            self.texture_desc.Height,
            self.format(),
        ))
    }

    /// Gets a cropped frame buffer of the duplication frame.
    #[inline]
    pub fn buffer_crop<'b>(
        &'b mut self,
        start_x: u32,
        start_y: u32,
        end_x: u32,
        end_y: u32,
    ) -> Result<DxgiDuplicationFrameBuffer<'b>, Error> {
        if start_x >= end_x || start_y >= end_y {
            return Err(Error::InvalidSize);
        }

        let texture_width = end_x - start_x;
        let texture_height = end_y - start_y;

        let staging = StagingTexture::new(self.d3d_device, texture_width, texture_height, self.texture_desc.Format)?;

        // Define the source box to copy from the duplication texture
        let src_box = D3D11_BOX { left: start_x, top: start_y, front: 0, right: end_x, bottom: end_y, back: 1 };

        // Copy the selected region into the staging texture at (0,0)
        unsafe {
            self.d3d_device_context.CopySubresourceRegion(
                staging.texture(),
                0,
                0,
                0,
                0,
                &self.texture,
                0,
                Some(&src_box),
            );
        }

        let mapped_texture = MappedStagingTexture::map_owned(self.d3d_device_context, staging)?;

        Ok(DxgiDuplicationFrameBuffer::from_mapped(mapped_texture, texture_width, texture_height, self.format()))
    }

    /// Advanced: reuse your own CPU staging texture ([`crate::d3d11::StagingTexture`]).
    ///
    /// This avoids per-frame allocations and lets you manage the texture’s lifetime.
    /// The `staging` texture must be a `D3D11_USAGE_STAGING` 2D texture with CPU read/write access,
    /// matching the frame’s width/height/format.
    #[inline]
    pub fn buffer_with<'s>(
        &'s mut self,
        staging: &'s mut StagingTexture,
    ) -> Result<DxgiDuplicationFrameBuffer<'s>, Error> {
        // Validate geometry/format match.
        let desc = staging.desc();
        if desc.Width != self.texture_desc.Width || desc.Height != self.texture_desc.Height {
            return Err(Error::InvalidStagingTexture("geometry must match the frame"));
        }
        if desc.Format != self.texture_desc.Format {
            return Err(Error::InvalidStagingTexture("format must match the frame"));
        }

        unmap_staging_texture(self.d3d_device_context, staging);

        // Copy the acquired duplication texture into the provided staging texture
        unsafe {
            self.d3d_device_context.CopyResource(staging.texture(), &self.texture);
        }

        let mapped_texture = MappedStagingTexture::map_borrowed(self.d3d_device_context, staging)?;

        Ok(DxgiDuplicationFrameBuffer::from_mapped(
            mapped_texture,
            self.texture_desc.Width,
            self.texture_desc.Height,
            self.format(),
        ))
    }

    /// Advanced: cropped buffer using a preallocated staging texture.
    /// The provided staging texture must be a D3D11_USAGE_STAGING 2D texture with CPU read/write
    /// access, of the same format as the duplication frame, and large enough to contain the
    /// crop region.
    #[inline]
    pub fn buffer_crop_with<'s>(
        &'s mut self,
        staging: &'s mut StagingTexture,
        start_x: u32,
        start_y: u32,
        end_x: u32,
        end_y: u32,
    ) -> Result<DxgiDuplicationFrameBuffer<'s>, Error> {
        // Validate crop rectangle
        if start_x >= end_x || start_y >= end_y {
            return Err(Error::InvalidSize);
        }

        let crop_width = end_x - start_x;
        let crop_height = end_y - start_y;

        // Validate format and capacity
        let desc = staging.desc();
        if desc.Format != self.texture_desc.Format {
            return Err(Error::InvalidStagingTexture("format must match the frame"));
        }
        if desc.Width < crop_width || desc.Height < crop_height {
            return Err(Error::InvalidStagingTexture("staging texture too small for crop region"));
        }

        unmap_staging_texture(self.d3d_device_context, staging);

        // Define the source region to copy
        let src_box = D3D11_BOX { left: start_x, top: start_y, front: 0, right: end_x, bottom: end_y, back: 1 };

        // Copy the selected region to the top-left of the staging texture
        unsafe {
            self.d3d_device_context.CopySubresourceRegion(
                staging.texture(),
                0,
                0,
                0,
                0,
                &self.texture,
                0,
                Some(&src_box),
            );
        }

        let mapped_texture = MappedStagingTexture::map_borrowed(self.d3d_device_context, staging)?;

        Ok(DxgiDuplicationFrameBuffer::from_mapped(mapped_texture, crop_width, crop_height, self.format()))
    }

    /// Saves the frame buffer as an image to the specified path.
    #[inline]
    pub fn save_as_image<T: AsRef<Path>>(&mut self, path: T, format: ImageFormat) -> Result<(), Error> {
        let mut frame_buffer = self.buffer()?;

        frame_buffer.save_as_image(path, format)?;

        Ok(())
    }
}

/// Represents a frame buffer containing pixel data.
///
/// # Example
/// ```ignore
/// // Get a frame from the capture session
/// let mut buffer = frame.buffer()?;
/// buffer.save_as_image("screenshot.png", ImageFormat::Png)?;
/// ```
enum DxgiDuplicationFrameBufferBacking<'a> {
    Borrowed(&'a mut [u8]),
    Mapped(MappedStagingTexture<'a>),
}

impl DxgiDuplicationFrameBufferBacking<'_> {
    const fn as_slice(&self, height: u32) -> &[u8] {
        match self {
            Self::Borrowed(buffer) => buffer,
            Self::Mapped(texture) => texture.as_slice(height),
        }
    }

    const fn as_mut_slice(&mut self, height: u32) -> &mut [u8] {
        match self {
            Self::Borrowed(buffer) => buffer,
            Self::Mapped(texture) => texture.as_mut_slice(height),
        }
    }
}

/// Represents a CPU-readable frame buffer produced from a duplication frame.
pub struct DxgiDuplicationFrameBuffer<'a> {
    backing: DxgiDuplicationFrameBufferBacking<'a>,
    width: u32,
    height: u32,
    row_pitch: u32,
    depth_pitch: u32,
    format: DxgiDuplicationFormat,
}

impl<'a> DxgiDuplicationFrameBuffer<'a> {
    /// Constructs a new `FrameBuffer`.
    #[inline]
    #[must_use]
    pub const fn new(
        raw_buffer: &'a mut [u8],
        width: u32,
        height: u32,
        row_pitch: u32,
        depth_pitch: u32,
        format: DxgiDuplicationFormat,
    ) -> Self {
        Self {
            backing: DxgiDuplicationFrameBufferBacking::Borrowed(raw_buffer),
            width,
            height,
            row_pitch,
            depth_pitch,
            format,
        }
    }

    const fn from_mapped(
        mapped_texture: MappedStagingTexture<'a>,
        width: u32,
        height: u32,
        format: DxgiDuplicationFormat,
    ) -> Self {
        let row_pitch = mapped_texture.row_pitch();
        let depth_pitch = mapped_texture.depth_pitch();

        Self {
            backing: DxgiDuplicationFrameBufferBacking::Mapped(mapped_texture),
            width,
            height,
            row_pitch,
            depth_pitch,
            format,
        }
    }

    /// Gets the width of the frame buffer.
    #[inline]
    #[must_use]
    pub const fn width(&self) -> u32 {
        self.width
    }

    /// Gets the height of the frame buffer.
    #[inline]
    #[must_use]
    pub const fn height(&self) -> u32 {
        self.height
    }

    /// Gets the row pitch of the frame buffer.
    #[inline]
    #[must_use]
    pub const fn row_pitch(&self) -> u32 {
        self.row_pitch
    }

    /// Gets the depth pitch of the frame buffer.
    #[inline]
    #[must_use]
    pub const fn depth_pitch(&self) -> u32 {
        self.depth_pitch
    }

    /// Gets the color format of the frame buffer.
    #[inline]
    #[must_use]
    pub const fn format(&self) -> DxgiDuplicationFormat {
        self.format
    }

    /// Checks if the buffer has padding.
    #[inline]
    #[must_use]
    pub const fn has_padding(&self) -> bool {
        self.width * self.bytes_per_pixel() != self.row_pitch
    }

    /// Gets the pixel data without padding.
    #[inline]
    #[must_use]
    pub fn as_nopadding_buffer<'b>(&'b self, buffer: &'b mut Vec<u8>) -> &'b [u8] {
        let raw_buffer = self.backing.as_slice(self.height);

        if !self.has_padding() {
            return raw_buffer;
        }

        let width = self.width;
        let height = self.height;
        let row_pitch = self.row_pitch;
        let multiplier = self.bytes_per_pixel();
        let frame_size = (width * height * multiplier) as usize;
        if buffer.len() < frame_size {
            buffer.resize(frame_size, 0);
        }

        let width_size = (width * multiplier) as usize;
        let buffer_address = buffer.as_mut_ptr() as usize;
        let raw_buffer_address = raw_buffer.as_ptr() as usize;
        (0..height).into_par_iter().for_each(|y| {
            let index = (y * row_pitch) as usize;
            let src = raw_buffer_address as *const u8;
            let dst = buffer_address as *mut u8;

            unsafe {
                std::ptr::copy_nonoverlapping(src.add(index), dst.add(y as usize * width_size), width_size);
            }
        });

        &buffer[0..frame_size]
    }

    /// Gets the raw pixel data, which may include padding.
    #[inline]
    #[must_use]
    pub const fn as_raw_buffer(&mut self) -> &mut [u8] {
        self.backing.as_mut_slice(self.height)
    }

    /// Saves the frame buffer as an image to the specified path.
    #[inline]
    pub fn save_as_image<T: AsRef<Path>>(&mut self, path: T, format: ImageFormat) -> Result<(), Error> {
        let width = self.width;
        let height = self.height;

        let pixel_format = match self.format {
            DxgiDuplicationFormat::Rgba8 => ImageEncoderPixelFormat::Rgba8,
            DxgiDuplicationFormat::Bgra8 => ImageEncoderPixelFormat::Bgra8,
            _ => return Err(ImageEncoderError::UnsupportedFormat.into()),
        };

        let mut buffer = Vec::new();
        let bytes =
            ImageEncoder::new(format, pixel_format)?.encode(self.as_nopadding_buffer(&mut buffer), width, height)?;

        fs::write(path, bytes)?;

        Ok(())
    }

    #[inline]
    #[must_use]
    const fn bytes_per_pixel(&self) -> u32 {
        match self.format {
            DxgiDuplicationFormat::Rgba16F => 8,
            DxgiDuplicationFormat::Rgba8 | DxgiDuplicationFormat::Bgra8 => 4,
        }
    }
}
