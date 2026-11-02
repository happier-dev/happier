//! Finite physical trim: native decoded intervals feed the same silent writer.
use super::{encoder, storage_path, WinRt, Writer};
use crate::capture::{CancelSignal, CaptureError, PixelSize};
use std::{ffi::c_void, path::Path};
use ::windows::{core::{w, GUID, HRESULT, Interface, PCSTR, PCWSTR}, Win32::{
    Foundation::{FreeLibrary, HMODULE}, Media::MediaFoundation::*,
    System::{Com::StructuredStorage::PROPVARIANT,
        LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32}}}};

fn native<T>(result: ::windows::core::Result<T>) -> Result<T, CaptureError> {
    result.map_err(|_| CaptureError::NativeFailure)
}

// Windows N can run the desktop without the optional Media Feature Pack. These
// SDK DLLs must not become mandatory process-start imports just to offer trim.
struct Library(HMODULE);
impl Library {
    fn load(name: PCWSTR) -> Result<Self, CaptureError> {
        native(unsafe { LoadLibraryExW(name, None, LOAD_LIBRARY_SEARCH_SYSTEM32) }).map(Self)
    }
    fn symbol(&self, name: PCSTR) -> Result<unsafe extern "system" fn() -> isize, CaptureError> {
        unsafe { GetProcAddress(self.0, name) }.ok_or(CaptureError::NativeFailure)
    }
}
impl Drop for Library { fn drop(&mut self) { let _ = unsafe { FreeLibrary(self.0) }; } }

type Startup = unsafe extern "system" fn(u32, u32) -> HRESULT;
type Shutdown = unsafe extern "system" fn() -> HRESULT;
type CreateAttributes = unsafe extern "system" fn(*mut *mut c_void, u32) -> HRESULT;
type CreateType = unsafe extern "system" fn(*mut *mut c_void) -> HRESULT;
type CreateReader = unsafe extern "system" fn(PCWSTR, *mut c_void, *mut *mut c_void) -> HRESULT;
type Stride = unsafe extern "system" fn(u32, u32, *mut i32) -> HRESULT;

struct MediaFoundation {
    _platform: Library, _reader: Library, shutdown: Shutdown,
    create_attributes: CreateAttributes, create_type: CreateType,
    create_reader: CreateReader, stride: Stride,
}
impl MediaFoundation {
    fn start() -> Result<Self, CaptureError> {
        let platform = Library::load(w!("mfplat.dll"))?;
        let reader = Library::load(w!("mfreadwrite.dll"))?;
        // SAFETY: Exact Windows SDK export signatures; the System32 modules
        // remain loaded until after all returned COM objects have dropped.
        let (startup, shutdown, create_attributes, create_type, create_reader, stride):
            (Startup, Shutdown, CreateAttributes, CreateType, CreateReader, Stride) = unsafe {
            (std::mem::transmute(platform.symbol(PCSTR(b"MFStartup\0".as_ptr()))?),
             std::mem::transmute(platform.symbol(PCSTR(b"MFShutdown\0".as_ptr()))?),
             std::mem::transmute(platform.symbol(PCSTR(b"MFCreateAttributes\0".as_ptr()))?),
             std::mem::transmute(platform.symbol(PCSTR(b"MFCreateMediaType\0".as_ptr()))?),
             std::mem::transmute(reader.symbol(PCSTR(b"MFCreateSourceReaderFromURL\0".as_ptr()))?),
             std::mem::transmute(platform.symbol(PCSTR(b"MFGetStrideForBitmapInfoHeader\0".as_ptr()))?))
        };
        native(unsafe { startup(MF_VERSION, MFSTARTUP_FULL) }.ok())?;
        Ok(Self { _platform: platform, _reader: reader, shutdown,
            create_attributes, create_type, create_reader, stride })
    }
    fn attributes(&self) -> Result<IMFAttributes, CaptureError> {
        let mut value = std::ptr::null_mut();
        native(unsafe { (self.create_attributes)(&mut value, 1) }.ok())?;
        if value.is_null() { return Err(CaptureError::NativeFailure); }
        // SAFETY: Successful MFCreateAttributes transfers this COM reference.
        Ok(unsafe { IMFAttributes::from_raw(value) })
    }
    fn media_type(&self) -> Result<IMFMediaType, CaptureError> {
        let mut value = std::ptr::null_mut();
        native(unsafe { (self.create_type)(&mut value) }.ok())?;
        if value.is_null() { return Err(CaptureError::NativeFailure); }
        // SAFETY: Successful MFCreateMediaType transfers this COM reference.
        Ok(unsafe { IMFMediaType::from_raw(value) })
    }
    fn reader(&self, path: PCWSTR, attributes: &IMFAttributes) -> Result<IMFSourceReader, CaptureError> {
        let mut value = std::ptr::null_mut();
        native(unsafe { (self.create_reader)(path, attributes.as_raw(), &mut value) }.ok())?;
        if value.is_null() { return Err(CaptureError::NativeFailure); }
        // SAFETY: Successful MFCreateSourceReaderFromURL transfers this reference.
        Ok(unsafe { IMFSourceReader::from_raw(value) })
    }
    fn stride(&self, width: u32) -> Result<i32, CaptureError> {
        let mut stride = 0;
        native(unsafe { (self.stride)(MFVideoFormat_RGB32.data1, width, &mut stride) }.ok())?;
        Ok(stride)
    }
}
impl Drop for MediaFoundation { fn drop(&mut self) { let _ = unsafe { (self.shutdown)() }; } }

struct Locked2D(IMF2DBuffer);
impl Drop for Locked2D { fn drop(&mut self) { let _ = unsafe { self.0.Unlock2D() }; } }
struct LockedBuffer(IMFMediaBuffer);
impl Drop for LockedBuffer { fn drop(&mut self) { let _ = unsafe { self.0.Unlock() }; } }

#[derive(Clone, Copy)]
struct Format { size: PixelSize, stride: i32 }
fn format(reader: &IMFSourceReader, stream: u32, foundation: &MediaFoundation) -> Result<Format, CaptureError> {
    let media = native(unsafe { reader.GetCurrentMediaType(stream) })?;
    let dimensions = native(unsafe { media.GetUINT64(&MF_MT_FRAME_SIZE) })?;
    let size = PixelSize { width: (dimensions >> 32) as u32, height: dimensions as u32 };
    let stride = match unsafe { media.GetUINT32(&MF_MT_DEFAULT_STRIDE) } {
        Ok(stride) => stride as i32,
        Err(_) => foundation.stride(size.width)?,
    };
    Ok(Format { size, stride })
}

/// scanline is the displayed top row; pitch can be negative for bottom-up RGB.
unsafe fn rows(scanline: *const u8, pitch: i32, size: PixelSize) -> Result<Vec<u8>, CaptureError> {
    let row_bytes = (size.width as usize).checked_mul(4).ok_or(CaptureError::InvalidMedia)?;
    if size.width == 0 || size.height == 0 || (pitch.unsigned_abs() as usize) < row_bytes {
        return Err(CaptureError::InvalidMedia);
    }
    let length = row_bytes.checked_mul(size.height as usize).ok_or(CaptureError::InvalidMedia)?;
    let mut pixels = Vec::with_capacity(length);
    for y in (0..size.height).rev() {
        let row = unsafe { scanline.offset(y as isize * pitch as isize) };
        // The OS buffer lock owns each row for the validated decoded geometry.
        pixels.extend_from_slice(unsafe { std::slice::from_raw_parts(row, row_bytes) });
    }
    for pixel in pixels.chunks_exact_mut(4) { pixel[3] = 255; }
    Ok(pixels)
}

fn pixels(sample: &IMFSample, format: Format) -> Result<Vec<u8>, CaptureError> {
    let buffer = native(unsafe { sample.ConvertToContiguousBuffer() })?;
    if let Ok(image) = buffer.cast::<IMF2DBuffer>() {
        let mut scanline = std::ptr::null_mut(); let mut pitch = 0;
        native(unsafe { image.Lock2D(&mut scanline, &mut pitch) })?;
        let _lock = Locked2D(image);
        unsafe { rows(scanline, pitch, format.size) }
    } else {
        let mut data = std::ptr::null_mut(); let mut length = 0;
        native(unsafe { buffer.Lock(&mut data, None, Some(&mut length)) })?;
        let _lock = LockedBuffer(buffer);
        let stride = format.stride.unsigned_abs() as usize;
        let row_bytes = (format.size.width as usize).checked_mul(4).ok_or(CaptureError::InvalidMedia)?;
        let span = stride.checked_mul(format.size.height.saturating_sub(1) as usize)
            .and_then(|offset| offset.checked_add(row_bytes)).ok_or(CaptureError::InvalidMedia)?;
        if span > length as usize { return Err(CaptureError::InvalidMedia); }
        let top = if format.stride < 0 {
            unsafe { data.add(stride * format.size.height.saturating_sub(1) as usize) }
        } else { data };
        unsafe { rows(top, format.stride, format.size) }
    }
}

/// Seek to the native source's preceding keyframe, decode through the selected
/// end, and physically encode only overlapping frame intervals. No edit list.
pub fn trim(source: &Path, output: &Path, start_ms: u64, end_ms: u64, cancel: &CancelSignal) -> Result<(), CaptureError> {
    if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
    if start_ms >= end_ms { return Err(CaptureError::InvalidSelection); }
    let ticks = |value: u64| value.checked_mul(10_000).and_then(|value| i64::try_from(value).ok())
        .ok_or(CaptureError::InvalidSelection);
    let (start, end) = (ticks(start_ms)?, ticks(end_ms)?);
    let _runtime = WinRt::new()?;
    let foundation = MediaFoundation::start()?;
    let attributes = foundation.attributes()?;
    native(unsafe { attributes.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1) })?;
    let path = storage_path(source)?;
    let reader = foundation.reader(PCWSTR(path.as_ptr()), &attributes)?;
    let video = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
    native(unsafe { reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false) })?;
    native(unsafe { reader.SetStreamSelection(video, true) })?;
    let duration = native(unsafe { reader.GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION) })?;
    if end as u64 > native(u64::try_from(&duration))? { return Err(CaptureError::InvalidSelection); }
    let decoded = foundation.media_type()?;
    native(unsafe { decoded.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video) })?;
    native(unsafe { decoded.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32) })?;
    native(unsafe { reader.SetCurrentMediaType(video, None, &decoded) })?;
    let mut decoded_format = format(&reader, video, &foundation)?;
    let size = decoded_format.size;
    // SourceReader's documented seek starts at the preceding sync frame. The
    // decoded PTS/duration below, not this seek, decides which pixels may leave.
    native(unsafe { reader.SetCurrentPosition(&GUID::zeroed(), &PROPVARIANT::from(start)) })?;
    drop(std::fs::OpenOptions::new().write(true).create_new(true).open(output).map_err(|_| CaptureError::FileIo)?);
    let result = (|| {
        let mut writer = Writer { encoder: Some(encoder(output, size)?), last: None };
        #[cfg(test)] let (mut decoded_count, mut admitted_count, mut first_pts) = (0u64, 0u64, None);
        loop {
            if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
            let mut flags = 0; let mut timestamp = 0; let mut sample = None;
            native(unsafe { reader.ReadSample(video, 0, None, Some(&mut flags), Some(&mut timestamp), Some(&mut sample)) })?;
            #[cfg(test)] if sample.is_some() { decoded_count += 1; first_pts.get_or_insert(timestamp); }
            if flags & MF_SOURCE_READERF_ERROR.0 as u32 != 0 { return Err(CaptureError::InvalidMedia); }
            if flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0 as u32 != 0 {
                decoded_format = format(&reader, video, &foundation)?;
                if decoded_format.size != size { return Err(CaptureError::InvalidMedia); }
            }
            if timestamp >= end { break; }
            if let Some(sample) = sample {
                let duration = native(unsafe { sample.GetSampleDuration() })?;
                if duration <= 0 { return Err(CaptureError::InvalidMedia); }
                let frame_end = timestamp.checked_add(duration).ok_or(CaptureError::InvalidMedia)?;
                if frame_end > start {
                    let relative = timestamp.max(start) - start;
                    writer.append(pixels(&sample, decoded_format)?, (relative as u64).checked_mul(100).ok_or(CaptureError::InvalidMedia)?)?;
                    #[cfg(test)] { admitted_count += 1; }
                }
            }
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 { break; }
        }
        #[cfg(test)] eprintln!("WINDOWS_TRIM_WORK decoded={decoded_count} admitted={admitted_count} first_pts={first_pts:?} selected={start}..{end}");
        if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
        writer.finish(((end-start) as u64).checked_mul(100).ok_or(CaptureError::InvalidSelection)?)
    })();
    // VideoEncoder's existing Drop joins and releases its native work before
    // this exact, newly-created partial can be removed on error/cancellation.
    if result.is_err() { std::fs::remove_file(output).map_err(|_| CaptureError::FileIo)?; }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_optional_media_library_is_a_requested_operation_failure() {
        assert!(matches!(Library::load(w!("Happier.Missing.Media.Proof.dll")), Err(CaptureError::NativeFailure)));
    }
}
