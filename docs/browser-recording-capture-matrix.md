# Browser recording — engine × capture-kind matrix

This is the canonical map of which browser render engine records through which capture **producer**,
and the disposition (per the runtime-unification "defer = NOW" rule) of every declared
`BrowserRecordingCaptureKindV1`. It is enforced by two closure tests, not just documented:

- **Daemon producer half** — `apps/cli/src/daemon/browser/recording/engineCaptureMatrix.closure.test.ts`
  iterates every `BrowserRecordingCaptureKindV1`. A `BUILD-NOW` kind must reach a live daemon
  producer when its dependency is bound, and stay honestly fail-closed
  (`browser_recording_capture_adapter_missing`) when absent — never silently dark. An `UNSURFACE`
  kind has no daemon producer by design.
- **UI navigation half** — `apps/ui/sources/components/browser/surfaces/browserEngineNavigationClosure.test.ts`
  iterates every `BrowserRenderEngineKindV1` for the navigation/lifecycle contract.

A `disabledReason` is **not** a free pass for a `BUILD-NOW` cell (Completion rule #2): it is permitted
only for an `UNSURFACE` cell that makes no product promise.

## Capture kinds → daemon producer

| Capture kind          | Disposition | Daemon producer | Engine surface | Notes |
|-----------------------|-------------|-----------------|----------------|-------|
| `streamFrameCapture`  | BUILD-NOW   | PMS live-stream capture registry → `createBrowserRecordingStreamFrameCaptureAdapter` → ffmpeg | streamed browser surface / simulator preview | `video/webm`. Requires a `liveStreamCaptureRegistry` + a `machineLiveStream` capture source. Simulator preview targets must carry or derive the producer `sourceId` from `resource.capture.sourceId`; that same id is the stream family registered by the simulator capture reconciler. Local-service preview iframes do not own a live-stream producer, so they stay unavailable instead of borrowing simulator/browser stream evidence. |
| `cdpScreencast`       | BUILD-NOW   | Managed-Chromium sidecar `Page.startScreencast({jpeg})` → `createBrowserRecordingCdpScreencastCaptureAdapter` → ffmpeg | streamed surface (chromium sidecar) | `video/webm`. JPEG frames kept addressable for per-frame multimodal evidence. Bound via the `cdpScreencast.transport` seam. |
| `nativeViewCapture`   | BUILD-NOW   | Desktop Wry `desktop_browser_capture_recording_frame` Tauri command → `createBrowserRecordingNativeViewCaptureCommand` → `createBrowserRecordingNativeViewCaptureAdapter` | desktop WebView (external URL) | `image/png`, single still frame, **reference-only** (PNG written to disk, never inline bytes). Bound via the `nativeViewCapture` seam; advertised only where the platform reports `capture:true`. Daemon re-enforces the recording byte cap on top of the native cap. |
| `webContentsCapture`  | UNSURFACE   | — | Electron `webContentsView` | No Electron `webContents` host in the Tauri/Wry desktop → structurally unsupported. Makes no product promise. |
| `mediaRecorder`       | UNSURFACE (daemon) | — | client-rendered surfaces | A client-side (in-page) capture path; the daemon surfaces no producer for it. |
| `unavailable`         | UNSURFACE   | — | — | No-capture sentinel. |

## Reference-only invariant (BRW-15)

Every producer reuses `sessionMediaWriter` + the existing recording caps
(30s / 16MB / 12fps, `browserCapabilities.ts`) + the retention/redaction model, and persists media
by **reference** (`local-file` / `local-uri`), never inline bytes. No producer accumulates unbounded
frames in memory. The PMS `streamFrameCapture` producer proves streamed/simulator recording ONLY —
it is never cited as proof for a desktop WebView recording, and vice-versa.
