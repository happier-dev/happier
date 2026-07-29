# iOS Native Terminal Vendor Artifacts

This directory is intentionally empty until the iOS Ghostty renderer passes the package proof gate.

The accepted artifact shape is:

```text
GhosttyKit.xcframework/
  ios-arm64/
  ios-arm64_x86_64-simulator/
```

`HappierTerminalNative.podspec` links `Vendor/GhosttyKit.xcframework` only when the directory exists. Disabled or artifact-free builds must keep reporting the native renderer as unavailable and must continue to use the xterm WebView fallback.

Production artifacts use the pinned/audited `libghostty-spm` GhosttyKit artifact for iOS v1 unless that package becomes stale, divergent, unavailable, or release-blocking. The currently verified upstream artifact is `storage.1.2.4` from commit `c069f05e0a4ef50143e943e954ed75e52e947009`, with upstream zip checksum `f1484a5411559bf4a5b665b82a5bb91cb8a3ca2065467dc15202fb191d7a5c9d` and expanded installed XCFramework checksum `f59c864108a9ef3002f6dcaaa00f87e5b56ce4966fb6c90d5ad744cc7aef37c7`. The selected artifact must be pinned by exact version/revision and checksum, reviewed for wrapper source/patch provenance, license/NOTICE posture, size budget, ABI smoke, crash fallback, and accessibility acceptance.
