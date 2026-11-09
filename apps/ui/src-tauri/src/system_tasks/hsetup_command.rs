use std::path::Path;
use std::process::{Command, Stdio};

use crate::background_command::background_command;

pub(super) fn hsetup_command(
    hsetup_path: &Path,
    desktop_context: Option<(&str, &Path)>,
) -> Command {
    let mut command = background_command(hsetup_path);
    if let Some((bundle_id, state_dir)) = desktop_context {
        command
            .env("HAPPIER_DESKTOP_BUNDLE_ID", bundle_id)
            .env("HAPPIER_DESKTOP_STATE_DIR", state_dir);
    }
    command
}

pub(super) fn run_uninstall(
    hsetup_path: &Path,
    bundle_id: &str,
    state_dir: &Path,
) -> Result<(), String> {
    let output = hsetup_command(hsetup_path, Some((bundle_id, state_dir)))
        .args(["desktop", "uninstall", "--bundle-id", bundle_id, "--state-dir"])
        .arg(state_dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("Failed to start desktop component cleanup: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "Desktop component cleanup failed ({}).\n{}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout).trim(),
        String::from_utf8_lossy(&output.stderr).trim(),
    ))
}
