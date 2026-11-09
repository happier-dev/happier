// Only the logging boundary is replaced; parsing, filesystem IO and native preference state
// below are the production owner, without GTK/WebKit linkage.
extern crate self as log;
#[macro_export]
macro_rules! warn {
    ($($argument:tt)*) => { eprintln!($($argument)*); };
}

#[path = "../../../src/window_chrome_preferences.rs"]
mod preferences;
