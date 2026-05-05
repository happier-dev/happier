use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct DisplayIdentityComponents {
    pub(crate) cg_display_id: Option<u32>,
    pub(crate) vendor_id: Option<u32>,
    pub(crate) model_id: Option<u32>,
    pub(crate) serial_number: Option<u32>,
}

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
    if let (Some(vendor_id), Some(model_id), Some(serial_number)) = (
        non_zero(components.vendor_id),
        non_zero(components.model_id),
        non_zero(components.serial_number),
    ) {
        return DesktopActivityOverlayDisplayIdentity {
            storage_key: format!("edid-{vendor_id}-{model_id}-{serial_number}"),
            source: DisplayIdentitySource::EdidComposite,
            cg_display_id: components.cg_display_id,
            vendor_id: Some(vendor_id),
            model_id: Some(model_id),
            serial_number: Some(serial_number),
        };
    }

    if let Some(cg_display_id) = non_zero(components.cg_display_id) {
        return DesktopActivityOverlayDisplayIdentity {
            storage_key: format!("display-{cg_display_id}"),
            source: DisplayIdentitySource::CgDisplayId,
            cg_display_id: Some(cg_display_id),
            vendor_id: components.vendor_id,
            model_id: components.model_id,
            serial_number: components.serial_number,
        };
    }

    DesktopActivityOverlayDisplayIdentity {
        storage_key: "display-unknown".to_string(),
        source: DisplayIdentitySource::Unknown,
        cg_display_id: None,
        vendor_id: components.vendor_id,
        model_id: components.model_id,
        serial_number: components.serial_number,
    }
}

fn non_zero(value: Option<u32>) -> Option<u32> {
    value.filter(|value| *value > 0)
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
