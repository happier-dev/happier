#[path = "../src/background_command.rs"]
mod background_command;
#[path = "../src/system_tasks/hsetup_command.rs"]
mod desktop_uninstall;

#[cfg(unix)]
#[test]
fn cleanup_uses_bundle_and_recorded_state_scope_and_reports_failure() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("happier-desktop-uninstall-test-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let helper = root.join("hsetup");
    let state = root.join("state with spaces");
    std::fs::create_dir_all(&state).unwrap();
    std::fs::write(&helper, b"#!/bin/sh\n[ \"$1\" = desktop ] && [ \"$2\" = uninstall ] && [ \"$3\" = --bundle-id ] && [ \"$4\" = dev.happier.app.preview ] && [ \"$5\" = --state-dir ] && [ \"$6\" = \"$HAPPIER_DESKTOP_STATE_DIR\" ] && [ \"$HAPPIER_DESKTOP_BUNDLE_ID\" = \"$4\" ] || exit 2\n[ ! -f \"$6/fail\" ] || { echo cleanup-retry-needed >&2; exit 9; }\nprintf complete > \"$6/result\"\n").unwrap();
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();

    desktop_uninstall::run_uninstall(&helper, "dev.happier.app.preview", &state).unwrap();
    assert_eq!(std::fs::read_to_string(state.join("result")).unwrap(), "complete");
    std::fs::write(state.join("fail"), b"").unwrap();
    let error = desktop_uninstall::run_uninstall(&helper, "dev.happier.app.preview", &state).unwrap_err();
    assert!(error.contains("cleanup-retry-needed"), "{error}");
    assert!(state.join("result").is_file(), "failed cleanup must preserve retry state");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_cleanup_executor_fails_instead_of_reporting_success() {
    let error = desktop_uninstall::run_uninstall(
        &std::env::temp_dir().join("nonexistent-happier-cleanup-executor"),
        "dev.happier.app",
        &std::env::temp_dir(),
    ).unwrap_err();
    assert!(error.contains("start"), "{error}");
}
