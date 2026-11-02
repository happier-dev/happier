//! X11 metadata and pixels. The native Wayland branch never constructs this adapter.
use crate::capture::{CaptureBackend, CaptureError, CaptureTarget, CancelSignal, DisplayDescriptor, Inventory, RgbaFrame, WindowDescriptor};
use crate::geometry::Rect;
use x11rb::{connection::Connection, protocol::{composite::{ConnectionExt as _, Redirect},
    randr::ConnectionExt as _, xproto::{ConnectionExt as _, AtomEnum, Drawable, ImageFormat, ImageOrder, MapState, Visualid}},
    rust_connection::RustConnection};

x11rb::atom_manager! {
    Atoms: AtomsCookie {
        _NET_CLIENT_LIST_STACKING, _NET_ACTIVE_WINDOW, _NET_WM_PID, _NET_WM_NAME, UTF8_STRING,
    }
}

pub struct X11CaptureBackend {
    connection: RustConnection, screen: usize, atoms: Atoms,
    /// Native root-pixel bounds and CSS scale from the shell's monitor owner.
    display_scales: Vec<(Rect, f64)>,
}
/// P1's native monitor identity/bounds producer, also consumed by an admitted
/// recorder when RandR pushes a topology change.
pub(in crate::capture) fn native_monitor_frames(connection: &RustConnection, root: u32) -> Result<Vec<(u32, Rect)>, CaptureError> {
    Ok(connection.randr_get_monitors(root, true).map_err(|_| CaptureError::NativeFailure)?
        .reply().map_err(|_| CaptureError::NativeFailure)?.monitors.into_iter().map(|monitor| (monitor.name,
            Rect { x: monitor.x as f64, y: monitor.y as f64, width: monitor.width as f64, height: monitor.height as f64 })).collect())
}
impl X11CaptureBackend {
    pub fn new(display_scales: Vec<(Rect, f64)>) -> Result<Self, CaptureError> {
        let (connection, screen) = x11rb::connect(None).map_err(|_| CaptureError::NativeFailure)?;
        let atoms = Atoms::new(&connection).map_err(|_| CaptureError::NativeFailure)?
            .reply().map_err(|_| CaptureError::NativeFailure)?;
        Ok(Self { connection, screen, atoms, display_scales })
    }
    fn root(&self) -> u32 { self.connection.setup().roots[self.screen].root }
    fn property(&self, window: u32, atom: u32, kind: AtomEnum) -> Result<x11rb::protocol::xproto::GetPropertyReply, CaptureError> {
        self.connection.get_property(false, window, atom, kind, 0, u32::MAX)
            .map_err(|_| CaptureError::TargetUnavailable)?.reply().map_err(|_| CaptureError::TargetUnavailable)
    }
    fn window(&self, id: u32, z_order: usize) -> Result<WindowDescriptor, CaptureError> {
        let attributes = self.connection.get_window_attributes(id).map_err(|_| CaptureError::TargetUnavailable)?
            .reply().map_err(|_| CaptureError::TargetUnavailable)?;
        if attributes.map_state != MapState::VIEWABLE { return Err(CaptureError::TargetUnavailable); }
        let pid = self.property(id, self.atoms._NET_WM_PID, AtomEnum::CARDINAL)?.value32()
            .and_then(|mut values| values.next()).ok_or(CaptureError::TargetUnavailable)?;
        if pid == std::process::id() { return Err(CaptureError::TargetUnavailable); }
        let geometry = self.connection.get_geometry(id).map_err(|_| CaptureError::TargetUnavailable)?
            .reply().map_err(|_| CaptureError::TargetUnavailable)?;
        let position = self.connection.translate_coordinates(id, self.root(), 0, 0)
            .map_err(|_| CaptureError::TargetUnavailable)?.reply().map_err(|_| CaptureError::TargetUnavailable)?;
        let title = self.property(id, self.atoms._NET_WM_NAME, AtomEnum::ANY).ok()
            .filter(|value| !value.value.is_empty()).map(|value| String::from_utf8_lossy(&value.value).into_owned())
            .or_else(|| self.property(id, AtomEnum::WM_NAME.into(), AtomEnum::ANY).ok()
                .map(|value| String::from_utf8_lossy(&value.value).into_owned()));
        let app_name = self.property(id, AtomEnum::WM_CLASS.into(), AtomEnum::STRING).ok()
            .and_then(|value| value.value.split(|b| *b == 0).nth(1).filter(|name| !name.is_empty())
                .map(|name| String::from_utf8_lossy(name).into_owned()));
        Ok(WindowDescriptor { window_id: id, process_id: pid, z_order, title, app_name,
            frame: Rect { x: position.dst_x as f64, y: position.dst_y as f64,
                width: geometry.width as f64, height: geometry.height as f64 } })
    }
    fn displays(&self) -> Result<Vec<DisplayDescriptor>, CaptureError> {
        native_monitor_frames(&self.connection, self.root())?.into_iter().map(|(id, native_frame)| {
                let name = self.connection.get_atom_name(id).map_err(|_| CaptureError::NativeFailure)?
                    .reply().map_err(|_| CaptureError::NativeFailure)?.name;
                let scale = self.display_scales.iter().find(|(frame, _)| *frame == native_frame)
                    .map(|(_, scale)| *scale).ok_or(CaptureError::TargetUnavailable)?;
                Ok(DisplayDescriptor { display_id: id,
                    frame: Rect { width: native_frame.width/scale, height: native_frame.height/scale, ..native_frame },
                    scale, desktop_scale: scale, storage_key: None,
                    localized_name: Some(String::from_utf8_lossy(&name).into_owned()),
                    safe_area_top: 0., physical_notch_size: None })
            }).collect()
    }
    fn chosen_window(&self, id: u32) -> Result<Inventory, CaptureError> {
        let mut inventory = Inventory { displays: self.displays()?, windows: vec![self.window(id, 0)?] };
        let display_id = inventory.window_display(&inventory.windows[0])
            .ok_or(CaptureError::TargetUnavailable)?.display_id;
        inventory.displays.retain(|display| display.display_id == display_id);
        Ok(inventory)
    }
    fn image(&self, drawable: Drawable, visual: Visualid, x: i16, y: i16, width: u16, height: u16) -> Result<RgbaFrame, CaptureError> {
        let image = self.connection.get_image(ImageFormat::Z_PIXMAP, drawable, x, y, width, height, u32::MAX)
            .map_err(|_| CaptureError::TargetUnavailable)?.reply().map_err(|_| CaptureError::TargetUnavailable)?;
        let setup = self.connection.setup();
        let format = setup.pixmap_formats.iter().find(|format| format.depth == image.depth).ok_or(CaptureError::UnsupportedPlatform)?;
        let visual = setup.roots[self.screen].allowed_depths.iter().flat_map(|depth| &depth.visuals)
            .find(|candidate| candidate.visual_id == visual).ok_or(CaptureError::UnsupportedPlatform)?;
        decode_image(width as u32, height as u32, &image.data, PixelFormat {
            bits_per_pixel: format.bits_per_pixel, scanline_pad: format.scanline_pad,
            little_endian: setup.image_byte_order == ImageOrder::LSB_FIRST,
            masks: [visual.red_mask, visual.green_mask, visual.blue_mask],
        })
    }
}
impl CaptureBackend for X11CaptureBackend {
    fn recording_format(&self) -> crate::capture::recording::Format { crate::capture::recording::Format::Webm }
    fn prepare_recording(&self, inventory: &Inventory, target: &CaptureTarget, path: &std::path::Path,
        timeline: std::sync::Arc<std::sync::Mutex<crate::capture::recording::Timeline>>,
        failed: std::sync::Arc<dyn Fn(CaptureError) + Send + Sync>) -> Result<crate::capture::recording::PreparedBackend, CaptureError> {
        crate::capture::recording::linux::prepare(inventory, target, path, timeline, failed)
    }
    fn discover(&self) -> Result<Inventory, CaptureError> {
        let ids = self.property(self.root(), self.atoms._NET_CLIENT_LIST_STACKING, AtomEnum::WINDOW)?;
        let windows = ids.value32().ok_or(CaptureError::TargetUnavailable)?.collect::<Vec<_>>()
            .into_iter().rev().enumerate().filter_map(|(z, id)| self.window(id, z).ok()).collect();
        Ok(Inventory::from_os(self.displays()?, windows, std::process::id()))
    }
    fn foreground(&self) -> Result<Inventory, CaptureError> {
        let id = self.property(self.root(), self.atoms._NET_ACTIVE_WINDOW, AtomEnum::WINDOW)?.value32()
            .and_then(|mut values| values.next()).ok_or(CaptureError::TargetUnavailable)?;
        self.chosen_window(id)
    }
    fn discover_target(&self, target: &CaptureTarget) -> Result<Inventory, CaptureError> {
        match target {
            CaptureTarget::Frontmost => self.foreground(),
            CaptureTarget::Window { window_id } => self.chosen_window(*window_id),
            CaptureTarget::Display { display_id } | CaptureTarget::Rect { display_id, .. } => {
                let display = self.displays()?.into_iter().find(|display| display.display_id == *display_id)
                    .ok_or(CaptureError::TargetUnavailable)?;
                Ok(Inventory { displays: vec![display], windows: vec![] })
            },
        }
    }
    fn capture_display(&self, id: u32, cancel: &CancelSignal) -> Result<RgbaFrame, CaptureError> {
        if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
        let display = self.displays()?.into_iter().find(|display| display.display_id == id).ok_or(CaptureError::TargetUnavailable)?;
        let screen = &self.connection.setup().roots[self.screen];
        self.image(screen.root, screen.root_visual, display.frame.x as i16, display.frame.y as i16,
            (display.frame.width*display.scale) as u16, (display.frame.height*display.scale) as u16)
    }
    fn capture_window(&self, id: u32, _include_shadow: bool, cancel: &CancelSignal) -> Result<RgbaFrame, CaptureError> {
        if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
        let attributes = self.connection.get_window_attributes(id).map_err(|_| CaptureError::TargetUnavailable)?
            .reply().map_err(|_| CaptureError::TargetUnavailable)?;
        if attributes.map_state != MapState::VIEWABLE { return Err(CaptureError::TargetUnavailable); }
        self.connection.composite_query_version(0, 4).map_err(|_| CaptureError::UnsupportedPlatform)?
            .reply().map_err(|_| CaptureError::UnsupportedPlatform)?;
        self.connection.composite_redirect_window(id, Redirect::AUTOMATIC).map_err(|_| CaptureError::TargetUnavailable)?
            .check().map_err(|_| CaptureError::TargetUnavailable)?;
        let result = (|| {
            let pixmap = self.connection.generate_id().map_err(|_| CaptureError::NativeFailure)?;
            self.connection.composite_name_window_pixmap(id, pixmap).map_err(|_| CaptureError::TargetUnavailable)?
                .check().map_err(|_| CaptureError::TargetUnavailable)?;
            let result = (|| {
                let size = self.connection.get_geometry(pixmap).map_err(|_| CaptureError::TargetUnavailable)?
                    .reply().map_err(|_| CaptureError::TargetUnavailable)?;
                self.image(pixmap, attributes.visual, 0, 0, size.width, size.height)
            })();
            let _ = self.connection.free_pixmap(pixmap);
            result
        })();
        let _ = self.connection.composite_unredirect_window(id, Redirect::AUTOMATIC);
        let _ = self.connection.flush();
        result
    }
}

#[derive(Clone, Copy)]
struct PixelFormat { bits_per_pixel: u8, scanline_pad: u8, little_endian: bool, masks: [u32; 3] }
fn decode_image(width: u32, height: u32, bytes: &[u8], format: PixelFormat) -> Result<RgbaFrame, CaptureError> {
    let bpp = usize::from(format.bits_per_pixel);
    let pad = usize::from(format.scanline_pad);
    if !matches!(bpp, 16 | 24 | 32) || !matches!(pad, 8 | 16 | 32) || format.masks.contains(&0) {
        return Err(CaptureError::UnsupportedPlatform);
    }
    let stride = (width as usize * bpp).div_ceil(pad) * pad / 8;
    if bytes.len() != stride * height as usize { return Err(CaptureError::NativeFailure); }
    let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
    for row in bytes.chunks_exact(stride) {
        for pixel in row[..width as usize * bpp / 8].chunks_exact(bpp / 8) {
            let value = if format.little_endian {
                pixel.iter().enumerate().fold(0, |value, (index, byte)| value | u32::from(*byte) << (index * 8))
            } else { pixel.iter().fold(0, |value, byte| value << 8 | u32::from(*byte)) };
            for mask in format.masks {
                let shift = mask.trailing_zeros();
                rgba.push((((value & mask) >> shift) as u64 * 255 / (mask >> shift) as u64) as u8);
            }
            rgba.push(255);
        }
    }
    Ok(RgbaFrame { width, height, rgba })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_pixels_preserve_channels_and_skip_row_padding() {
        let format = PixelFormat { bits_per_pixel: 24, scanline_pad: 32, little_endian: true, masks: [0xff0000, 0xff00, 0xff] };
        let frame = decode_image(1, 2, &[3, 5, 7, 99, 11, 13, 17, 99], format).unwrap();
        assert_eq!(frame.rgba, [7, 5, 3, 255, 17, 13, 11, 255]);
        let format = PixelFormat { little_endian: false, ..format };
        assert_eq!(decode_image(1, 1, &[7, 5, 3, 99], format).unwrap().rgba, [7, 5, 3, 255]);
        assert_eq!(decode_image(1, 2, &[3, 5, 7], format).unwrap_err(), CaptureError::NativeFailure);
    }
}
