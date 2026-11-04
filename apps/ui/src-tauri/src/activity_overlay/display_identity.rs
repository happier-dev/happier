use serde::{Deserialize, Serialize};

pub(crate) use happier_desktop_native::geometry::DisplayIdentityComponents;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DisplayIdentitySource {
    EdidComposite,
    CgDisplayId,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopActivityOverlayDisplayIdentity {
    pub(crate) storage_key: String,
    pub(crate) source: DisplayIdentitySource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cg_display_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) vendor_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) model_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) serial_number: Option<u32>,
}

pub(crate) fn resolve_display_identity(
    components: DisplayIdentityComponents,
) -> DesktopActivityOverlayDisplayIdentity {
    happier_desktop_native::geometry::resolve_display_identity(components).into()
}

impl From<happier_desktop_native::geometry::DisplayIdentity>
    for DesktopActivityOverlayDisplayIdentity
{
    fn from(value: happier_desktop_native::geometry::DisplayIdentity) -> Self {
        use happier_desktop_native::geometry::DisplayIdentitySource as Source;
        Self {
            storage_key: value.storage_key,
            source: match value.source {
                Source::EdidComposite => DisplayIdentitySource::EdidComposite,
                Source::CgDisplayId => DisplayIdentitySource::CgDisplayId,
                Source::Unknown => DisplayIdentitySource::Unknown,
            },
            cg_display_id: value.cg_display_id,
            vendor_id: value.vendor_id,
            model_id: value.model_id,
            serial_number: value.serial_number,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_identity_prefers_edid_composite_storage_key() {
        let identity = resolve_display_identity(DisplayIdentityComponents {
            cg_display_id: Some(72_110_592),
            vendor_id: Some(610),
            model_id: Some(41_056),
            serial_number: Some(12_345_678),
        });

        assert_eq!(identity.storage_key, "edid-610-41056-12345678");
        assert_eq!(identity.source, DisplayIdentitySource::EdidComposite);
    }

    #[test]
    fn display_identity_falls_back_to_cg_display_id_when_edid_is_incomplete() {
        let identity = resolve_display_identity(DisplayIdentityComponents {
            cg_display_id: Some(72_110_592),
            vendor_id: Some(610),
            model_id: Some(41_056),
            serial_number: None,
        });

        assert_eq!(identity.storage_key, "display-72110592");
        assert_eq!(identity.source, DisplayIdentitySource::CgDisplayId);
    }

    #[test]
    fn display_identity_uses_unknown_key_when_no_stable_values_exist() {
        let identity = resolve_display_identity(DisplayIdentityComponents {
            cg_display_id: None,
            vendor_id: None,
            model_id: None,
            serial_number: None,
        });

        assert_eq!(identity.storage_key, "display-unknown");
        assert_eq!(identity.source, DisplayIdentitySource::Unknown);
    }
}
