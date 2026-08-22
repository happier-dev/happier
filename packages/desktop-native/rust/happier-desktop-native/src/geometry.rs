//! Pure display-geometry derivations.
//!
//! These mirror the rules currently implemented inside the Tauri shell
//! (`apps/ui/src-tauri/src/activity_overlay/display_identity.rs` and
//! `macos_display_context.rs`) so that shell can later delegate to this crate
//! without a behaviour change. They are pure so they run headlessly under test.

/// A rectangle in AppKit's bottom-left-origin screen coordinate space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Physical notch extents, in points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NotchSize {
    pub width: f64,
    pub height: f64,
}

/// Which facts the stable per-display storage key was derived from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayIdentitySource {
    EdidComposite,
    CgDisplayId,
    Unknown,
}

impl DisplayIdentitySource {
    pub fn as_str(self) -> &'static str {
        match self {
            DisplayIdentitySource::EdidComposite => "edidComposite",
            DisplayIdentitySource::CgDisplayId => "cgDisplayId",
            DisplayIdentitySource::Unknown => "unknown",
        }
    }
}

/// The raw Core Graphics facts a display identity is derived from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DisplayIdentityComponents {
    pub cg_display_id: Option<u32>,
    pub vendor_id: Option<u32>,
    pub model_id: Option<u32>,
    pub serial_number: Option<u32>,
}

/// A display identity stable enough to key persisted per-display placement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayIdentity {
    pub storage_key: String,
    pub source: DisplayIdentitySource,
    pub cg_display_id: Option<u32>,
    pub vendor_id: Option<u32>,
    pub model_id: Option<u32>,
    pub serial_number: Option<u32>,
}

fn non_zero(value: Option<u32>) -> Option<u32> {
    value.filter(|value| *value > 0)
}

pub fn resolve_display_identity(components: DisplayIdentityComponents) -> DisplayIdentity {
    if let (Some(vendor_id), Some(model_id), Some(serial_number)) = (
        non_zero(components.vendor_id),
        non_zero(components.model_id),
        non_zero(components.serial_number),
    ) {
        return DisplayIdentity {
            storage_key: format!("edid-{vendor_id}-{model_id}-{serial_number}"),
            source: DisplayIdentitySource::EdidComposite,
            cg_display_id: components.cg_display_id,
            vendor_id: Some(vendor_id),
            model_id: Some(model_id),
            serial_number: Some(serial_number),
        };
    }

    if let Some(cg_display_id) = non_zero(components.cg_display_id) {
        return DisplayIdentity {
            storage_key: format!("display-{cg_display_id}"),
            source: DisplayIdentitySource::CgDisplayId,
            cg_display_id: Some(cg_display_id),
            vendor_id: components.vendor_id,
            model_id: components.model_id,
            serial_number: components.serial_number,
        };
    }

    DisplayIdentity {
        storage_key: "display-unknown".to_owned(),
        source: DisplayIdentitySource::Unknown,
        cg_display_id: None,
        vendor_id: components.vendor_id,
        model_id: components.model_id,
        serial_number: components.serial_number,
    }
}

/// A display has a physical notch when it is the built-in panel and AppKit
/// reports two disjoint auxiliary menu-bar areas either side of the camera
/// housing.
pub fn has_physical_notch(
    is_builtin: bool,
    auxiliary_top_left: Rect,
    auxiliary_top_right: Rect,
) -> bool {
    is_builtin
        && auxiliary_top_left.width > 0.0
        && auxiliary_top_right.width > 0.0
        && auxiliary_top_left.x < auxiliary_top_right.x
}

/// Derive the notch's physical size from the gap AppKit leaves between the two
/// auxiliary menu-bar areas.
pub fn derive_physical_notch_size(
    screen_frame: Rect,
    safe_area_top: f64,
    auxiliary_top_left: Rect,
    auxiliary_top_right: Rect,
    has_physical_notch: bool,
) -> Option<NotchSize> {
    if !has_physical_notch || !safe_area_top.is_finite() || safe_area_top <= 0.0 {
        return None;
    }

    let auxiliary_width = auxiliary_top_left.width + auxiliary_top_right.width;
    let measured_width = screen_frame.width - auxiliary_width + 4.0;
    if !measured_width.is_finite() || measured_width <= 0.0 {
        return None;
    }

    Some(NotchSize {
        width: measured_width,
        height: safe_area_top,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, width: f64) -> Rect {
        Rect {
            x,
            y: 0.0,
            width,
            height: 32.0,
        }
    }

    #[test]
    fn prefers_the_edid_composite_key_when_every_component_is_present() {
        let identity = resolve_display_identity(DisplayIdentityComponents {
            cg_display_id: Some(1),
            vendor_id: Some(610),
            model_id: Some(41005),
            serial_number: Some(7),
        });
        assert_eq!(identity.storage_key, "edid-610-41005-7");
        assert_eq!(identity.source, DisplayIdentitySource::EdidComposite);
        assert_eq!(identity.cg_display_id, Some(1));
    }

    #[test]
    fn falls_back_to_the_display_id_when_an_edid_component_is_zero() {
        let identity = resolve_display_identity(DisplayIdentityComponents {
            cg_display_id: Some(3),
            vendor_id: Some(610),
            model_id: Some(0),
            serial_number: Some(7),
        });
        assert_eq!(identity.storage_key, "display-3");
        assert_eq!(identity.source, DisplayIdentitySource::CgDisplayId);
    }

    #[test]
    fn falls_back_to_unknown_when_nothing_identifies_the_display() {
        let identity = resolve_display_identity(DisplayIdentityComponents::default());
        assert_eq!(identity.storage_key, "display-unknown");
        assert_eq!(identity.source, DisplayIdentitySource::Unknown);
    }

    #[test]
    fn an_external_display_never_reports_a_physical_notch() {
        assert!(!has_physical_notch(false, rect(0.0, 663.0), rect(848.0, 664.0)));
    }

    #[test]
    fn a_builtin_display_with_two_auxiliary_areas_reports_a_physical_notch() {
        assert!(has_physical_notch(true, rect(0.0, 663.0), rect(848.0, 664.0)));
    }

    #[test]
    fn derives_the_measured_notch_size_from_the_auxiliary_gap() {
        // Measured on a 14" MacBook Pro: 1512pt wide, safeAreaInsets.top = 32.
        let size = derive_physical_notch_size(
            Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            32.0,
            rect(0.0, 663.0),
            rect(848.0, 664.0),
            true,
        )
        .expect("notch size");
        assert_eq!(size.width, 189.0);
        assert_eq!(size.height, 32.0);
    }

    #[test]
    fn declines_a_notch_size_when_the_safe_area_is_absent() {
        assert_eq!(
            derive_physical_notch_size(
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 1512.0,
                    height: 982.0
                },
                0.0,
                rect(0.0, 663.0),
                rect(848.0, 664.0),
                true,
            ),
            None
        );
    }

    #[test]
    fn declines_a_notch_size_when_the_auxiliary_areas_span_the_whole_screen() {
        assert_eq!(
            derive_physical_notch_size(
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 1512.0,
                    height: 982.0
                },
                32.0,
                rect(0.0, 760.0),
                rect(760.0, 760.0),
                true,
            ),
            None
        );
    }
}
