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

The daemon owns recording admission, identifiers and lifecycle. Its per-view identity is
`browserViewKey({ browserSessionId, viewId })`, so Sessions can use the same view id
independently. Recording lists require both identity fields; status, Stop and Cancel
address the daemon's unique recording id. The UI projects daemon results and retains
the real Composer attachment path without a second local recording lifecycle.

In 0.3 development, `recording/captureProfiles.ts` owns the shared availability
classification used by UI projection and daemon admission, including policy-denial
reason codes. Browser recording has no pause/resume API or view-hidden/parked/suspended
recording states; the browser surface lifecycle is separate. The capture producer
owns frame cadence: a completed artifact reporting a higher FPS than requested
still reaches media persistence. Encoder and storage failures remain failures.

In 0.3 development, CDP recording and browser live viewing share the per-view producer in
`apps/cli/src/daemon/browser/capture/cdpScreencast.ts`. The recording transport subscribes to it;
it does not independently start, stop or acknowledge the CDP screencast. Releasing the last
consumer stops capture, and view retirement terminates every consumer.

The daemon resolves the recording's Session workspace from the existing owner-metadata and
Machine-locality reader before persisting Session media. Human-only Sessions do not need a
tracked agent process; the Session's workspace remains the destination for their recording.

The managed recording transport enables CDP focus emulation for its target while
recording is active. This keeps the page rendering when another tab or popup is
in front, while preserving the foreground tab. Existing recording cleanup disables
the override on Stop, Cancel, view retirement, confidential hold and failed start;
the same cleanup removes the recording overlay.

Live-view discovery also carries the daemon's exact Session and view identity into
the workspace target. The opaque stream target id is not a replacement for that
identity. A workspace tab saved before this 0.3 development correction may remain
unavailable; close it and reopen the browser from current discovery.

In the current 0.3 development daemon, a finished recording is persisted in its Session's
working directory by `persistSessionMedia`. The daemon then admits a media-only transcript
attachment through its existing encrypted durable mutation custody, using the recording's
message local id. `session_media.v1` carries the playable relative path, MIME type, size and
hash; the normal transcript media renderer consumes it. Once admitted, draft-recording cleanup
does not delete the attached bytes. A missing Session directory or failed custody admission
fails recording finalization rather than reporting an attachment that was never admitted.

Desktop recording capability uses the actual reverse-capture handler registration for the view's
machine as well as the native capture shape. The surface refreshes that capability when handler
readiness changes, preserving navigation state.

Every producer reuses `sessionMediaWriter` + the existing recording caps
(30s / 16MB / 12fps, `browserCapabilities.ts`) + the retention/redaction model, and persists media
by **reference** (`local-file` / `local-uri`), never inline bytes. No producer accumulates unbounded
frames in memory. The PMS `streamFrameCapture` producer proves streamed/simulator recording ONLY —
it is never cited as proof for a desktop WebView recording, and vice-versa.

The existing input
owner's confidential hold stops an active recording and removes its overlay before
secret delivery. The already-captured public prefix is finalized successfully with
the `policy_revoked` privacy-stop reason and its Session media reference retained.
An already-admitted Stop also retains its safe prefix when the hold begins during
capture shutdown or persistence; secret delivery waits for that finalization.
The lifecycle chooses the stop reason once when capture successfully stops, before
persistence. A hold already active at that boundary produces `policy_revoked`;
a user Stop whose capture ended before a later hold remains `user_stopped`. The attached
Session media item's optional `browserRecording.outcomeReason` preserves that
typed reason, which the transcript media list and player present as “Stopped for
privacy” for `policy_revoked`. Older media without this metadata stays playable.
Startup-overlap and capture/encoder failures still discard unsafe or unusable output;
starting during the hold remains unavailable.
