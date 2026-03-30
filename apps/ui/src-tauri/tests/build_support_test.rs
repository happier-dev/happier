#[path = "../build_support.rs"]
mod build_support;

use build_support::{resolve_sidecar_update_action, SidecarSnapshot, SidecarUpdateAction};

fn snapshot(bytes: &[u8], unix_mode: Option<u32>) -> SidecarSnapshot {
    SidecarSnapshot {
        bytes: bytes.to_vec(),
        unix_mode,
    }
}

#[test]
fn identical_bytes_and_permissions_are_a_noop() {
    let source = snapshot(b"hsetup-binary", Some(0o755));
    let destination = snapshot(b"hsetup-binary", Some(0o755));

    assert_eq!(
        resolve_sidecar_update_action(&source, Some(&destination)),
        SidecarUpdateAction::Noop,
    );
}

#[test]
fn different_bytes_request_a_copy() {
    let source = snapshot(b"hsetup-binary-v2", Some(0o755));
    let destination = snapshot(b"hsetup-binary-v1", Some(0o755));

    assert_eq!(
        resolve_sidecar_update_action(&source, Some(&destination)),
        SidecarUpdateAction::Copy,
    );
}

#[test]
fn permission_only_drift_requests_permissions_update() {
    let source = snapshot(b"hsetup-binary", Some(0o755));
    let destination = snapshot(b"hsetup-binary", Some(0o644));

    assert_eq!(
        resolve_sidecar_update_action(&source, Some(&destination)),
        SidecarUpdateAction::PermissionsOnly,
    );
}

#[test]
fn content_and_permission_drift_requests_copy_and_permissions_update() {
    let source = snapshot(b"hsetup-binary-v2", Some(0o755));
    let destination = snapshot(b"hsetup-binary-v1", Some(0o644));

    assert_eq!(
        resolve_sidecar_update_action(&source, Some(&destination)),
        SidecarUpdateAction::CopyAndPermissions,
    );
}
