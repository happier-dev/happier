use std::env;
use std::fs;
use std::path::PathBuf;

#[path = "build_support.rs"]
mod build_support;

use build_support::{resolve_sidecar_update_action, SidecarSnapshot, SidecarUpdateAction};
use flate2;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use tauri_build::{AppManifest, Attributes};

const APP_TAURI_COMMANDS: &[&str] = &[
    "desktop_fetch_update",
    "desktop_install_update",
    "desktop_pick_ssh_identity_file",
    "desktop_get_autostart_enabled",
    "desktop_set_autostart_enabled",
    "desktop_set_tray_state",
    "sync_desktop_pet_overlay_state",
    "desktop_pet_overlay_read_window_state",
    "desktop_pet_overlay_set_input_locked",
    "desktop_pet_overlay_sync_element_metrics",
    "desktop_pet_overlay_start_drag_session",
    "desktop_pet_overlay_apply_drag_delta",
    "desktop_pet_overlay_release_drag_velocity",
    "desktop_pet_overlay_apply_momentum_delta",
    "desktop_pet_overlay_end_drag_session",
    "desktop_pet_overlay_reset_position",
    "emit_desktop_pet_overlay_interaction_result",
    "desktop_pet_overlay_show_main_window",
    "start_system_task",
    "cancel_system_task",
    "get_system_task_snapshot",
    "system_tasks_open_log_path",
    "respond_system_task_prompt",
    "desktop_get_window_chrome_policy",
    "desktop_get_window_state",
    "desktop_minimize_window",
    "desktop_toggle_window_maximize",
    "desktop_close_window",
    "desktop_show_main_window",
    "desktop_start_window_dragging",
];

fn is_truthy_env(name: &str) -> bool {
    env::var(name)
        .map(|value| {
            let value = value.trim();
            value == "1" || value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("yes")
        })
        .unwrap_or(false)
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=TARGET");
    println!("cargo:rerun-if-env-changed=HAPPIER_HSETUP_SIDECAR_SOURCE");
    println!("cargo:rerun-if-env-changed=HAPPIER_SKIP_HSETUP_SIDECAR_BUILD");

    if is_truthy_env("HAPPIER_SKIP_HSETUP_SIDECAR_BUILD") {
        // `tauri-build` validates that sidecar/resource paths exist even when running `cargo test`.
        // Provide a tiny stub so local test runs don't require the real bootstrap binary to be built.
        // Real builds must not use this flag.
        if let Err(error) = ensure_hsetup_sidecar_stub() {
            panic!("failed to create bundled hsetup sidecar stub: {error}");
        }
        println!(
            "cargo:warning=Skipping hsetup sidecar bundling (HAPPIER_SKIP_HSETUP_SIDECAR_BUILD=1)."
        );
    } else {
        build_hsetup_sidecar().expect("failed to build bundled hsetup sidecar");
    }
    tauri_build::try_build(
        Attributes::new().app_manifest(AppManifest::new().commands(APP_TAURI_COMMANDS)),
    )
    .expect("failed to build tauri app ACLs")
}

fn ensure_hsetup_sidecar_stub() -> Result<(), String> {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").map_err(|error| error.to_string())?);
    let target = env::var("TARGET").map_err(|error| error.to_string())?;
    let filename = if target.contains("windows") {
        format!("hsetup-{target}.exe")
    } else {
        format!("hsetup-{target}")
    };

    let binaries_dir = manifest_dir.join("binaries");
    fs::create_dir_all(&binaries_dir).map_err(|error| error.to_string())?;

    let output_path = binaries_dir.join(&filename);
    if !output_path.is_file() {
        #[cfg(windows)]
        let bytes = b"@echo off\r\nexit /b 1\r\n".to_vec();
        #[cfg(not(windows))]
        let bytes = b"#!/bin/sh\nexit 1\n".to_vec();
        fs::write(&output_path, bytes).map_err(|error| error.to_string())?;

        #[cfg(unix)]
        {
            fs::set_permissions(&output_path, fs::Permissions::from_mode(0o755))
                .map_err(|error| error.to_string())?;
        }
    }

    // Keep the runtime lookup contract stable.
    println!("cargo:rustc-env=HAPPIER_HSETUP_SIDECAR_FILENAME={filename}");
    Ok(())
}

fn build_hsetup_sidecar() -> Result<(), String> {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").map_err(|error| error.to_string())?);
    let target = env::var("TARGET").map_err(|error| error.to_string())?;
    let filename = if target.contains("windows") {
        format!("hsetup-{target}.exe")
    } else {
        format!("hsetup-{target}")
    };
    let binaries_dir = manifest_dir.join("binaries");
    let output_path = binaries_dir.join(&filename);
    let default_source_path = if target.contains("windows") {
        manifest_dir
            .join("..")
            .join("..")
            .join("bootstrap")
            .join("dist")
            .join("bin")
            .join("hsetup.exe")
    } else {
        manifest_dir
            .join("..")
            .join("..")
            .join("bootstrap")
            .join("dist")
            .join("bin")
            .join("hsetup")
    };
    let source_path = env::var("HAPPIER_HSETUP_SIDECAR_SOURCE")
        .map(PathBuf::from)
        .unwrap_or(default_source_path);

    fs::create_dir_all(&binaries_dir).map_err(|error| error.to_string())?;
    println!("cargo:rerun-if-changed={}", source_path.display());
    println!("cargo:rerun-if-changed=build_support.rs");

    if !source_path.is_file() {
        return Err(format!(
      "hsetup sidecar binary not found at {}. Build it first (recommended): yarn workspace @happier-dev/bootstrap build:binary",
      source_path.display()
    ));
    }

    let source_snapshot =
        SidecarSnapshot::from_path(&source_path).map_err(|error| error.to_string())?;
    let destination_snapshot = if output_path.is_file() {
        Some(SidecarSnapshot::from_path(&output_path).map_err(|error| error.to_string())?)
    } else {
        None
    };

    match resolve_sidecar_update_action(&source_snapshot, destination_snapshot.as_ref()) {
        SidecarUpdateAction::Noop => {}
        SidecarUpdateAction::Copy => {
            fs::copy(&source_path, &output_path).map_err(|error| error.to_string())?;
        }
        SidecarUpdateAction::PermissionsOnly => {
            #[cfg(unix)]
            {
                if let Some(mode) = source_snapshot.unix_mode {
                    fs::set_permissions(&output_path, fs::Permissions::from_mode(mode))
                        .map_err(|error| error.to_string())?;
                }
            }
        }
        SidecarUpdateAction::CopyAndPermissions => {
            fs::copy(&source_path, &output_path).map_err(|error| error.to_string())?;

            #[cfg(unix)]
            {
                if let Some(mode) = source_snapshot.unix_mode {
                    fs::set_permissions(&output_path, fs::Permissions::from_mode(mode))
                        .map_err(|error| error.to_string())?;
                }
            }
        }
    }

    println!("cargo:rustc-env=HAPPIER_HSETUP_SIDECAR_FILENAME={filename}");

    // Linux AppImage bundling can abort when linuxdeploy runs `ldd` on our sidecar binary.
    // Build a gzip archive so we can ship the archive as a resource and materialize it at runtime.
    if target.contains("linux") && !target.contains("android") {
        if let Err(error) = write_linux_hsetup_gzip(&output_path) {
            return Err(format!("failed to gzip hsetup sidecar: {error}"));
        }
    }
    Ok(())
}

fn write_linux_hsetup_gzip(source_path: &PathBuf) -> Result<(), String> {
    let bytes = fs::read(source_path).map_err(|error| error.to_string())?;
    let gzip_path = PathBuf::from(format!("{}.gz", source_path.display()));

    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    use std::io::Write;
    encoder
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    let gz = encoder.finish().map_err(|error| error.to_string())?;
    fs::write(&gzip_path, gz).map_err(|error| error.to_string())?;
    Ok(())
}
