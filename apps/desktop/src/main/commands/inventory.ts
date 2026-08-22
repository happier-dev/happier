/**
 * Every command the Tauri target registers in `apps/ui/src-tauri/src/lib.rs`.
 *
 * The renderer is shared byte-for-byte between the two desktop targets, so this is the full set of
 * command names that can reach this host. It exists so an unimplemented command can be reported as
 * "known to the product, not yet implemented here" rather than "unknown command", and so a test can
 * assert the registry never quietly drops one.
 */
export const TAURI_DESKTOP_COMMANDS = [
    'desktop_fetch_update',
    'desktop_install_update',
    'desktop_pick_ssh_identity_file',
    'desktop_get_autostart_enabled',
    'desktop_set_autostart_enabled',
    'desktop_set_tray_state',
    'sync_desktop_pet_overlay_state',
    'desktop_pet_overlay_read_window_state',
    'desktop_pet_overlay_set_input_locked',
    'desktop_pet_overlay_sync_element_metrics',
    'desktop_pet_overlay_start_drag_session',
    'desktop_pet_overlay_apply_drag_delta',
    'desktop_pet_overlay_release_drag_velocity',
    'desktop_pet_overlay_apply_momentum_delta',
    'desktop_pet_overlay_end_drag_session',
    'desktop_pet_overlay_reset_position',
    'emit_desktop_pet_overlay_interaction_result',
    'desktop_pet_overlay_show_main_window',
    'start_system_task',
    'cancel_system_task',
    'get_system_task_snapshot',
    'system_tasks_open_log_path',
    'respond_system_task_prompt',
    'desktop_get_window_chrome_policy',
    'desktop_get_window_state',
    'desktop_minimize_window',
    'desktop_toggle_window_maximize',
    'desktop_close_window',
    'desktop_show_main_window',
    'desktop_start_window_dragging',
    'desktop_set_window_mode',
    'desktop_read_stack_boot_credentials',
    'desktop_browser_get_availability',
    'desktop_browser_open_view',
    'desktop_browser_navigate',
    'desktop_browser_set_bounds',
    'desktop_browser_set_pointer_passthrough',
    'desktop_browser_close_view',
    'desktop_browser_open_devtools',
    'desktop_browser_get_page_info',
    'desktop_browser_capture_snapshot',
    'desktop_browser_capture_recording_frame',
    'desktop_browser_drain_diagnostics',
    'desktop_browser_eval_script',
    'desktop_browser_dispatch_navigation',
    'desktop_hosted_artifact_get_frame_capability',
    'desktop_hosted_artifact_register',
    'desktop_hosted_artifact_unregister',
    'desktop_hosted_artifact_cache_read',
    'desktop_hosted_artifact_cache_write',
    'desktop_hosted_artifact_cache_describe',
    'desktop_hosted_artifact_cache_remove',
    'desktop_hosted_artifact_cache_remove_account',
    'desktop_hosted_artifact_open_view',
    'desktop_hosted_artifact_set_bounds',
    'desktop_hosted_artifact_post_message',
    'desktop_hosted_artifact_go_back',
    'desktop_hosted_artifact_close_view',
    'desktop_activity_overlay_sync',
    'desktop_activity_overlay_get_window_state',
    'desktop_activity_overlay_set_expanded',
    'desktop_activity_overlay_set_input_locked',
    'desktop_activity_overlay_apply_drag_delta',
    'desktop_activity_overlay_release_drag_velocity',
    'desktop_activity_overlay_apply_momentum_delta',
    'desktop_activity_overlay_reset_position',
    'desktop_activity_overlay_emit_interaction',
    'desktop_activity_overlay_emit_interaction_result',
] as const;

export type TauriDesktopCommand = (typeof TAURI_DESKTOP_COMMANDS)[number];

const COMMAND_LOOKUP: ReadonlySet<string> = new Set<string>(TAURI_DESKTOP_COMMANDS);

export function isKnownTauriDesktopCommand(command: string): command is TauriDesktopCommand {
    return COMMAND_LOOKUP.has(command);
}

/**
 * `@tauri-apps/api`'s event module routes through the host as regular commands, so they reach the
 * same invoke path as product commands and are implemented by the event bus rather than a plugin.
 */
export const EVENT_PLUGIN_COMMANDS = {
    listen: 'plugin:event|listen',
    unlisten: 'plugin:event|unlisten',
    emit: 'plugin:event|emit',
    emitTo: 'plugin:event|emit_to',
} as const;
