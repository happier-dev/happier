fn main() {
    if cfg!(feature = "capture") && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // Swift's system runtime path, reported by swiftc -print-target-info.
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
    #[cfg(feature = "node-bindings")]
    napi_build::setup();
}
