# iOS simulator producer

In 0.3 development source, the daemon's iOS simulator adapter uses a bundled native producer for live frames and input. Android continues to use the bundled scrcpy server. Both feed the same capture registry, Machine stream relay, encrypted transport, shared player and control lease.
The iOS producer currently targets macOS arm64 with Xcode and CoreSimulator installed. Discovery asks `xcrun --find simctl` for the active developer selection and uses `xcrun simctl list devices --json` to include running and stopped simulators. A stopped device remains discoverable without advertising capture.
## Runtime ownership

| Responsibility | Owner |
| --- | --- |
| Bundled addon and adjacent framework | `apps/cli/assets/ios/producer/**` |
| Packaged asset resolution and native ABI availability | `apps/cli/src/daemon/devices/simulator/ios/native.ts` |
| Capture, input and native-session teardown | `apps/cli/src/daemon/devices/simulator/ios/nativeSession.ts` |
| Device discovery and capability projection | `apps/cli/src/daemon/devices/simulator/ios/discovery.ts` |
| Platform dispatch | `apps/cli/src/daemon/devices/simulator/platform/ios.ts` |
| Devices-role composition | `apps/cli/src/daemon/roles/devices/entry.ts` |
| Device commands and screenshots | `apps/cli/src/daemon/devices/simulator/operations/deviceOperations.ts` |

`resolveCliRuntimeAssetPath` locates `native/serve-sim-native.node`. Its adjacent LiveKitWebRTC framework is part of the bundled closure. Loading uses the daemon's existing JavaScript runtime; it does not invoke a system Node executable or a package manager. The addon uses Apple's private CoreSimulator and SimulatorKit frameworks on the developer's Mac. Those frameworks are used by the daemon-side producer, not the mobile viewer.
The loader's typed result decides native availability once for the devices role. Unsupported hosts, missing assets, dynamic-loader failures and an incompatible native ABI produce unavailable health with a diagnostic cause. Discovery consumes that same result. A device advertises capture only when the loaded producer and its capture/input wiring exist.
## Frames and controls
The native session creates a producer for each device. H.264 AVCC metadata and encoded frames retain the producer's envelope; MJPEG frames use the same generic capture adapter. Admitted stream caps bound encoder settings. Pause detaches the native capture subscription; resume attaches it again. A keyframe request restarts capture. Stopping the stream or devices role unsubscribes and stops its native capture sessions.
The shared input layer and simulator Actions send typed controls through the existing control lease. The native session selects the active capture by source id and uses that capture's actual screen dimensions for HID input. Supported controls are reported by the producer owner. Unsupported controls and failed native input return typed refusals rather than accepted acknowledgements.
Native app viewers host the shared web H.264 decoder in `react-native-webview`; encoded carrier batches cross the existing chunked WebView bridge. The native input layer stays above the noninteractive video surface and retains the same control lease. A lost WebView process reopens the existing relay, decoder failures settle into the viewer's Retry flow, and leaving the viewer closes the decoder and relay subscription.
Device boot/power-off, app lifecycle, deep links, test settings and screenshots remain owned by the simulator device-operation Actions. A screenshot produces image media through the existing Session attachment path; it is separate from requesting a video keyframe.
Hosts other than the Machine's daemon (the app, CLI, external MCP and Session MCP) share one client, `packages/protocol/src/devices/simulator/runtimeActionClient.ts`. It sends `devices.simulator.list` and the preview controls to the addressed Machine (the explicit Machine target, otherwise the Session's Machine) over the simulator Machine RPC methods. Home's Machine RPC route policy admits the caller to that Machine (`use` role) and its refusal reaches the caller unchanged. Device-operation Actions are whole Actions. The app, the CLI and external MCP send them through the original-Account Machine Action transport (`dispatchOriginalAccountMachineAction` in `cliActionDeps/machineTransport.ts`): Home admits the requester, and the addressed Machine's daemon executes. That invocation contract carries only host and Plugin callers, so an ordinary Session's MCP gets `simulator_action_route_unavailable` for device operations. A daemon-hosted caller with an installed runtime answers only for its own Machine. When the call addresses another Machine, it goes through the Machine transport.
## Availability and recovery
This is development-source behavior, not a declaration of release availability. The native dependency must load on the host before preview can be offered. Install/select Xcode when simulator tooling is unavailable; repair the bundled producer installation when its native loader reports missing or incompatible assets. Retry through the existing simulator flow after correcting the reported prerequisite.
The bundled upstream addon is ad-hoc signed by its publisher. Release signing and hardened-runtime compatibility remain release-validation obligations. There is no first-party Swift helper build, helper digest pin, helper signature/notarization probe or local development-helper fallback in this path. The bundled dependency retains its license and attribution files.
The native producer includes its own IOSurface polling and idle frame behavior. No claim is made that closing an input stream changes that upstream implementation into a push-only producer. Happier releases its native capture subscriptions when their stream lifecycle ends.

## Simulator accessibility Actions (0.3 development)

`devices.simulator.accessibility.snapshot` reads the foreground iOS simulator application's native
accessibility tree, including identifiers, labels, values, frames and explicit truncation.
`devices.simulator.accessibility.press` resolves a unique identifier in XCTest at the time of the
effect and synthesizes the press there. Missing, ambiguous, disabled or non-hittable elements return
a typed failure. Neither Action uses preview image coordinates or claims a successful effect from a
keyframe request. Snapshot is read-only; press uses the existing Action consent policy.

The daemon's `ios/accessibility.ts` owns the guest AX/XCTest adapter. It uses bundled native sources
and the selected full Xcode installation through `xcrun`/`xcodebuild`, with owned temporary build
files removed after the request. Inventory advertises these operations only when their native
sources and tooling are available; preview capture health is independent. Android, missing assets
and unavailable Xcode tooling return `simulator_accessibility_unavailable`. The native dependency
closure must be applied before this development capability is advertised by default.
