//! X11 outside presses, owned by the engaged window's GLib fd source. No worker or polling timer.
use std::os::fd::{AsRawFd, RawFd};
use x11rb::{
    connection::Connection,
    protocol::{xinput::{ConnectionExt as _, Device, EventMask, XIEventMask}, xproto::ConnectionExt as _, Event},
    rust_connection::RustConnection,
};

pub struct X11OutsidePress {
    connection: RustConnection,
    root: u32,
    window: u32,
}

impl X11OutsidePress {
    pub fn new(window: u32) -> Result<Self, String> {
        let (connection, screen) = x11rb::connect(None).map_err(|error| error.to_string())?;
        let root = connection.setup().roots[screen].root;
        connection.xinput_xi_query_version(2, 0).map_err(|error| error.to_string())?
            .reply().map_err(|error| error.to_string())?;
        connection.xinput_xi_select_events(root, &[EventMask {
            deviceid: Device::ALL_MASTER.into(),
            mask: vec![XIEventMask::RAW_BUTTON_PRESS],
        }]).map_err(|error| error.to_string())?.check().map_err(|error| error.to_string())?;
        connection.flush().map_err(|error| error.to_string())?;
        Ok(Self { connection, root, window })
    }

    pub fn fd(&self) -> RawFd { self.connection.stream().as_raw_fd() }

    /// Drain only after fd readiness. Resolve the actual hit window, including WM reparenting.
    pub fn drain(&self, mut outside: impl FnMut()) -> Result<(), String> {
        while let Some(event) = self.connection.poll_for_event().map_err(|error| error.to_string())? {
            if !matches!(event, Event::XinputRawButtonPress(_)) { continue; }
            let pointer = self.connection.query_pointer(self.root).map_err(|error| error.to_string())?
                .reply().map_err(|error| error.to_string())?;
            let mut top = self.window;
            loop {
                let tree = self.connection.query_tree(top).map_err(|error| error.to_string())?
                    .reply().map_err(|error| error.to_string())?;
                if tree.parent == self.root || tree.parent == 0 { break; }
                top = tree.parent;
            }
            if pointer.child != top { outside(); }
        }
        Ok(())
    }
}
