use std::fs::{self, File};
use std::path::Path;
use std::sync::atomic::{self, AtomicBool};
use std::sync::{Arc, mpsc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use parking_lot::Mutex;
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Graphics::DirectX::Direct3D11::IDirect3DSurface;
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapEncoder, BitmapPixelFormat};
use windows::Media::Core::{
    AudioStreamDescriptor, MediaStreamSample, MediaStreamSource, MediaStreamSourceSampleRequestedEventArgs,
    MediaStreamSourceStartingEventArgs, VideoStreamDescriptor,
};
use windows::Media::MediaProperties::{
    AudioEncodingProperties, ContainerEncodingProperties, MediaEncodingProfile, MediaEncodingSubtypes,
    VideoEncodingProperties,
};
use windows::Media::Transcoding::MediaTranscoder;
use windows::Security::Cryptography::CryptographicBuffer;
use windows::Storage::Streams::{DataReader, IRandomAccessStream, InMemoryRandomAccessStream};
use windows::Storage::{FileAccessMode, StorageFile};
use windows::System::Threading::{ThreadPool, WorkItemHandler, WorkItemOptions, WorkItemPriority};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BOX, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    ID3D11Device, ID3D11RenderTargetView, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGISurface;
use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11SurfaceFromDXGISurface;
use windows::core::{HSTRING, Interface};

use crate::d3d11::SendDirectX;
use crate::frame::Frame;
use crate::settings::ColorFormat;

type VideoFrameReceiver = Arc<Mutex<mpsc::Receiver<Option<(VideoEncoderSource, TimeSpan)>>>>;
type AudioFrameReceiver = Arc<Mutex<mpsc::Receiver<Option<(AudioEncoderSource, TimeSpan)>>>>;

enum VideoHandoff { Accepted, Settled }

#[derive(thiserror::Error, Debug)]
/// Errors that can occur when encoding raw buffers to images via [`ImageEncoder`].
pub enum ImageEncoderError {
    /// The provided source pixel format is not supported for image encoding.
    ///
    /// This occurs for formats such as [`crate::settings::ColorFormat::Rgba16F`].
    #[error("This color format is not supported for saving as an image")]
    UnsupportedFormat,
    /// An I/O error occurred while writing the image to disk.
    ///
    /// Wraps [`std::io::Error`].
    #[error("I/O error: {0}")]
    IoError(#[from] std::io::Error),
    /// An integer conversion failed during buffer sizing or Windows API calls.
    ///
    /// Wraps [`std::num::TryFromIntError`].
    #[error("Integer conversion error: {0}")]
    IntConversionError(#[from] std::num::TryFromIntError),
    /// A Windows Runtime/Win32 API call failed.
    ///
    /// Wraps [`windows::core::Error`].
    #[error("Windows API error: {0}")]
    WindowsError(#[from] windows::core::Error),
}

#[derive(Eq, PartialEq, Clone, Copy, Debug)]
/// Supported output image formats for [`crate::encoder::ImageEncoder`].
pub enum ImageFormat {
    /// JPEG (lossy).
    Jpeg,
    /// PNG (lossless).
    Png,
    /// GIF (palette-based).
    Gif,
    /// TIFF (Tagged Image File Format).
    Tiff,
    /// BMP (Bitmap).
    Bmp,
    /// JPEG XR (HD Photo).
    JpegXr,
}

/// Pixel formats supported by the Windows API for image encoding.
#[derive(Eq, PartialEq, Clone, Copy, Debug)]
pub enum ImageEncoderPixelFormat {
    /// 16-bit floating-point RGBA format.
    Rgb16F,
    /// 8-bit unsigned integer BGRA format.
    Bgra8,
    /// 8-bit unsigned integer RGBA format.
    Rgba8,
}

/// Encodes raw image buffers into encoded bytes for common formats.
///
/// Supports saving as PNG, JPEG, GIF, TIFF, BMP, and JPEG XR when the input
/// color format is compatible.
///
/// # Example
/// ```no_run
/// use windows_capture::encoder::{ImageEncoder, ImageEncoderPixelFormat, ImageFormat};
///
/// let width = 320u32;
/// let height = 240u32;
/// // BGRA8 buffer (e.g., from a frame)
/// let bgra = vec![0u8; (width * height * 4) as usize];
///
/// let png_bytes = ImageEncoder::new(ImageFormat::Png, ImageEncoderPixelFormat::Bgra8)
///     .unwrap()
///     .encode(&bgra, width, height)
///     .unwrap();
///
/// std::fs::write("example.png", png_bytes).unwrap();
/// ```
pub struct ImageEncoder {
    encoder: windows::core::GUID,
    pixel_format: BitmapPixelFormat,
}

impl ImageEncoder {
    /// Constructs a new [`ImageEncoder`].
    #[inline]
    pub fn new(format: ImageFormat, pixel_format: ImageEncoderPixelFormat) -> Result<Self, ImageEncoderError> {
        let encoder = match format {
            ImageFormat::Jpeg => BitmapEncoder::JpegEncoderId()?,
            ImageFormat::Png => BitmapEncoder::PngEncoderId()?,
            ImageFormat::Gif => BitmapEncoder::GifEncoderId()?,
            ImageFormat::Tiff => BitmapEncoder::TiffEncoderId()?,
            ImageFormat::Bmp => BitmapEncoder::BmpEncoderId()?,
            ImageFormat::JpegXr => BitmapEncoder::JpegXREncoderId()?,
        };

        let pixel_format = match pixel_format {
            ImageEncoderPixelFormat::Bgra8 => BitmapPixelFormat::Bgra8,
            ImageEncoderPixelFormat::Rgba8 => BitmapPixelFormat::Rgba8,
            ImageEncoderPixelFormat::Rgb16F => BitmapPixelFormat::Rgba16,
        };

        Ok(Self { pixel_format, encoder })
    }

    /// Encodes the provided pixel buffer into the configured output [`ImageFormat`].
    ///
    /// The input buffer must match the specified source [`crate::settings::ColorFormat`]
    /// and dimensions. For packed 8-bit formats (e.g., [`crate::settings::ColorFormat::Bgra8`]),
    /// the buffer length should be `width * height * 4`.
    ///
    /// # Errors
    ///
    /// - [`ImageEncoderError::UnsupportedFormat`] when the source format is unsupported for images
    ///   (e.g., [`crate::settings::ColorFormat::Rgba16F`])
    /// - [`ImageEncoderError::WindowsError`] when Windows Imaging API calls fail
    /// - [`ImageEncoderError::IntConversionError`] on integer conversion failures
    #[inline]
    pub fn encode(&self, image_buffer: &[u8], width: u32, height: u32) -> Result<Vec<u8>, ImageEncoderError> {
        let stream = InMemoryRandomAccessStream::new()?;

        let encoder = BitmapEncoder::CreateAsync(self.encoder, &stream)?.join()?;

        encoder.SetPixelData(
            self.pixel_format,
            BitmapAlphaMode::Premultiplied,
            width,
            height,
            1.0,
            1.0,
            image_buffer,
        )?;
        encoder.FlushAsync()?.join()?;

        let size = stream.Size()?;
        let input = stream.GetInputStreamAt(0)?;
        let reader = DataReader::CreateDataReader(&input)?;
        reader.LoadAsync(size as u32)?.join()?;

        let mut bytes = vec![0u8; size as usize];
        reader.ReadBytes(&mut bytes)?;

        Ok(bytes)
    }
}

#[derive(thiserror::Error, Debug)]
/// Errors emitted by [`VideoEncoder`] during configuration, streaming, or finalization.
pub enum VideoEncoderError {
    /// A Windows Runtime/Win32 API call failed.
    ///
    /// Wraps [`windows::core::Error`].
    #[error("Windows API error: {0}")]
    WindowsError(#[from] windows::core::Error),
    /// Failed to send a video sample into the internal pipeline.
    ///
    /// Typically indicates the internal channel is closed.
    #[error("Failed to send frame: {0}")]
    FrameSendError(#[from] mpsc::SendError<Option<(VideoEncoderSource, TimeSpan)>>),
    /// Failed to send an audio sample into the internal pipeline.
    ///
    /// Typically indicates the internal channel is closed.
    #[error("Failed to send audio: {0}")]
    AudioSendError(#[from] mpsc::SendError<Option<(AudioEncoderSource, TimeSpan)>>),
    /// Video encoding was disabled via [`VideoSettingsBuilder::disabled`].
    #[error("Video encoding is disabled")]
    VideoDisabled,
    /// Audio encoding was disabled via [`AudioSettingsBuilder::disabled`].
    #[error("Audio encoding is disabled")]
    AudioDisabled,
    /// An I/O error occurred during file creation or writing.
    ///
    /// Wraps [`std::io::Error`].
    #[error("I/O error: {0}")]
    IoError(#[from] std::io::Error),
    /// The provided frame color format is unsupported by the encoder path.
    ///
    /// See [`crate::settings::ColorFormat`].
    #[error("Unsupported frame color format: {0:?}")]
    UnsupportedFrameFormat(ColorFormat),
}

unsafe impl Send for VideoEncoderError {}
unsafe impl Sync for VideoEncoderError {}

/// Video sources used by [`VideoEncoder`].
///
/// - For [`VideoEncoderSource::DirectX`], the COM surface pointer is ref-counted; holding the
///   pointer is sufficient.
/// - For [`VideoEncoderSource::Buffer`], the encoder takes ownership of the bytes, allowing callers
///   to return immediately.
pub enum VideoEncoderSource {
    /// A Direct3D surface sample.
    DirectX(SendDirectX<IDirect3DSurface>),
    /// A raw BGRA sample buffer.
    Buffer(Vec<u8>),
    /// A raw BGRA sample with an explicit presentation duration.
    TimedBuffer(Vec<u8>, TimeSpan),
}

/// Audio sources used by [`VideoEncoder`]. The encoder takes ownership of the bytes.
pub enum AudioEncoderSource {
    /// Interleaved PCM bytes.
    Buffer(Vec<u8>),
}

struct CachedSurface {
    width: u32,
    height: u32,
    format: ColorFormat,
    texture: SendDirectX<ID3D11Texture2D>,
    surface: SendDirectX<IDirect3DSurface>,
    render_target_view: Option<SendDirectX<ID3D11RenderTargetView>>,
}

/// Builder for configuring video encoder settings.
pub struct VideoSettingsBuilder {
    sub_type: VideoSettingsSubType,
    bitrate: u32,
    width: u32,
    height: u32,
    frame_rate: u32,
    pixel_aspect_ratio: (u32, u32),
    disabled: bool,
}

impl VideoSettingsBuilder {
    /// Constructs a new [`VideoSettingsBuilder`] with required geometry.
    ///
    /// Defaults:
    /// - Subtype: [`VideoSettingsSubType::HEVC`]
    /// - Bitrate: 15 Mbps
    /// - Frame rate: 60 fps
    /// - Pixel aspect ratio: 1:1
    /// - Disabled: false
    pub const fn new(width: u32, height: u32) -> Self {
        Self {
            bitrate: 15_000_000,
            frame_rate: 60,
            pixel_aspect_ratio: (1, 1),
            sub_type: VideoSettingsSubType::HEVC,
            width,
            height,
            disabled: false,
        }
    }

    /// Sets the video codec/subtype (e.g., [`VideoSettingsSubType::HEVC`]).
    pub const fn sub_type(mut self, sub_type: VideoSettingsSubType) -> Self {
        self.sub_type = sub_type;
        self
    }

    /// Sets target bitrate in bits per second.
    pub const fn bitrate(mut self, bitrate: u32) -> Self {
        self.bitrate = bitrate;
        self
    }

    /// Sets target frame width in pixels.
    pub const fn width(mut self, width: u32) -> Self {
        self.width = width;
        self
    }

    /// Sets target frame height in pixels.
    pub const fn height(mut self, height: u32) -> Self {
        self.height = height;
        self
    }

    /// Sets target frame rate (numerator; denominator is fixed to 1).
    pub const fn frame_rate(mut self, frame_rate: u32) -> Self {
        self.frame_rate = frame_rate;
        self
    }

    /// Sets pixel aspect ratio as (numerator, denominator).
    pub const fn pixel_aspect_ratio(mut self, par: (u32, u32)) -> Self {
        self.pixel_aspect_ratio = par;
        self
    }
    /// Disables or enables video encoding.
    ///
    /// When `true`, calls to send frames still succeed but produce no video samples.
    pub const fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    fn build(self) -> Result<(VideoEncodingProperties, bool), VideoEncoderError> {
        let properties = VideoEncodingProperties::new()?;
        properties.SetSubtype(&self.sub_type.to_hstring())?;
        properties.SetBitrate(self.bitrate)?;
        properties.SetWidth(self.width)?;
        properties.SetHeight(self.height)?;
        properties.FrameRate()?.SetNumerator(self.frame_rate)?;
        properties.FrameRate()?.SetDenominator(1)?;
        properties.PixelAspectRatio()?.SetNumerator(self.pixel_aspect_ratio.0)?;
        properties.PixelAspectRatio()?.SetDenominator(self.pixel_aspect_ratio.1)?;
        Ok((properties, self.disabled))
    }
}

/// Builder for configuring audio encoder settings.
pub struct AudioSettingsBuilder {
    bitrate: u32,
    channel_count: u32,
    sample_rate: u32,
    bit_per_sample: u32,
    sub_type: AudioSettingsSubType,
    disabled: bool,
}

impl AudioSettingsBuilder {
    /// Constructs a new [`AudioSettingsBuilder`] with common defaults.
    ///
    /// Defaults:
    /// - Bitrate: 192 kbps
    /// - Channels: 2
    /// - Sample rate: 48 kHz
    /// - Bits per sample: 16
    /// - Subtype: [`AudioSettingsSubType::AAC`]
    /// - Disabled: false
    pub const fn new() -> Self {
        Self {
            bitrate: 192_000,
            channel_count: 2,
            sample_rate: 48_000,
            bit_per_sample: 16,
            sub_type: AudioSettingsSubType::AAC,
            disabled: false,
        }
    }
    /// Sets audio bitrate in bits per second.
    pub const fn bitrate(mut self, bitrate: u32) -> Self {
        self.bitrate = bitrate;
        self
    }
    /// Sets number of interleaved channels.
    pub const fn channel_count(mut self, channel_count: u32) -> Self {
        self.channel_count = channel_count;
        self
    }
    /// Sets sample rate in Hz.
    pub const fn sample_rate(mut self, sample_rate: u32) -> Self {
        self.sample_rate = sample_rate;
        self
    }
    /// Sets bits per sample.
    pub const fn bit_per_sample(mut self, bit_per_sample: u32) -> Self {
        self.bit_per_sample = bit_per_sample;
        self
    }
    /// Sets audio codec/subtype (e.g., [`AudioSettingsSubType::AAC`]).
    pub const fn sub_type(mut self, sub_type: AudioSettingsSubType) -> Self {
        self.sub_type = sub_type;
        self
    }
    /// Disables or enables audio encoding.
    pub const fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    fn build(self) -> Result<(AudioEncodingProperties, bool), VideoEncoderError> {
        let properties = AudioEncodingProperties::new()?;
        properties.SetBitrate(self.bitrate)?;
        properties.SetChannelCount(self.channel_count)?;
        properties.SetSampleRate(self.sample_rate)?;
        properties.SetBitsPerSample(self.bit_per_sample)?;
        properties.SetSubtype(&self.sub_type.to_hstring())?;
        Ok((properties, self.disabled))
    }
}

impl Default for AudioSettingsBuilder {
    fn default() -> Self {
        Self::new()
    }
}

/// Builder for configuring container settings.
pub struct ContainerSettingsBuilder {
    sub_type: ContainerSettingsSubType,
}
impl ContainerSettingsBuilder {
    /// Constructs a new [`ContainerSettingsBuilder`].
    ///
    /// Default subtype: [`ContainerSettingsSubType::MPEG4`].
    pub const fn new() -> Self {
        Self { sub_type: ContainerSettingsSubType::MPEG4 }
    }
    /// Sets the container subtype (e.g., [`ContainerSettingsSubType::MPEG4`]).
    pub const fn sub_type(mut self, sub_type: ContainerSettingsSubType) -> Self {
        self.sub_type = sub_type;
        self
    }
    fn build(self) -> Result<ContainerEncodingProperties, VideoEncoderError> {
        let properties = ContainerEncodingProperties::new()?;
        properties.SetSubtype(&self.sub_type.to_hstring())?;
        Ok(properties)
    }
}
impl Default for ContainerSettingsBuilder {
    fn default() -> Self {
        Self::new()
    }
}

/// Video encoder subtypes.
#[derive(Eq, PartialEq, Clone, Copy, Debug)]
pub enum VideoSettingsSubType {
    /// Uncompressed 32-bit ARGB (8:8:8:8).
    ARGB32,
    /// Uncompressed 32-bit BGRA (8:8:8:8).
    BGRA8,
    /// 16-bit depth format.
    D16,
    /// H.263 video.
    H263,
    /// H.264/AVC video.
    H264,
    /// H.264 elementary stream.
    H264ES,
    /// H.265/HEVC video.
    HEVC,
    /// H.265/HEVC elementary stream.
    HEVCES,
    /// Planar YUV 4:2:0 (IYUV).
    IYUV,
    /// 8-bit luminance (grayscale).
    L8,
    /// 16-bit luminance (grayscale).
    L16,
    /// Motion JPEG.
    MJPG,
    /// NV12 YUV 4:2:0 (semi-planar).
    NV12,
    /// MPEG-1 video.
    MPEG1,
    /// MPEG-2 video.
    MPEG2,
    /// 24-bit RGB.
    RGB24,
    /// 32-bit RGB.
    RGB32,
    /// Windows Media Video 9 (WMV3).
    WMV3,
    /// Windows Media Video Advanced Profile (VC-1).
    WVC1,
    /// VP9 video.
    VP9,
    /// Packed YUY2 4:2:2.
    YUY2,
    /// Planar YV12 4:2:0.
    YV12,
}
impl VideoSettingsSubType {
    /// Returns the Windows Media subtype identifier string for this [`VideoSettingsSubType`].
    pub fn to_hstring(&self) -> HSTRING {
        let s = match self {
            Self::ARGB32 => "ARGB32",
            Self::BGRA8 => "BGRA8",
            Self::D16 => "D16",
            Self::H263 => "H263",
            Self::H264 => "H264",
            Self::H264ES => "H264ES",
            Self::HEVC => "HEVC",
            Self::HEVCES => "HEVCES",
            Self::IYUV => "IYUV",
            Self::L8 => "L8",
            Self::L16 => "L16",
            Self::MJPG => "MJPG",
            Self::NV12 => "NV12",
            Self::MPEG1 => "MPEG1",
            Self::MPEG2 => "MPEG2",
            Self::RGB24 => "RGB24",
            Self::RGB32 => "RGB32",
            Self::WMV3 => "WMV3",
            Self::WVC1 => "WVC1",
            Self::VP9 => "VP9",
            Self::YUY2 => "YUY2",
            Self::YV12 => "YV12",
        };
        HSTRING::from(s)
    }
}

/// Audio encoder subtypes.
#[derive(Eq, PartialEq, Clone, Copy, Debug)]
pub enum AudioSettingsSubType {
    /// Advanced Audio Coding (AAC).
    AAC,
    /// Dolby Digital (AC-3).
    AC3,
    /// AAC framed with ADTS headers.
    AACADTS,
    /// AAC with HDCP protection.
    AACHDCP,
    /// AC-3 over S/PDIF.
    AC3SPDIF,
    /// AC-3 with HDCP protection.
    AC3HDCP,
    /// ADTS (Audio Data Transport Stream).
    ADTS,
    /// Apple Lossless Audio Codec (ALAC).
    ALAC,
    /// Adaptive Multi-Rate Narrowband (AMR-NB).
    AMRNB,
    /// Adaptive Multi-Rate Wideband (AMR-WB).
    AWRWB,
    /// DTS audio.
    DTS,
    /// Enhanced AC-3 (E-AC-3).
    EAC3,
    /// Free Lossless Audio Codec (FLAC).
    FLAC,
    /// 32-bit floating-point PCM.
    Float,
    /// MPEG-1/2 Layer III (MP3).
    MP3,
    /// Generic MPEG audio.
    MPEG,
    /// Opus audio.
    OPUS,
    /// Pulse-code modulation (PCM).
    PCM,
    /// Windows Media Audio 8.
    WMA8,
    /// Windows Media Audio 9.
    WMA9,
    /// Vorbis audio.
    Vorbis,
}
impl AudioSettingsSubType {
    /// Returns the Windows Media subtype identifier string for this [`AudioSettingsSubType`].
    pub fn to_hstring(&self) -> HSTRING {
        let s = match self {
            Self::AAC => "AAC",
            Self::AC3 => "AC3",
            Self::AACADTS => "AACADTS",
            Self::AACHDCP => "AACHDCP",
            Self::AC3SPDIF => "AC3SPDIF",
            Self::AC3HDCP => "AC3HDCP",
            Self::ADTS => "ADTS",
            Self::ALAC => "ALAC",
            Self::AMRNB => "AMRNB",
            Self::AWRWB => "AWRWB",
            Self::DTS => "DTS",
            Self::EAC3 => "EAC3",
            Self::FLAC => "FLAC",
            Self::Float => "Float",
            Self::MP3 => "MP3",
            Self::MPEG => "MPEG",
            Self::OPUS => "OPUS",
            Self::PCM => "PCM",
            Self::WMA8 => "WMA8",
            Self::WMA9 => "WMA9",
            Self::Vorbis => "Vorbis",
        };
        HSTRING::from(s)
    }
}

/// Container subtypes.
#[derive(Eq, PartialEq, Clone, Copy, Debug)]
pub enum ContainerSettingsSubType {
    /// Advanced Systems Format (ASF).
    ASF,
    /// Raw MP3 container.
    MP3,
    /// MPEG-4 container (e.g., MP4).
    MPEG4,
    /// Audio Video Interleave (AVI).
    AVI,
    /// MPEG-2 container.
    MPEG2,
    /// WAVE (WAV) container.
    WAVE,
    /// AAC ADTS stream.
    AACADTS,
    /// ADTS container.
    ADTS,
    /// 3GP container.
    GP3,
    /// AMR container.
    AMR,
    /// FLAC container.
    FLAC,
}
impl ContainerSettingsSubType {
    /// Returns the Windows Media container subtype identifier string for this
    /// [`ContainerSettingsSubType`].
    pub fn to_hstring(&self) -> HSTRING {
        match self {
            Self::ASF => HSTRING::from("ASF"),
            Self::MP3 => HSTRING::from("MP3"),
            Self::MPEG4 => HSTRING::from("MPEG4"),
            Self::AVI => HSTRING::from("AVI"),
            Self::MPEG2 => HSTRING::from("MPEG2"),
            Self::WAVE => HSTRING::from("WAVE"),
            Self::AACADTS => HSTRING::from("AACADTS"),
            Self::ADTS => HSTRING::from("ADTS"),
            Self::GP3 => HSTRING::from("3GP"),
            Self::AMR => HSTRING::from("AMR"),
            Self::FLAC => HSTRING::from("FLAC"),
        }
    }
}

/// Encodes video frames (and optional audio) and writes them to a file or stream.
///
/// Frames are provided as Direct3D surfaces or raw BGRA buffers. Audio can be pushed
/// as interleaved PCM bytes.
///
/// - Use [`VideoEncoder::new`] for file output or [`VideoEncoder::new_from_stream`] for stream
///   output.
/// - Push frames with [`VideoEncoder::send_frame`] or [`VideoEncoder::send_frame_buffer`].
/// - Optionally push audio with [`VideoEncoder::send_audio_buffer`] or use
///   [`VideoEncoder::send_frame_with_audio`].
/// - Call [`VideoEncoder::finish`] to finalize the container.
///
/// # Example
/// ```no_run
/// use windows_capture::encoder::{
///     AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
/// };
///
/// // Create an encoder that outputs H.265 in an MP4 container
/// let mut encoder = VideoEncoder::new(
///     VideoSettingsBuilder::new(1920, 1080),
///     AudioSettingsBuilder::new().disabled(true),
///     ContainerSettingsBuilder::new(),
///     "capture.mp4",
/// )
/// .unwrap();
///
/// // In your capture loop, push frames:
/// // encoder.send_frame(&frame).unwrap();
///
/// // When done:
/// // encoder.finish().unwrap();
/// ```
pub struct VideoEncoder {
    video_handoff: mpsc::Receiver<VideoHandoff>,
    // Video timing
    first_timestamp: Option<TimeSpan>,

    // Channels
    frame_sender: mpsc::Sender<Option<(VideoEncoderSource, TimeSpan)>>,
    audio_sender: mpsc::Sender<Option<(AudioEncoderSource, TimeSpan)>>,

    // MSS event tokens
    sample_requested: i64,
    media_stream_source: MediaStreamSource,
    starting: i64,

    // Transcode worker
    transcode_thread: Option<JoinHandle<Result<(), VideoEncoderError>>>,
    error_notify: Arc<AtomicBool>,

    // Feature toggles
    is_video_disabled: bool,
    is_audio_disabled: bool,

    // --- NEW: audio clock & format bookkeeping (monotonic timing) ---
    audio_sample_rate: u32,  // Hz (frames per second)
    audio_block_align: u32,  // bytes per interleaved sample frame (channels * (bits/8))
    audio_samples_sent: u64, // number of sample frames (not bytes) emitted so far

    // Video sizing constraints
    target_width: u32,
    target_height: u32,
    target_color_format: ColorFormat,

    cached_surface: Option<CachedSurface>,
}

impl VideoEncoder {
    fn settled_error(&mut self) -> VideoEncoderError {
        if let Some(worker) = self.transcode_thread.take() {
            if let Err(error) = worker.join().expect("Failed to join transcode thread") { return error; }
        }
        VideoEncoderError::WindowsError(windows::core::Error::from_hresult(
            windows::core::HRESULT(0x80004004_u32 as i32)))
    }
    fn create_cached_surface(
        device: &ID3D11Device,
        width: u32,
        height: u32,
        format: ColorFormat,
    ) -> Result<CachedSurface, VideoEncoderError> {
        let texture_desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT(format as i32),
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };

        let mut texture = None;
        unsafe {
            device.CreateTexture2D(&texture_desc, None, Some(&mut texture))?;
        }
        let texture = texture.expect("CreateTexture2D returned None");

        let mut render_target = None;
        unsafe {
            device.CreateRenderTargetView(&texture, None, Some(&mut render_target))?;
        }
        let render_target_view = render_target.map(SendDirectX::new);

        let dxgi_surface: IDXGISurface = texture.cast()?;
        let inspectable = unsafe { CreateDirect3D11SurfaceFromDXGISurface(&dxgi_surface)? };
        let surface: IDirect3DSurface = inspectable.cast()?;

        Ok(CachedSurface {
            width,
            height,
            format,
            texture: SendDirectX::new(texture),
            surface: SendDirectX::new(surface),
            render_target_view,
        })
    }

    fn attach_sample_requested_handlers(
        media_stream_source: &MediaStreamSource,
        is_video_disabled: bool,
        is_audio_disabled: bool,
        frame_receiver: VideoFrameReceiver,
        audio_receiver: AudioFrameReceiver,
        audio_block_align: u32,
        audio_sample_rate: u32,
        video_handoff: mpsc::Sender<VideoHandoff>,
    ) -> Result<i64, VideoEncoderError> {
        let token = media_stream_source.SampleRequested(&TypedEventHandler::<
            MediaStreamSource,
            MediaStreamSourceSampleRequestedEventArgs,
        >::new(move |_, sample_requested| {
            let sample_requested = sample_requested
                .as_ref()
                .expect("MediaStreamSource SampleRequested parameter was None. This should not happen.");

            let request = sample_requested.Request()?;
            let is_audio = request.StreamDescriptor()?.cast::<AudioStreamDescriptor>().is_ok();

            // Always offload blocking work to the thread pool; never block the MSS event
            // thread.
            let deferral = request.GetDeferral()?;

            if is_audio {
                if is_audio_disabled {
                    request.SetSample(None)?;
                    deferral.Complete()?;
                } else {
                    let request_clone = request;
                    let audio_receiver = audio_receiver.clone();
                    ThreadPool::RunWithPriorityAndOptionsAsync(
                        &WorkItemHandler::new(move |_| {
                            let value = audio_receiver.lock().recv();
                            match value {
                                Ok(Some((source, timestamp))) => {
                                    let sample = match source {
                                        AudioEncoderSource::Buffer(bytes) => {
                                            let buf = CryptographicBuffer::CreateFromByteArray(&bytes)?;
                                            let sample = MediaStreamSample::CreateFromBuffer(&buf, timestamp)?;
                                            // Duration = (frames / sample_rate) in 100ns ticks
                                            // frames = bytes / block_align
                                            let frames = (bytes.len() as u32) / audio_block_align;
                                            let duration_ticks =
                                                (frames as i64) * 10_000_000i64 / (audio_sample_rate as i64);
                                            sample.SetDuration(TimeSpan { Duration: duration_ticks })?;
                                            sample
                                        }
                                    };
                                    request_clone.SetSample(&sample)?;
                                }
                                Ok(None) | Err(_) => {
                                    request_clone.SetSample(None)?;
                                }
                            }
                            deferral.Complete()?;
                            Ok(())
                        }),
                        WorkItemPriority::Normal,
                        WorkItemOptions::None,
                    )?;
                }
            } else if is_video_disabled {
                request.SetSample(None)?;
                deferral.Complete()?;
            } else {
                let request_clone = request;
                let frame_receiver = frame_receiver.clone();
                let video_handoff = video_handoff.clone();
                ThreadPool::RunWithPriorityAndOptionsAsync(
                    &WorkItemHandler::new(move |_| {
                        let value = frame_receiver.lock().recv();
                        match value {
                            Ok(Some((source, timestamp))) => {
                                let timed = matches!(&source, VideoEncoderSource::TimedBuffer(..));
                                let sample = match source {
                                    VideoEncoderSource::DirectX(surface) => {
                                        MediaStreamSample::CreateFromDirect3D11Surface(&surface.0, timestamp)?
                                    }
                                    VideoEncoderSource::Buffer(bytes) => {
                                        let buf = CryptographicBuffer::CreateFromByteArray(&bytes)?;
                                        MediaStreamSample::CreateFromBuffer(&buf, timestamp)?
                                    }
                                    VideoEncoderSource::TimedBuffer(bytes, duration) => {
                                        let buf = CryptographicBuffer::CreateFromByteArray(&bytes)?;
                                        let sample = MediaStreamSample::CreateFromBuffer(&buf, timestamp)?;
                                        sample.SetDuration(duration)?;
                                        sample
                                    }
                                };
                                request_clone.SetSample(&sample)?;
                                if timed { let _ = video_handoff.send(VideoHandoff::Accepted); }
                            }
                            Ok(None) | Err(_) => {
                                request_clone.SetSample(None)?;
                            }
                        }
                        deferral.Complete()?;
                        Ok(())
                    }),
                    WorkItemPriority::Normal,
                    WorkItemOptions::None,
                )?;
            }

            Ok(())
        }))?;
        Ok(token)
    }

    /// Constructs a new `VideoEncoder` that writes to a file path.
    #[inline]
    pub fn new<P: AsRef<Path>>(
        video_settings: VideoSettingsBuilder,
        audio_settings: AudioSettingsBuilder,
        container_settings: ContainerSettingsBuilder,
        path: P,
    ) -> Result<Self, VideoEncoderError> {
        Self::from_output(video_settings, audio_settings, container_settings, || {
            let path = path.as_ref();
            File::create(path)?;
            let path = fs::canonicalize(path)?.to_string_lossy()[4..].to_string();
            let path = HSTRING::from(Path::new(&path).as_os_str().to_os_string());
            let file = StorageFile::GetFileFromPathAsync(&path)?.join()?;
            Ok(file.OpenAsync(FileAccessMode::ReadWrite)?.join()?)
        })
    }

    /// Constructs a new `VideoEncoder` that writes to the given stream.
    ///
    /// Unlike [`VideoEncoder::new`], which writes directly to a file, this constructor writes
    /// encoded output into any [`IRandomAccessStream`]. Use [`InMemoryRandomAccessStream`] to
    /// keep the encoded video in memory (e.g., for network streaming or further processing).
    ///
    /// # Example
    /// ```no_run
    /// use windows::Storage::Streams::InMemoryRandomAccessStream;
    /// use windows::core::Interface;
    /// use windows_capture::encoder::{
    ///     AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
    /// };
    ///
    /// let stream = InMemoryRandomAccessStream::new().unwrap();
    ///
    /// let encoder = VideoEncoder::new_from_stream(
    ///     VideoSettingsBuilder::new(1920, 1080),
    ///     AudioSettingsBuilder::new().disabled(true),
    ///     ContainerSettingsBuilder::new(),
    ///     stream.cast().unwrap(),
    /// )
    /// .unwrap();
    /// ```
    #[inline]
    pub fn new_from_stream(
        video_settings: VideoSettingsBuilder,
        audio_settings: AudioSettingsBuilder,
        container_settings: ContainerSettingsBuilder,
        stream: IRandomAccessStream,
    ) -> Result<Self, VideoEncoderError> {
        Self::from_output(video_settings, audio_settings, container_settings, || Ok(stream))
    }

    fn from_output(
        video_settings: VideoSettingsBuilder,
        audio_settings: AudioSettingsBuilder,
        container_settings: ContainerSettingsBuilder,
        open_output: impl FnOnce() -> Result<IRandomAccessStream, VideoEncoderError>,
    ) -> Result<Self, VideoEncoderError> {
        let media_encoding_profile = MediaEncodingProfile::new()?;

        let (video_encoding_properties_cfg, is_video_disabled) = video_settings.build()?;
        media_encoding_profile.SetVideo(&video_encoding_properties_cfg)?;
        let (audio_encoding_properties_cfg, is_audio_disabled) = audio_settings.build()?;
        if !is_audio_disabled {
            media_encoding_profile.SetAudio(&audio_encoding_properties_cfg)?;
        }
        let container_encoding_properties = container_settings.build()?;
        media_encoding_profile.SetContainer(&container_encoding_properties)?;

        let target_width = video_encoding_properties_cfg.Width()?;
        let target_height = video_encoding_properties_cfg.Height()?;
        let target_color_format = ColorFormat::Bgra8;

        // Build settings before opening/truncating the caller's output, once.
        let stream = open_output()?;
        let create_attempt = |hardware_enabled| -> Result<_, VideoEncoderError> {
            let video_encoding_properties = VideoEncodingProperties::CreateUncompressed(
                &MediaEncodingSubtypes::Bgra8()?,
                video_encoding_properties_cfg.Width()?,
                video_encoding_properties_cfg.Height()?,
            )?;
            let video_stream_descriptor = VideoStreamDescriptor::Create(&video_encoding_properties)?;

            let audio_desc_props = AudioEncodingProperties::CreatePcm(
                audio_encoding_properties_cfg.SampleRate()?,
                audio_encoding_properties_cfg.ChannelCount()?,
                audio_encoding_properties_cfg.BitsPerSample()?,
            )?;
            let audio_stream_descriptor = AudioStreamDescriptor::Create(&audio_desc_props)?;

            // Monotonic audio timing parameters
            let audio_sr = audio_desc_props.SampleRate()?;
            let audio_ch = audio_desc_props.ChannelCount()?;
            let audio_bps = audio_desc_props.BitsPerSample()?;
            let audio_block_align = (audio_bps / 8) * audio_ch;

            let media_stream_source = if is_audio_disabled {
                MediaStreamSource::CreateFromDescriptor(&video_stream_descriptor)?
            } else {
                MediaStreamSource::CreateFromDescriptors(&video_stream_descriptor, &audio_stream_descriptor)?
            };
            // Preserve the stream source buffer across profile selection.
            media_stream_source.SetBufferTime(Duration::from_millis(30).into())?;

            let starting = media_stream_source.Starting(&TypedEventHandler::<
                MediaStreamSource,
                MediaStreamSourceStartingEventArgs,
            >::new(move |_, stream_start| {
                let stream_start =
                    stream_start.as_ref().expect("MediaStreamSource Starting parameter was None. This should not happen.");
                stream_start.Request()?.SetActualStartPosition(TimeSpan { Duration: 0 })?;
                Ok(())
            }))?;

            let (frame_sender, frame_receiver_raw) = mpsc::channel::<Option<(VideoEncoderSource, TimeSpan)>>();
            let (audio_sender, audio_receiver_raw) = mpsc::channel::<Option<(AudioEncoderSource, TimeSpan)>>();

            let frame_receiver = Arc::new(Mutex::new(frame_receiver_raw));
            let audio_receiver = Arc::new(Mutex::new(audio_receiver_raw));

            let (video_handoff_tx, video_handoff) = mpsc::channel();
            let sample_requested = Self::attach_sample_requested_handlers(
                &media_stream_source,
                is_video_disabled,
                is_audio_disabled,
                frame_receiver,
                audio_receiver,
                audio_block_align,
                audio_sr,
                video_handoff_tx.clone(),
            )?;

            let media_transcoder = MediaTranscoder::new()?;
            media_transcoder.SetHardwareAccelerationEnabled(hardware_enabled)?;

            let encoder = Self {
                first_timestamp: None,
                video_handoff,
                frame_sender,
                audio_sender,
                sample_requested,
                media_stream_source,
                starting,
                transcode_thread: None,
                error_notify: Arc::new(AtomicBool::new(false)),
                is_video_disabled,
                is_audio_disabled,
                audio_sample_rate: audio_sr,
                audio_block_align,
                audio_samples_sent: 0,
                target_width,
                target_height,
                target_color_format,
                cached_surface: None,
            };
            Ok((encoder, media_transcoder, video_handoff_tx))
        };

        let prepare = |encoder: &Self, transcoder: &MediaTranscoder| {
            transcoder.PrepareMediaStreamSourceTranscodeAsync(&encoder.media_stream_source, &stream,
                &media_encoding_profile)?.join()
        };
        let mut attempt = create_attempt(true)?;
        let transcode = match prepare(&attempt.0, &attempt.1) {
            // MF_E_TRANSFORM_TYPE_NOT_SET, observed for a valid small profile
            // on the hardware path. Preparation shuts down its CPU source.
            Err(error) if error.code() == windows::core::HRESULT(0xC00D6D60_u32 as i32) => {
                // Existing Drop releases old senders and event refs. No
                // worker or input sample exists until preparation succeeds.
                drop(attempt);
                attempt = create_attempt(false)?;
                prepare(&attempt.0, &attempt.1)?
            }
            result => result?,
        };
        let (mut encoder, media_transcoder, video_handoff) = attempt;
        let error_notify = encoder.error_notify.clone();
        encoder.transcode_thread = Some(thread::spawn(move || -> Result<(), VideoEncoderError> {
            let result = (|| -> Result<(), VideoEncoderError> { transcode.TranscodeAsync()?.join()?; Ok(()) })();
            error_notify.store(true, atomic::Ordering::Relaxed);
            let _ = video_handoff.send(VideoHandoff::Settled);
            drop(media_transcoder);
            result
        }));
        Ok(encoder)
    }

    fn build_padded_surface(&mut self, frame: &Frame) -> Result<SendDirectX<IDirect3DSurface>, VideoEncoderError> {
        let frame_format = frame.color_format();
        let needs_recreate = self.cached_surface.as_ref().is_none_or(|cache| {
            cache.format != frame_format || cache.width != self.target_width || cache.height != self.target_height
        });

        if needs_recreate {
            let surface =
                Self::create_cached_surface(frame.device(), self.target_width, self.target_height, frame_format)?;
            self.cached_surface = Some(surface);
            self.target_color_format = frame_format;
        }

        let cache = self.cached_surface.as_mut().expect("cached_surface must be populated before use");
        let context = frame.device_context();

        if let Some(rtv) = &cache.render_target_view {
            let clear_color = [0.0f32, 0.0, 0.0, 1.0];
            unsafe {
                context.ClearRenderTargetView(&rtv.0, &clear_color);
            }
        }

        let copy_width = self.target_width.min(frame.width());
        let copy_height = self.target_height.min(frame.height());

        if copy_width > 0 && copy_height > 0 {
            let source_box = D3D11_BOX { left: 0, top: 0, front: 0, right: copy_width, bottom: copy_height, back: 1 };
            unsafe {
                context.CopySubresourceRegion(
                    &cache.texture.0,
                    0,
                    0,
                    0,
                    0,
                    frame.as_raw_texture(),
                    0,
                    Some(&source_box),
                );
            }
        }

        unsafe {
            context.Flush();
        }

        Ok(SendDirectX::new(cache.surface.0.clone()))
    }

    /// Sends a video frame (DirectX). Returns immediately.
    #[inline]
    pub fn send_frame(&mut self, frame: &Frame) -> Result<(), VideoEncoderError> {
        if self.is_video_disabled {
            return Err(VideoEncoderError::VideoDisabled);
        }

        let timestamp = match self.first_timestamp {
            Some(t0) => TimeSpan { Duration: frame.timestamp()?.Duration - t0.Duration },
            None => {
                let ts = frame.timestamp()?;
                self.first_timestamp = Some(ts);
                TimeSpan { Duration: 0 }
            }
        };

        let surface = if frame.width() == self.target_width && frame.height() == self.target_height {
            SendDirectX::new(frame.as_raw_surface().clone())
        } else {
            self.build_padded_surface(frame)?
        };

        self.frame_sender.send(Some((VideoEncoderSource::DirectX(surface), timestamp)))?;

        if self.error_notify.load(atomic::Ordering::Relaxed)
            && let Some(t) = self.transcode_thread.take()
        {
            t.join().expect("Failed to join transcode thread")?;
        }

        Ok(())
    }

    /// Sends a video frame and an audio buffer (owned). Returns immediately.
    /// Audio timestamp is derived from total samples sent so far (monotonic).
    #[inline]
    pub fn send_frame_with_audio(&mut self, frame: &mut Frame, audio_buffer: &[u8]) -> Result<(), VideoEncoderError> {
        if self.is_video_disabled {
            return Err(VideoEncoderError::VideoDisabled);
        }
        if self.is_audio_disabled {
            return Err(VideoEncoderError::AudioDisabled);
        }

        // Video timestamp based on capture timestamps (as before)
        let video_ts = match self.first_timestamp {
            Some(t0) => TimeSpan { Duration: frame.timestamp()?.Duration - t0.Duration },
            None => {
                let ts = frame.timestamp()?;
                self.first_timestamp = Some(ts);
                TimeSpan { Duration: 0 }
            }
        };

        let surface = if frame.width() == self.target_width && frame.height() == self.target_height {
            SendDirectX::new(frame.as_raw_surface().clone())
        } else {
            self.build_padded_surface(frame)?
        };

        self.frame_sender.send(Some((VideoEncoderSource::DirectX(surface), video_ts)))?;

        // Audio timestamp from running sample count
        let frames_in_buf = (audio_buffer.len() as u32) / self.audio_block_align;
        let audio_ts_ticks = ((self.audio_samples_sent as i128) * 10_000_000i128) / (self.audio_sample_rate as i128);
        let audio_ts = TimeSpan { Duration: audio_ts_ticks as i64 };

        self.audio_sender.send(Some((AudioEncoderSource::Buffer(audio_buffer.to_vec()), audio_ts)))?;

        // Advance counter after stamping
        self.audio_samples_sent = self.audio_samples_sent.saturating_add(frames_in_buf as u64);

        if self.error_notify.load(atomic::Ordering::Relaxed)
            && let Some(t) = self.transcode_thread.take()
        {
            t.join().expect("Failed to join transcode thread")?;
        }

        Ok(())
    }

    /// Sends a raw frame buffer (owned inside). Returns immediately.
    /// Windows expects BGRA and bottom-to-top layout for this path.
    #[inline]
    pub fn send_frame_buffer(&mut self, buffer: &[u8], timestamp: i64) -> Result<(), VideoEncoderError> {
        self.send_frame_buffer_sample(buffer, timestamp, None)
    }

    /// Sends BGRA pixels with an explicit presentation interval, in 100ns ticks.
    /// Waits for native sample acceptance, so finite producers cannot queue the clip in RAM.
    pub fn send_frame_buffer_with_duration(&mut self, buffer: &[u8], timestamp: i64, duration: i64) -> Result<(), VideoEncoderError> {
        self.send_frame_buffer_sample(buffer, timestamp, Some(TimeSpan { Duration: duration }))
    }

    fn send_frame_buffer_sample(&mut self, buffer: &[u8], timestamp: i64, duration: Option<TimeSpan>) -> Result<(), VideoEncoderError> {
        if self.is_video_disabled {
            return Err(VideoEncoderError::VideoDisabled);
        }
        if duration.is_some() && self.error_notify.load(atomic::Ordering::Relaxed) {
            return Err(self.settled_error());
        }

        let frame_timestamp = timestamp;
        let timestamp = match self.first_timestamp {
            Some(t0) => TimeSpan { Duration: frame_timestamp - t0.Duration },
            None => {
                self.first_timestamp = Some(TimeSpan { Duration: frame_timestamp });
                TimeSpan { Duration: 0 }
            }
        };

        let source = match duration {
            Some(duration) => VideoEncoderSource::TimedBuffer(buffer.to_vec(), duration),
            None => VideoEncoderSource::Buffer(buffer.to_vec()),
        };
        self.frame_sender.send(Some((source, timestamp)))?;

        if duration.is_some() {
            match self.video_handoff.recv() {
                Ok(VideoHandoff::Accepted) => {},
                Ok(VideoHandoff::Settled) | Err(_) => {
                    return Err(self.settled_error());
                }
            }
        }

        if self.error_notify.load(atomic::Ordering::Relaxed)
            && let Some(t) = self.transcode_thread.take()
        {
            t.join().expect("Failed to join transcode thread")?;
        }

        Ok(())
    }

    /// Sends an audio buffer (owned inside). Returns immediately.
    /// NOTE: The provided `timestamp` is ignored; we use a monotonic audio clock.
    #[inline]
    pub fn send_audio_buffer(
        &mut self,
        buffer: &[u8],
        _timestamp: i64, // ignored to guarantee monotonic audio timing
    ) -> Result<(), VideoEncoderError> {
        if self.is_audio_disabled {
            return Err(VideoEncoderError::AudioDisabled);
        }

        let frames_in_buf = (buffer.len() as u32) / self.audio_block_align;
        let audio_ts_ticks = ((self.audio_samples_sent as i128) * 10_000_000i128) / (self.audio_sample_rate as i128);
        let timestamp = TimeSpan { Duration: audio_ts_ticks as i64 };

        self.audio_sender.send(Some((AudioEncoderSource::Buffer(buffer.to_vec()), timestamp)))?;

        self.audio_samples_sent = self.audio_samples_sent.saturating_add(frames_in_buf as u64);

        if self.error_notify.load(atomic::Ordering::Relaxed)
            && let Some(t) = self.transcode_thread.take()
        {
            t.join().expect("Failed to join transcode thread")?;
        }

        Ok(())
    }

    /// Finishes the encoding and performs any necessary cleanup.
    #[inline]
    pub fn finish(mut self) -> Result<(), VideoEncoderError> {
        // 1) Signal EOS on both streams.
        let _ = self.frame_sender.send(None);
        let _ = self.audio_sender.send(None);

        // 2) **Close the channels** so any further recv() returns Err immediately. We replace the fields
        //    with dummy senders and drop the originals now.
        {
            let (dummy_tx_v, _dummy_rx_v) = mpsc::channel::<Option<(VideoEncoderSource, TimeSpan)>>();
            let (dummy_tx_a, _dummy_rx_a) = mpsc::channel::<Option<(AudioEncoderSource, TimeSpan)>>();

            let old_v = std::mem::replace(&mut self.frame_sender, dummy_tx_v);
            let old_a = std::mem::replace(&mut self.audio_sender, dummy_tx_a);
            drop(old_v);
            drop(old_a);
        }

        // 3) Wait for the transcoder to flush and finalize.
        if let Some(transcode_thread) = self.transcode_thread.take() {
            transcode_thread.join().expect("Failed to join transcode thread")?;
        }

        // 4) Unhook events after pipeline has completed.
        self.media_stream_source.RemoveStarting(self.starting)?;
        self.media_stream_source.RemoveSampleRequested(self.sample_requested)?;

        Ok(())
    }
}

impl Drop for VideoEncoder {
    #[inline]
    fn drop(&mut self) {
        // Try to signal EOS, then **close** the channels before waiting.
        let _ = self.frame_sender.send(None);
        let _ = self.audio_sender.send(None);

        // Close channels early in Drop too (same trick as in finish()).
        let (dummy_tx_v, _dummy_rx_v) = mpsc::channel::<Option<(VideoEncoderSource, TimeSpan)>>();
        let (dummy_tx_a, _dummy_rx_a) = mpsc::channel::<Option<(AudioEncoderSource, TimeSpan)>>();

        let old_v = std::mem::replace(&mut self.frame_sender, dummy_tx_v);
        let old_a = std::mem::replace(&mut self.audio_sender, dummy_tx_a);
        drop(old_v);
        drop(old_a);

        if let Some(transcode_thread) = self.transcode_thread.take() {
            let _ = transcode_thread.join();
        }

        let _ = self.media_stream_source.RemoveStarting(self.starting);
        let _ = self.media_stream_source.RemoveSampleRequested(self.sample_requested);
    }
}

#[allow(clippy::non_send_fields_in_send_ty)]
unsafe impl Send for VideoEncoder {}
