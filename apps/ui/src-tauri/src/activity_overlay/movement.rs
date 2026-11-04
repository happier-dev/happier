use super::{displays, storage, window_lifecycle, ActivityOverlayState, DesktopActivityOverlayExtent, DesktopActivityOverlayPresentPayload, DesktopActivityOverlaySurface, OVERLAY_WINDOW_LABEL};
use tauri::{AppHandle, Runtime, State};

#[tauri::command]
pub fn desktop_activity_overlay_move<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ActivityOverlayState>,
    position: Option<storage::NotchMovePosition>,
    delta: Option<super::dock::Point>,
    commit: bool,
) -> Result<(), String> {
    storage::validate_move(position, delta)?;
    let policy = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .last_sync_payload
        .as_ref()
        .map(|p| p.policy.clone())
        .ok_or_else(|| "Desktop notch has no synced policy".to_string())?;
    let (selected, _, visible) = displays::placement(&app, &state, &policy.display_mode)?;
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        let extent = guard.rest_extent.unwrap_or(DesktopActivityOverlayExtent {
            width: 0.,
            height: 0.,
            camera_offset: 0.,
            screen_bounds: None,
        });
        let present = guard
            .present
            .unwrap_or(DesktopActivityOverlayPresentPayload {
                surface: DesktopActivityOverlaySurface::Hidden,
                engaged: false,
                extent,
                settled: true,
            });
        let input = window_lifecycle::frame_input(
            &policy,
            present,
            extent,
            &selected,
            visible,
            &guard.notch_positions,
        );
        let moved = storage::update_notch_position(
            &mut guard.notch_positions,
            &selected.storage_key,
            &selected.name,
            input,
            position,
            delta,
            commit,
            |positions| storage::persist_notch_positions(&app, positions),
        )?;
        if !moved {
            return Ok(());
        }
        // A move replaces its current frame; it must not union it with the old
        // animation envelope and grow the window across the drag path.
        guard.envelope = None;
    }
    window_lifecycle::apply_overlay_state(&app, &state)
}
