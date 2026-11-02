use std::fs::{self};
use std::path::Path;
use std::{io, ptr};

use rayon::iter::{IntoParallelIterator, ParallelIterator};
use windows::Foundation::TimeSpan;
use windows::Graphics::Capture::Direct3D11CaptureFrame;
use windows::Graphics::DirectX::Direct3D11::IDirect3DSurface;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BOX, D3D11_TEXTURE2D_DESC, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};

use crate::d3d11::{MappedStagingTexture, StagingTexture};
use crate::encoder::{self, ImageEncoder, ImageEncoderError, ImageEncoderPixelFormat, ImageFormat};
use crate::settings::ColorFormat;

#[derive(thiserror::Error, Debug)]
/// Errors that can occur while working with captured frames and buffers.
pub enum Error {
    /// The crop rectangle is invalid (start >= end on either axis).
    #[error("Invalid crop size")]
    InvalidSize,
    /// The configured title bar height is invalid (greater than or equal to the frame height).
    #[error("Invalid title bar height")]
    InvalidTitleBarSize,
    /// The current [`ColorFormat`] cannot be saved as an image.
    #[error("This color format is not supported for saving as an image")]
    UnsupportedFormat,
    /// Direct3D staging/mapping failed.
    #[error("DirectX error: {0}")]
    DirectXError(#[from] crate::d3d11::Error),
    /// Image encoding failed.
    ///
    /// Wraps [`crate::encoder::ImageEncoderError`].
    #[error("Failed to encode the image buffer to image bytes with the specified format: {0}")]
    ImageEncoderError(#[from] encoder::ImageEncoderError),
    /// An I/O error occurred while writing the image to disk.
    ///
    /// Wraps [`std::io::Error`].
    #[error("I/O error: {0}")]
    IoError(#[from] io::Error),
    /// A Windows API call failed.
    ///
    /// Wraps [`windows::core::Error`].
    #[error("Windows API error: {0}")]
    WindowsError(#[from] windows::core::Error),
}

/// Represents a rectangular dirty region within a frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DirtyRegion {
    /// The left coordinate (in pixels) of the region.
    pub x: i32,
    /// The top coordinate (in pixels) of the region.
    pub y: i32,
    /// The width (in pixels) of the region.
    pub width: i32,
    /// The height (in pixels) of the region.
    pub height: i32,
}

/// Represents a frame captured from a graphics capture item.
///
/// # Example
/// ```ignore
/// // Get a frame from the capture session
/// let mut buffer = frame.buffer()?;
/// buffer.save_as_image("screenshot.png", ImageFormat::Png)?;
/// ```
pub struct Frame<'a> {
    capture_frame: Direct3D11CaptureFrame,
    d3d_device: &'a ID3D11Device,
    frame_surface: IDirect3DSurface,
    frame_texture: ID3D11Texture2D,
    context: &'a ID3D11DeviceContext,
    desc: D3D11_TEXTURE2D_DESC,
    color_format: ColorFormat,
    title_bar_height: Option<u32>,
}

impl<'a> Frame<'a> {
    /// Constructs a new `Frame`.
    #[allow(clippy::too_many_arguments)]
    #[inline]
    #[must_use]
    pub const fn new(
        capture_frame: Direct3D11CaptureFrame,
        d3d_device: &'a ID3D11Device,
        frame_surface: IDirect3DSurface,
        frame_texture: ID3D11Texture2D,
        context: &'a ID3D11DeviceContext,
        desc: D3D11_TEXTURE2D_DESC,
        color_format: ColorFormat,
        title_bar_height: Option<u32>,
    ) -> Self {
        Self { capture_frame, d3d_device, frame_surface, frame_texture, context, desc, color_format, title_bar_height }
    }

    /// Gets the width of the frame.
    #[inline]
    #[must_use]
    pub const fn width(&self) -> u32 {
        self.desc.Width
    }
    /// Gets the dirty regions of the frame.
    #[inline]
    pub fn dirty_regions(&self) -> Result<Vec<DirtyRegion>, windows::core::Error> {
        Ok(self
            .capture_frame
            .DirtyRegions()?
            .into_iter()
            .map(|r| DirtyRegion { x: r.X, y: r.Y, width: r.Width, height: r.Height })
            .collect())
    }

    /// Gets the height of the frame.
    #[inline]
    #[must_use]
    pub const fn height(&self) -> u32 {
        self.desc.Height
    }

    /// Gets the timestamp of the frame.
    #[inline]
    pub fn timestamp(&self) -> Result<TimeSpan, windows::core::Error> {
        self.capture_frame.SystemRelativeTime()
    }

    /// Gets the color format of the frame.
    #[inline]
    #[must_use]
    pub const fn color_format(&self) -> ColorFormat {
        self.color_format
    }

    /// Gets the raw surface of the frame.
    #[inline]
    #[must_use]
    pub const fn as_raw_surface(&self) -> &IDirect3DSurface {
        &self.frame_surface
    }

    /// Gets the raw texture of the frame.
    #[inline]
    #[must_use]
    pub const fn as_raw_texture(&self) -> &ID3D11Texture2D {
        &self.frame_texture
    }

    /// Gets the underlying Direct3D device associated with this frame.
    #[inline]
    #[must_use]
    pub const fn device(&self) -> &ID3D11Device {
        self.d3d_device
    }

    /// Gets the device context used for GPU operations on this frame.
    #[inline]
    #[must_use]
    pub const fn device_context(&self) -> &ID3D11DeviceContext {
        self.context
    }

    /// Gets the texture description of the frame.
    #[inline]
    #[must_use]
    pub const fn desc(&self) -> &D3D11_TEXTURE2D_DESC {
        &self.desc
    }

    /// Gets the frame buffer.
    #[inline]
    pub fn buffer(&'_ mut self) -> Result<FrameBuffer<'_>, Error> {
        let staging = StagingTexture::new(self.d3d_device, self.width(), self.height(), self.desc.Format)?;

        // Copy the GPU texture into a CPU-readable staging texture before mapping it.
        unsafe {
            self.context.CopyResource(staging.texture(), &self.frame_texture);
        }

        let mapped_texture = MappedStagingTexture::map_owned(self.context, staging)?;

        Ok(FrameBuffer::from_mapped(mapped_texture, self.width(), self.height(), self.color_format))
    }

    /// Gets a cropped frame buffer.
    #[inline]
    pub fn buffer_crop(
        &'_ mut self,
        start_x: u32,
        start_y: u32,
        end_x: u32,
        end_y: u32,
    ) -> Result<FrameBuffer<'_>, Error> {
        if start_x >= end_x || start_y >= end_y {
            return Err(Error::InvalidSize);
        }

        let texture_width = end_x - start_x;
        let texture_height = end_y - start_y;

        let staging = StagingTexture::new(self.d3d_device, texture_width, texture_height, self.desc.Format)?;

        // Box settings
        let resource_box = D3D11_BOX { left: start_x, top: start_y, front: 0, right: end_x, bottom: end_y, back: 1 };

        // Copy the requested sub-rectangle into a CPU-readable staging texture.
        unsafe {
            self.context.CopySubresourceRegion(
                staging.texture(),
                0,
                0,
                0,
                0,
                &self.frame_texture,
                0,
                Some(&resource_box),
            );
        }

        let mapped_texture = MappedStagingTexture::map_owned(self.context, staging)?;

        Ok(FrameBuffer::from_mapped(mapped_texture, texture_width, texture_height, self.color_format))
    }

    /// Gets the frame buffer without the title bar.
    #[inline]
    pub fn buffer_without_title_bar(&'_ mut self) -> Result<FrameBuffer<'_>, Error> {
        if let Some(title_bar_height) = self.title_bar_height {
            if title_bar_height >= self.height() {
                return Err(Error::InvalidTitleBarSize);
            }

            self.buffer_crop(0, title_bar_height, self.width(), self.height())
        } else {
            self.buffer()
        }
    }

    /// Saves the frame buffer as an image to the specified path.
    #[inline]
    pub fn save_as_image<T: AsRef<Path>>(&mut self, path: T, format: ImageFormat) -> Result<(), Error> {
        let mut frame_buffer = self.buffer()?;

        frame_buffer.save_as_image(path, format)?;

        Ok(())
    }
}

enum FrameBufferBacking<'a> {
    Borrowed(&'a mut [u8]),
    Mapped(MappedStagingTexture<'a>),
}

impl FrameBufferBacking<'_> {
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

/// Represents a frame buffer containing pixel data.
///
/// # Example
/// ```ignore
/// // Get a frame from the capture session
/// let mut buffer = frame.buffer()?;
/// buffer.save_as_image("screenshot.png", ImageFormat::Png)?;
/// ```
pub struct FrameBuffer<'a> {
    backing: FrameBufferBacking<'a>,
    width: u32,
    height: u32,
    row_pitch: u32,
    depth_pitch: u32,
    color_format: ColorFormat,
}

impl<'a> FrameBuffer<'a> {
    /// Constructs a new `FrameBuffer`.
    #[inline]
    #[must_use]
    pub const fn new(
        raw_buffer: &'a mut [u8],
        width: u32,
        height: u32,
        row_pitch: u32,
        depth_pitch: u32,
        color_format: ColorFormat,
    ) -> Self {
        Self { backing: FrameBufferBacking::Borrowed(raw_buffer), width, height, row_pitch, depth_pitch, color_format }
    }

    const fn from_mapped(
        mapped_texture: MappedStagingTexture<'a>,
        width: u32,
        height: u32,
        color_format: ColorFormat,
    ) -> Self {
        let row_pitch = mapped_texture.row_pitch();
        let depth_pitch = mapped_texture.depth_pitch();

        Self {
            backing: FrameBufferBacking::Mapped(mapped_texture),
            width,
            height,
            row_pitch,
            depth_pitch,
            color_format,
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
    pub const fn color_format(&self) -> ColorFormat {
        self.color_format
    }

    /// Checks if the buffer has padding.
    #[inline]
    #[must_use]
    pub const fn has_padding(&self) -> bool {
        self.width * self.bytes_per_pixel() != self.row_pitch
    }

    /// Gets the raw pixel data, which may include padding.
    #[inline]
    #[must_use]
    pub const fn as_raw_buffer(&mut self) -> &mut [u8] {
        self.backing.as_mut_slice(self.height)
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
                ptr::copy_nonoverlapping(src.add(index), dst.add(y as usize * width_size), width_size);
            }
        });

        &buffer[0..frame_size]
    }

    /// Saves the frame buffer as an image to the specified path.
    #[inline]
    pub fn save_as_image<T: AsRef<Path>>(&mut self, path: T, format: ImageFormat) -> Result<(), Error> {
        let width = self.width;
        let height = self.height;

        let pixel_format = match self.color_format {
            ColorFormat::Rgba8 => ImageEncoderPixelFormat::Rgba8,
            ColorFormat::Bgra8 => ImageEncoderPixelFormat::Bgra8,
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
        match self.color_format {
            ColorFormat::Rgba16F => 8,
            ColorFormat::Rgba8 | ColorFormat::Bgra8 => 4,
        }
    }
}
