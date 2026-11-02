use super::{x11_identity, PlatformDisplayFacts};
use x11rb::{
    connection::Connection,
    protocol::{
        randr::{Connection as OutputConnection, ConnectionExt as _},
        xproto::{AtomEnum, ConnectionExt as _},
    },
};

/// RandR connector and EDID facts do not require screen-capture permission.
pub fn platform_display_facts() -> Result<Vec<PlatformDisplayFacts>, String> {
    // XWayland's synthetic outputs are not physical connector identities. The
    // shell keeps its GDK model name and unknown built-in fact on native Wayland.
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|value| value == "wayland")
    {
        return Ok(Vec::new());
    }
    let (connection, screen) = x11rb::connect(None).map_err(|error| error.to_string())?;
    let root = connection.setup().roots[screen].root;
    let resources = connection
        .randr_get_screen_resources_current(root)
        .map_err(|error| error.to_string())?
        .reply()
        .map_err(|error| error.to_string())?;
    let edid_atom = connection
        .intern_atom(true, b"EDID")
        .map_err(|error| error.to_string())?
        .reply()
        .map_err(|error| error.to_string())?
        .atom;
    resources
        .outputs
        .into_iter()
        .filter_map(|output| {
            let read = || -> Result<Option<PlatformDisplayFacts>, String> {
                let info = connection
                    .randr_get_output_info(output, resources.config_timestamp)
                    .map_err(|error| error.to_string())?
                    .reply()
                    .map_err(|error| error.to_string())?;
                if info.connection != OutputConnection::CONNECTED || info.crtc == 0 {
                    return Ok(None);
                }
                let name = String::from_utf8(info.name).map_err(|error| error.to_string())?;
                // EDID is optional metadata: a missing property still yields the
                // connector identity and embedded-panel fact supplied by RandR.
                let edid = if edid_atom == 0 {
                    Vec::new()
                } else {
                    // RandR lengths use four-byte units; only the standard 128-byte
                    // EDID base block carries this reader's identity/name fields.
                    connection
                        .randr_get_output_property(
                            output,
                            edid_atom,
                            AtomEnum::ANY,
                            0,
                            32,
                            false,
                            false,
                        )
                        .ok()
                        .and_then(|cookie| cookie.reply().ok())
                        .filter(|property| property.format == 8)
                        .map(|property| property.data)
                        .unwrap_or_default()
                };
                Ok(Some(x11_identity::from_output(name, &edid)))
            };
            read().transpose()
        })
        .collect()
}
