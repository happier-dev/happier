use std::collections::BTreeSet;

include!("../desktop_commands.rs");

macro_rules! command_records {
    ($($owner:ident::$name:ident),* $(,)?) => {
        &[$((stringify!($owner), stringify!($name))),*]
    };
}
const REGISTERED: &[(&str, &str)] = with_desktop_commands!(command_records);

fn permission_commands(identifier: &str) -> BTreeSet<String> {
    let permission = include_str!("../permissions/capture.toml")
        .split("[[permission]]")
        .find(|block| block.contains(&format!("identifier = \"{identifier}\"")))
        .expect("capture permission group");
    // Inspect only quoted names in this command array; the native build validates TOML.
    let commands = permission.split_once("commands.allow = ").unwrap().1.trim();
    commands.split_once('[').unwrap().1.split_once(']').unwrap().0
        .split(',').map(|command| command.trim().trim_matches('"').to_owned()).collect()
}

#[test]
fn every_registered_capture_operation_has_manifest_and_group_permission() {
    let registered: BTreeSet<_> = REGISTERED.iter()
        .filter(|(owner, command)| *owner != "capture_window"
            && (command.starts_with("desktop_capture_") || command.starts_with("desktop_recording_")))
        .map(|(_, command)| *command)
        .collect();
    assert!(!registered.is_empty(), "must inspect the real capture handler registration");
    let allowed = permission_commands("allow-desktop-capture");
    let missing_permission: Vec<_> = registered.iter().filter(|command| !allowed.contains(**command)).collect();
    assert!(missing_permission.is_empty(), "registered capture commands missing group permission: {missing_permission:?}");

    for capability in [include_str!("../capabilities/default.json"), include_str!("../capabilities/capture.json")] {
        assert!(capability.contains("\"allow-desktop-capture\""));
    }
}

#[test]
fn selection_capability_stays_limited_to_local_input_and_facts() {
    let allowed = permission_commands("allow-desktop-capture-selection");
    let expected: BTreeSet<String> = ["desktop_capture_read_state", "desktop_capture_commit",
        "desktop_capture_cancel", "desktop_capture_hit_test", "desktop_capture_selection_facts",
        "desktop_capture_set_mode", "desktop_capture_shortcuts", "desktop_capture_window_ready"].into_iter().map(String::from).collect();
    assert_eq!(allowed, expected);
    let capability = include_str!("../capabilities/capture-selection.json");
    assert!(capability.contains("\"allow-desktop-capture-selection\""));
    assert!(!capability.contains("\"allow-desktop-capture\""));
}

#[test]
fn capture_window_lifecycle_keeps_its_caller_scoped_permissions() {
    let commands: Vec<_> = REGISTERED.iter().filter(|(owner, _)| *owner == "capture_window")
        .map(|(_, command)| *command).collect();
    assert!(!commands.is_empty());
    let grouped = permission_commands("allow-desktop-capture");
    for command in commands {
        assert!(grouped.contains(command)
            || include_str!("../capabilities/capture.json").contains(&format!("\"allow-{}\"", command.replace('_', "-"))),
            "capture window command missing effective permission: {command}");
    }
    let main = include_str!("../capabilities/default.json");
    assert!(main.contains("\"allow-desktop-capture-window-hide\""));
    for command in ["ready", "present", "set-floating"] {
        assert!(!main.contains(&format!("\"allow-desktop-capture-window-{command}\"")));
    }
}

#[test]
fn capture_picker_can_choose_a_folder_without_widening_selection_permissions() {
    assert!(REGISTERED.contains(&("desktop_dialog", "desktop_pick_folder")));
    assert!(include_str!("../capabilities/capture.json").contains("\"allow-desktop-pick-folder\""));
    assert!(!include_str!("../capabilities/capture-selection.json").contains("\"allow-desktop-pick-folder\""));
}

#[test]
fn registered_notch_commands_are_granted_to_their_native_caller_windows() {
    let main = include_str!("../capabilities/default.json");
    let overlay = include_str!("../capabilities/overlay.json");
    // The command's native caller boundary admits main and activity_overlay only.
    // Keep it separate from default, which also admits destination_* windows.
    let presentation = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities/notch-presentation.json"))
        .unwrap_or_default();
    let mut missing = Vec::new();
    for (_, command) in REGISTERED.iter().filter(|(owner, _)| *owner == "activity_overlay") {
        let permission = format!("\"allow-{}\"", command.replace('_', "-"));
        let callers: &[(&str, &str)] = match *command {
            "desktop_displays_list" | "desktop_activity_overlay_sync" => &[("main", main)],
            "desktop_activity_overlay_get_window_state" | "desktop_activity_overlay_move" => &[("main", main), ("activity_overlay", overlay)],
            "desktop_activity_overlay_request_presentation" => &[("main", &presentation), ("activity_overlay", &presentation)],
            _ => &[("activity_overlay", overlay)],
        };
        for (window, capability) in callers {
            if !capability.contains(&permission) { missing.push(format!("{window}: {command}")); }
        }
    }
    assert!(missing.is_empty(), "registered commands missing caller grants: {missing:?}");
    assert!(presentation.contains("\"main\"") && presentation.contains("\"activity_overlay\""));
    assert!(!presentation.contains("destination_*"));
    for command in ["take-presentation-request", "set-keyboard-wanted"] {
        assert!(!main.contains(&format!("\"allow-desktop-activity-overlay-{command}\"")));
    }
    for config in [include_str!("../tauri.conf.json"), include_str!("../tauri.publicdev.conf.json")] {
        assert!(config.contains("\"notch-presentation\""), "desktop channel must enable the caller-scoped grant");
    }
}

#[test]
fn the_notch_reads_and_places_its_glass() {
    let overlay = include_str!("../capabilities/overlay.json");
    for permission in ["allow-desktop-get-glass-state", "allow-desktop-set-glass-panel-shape"] {
        assert!(overlay.contains(permission), "the notch panel lacks {permission}");
    }
}

#[test]
fn registered_overlay_and_window_commands_have_an_effective_capability() {
    let capabilities = [
        include_str!("../capabilities/default.json"),
        include_str!("../capabilities/overlay.json"),
        include_str!("../capabilities/pet_overlay.json"),
        include_str!("../capabilities/capture.json"),
        include_str!("../capabilities/capture-selection.json"),
        include_str!("../capabilities/notch-presentation.json"),
    ];
    let capture = permission_commands("allow-desktop-capture");
    let owners = ["activity_overlay", "pet_overlay", "window_chrome", "window_sizing", "desktop_window", "app_window", "capture_window"];
    for (_, command) in REGISTERED.iter().filter(|(owner, _)| owners.contains(owner)) {
        let permission = format!("\"allow-{}\"", command.replace('_', "-"));
        assert!(capabilities.iter().any(|capability| capability.contains(&permission))
            || (capture.contains(*command) && capabilities.iter().any(|capability| capability.contains("\"allow-desktop-capture\""))),
            "registered overlay/window command has no effective grant: {command}");
    }
    // App windows use default; panel-only chrome and input stay with their panel.
    // Capture's grouped permission and notch's finer caller roles are checked above.
    for (owner, command) in REGISTERED.iter().filter(|(owner, _)| owners.contains(owner)) {
        let callers: &[usize] = match (*owner, *command) {
            ("app_window" | "window_sizing", _) => &[0],
            ("window_chrome", "desktop_set_glass_panel_shape") => &[3],
            ("window_chrome", "desktop_show_main_window") => &[0, 1],
            ("window_chrome", _) => &[0],
            ("desktop_window", "desktop_window_emit_action") => &[0, 1, 3],
            ("desktop_window", "desktop_host_get_availability") => &[0, 1],
            ("desktop_window", _) => &[0],
            ("pet_overlay", "sync_desktop_pet_overlay_state") => &[0],
            ("pet_overlay", "desktop_pet_overlay_read_window_state" | "desktop_pet_overlay_set_input_locked"
                | "desktop_pet_overlay_reset_position" | "emit_desktop_pet_overlay_interaction_result") => &[0, 2],
            ("pet_overlay", _) => &[2],
            _ => &[],
        };
        for caller in callers {
            assert!(capabilities[*caller].contains(&format!("\"allow-{}\"", command.replace('_', "-"))),
                "registered command {command} missing its caller capability {caller}");
        }
    }
}
