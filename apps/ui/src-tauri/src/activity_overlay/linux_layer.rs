//! Optional Wayland host. GTK/X11 continues through the normal window adapter.
use super::{dock::Dock, placement::Rect};
use gtk::{glib::translate::ToGlibPtr, prelude::*};
use std::{ffi::OsStr, rc::Rc};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Unavailable {
    LibraryMissing,
    SymbolsMissing,
    Unsupported,
    AlreadyRealized,
}

impl Unavailable {
    pub(super) fn reason(&self) -> &'static str {
        "Your desktop doesn't let apps dock to the screen edge"
    }
}

type Window = *mut gtk::ffi::GtkWindow;
struct LayerShell {
    // Function pointers are valid only while their originating library is owned.
    _library: libloading::Library,
    supported: unsafe extern "C" fn() -> i32,
    init: unsafe extern "C" fn(Window),
    layer: unsafe extern "C" fn(Window, i32),
    anchor: unsafe extern "C" fn(Window, i32, i32),
    margin: unsafe extern "C" fn(Window, i32, i32),
    exclusive: unsafe extern "C" fn(Window, i32),
    monitor: unsafe extern "C" fn(Window, *mut gtk::gdk::ffi::GdkMonitor),
    keyboard: unsafe extern "C" fn(Window, i32),
}
impl LayerShell {
    fn load(path: &OsStr) -> Result<Self, Unavailable> {
        // SAFETY: gtk-layer-shell's GTK3 C ABI, checked by acquiring every used
        // symbol before initializing a window. No link-time dependency exists.
        unsafe {
            let library =
                libloading::Library::new(path).map_err(|_| Unavailable::LibraryMissing)?;
            macro_rules! symbol {
                ($name:literal) => {
                    *library
                        .get(concat!($name, "\0").as_bytes())
                        .map_err(|_| Unavailable::SymbolsMissing)?
                };
            }
            Ok(Self {
                supported: symbol!("gtk_layer_is_supported"),
                init: symbol!("gtk_layer_init_for_window"),
                layer: symbol!("gtk_layer_set_layer"),
                anchor: symbol!("gtk_layer_set_anchor"),
                margin: symbol!("gtk_layer_set_margin"),
                exclusive: symbol!("gtk_layer_set_exclusive_zone"),
                monitor: symbol!("gtk_layer_set_monitor"),
                keyboard: symbol!("gtk_layer_set_keyboard_mode"),
                _library: library,
            })
        }
    }
}

const DATA_KEY: &str = "happier-notch-layer-shell";

fn adapter(window: &gtk::ApplicationWindow) -> Option<Rc<LayerShell>> {
    // SAFETY: this module is the sole writer for this GTK object-data key.
    unsafe {
        window
            .data::<Rc<LayerShell>>(DATA_KEY)
            .map(|value| value.as_ref().clone())
    }
}

pub(super) fn initialize_native(
    window: &gtk::ApplicationWindow,
    library: &OsStr,
) -> Result<bool, Unavailable> {
    if window.display().type_().name() != "GdkWaylandDisplay" {
        return Ok(false);
    }
    if adapter(window).is_some() {
        return Ok(true);
    }
    let api = Rc::new(LayerShell::load(library)?);
    if unsafe { (api.supported)() } == 0 {
        return Err(Unavailable::Unsupported);
    }
    if window.is_realized() {
        return Err(Unavailable::AlreadyRealized);
    }
    let ptr = window.upcast_ref::<gtk::Window>().to_glib_none().0;
    unsafe {
        (api.init)(ptr);
        (api.exclusive)(ptr, 0);
        (api.keyboard)(ptr, 0); // NONE; the composer requests ON_DEMAND.
        window.set_data(DATA_KEY, api);
    }
    Ok(true)
}

#[derive(Debug, PartialEq, Eq)]
struct Placement {
    anchors: [bool; 4],
    margins: [i32; 4],
    layer: i32,
}

fn placement(dock: Dock, rect: Rect, monitor: Rect, above: bool) -> Placement {
    let right = dock == Dock::Right;
    Placement {
        // gtk-layer-shell edge order: LEFT, RIGHT, TOP, BOTTOM.
        anchors: [!right, right, true, false],
        margins: [
            if right {
                0
            } else {
                (rect.x - monitor.x).round() as i32
            },
            if right {
                (monitor.x + monitor.width - rect.x - rect.width).round() as i32
            } else {
                0
            },
            (rect.y - monitor.y).round() as i32,
            0,
        ],
        layer: if above { 3 } else { 2 }, // OVERLAY / TOP.
    }
}

pub(super) fn apply_native(
    window: &gtk::ApplicationWindow,
    dock: Dock,
    rect: Rect,
    monitor: Rect,
    above: bool,
) -> Result<bool, String> {
    let Some(api) = adapter(window) else {
        return Ok(false);
    };
    let display = window.display();
    let target = (0..display.n_monitors())
        .filter_map(|index| display.monitor(index))
        .find(|value| {
            let g = value.geometry();
            f64::from(g.x()) == monitor.x
                && f64::from(g.y()) == monitor.y
                && f64::from(g.width()) == monitor.width
                && f64::from(g.height()) == monitor.height
        })
        .ok_or_else(|| "Wayland display is no longer connected".to_string())?;
    let plan = placement(dock, rect, monitor, above);
    let ptr = window.upcast_ref::<gtk::Window>().to_glib_none().0;
    unsafe {
        (api.monitor)(ptr, target.to_glib_none().0);
        (api.layer)(ptr, plan.layer);
        for edge in 0..4 {
            (api.anchor)(ptr, edge as i32, i32::from(plan.anchors[edge]));
            (api.margin)(ptr, edge as i32, plan.margins[edge]);
        }
    }
    window.set_size_request(rect.width.round() as i32, rect.height.round() as i32);
    window.resize(1, 1); // GTK/layer-shell recomputes the requested extent.
    Ok(true)
}

pub(super) fn keyboard_native(window: &gtk::ApplicationWindow, wanted: bool) {
    if let Some(api) = adapter(window) {
        // gtk-layer-shell: NONE = 0, ON_DEMAND = 2. Pointer clicks stay non-key.
        unsafe { (api.keyboard)(window.upcast_ref::<gtk::Window>().to_glib_none().0, if wanted { 2 } else { 0 }); }
    }
}

// TAURI ADAPTER
pub(super) fn initialize<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    use tauri::Manager;
    let native_window = window.clone();
    crate::desktop_panel::run_on_main_thread(
        window.app_handle(),
        move || {
            let native = native_window
                .gtk_window()
                .map_err(|error| error.to_string())?;
            initialize_native(&native, OsStr::new("libgtk-layer-shell.so.0"))
                .map(|_| ())
                .map_err(|error| error.reason().to_string())
        },
        "Overlay layer-shell initialization did not return",
    )?
}

pub(super) fn apply<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    dock: Dock,
    rect: Rect,
    monitor: Rect,
    above: bool,
) -> Result<bool, String> {
    use tauri::Manager;
    let native_window = window.clone();
    crate::desktop_panel::run_on_main_thread(
        window.app_handle(),
        move || {
            let native = native_window
                .gtk_window()
                .map_err(|error| error.to_string())?;
            apply_native(&native, dock, rect, monitor, above)
        },
        "Overlay layer-shell placement did not return",
    )?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_library_settles_unavailable_without_aborting_host_startup() {
        let absent = std::path::Path::new("/happier-absent-layer-shell/libgtk-layer-shell.so.0");
        let error = LayerShell::load(absent.as_os_str())
            .err()
            .expect("optional library absent");
        assert_eq!(error, Unavailable::LibraryMissing);
        let result = super::super::availability_for_failure(Some(error.reason()));
        assert_eq!(result["kind"], "unavailable");
        assert!(result["reason"]
            .as_str()
            .is_some_and(|value| !value.is_empty() && !value.contains('\n')));
        assert_eq!(
            super::super::availability_for_failure(None)["kind"],
            "available"
        );
    }

    #[test]
    fn edge_and_floating_frames_use_position_margins_and_fullscreen_layer() {
        let monitor = Rect {
            x: -800.,
            y: 20.,
            width: 800.,
            height: 600.,
        };
        let frame = Rect {
            x: -300.,
            y: 157.,
            width: 200.,
            height: 80.,
        };
        for dock in [Dock::Top, Dock::Left, Dock::Floating] {
            let plan = placement(dock, frame, monitor, true);
            assert_eq!(plan.anchors, [true, false, true, false]);
            assert_eq!(plan.margins, [500, 0, 137, 0]);
            assert_eq!(plan.layer, 3);
        }
        let plan = placement(Dock::Right, frame, monitor, false);
        assert_eq!(plan.anchors, [false, true, true, false]);
        assert_eq!(plan.margins, [0, 100, 137, 0]);
        assert_eq!(plan.layer, 2);
    }
}
