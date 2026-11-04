//! Shell adapter for the shared desktop-native display reader. No selection policy lives here.
use super::host_mode::DesktopActivityOverlayDisplayContext;
use super::placement::Rect;
use tauri::{AppHandle, Manager, Runtime};

#[derive(Clone, Debug)]
pub(crate) struct MonitorFacts {
    pub storage_key: String,
    pub name: String,
    pub built_in: Option<bool>,
    pub primary: bool,
    pub native_name: Option<String>,
    pub rect: Rect,
    pub work_area: Rect,
    pub scale: f64,
    pub display_context: Option<DesktopActivityOverlayDisplayContext>,
}

pub(crate) fn resolve_monitor_logical_scale_factor(scale: f64, fallback: f64) -> f64 {
    if scale.is_finite() && scale > 0. { scale } else { fallback.max(f64::EPSILON) }
}
pub(crate) fn logical_rect_from_physical_bounds(x:i32,y:i32,width:u32,height:u32,scale:f64) -> Rect {
    Rect { x:x as f64/scale, y:y as f64/scale, width:width as f64/scale, height:height as f64/scale }
}
pub(crate) fn monitor_to_logical_rect(monitor:&tauri::Monitor, fallback:f64) -> Rect {
    logical_rect_from_physical_bounds(monitor.position().x,monitor.position().y,monitor.size().width,monitor.size().height,
        resolve_monitor_logical_scale_factor(monitor.scale_factor(),fallback))
}

pub(crate) fn read_monitor_facts<R:Runtime>(app:&AppHandle<R>) -> Result<Vec<MonitorFacts>,String> {
    let monitors=app.available_monitors().map_err(|e| e.to_string())?;
    let primary=app.primary_monitor().map_err(|e| e.to_string())?;
    #[cfg(target_os="macos")]
    let screens=crate::desktop_panel::run_on_main_thread(app, || {
        happier_desktop_native::display::list_displays(objc2::MainThreadMarker::new().unwrap())
    }, "Display discovery did not return")?;
    #[cfg(any(target_os="windows",target_os="linux"))]
    let native=happier_desktop_native::display::platform_display_facts().unwrap_or_else(|error| {
        log::warn!("Native display identity unavailable: {error}"); Vec::new()
    });
    Ok(monitors.into_iter().map(|monitor| {
        let scale=resolve_monitor_logical_scale_factor(monitor.scale_factor(),1.);
        let rect=monitor_to_logical_rect(&monitor,scale);
        let work=monitor.work_area();
        let work_area=logical_rect_from_physical_bounds(work.position.x,work.position.y,work.size.width,work.size.height,scale);
        let native_name=monitor.name().cloned();
        let primary=primary.as_ref().is_some_and(|p| p.position()==monitor.position() && p.size()==monitor.size());
        #[cfg(target_os="macos")]
        let (storage_key,name,built_in,display_context)={
            // Core Graphics bounds use Tauri's top-origin coordinate system;
            // NSScreen frame is retained in the context for AppKit conversion.
            let screen=screens.iter().find(|screen| screen.cg_display_id.is_some_and(|id| {
                let bounds=unsafe { objc2_core_graphics::CGDisplayBounds(id) };
                (bounds.origin.x-rect.x).abs()<0.5 && (bounds.origin.y-rect.y).abs()<0.5
                    && (bounds.size.width-rect.width).abs()<0.5 && (bounds.size.height-rect.height).abs()<0.5
            }));
            match screen {
                Some(screen)=>(screen.identity.storage_key.clone(),screen.localized_name.clone(),Some(screen.is_builtin),
                    super::macos_display_context::build_display_context_for_screen(screen, Rect {
                        x:screen.frame.x,y:screen.frame.y,width:screen.frame.width,height:screen.frame.height })),
                None=>(format!("display-{}-{}",monitor.position().x,monitor.position().y),native_name.clone().unwrap_or_default(),None,None),
            }
        };
        #[cfg(any(target_os="windows",target_os="linux"))]
        let (storage_key,name,built_in,display_context)={
            let facts=native.iter().find(|facts| Some(&facts.native_name)==native_name.as_ref());
            let key=facts.map(|f| f.storage_key.clone()).unwrap_or_else(|| format!("native-{}-{}-{}",native_name.as_deref().unwrap_or("display"),monitor.position().x,monitor.position().y));
            let name=facts.and_then(|f| f.friendly_name.clone()).or_else(||native_name.clone()).unwrap_or_else(||key.clone());
            let builtin=facts.and_then(|f| f.built_in);
            (key,name,builtin,None)
        };
        MonitorFacts {storage_key,name,built_in,primary,native_name,rect,work_area,scale,display_context}
    }).collect())
}
