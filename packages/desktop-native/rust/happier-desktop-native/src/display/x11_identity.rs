use super::PlatformDisplayFacts;

pub(super) fn from_output(name: String, edid: &[u8]) -> PlatformDisplayFacts {
    let edid = edid.get(..128).filter(|bytes| {
        bytes[..8] == [0, 255, 255, 255, 255, 255, 255, 0]
            && bytes.iter().fold(0_u8, |sum, byte| sum.wrapping_add(*byte)) == 0
    });
    let identity = edid.map(|bytes| {
        crate::geometry::resolve_display_identity(crate::geometry::DisplayIdentityComponents {
            cg_display_id: None,
            vendor_id: Some(u16::from_be_bytes([bytes[8], bytes[9]]) as u32),
            model_id: Some(u16::from_le_bytes([bytes[10], bytes[11]]) as u32),
            serial_number: Some(u32::from_le_bytes([
                bytes[12], bytes[13], bytes[14], bytes[15],
            ])),
        })
    });
    let storage_key = identity
        .filter(|identity| identity.source == crate::geometry::DisplayIdentitySource::EdidComposite)
        .map(|identity| identity.storage_key)
        .unwrap_or_else(|| format!("x11-{name}"));
    let friendly_name = edid
        .and_then(|bytes| {
            bytes[54..126]
                .chunks_exact(18)
                .find(|descriptor| descriptor[..5] == [0, 0, 0, 0xfc, 0])
        })
        .and_then(|descriptor| std::str::from_utf8(&descriptor[5..18]).ok())
        .map(|value| {
            value
                .trim_matches(|c: char| c.is_whitespace() || c == '\0')
                .to_owned()
        })
        .filter(|value| !value.is_empty());
    let built_in = if ["eDP", "LVDS", "DSI"]
        .iter()
        .any(|prefix| name.starts_with(prefix))
    {
        Some(true)
    } else if ["DP", "DisplayPort", "HDMI", "DVI", "VGA", "TV"]
        .iter()
        .any(|prefix| name.starts_with(prefix))
    {
        Some(false)
    } else {
        None
    };
    PlatformDisplayFacts {
        storage_key,
        native_name: name,
        friendly_name,
        built_in,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edid(serial: u32) -> [u8; 128] {
        let mut bytes = [0; 128];
        bytes[..8].copy_from_slice(&[0, 255, 255, 255, 255, 255, 255, 0]);
        bytes[8..10].copy_from_slice(&610_u16.to_be_bytes());
        bytes[10..12].copy_from_slice(&41005_u16.to_le_bytes());
        bytes[12..16].copy_from_slice(&serial.to_le_bytes());
        bytes[54..59].copy_from_slice(&[0, 0, 0, 0xfc, 0]);
        bytes[59..72].copy_from_slice(b"Studio Panel\n");
        bytes[127] =
            0_u8.wrapping_sub(bytes.iter().fold(0_u8, |sum, byte| sum.wrapping_add(*byte)));
        bytes
    }

    #[test]
    fn edid_identity_and_name_survive_an_output_rename() {
        let first = from_output("DP-1".into(), &edid(7));
        let second = from_output("DP-2".into(), &edid(7));
        assert_eq!(first.storage_key, second.storage_key);
        assert_eq!(first.storage_key, "edid-610-41005-7");
        assert_eq!(first.native_name, "DP-1");
        assert_eq!(first.friendly_name.as_deref(), Some("Studio Panel"));
        assert_eq!(first.built_in, Some(false));
    }

    #[test]
    fn serial_less_displays_keep_distinct_connector_identities() {
        assert_ne!(
            from_output("HDMI-1".into(), &edid(0)).storage_key,
            from_output("HDMI-2".into(), &edid(0)).storage_key
        );
        assert_eq!(from_output("eDP-1".into(), &[]).built_in, Some(true));
        assert_eq!(from_output("Unknown-1".into(), &[]).built_in, None);
        let mut invalid = edid(7);
        invalid[12] ^= 1;
        assert_eq!(from_output("DP-1".into(), &invalid).storage_key, "x11-DP-1");
    }
}
