//! Pixel layout at the native H.264 input boundary.
use crate::{capture::{CaptureError, DisplayDescriptor, PixelSize, clamp_local_rect}, geometry::Rect};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Crop { pub left: u32, pub top: u32, pub right: u32, pub bottom: u32 }
impl Crop {
    pub fn size(self) -> PixelSize { PixelSize { width: self.right-self.left, height: self.bottom-self.top } }
}

pub(super) fn display_crop(display: &DisplayDescriptor, rect: Rect) -> Result<Crop, CaptureError> {
    let rect = clamp_local_rect(rect, display)?;
    let width = (display.frame.width * display.scale).round() as u32;
    let height = (display.frame.height * display.scale).round() as u32;
    let (x, y) = crate::geometry::display_pixel_ranges(rect, display.scale, width, height)
        .ok_or(CaptureError::InvalidSelection)?;
    let (left, right) = even_interval(x.start, x.end, width)?;
    let (top, bottom) = even_interval(y.start, y.end, height)?;
    Ok(Crop { left, top, right, bottom })
}

/// WGC supplies top-down BGRA rows with driver stride; the raw WinRT encoder
/// expects packed bottom-up rows. Crop here, never through encoder resizing.
pub(super) fn pack_crop(raw: &[u8], stride: usize, crop: Crop) -> Result<Vec<u8>, CaptureError> {
    if crop.right <= crop.left || crop.bottom <= crop.top || crop.right as usize * 4 > stride
        || (crop.bottom as usize - 1).checked_mul(stride).and_then(|last|
            last.checked_add(crop.right as usize * 4)).is_none_or(|end| end > raw.len()) {
        return Err(CaptureError::TargetUnavailable);
    }
    let row = (crop.right-crop.left) as usize * 4;
    let mut packed = Vec::with_capacity(row * (crop.bottom-crop.top) as usize);
    for y in (crop.top..crop.bottom).rev() {
        let start = y as usize * stride + crop.left as usize * 4;
        packed.extend_from_slice(&raw[start..start+row]);
    }
    Ok(packed)
}

pub(super) fn even_interval(start: u32, end: u32, bound: u32) -> Result<(u32, u32), CaptureError> {
    if end <= start || end > bound { return Err(CaptureError::InvalidSelection); }
    if (end-start) % 2 == 0 { return Ok((start,end)); }
    if end < bound { Ok((start,end+1)) } else if start > 0 { Ok((start-1,end)) } else { Err(CaptureError::InvalidSelection) }
}

pub(super) fn window_pixel_size(width: u32, height: u32) -> PixelSize {
    PixelSize { width: width - width % 2, height: height - height % 2 }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_pixels_use_nonzero_origin_row_stride_and_bottom_up_encoder_layout() {
        let mut pixels = vec![255; 6 * 4 * 4];
        for y in 0..4usize { for x in 0..5usize {
            let offset = y * 24 + x * 4;
            pixels[offset..offset+4].copy_from_slice(&[x as u8, y as u8, 7, 255]);
        }}
        let packed = pack_crop(&pixels, 24, Crop { left: 1, top: 1, right: 5, bottom: 3 }).unwrap();
        assert_eq!(packed.len(), 4 * 2 * 4);
        assert_eq!(&packed[..4], &[1, 2, 7, 255]);
        assert_eq!(&packed[16..20], &[1, 1, 7, 255]);
        assert_eq!(&packed[28..], &[4, 1, 7, 255]);
        assert_eq!(pack_crop(&pixels, 24, Crop { left: 1, top: 1, right: 5, bottom: 5 }), Err(CaptureError::TargetUnavailable));
    }

    #[test]
    fn negative_desktop_origin_and_mixed_dpi_keep_region_display_local() {
        let display = DisplayDescriptor { display_id: 4,
            frame: Rect { x: -3000., y: -100., width: 100., height: 80. },
            scale: 1.5, desktop_scale: 1.5, storage_key: None, localized_name: None,
            safe_area_top: 0., physical_notch_size: None };
        let crop = display_crop(&display, Rect { x: 10., y: 8., width: 9., height: 7. }).unwrap();
        assert_eq!(crop, Crop { left: 15, top: 12, right: 29, bottom: 24 });
        let edge = display_crop(&display, Rect { x: 99., y: 79., width: 1., height: 1. }).unwrap();
        assert_eq!(edge, Crop { left: 148, top: 118, right: 150, bottom: 120 });
        assert_eq!(window_pixel_size(65, 49), PixelSize { width: 64, height: 48 });
    }
}
