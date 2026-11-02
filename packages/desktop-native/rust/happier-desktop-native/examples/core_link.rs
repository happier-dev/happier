//! A real executable links the public core without a Node runtime.
fn main() {
    let identity = happier_desktop_native::geometry::resolve_display_identity(Default::default());
    assert_eq!(identity.storage_key, "display-unknown");
    let _ = happier_desktop_native::list_displays();
}
