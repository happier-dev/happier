use super::{display_choice::{choose_display, DisplayCandidate, DisplayChoice}, monitor_resolution::{read_monitor_facts, monitor_to_logical_rect, MonitorFacts}, storage, ActivityOverlayState, MAIN_WINDOW_LABEL};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

pub(super) fn invalidate_projection(state: &mut super::ActivityOverlayRuntimeState) {
    state.envelope = None;
    state.last_display_context = None;
    state.display_inventory = None;
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct DisplayOption {
    storage_key:String, name:String, built_in:bool, primary:bool, connected:bool, in_use:bool,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all="camelCase")]
pub struct DesktopDisplaysList { displays:Vec<DisplayOption>, automatic_resolves_to:Option<String> }
#[derive(Clone, Debug, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct DisplayResolution {
    pub source:String, pub fell_back:bool, pub storage_key:String, pub name:String,
    #[serde(skip_serializing_if="Option::is_none")]
    pub requested_name:Option<String>,
}

pub(super) fn inventory<R:Runtime>(app:&AppHandle<R>, state:&ActivityOverlayState, refresh:bool) -> Result<Vec<MonitorFacts>,String> {
    if !refresh {
        if let Some(displays)=state.0.lock().map_err(|e|e.to_string())?.display_inventory.as_ref() {return Ok(displays.clone());}
    }
    let displays=read_monitor_facts(app)?;
    let mut guard=state.0.lock().map_err(|e|e.to_string())?;
    if remember_names(&mut guard.notch_positions, &displays) {
        storage::persist_notch_positions(app,&guard.notch_positions)?;
    }
    guard.display_inventory=Some(displays.clone());
    Ok(displays)
}

fn remember_names(remembered:&mut storage::NotchPositions, displays:&[MonitorFacts]) -> bool {
    let mut changed=false;
    for display in displays {
        let record=remembered.entry(display.storage_key.clone()).or_default();
        if record.name!=display.name { record.name=display.name.clone(); changed=true; }
    }
    changed
}

fn candidates(displays:&[MonitorFacts]) -> Vec<DisplayCandidate> {
    displays.iter().map(|d|DisplayCandidate {storage_key:d.storage_key.clone(),built_in:d.built_in,primary:d.primary}).collect()
}
pub(super) fn main_key<R:Runtime>(app:&AppHandle<R>,displays:&[MonitorFacts]) -> Option<String> {
    let monitor=app.get_webview_window(MAIN_WINDOW_LABEL)?.current_monitor().ok()??;
    let rect=monitor_to_logical_rect(&monitor,1.);
    displays.iter().find(|d|d.rect==rect).map(|d|d.storage_key.clone())
}
pub(super) fn select<R:Runtime>(app:&AppHandle<R>,mode:&str,displays:&[MonitorFacts]) -> Result<DisplayChoice,String> {
    let main=if mode=="main" {main_key(app,displays)} else {None};
    choose_display(mode,&candidates(displays),main.as_deref()).ok_or_else(||"No connected display is available".into())
}

pub(super) fn placement<R:Runtime>(app:&AppHandle<R>,state:&ActivityOverlayState,mode:&str) -> Result<(MonitorFacts,DisplayChoice,super::placement::Rect),String> {
    let inventory=inventory(app,state,false)?;
    let choice=select(app,mode,&inventory)?;
    let selected=inventory[choice.index].clone();
    let visible=visible_frame(&selected)?;
    Ok((selected,choice,visible))
}
pub(super) fn visible_frame(display:&MonitorFacts) -> Result<super::placement::Rect,String> {
    if cfg!(target_os="macos") {
        super::panel_host::visible_frame(display.rect,display.work_area,display.display_context.as_ref())
    } else {Ok(display.work_area)}
}
pub(super) fn resolution(display:&MonitorFacts,choice:DisplayChoice, mode:&str, remembered:&storage::NotchPositions) -> DisplayResolution {
    let requested_name=mode.strip_prefix("named:").and_then(|key|remembered.get(key)).map(|record|record.name.clone());
    DisplayResolution {source:choice.source.into(),fell_back:choice.fell_back,storage_key:display.storage_key.clone(),name:display.name.clone(),requested_name}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_scale_changes_invalidate_cached_facts_before_reframing() {
        let mut state = super::super::ActivityOverlayRuntimeState::default();
        state.display_inventory = Some(Vec::new());
        invalidate_projection(&mut state);
        assert!(state.display_inventory.is_none(), "DPI reframe must discover the target's new scale");
    }

    #[test]
    fn connected_display_renames_preserve_positions_and_unchanged_facts_do_not_write() {
        let mut remembered = storage::NotchPositions::from([("studio".into(), storage::NotchPositionRecord {
            name:"Old name".into(), top:Some(0.25), ..Default::default()
        })]);
        let display=MonitorFacts {
            storage_key:"studio".into(), name:"Studio Display".into(), built_in:Some(false), primary:true,
            native_name:None, rect:super::super::placement::Rect {x:0.,y:0.,width:1920.,height:1080.},
            work_area:super::super::placement::Rect {x:0.,y:0.,width:1920.,height:1040.}, scale:1.,display_context:None,
        };
        assert!(remember_names(&mut remembered,std::slice::from_ref(&display)));
        assert_eq!(remembered["studio"].name,"Studio Display");
        assert_eq!(remembered["studio"].top,Some(0.25));
        assert!(!remember_names(&mut remembered,std::slice::from_ref(&display)));
        assert!(!remember_names(&mut remembered,&[]));
        assert_eq!(remembered["studio"].name,"Studio Display");
    }

    #[test]
    fn unplugged_display_diagnostics_keep_the_last_seen_requested_name() {
        let display = MonitorFacts {
            storage_key: "primary".into(), name: "Primary".into(), built_in: Some(false), primary: true,
            native_name: None, rect: super::super::placement::Rect { x:0.,y:0.,width:1920.,height:1080. },
            work_area: super::super::placement::Rect { x:0.,y:0.,width:1920.,height:1040. },
            scale:1., display_context:None,
        };
        let mut remembered = storage::NotchPositions::from([("studio".into(), storage::NotchPositionRecord {
            name:"Studio Display".into(), ..Default::default()
        })]);
        assert!(!remember_names(&mut remembered, &[]), "unplug does not erase the last seen name");
        let choice = choose_display("named:studio", &candidates(std::slice::from_ref(&display)), None).unwrap();
        let result = serde_json::to_value(resolution(&display, choice, "named:studio", &remembered)).unwrap();
        assert_eq!(result["requestedName"], "Studio Display");
        assert_eq!(result["storageKey"], "primary");
        assert_eq!(result["fellBack"], true);
    }
}
pub(super) fn list<R:Runtime>(app:&AppHandle<R>,state:&ActivityOverlayState) -> Result<DesktopDisplaysList,String> {
    let displays=inventory(app,state,true)?;
    let mode=state.0.lock().map_err(|e|e.to_string())?.last_sync_payload.as_ref().map(|p|p.policy.display_mode.clone()).unwrap_or_else(||"automatic".into());
    let selected=select(app,&mode,&displays).ok();
    let automatic=choose_display("automatic",&candidates(&displays),None).map(|c|displays[c.index].storage_key.clone());
    let guard=state.0.lock().map_err(|e|e.to_string())?;
    let mut options:Vec<_>=displays.iter().enumerate().map(|(index,d)|DisplayOption {storage_key:d.storage_key.clone(),name:d.name.clone(),built_in:d.built_in==Some(true),primary:d.primary,connected:true,in_use:selected.is_some_and(|c|c.index==index)}).collect();
    for (key,record) in &guard.notch_positions {
        if !displays.iter().any(|d|&d.storage_key==key) {
            options.push(DisplayOption {storage_key:key.clone(),name:record.name.clone(),built_in:false,primary:false,connected:false,in_use:false});
        }
    }
    Ok(DesktopDisplaysList {displays:options,automatic_resolves_to:automatic})
}

pub(super) fn main_moved<R:Runtime>(app:&AppHandle<R>,state:&ActivityOverlayState) -> Result<(),String> {
    let inventory={
        let guard=state.0.lock().map_err(|e|e.to_string())?;
        if !guard.last_sync_payload.as_ref().is_some_and(|p|p.policy.display_mode=="main") {return Ok(());}
        guard.display_inventory.clone().unwrap_or_default()
    };
    let next=select(app,"main",&inventory).ok().map(|choice|inventory[choice.index].storage_key.clone());
    {
        let mut guard=state.0.lock().map_err(|e|e.to_string())?;
        if guard.resolved_display_key==next {return Ok(());}
        guard.envelope=None;
    }
    super::window_lifecycle::apply_overlay_state(app,state)
}
