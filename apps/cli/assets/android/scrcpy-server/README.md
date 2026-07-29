# Android scrcpy-server artifact

This directory packages the Android emulator `scrcpy-server.jar` used by the simulator adapter.

Current artifact:

- Upstream project: https://github.com/Genymobile/scrcpy
- Release: https://github.com/Genymobile/scrcpy/releases/tag/v3.2
- Artifact: `scrcpy-server-v3.2`, vendored locally as `scrcpy-server.jar`
- SHA-256: `sha256:b920e0ea01936bf2482f4ba2fa985c22c13c621999e3d33b45baa5acfc1ea3d0`
- License: Apache-2.0, vendored as `LICENSE.scrcpy`

Keep `manifest.json`, `NOTICE.md`, `LICENSE.scrcpy`, and the pinned digest in
`apps/cli/src/daemon/devices/simulator/android/artifact.ts` aligned whenever the
vendored artifact changes.
