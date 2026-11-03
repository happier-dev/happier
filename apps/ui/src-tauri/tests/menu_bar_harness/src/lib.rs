//! Source-only tests of native menu contracts without GTK or WebKit linkage.
#[path = "../../../src/menu/ids.rs"]
pub mod menu_ids;
pub mod menu {
    pub use crate::menu_ids as ids;
}
#[path = "../../../src/tray/model.rs"]
pub mod tray_model;
pub mod tray {
    pub use crate::tray_model as model;
}
#[path = "../../../src/desktop_exit_policy.rs"]
pub mod desktop_exit_policy;
#[path = "../../../src/menu_bar/policy.rs"]
pub mod menu_bar_policy;
pub mod menu_bar {
    pub use crate::menu_bar_policy as policy;
}
#[path = "../../../src/app_updates/relaunch.rs"]
pub mod update_relaunch;
#[path = "../../../src/web_runtime_config.rs"]
pub mod web_runtime_config;
