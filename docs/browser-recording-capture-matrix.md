# Browser recording — engine × capture-kind matrix

This page describes unreleased 0.3 development source, not released or loaded-native
certification. The Home's Browser recording decision, a matching capture profile,
an actual producer and durable Session media support are all required; a declared
capture kind alone does not make a view recordable.

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
| `streamFrameCapture`  | BUILD-NOW   | PMS live-stream capture registry → `createBrowserRecordingStreamFrameCaptureAdapter` → ffmpeg | streamed browser surface / simulator preview | `video/mp4` (H.264) when the managed encoder reports support, otherwise `video/webm`. Requires a `liveStreamCaptureRegistry` + a `machineLiveStream` capture source. Simulator preview targets must carry or derive the producer `sourceId` from `resource.capture.sourceId`; that same id is the stream family registered by the simulator capture reconciler. Local-service preview iframes do not own a live-stream producer, so they stay unavailable instead of borrowing simulator/browser stream evidence. |
| `cdpScreencast`       | BUILD-NOW   | Managed-Chromium sidecar `Page.startScreencast({jpeg})` → `createBrowserRecordingCdpScreencastCaptureAdapter` → ffmpeg | streamed surface (chromium sidecar) | `video/mp4` (H.264) when supported by the managed encoder, otherwise `video/webm`. The shared capture profile accepts the daemon's `chromiumSidecar` adapter and the UI's `streamedBrowserSurface` adapter; both record the same managed view through CDP. JPEG frames kept addressable for per-frame multimodal evidence. Bound via the `cdpScreencast.transport` seam. |
| `nativeViewCapture`   | BUILD-NOW   | Desktop Wry `desktop_browser_capture_recording_frame` Tauri command → `createBrowserRecordingNativeViewCaptureCommand` → `createBrowserRecordingNativeViewCaptureAdapter` | desktop WebView (external URL) | `image/png`, single still frame, **reference-only** (PNG written to disk, never inline bytes). Bound via the `nativeViewCapture` seam; advertised only where the platform reports `capture:true`. |
| `webContentsCapture`  | UNSURFACE   | — | Electron `webContentsView` | No Electron `webContents` host in the Tauri/Wry desktop → structurally unsupported. Makes no product promise. |
| `mediaRecorder`       | UNSURFACE (daemon) | — | client-rendered surfaces | A client-side (in-page) capture path; the daemon surfaces no producer for it. |
| `unavailable`         | UNSURFACE   | — | — | No-capture sentinel. |

In 0.3 development, the shared ffmpeg encoder pads odd frame widths and heights
to the next even dimension for yuv420p, preserving captured pixels. Browser and
Computer recordings use this same filter; the H.264 capability probe exercises
odd-sized RGB input through it before selecting MP4.
The WebM fallback also requires a successful VP8 encode through the same output
arguments as recording. If no listed encoder works, recording is unavailable
before capture starts. Stopping without captured frames retains the typed
`no_frames_captured` encoder cause.

## Reference-only invariant (BRW-15)

The daemon owns recording admission, identifiers and lifecycle. Its per-view identity is
`browserViewKey({ browserSessionId, viewId })`, so Sessions can use the same view id
independently. Recording lists require both identity fields; status, Stop and Cancel
address the daemon's unique recording id. The UI projects daemon results and retains
the real Composer attachment path without a second local recording lifecycle.

The shared Session recording runtime presents failed starts in both the details pane
and mobile browser. An Action failure or daemon refusal leaves no local active recording
and shows one failure alert; a retired Session request stays quiet. Daemon diagnostic
messages are not shown raw, and a successful start is presented by its recording capsule.

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

The shared CDP capture producer enables focus emulation while any live viewer or
recording consumes the target. This keeps a hidden page rendering without activating
its native tab. The last consumer's stop, view retirement or failed start releases
the override. Recording Stop, Cancel or confidential hold removes that recording's
overlay and subscription, while a remaining human viewer keeps rendering.

Live-view discovery also carries the daemon's exact Session and view identity into
the workspace target. The opaque stream target id is not a replacement for that
identity. A workspace tab saved before this 0.3 development correction may remain
unavailable; close it and reopen the browser from current discovery.

Shared-Machine viewers in current 0.3 development source obtain source admission
from the installed daemon before the Home mints a viewer-bound relay grant.
Browser admission consumes the same profile-filtered view list as discovery;
Computer admission consumes the requester's desktop scope. The acting Account
remains distinct from the Machine's custodian through relay start. Successful
Browser control or recording does not by itself establish viewer-route admission.

In the current 0.3 development daemon, a finished recording is persisted in its Session's
working directory by `persistSessionMedia`. The daemon then admits a media-only transcript
attachment through its existing encrypted durable mutation custody, using the recording's
message local id. `session_media.v1` carries the playable relative path, MIME type, size and
hash; the normal transcript media renderer consumes it. Once admitted, draft-recording cleanup
does not delete the attached bytes. A missing Session directory or failed custody admission
fails recording finalization rather than reporting an attachment that was never admitted.

Record START decides once who may save where (`createRecordingSessionMediaHost`, `admitSave`),
before any capture. Installed requester ingress and the Session issuer's projected custody for an
Agent's Action save with that custody. A person's own Machine RPC (Computer personal controls,
the raw Browser recording RPC) carries only Machine admission: START then reuses the custody the
daemon already holds for the named tracked Session, and admits the save only when that Session
runs as the authenticated caller. No credential travels with the RPC. A caller naming anyone
else's Session, including the Machine owner naming a guest's, is refused with
`recording_session_not_owned`; a Session that cannot be read here as its owner is refused with
`recording_session_unavailable`. START resolves the Session's workspace with the owner read, which
also decides the Account mode, and the attachment is sealed by the transcript custody the way that
Session's own content is. Only original own-Account ingress and the custodian's own Sessions use
the daemon Account.

A capture that stopped cleanly but could not be saved ends `failed` with
`media_persistence_failed` and a `saveFailure` naming the file's fate:
`workspace_write_failed` (not written; the encoded file is deleted) or
`transcript_attach_failed` (kept in the Session's workspace on that Machine, not attached).
`capture_failed` means capture itself failed.

The shared SessionMedia format list, Composer staging and transcript readers accept
file-backed MP4 (`video/mp4`) alongside WebM (`video/webm`) in 0.3 development source.
The browser recording producers in this matrix continue to emit WebM.

## Native screen recording (unreleased 0.3)

### Session-list privacy

The Account preference `sessionListHiddenTagIdsWhileRecording` selects existing
Session tag IDs per Home. It defaults to no hidden tags and never changes the
tags themselves. One Home-qualified visibility selector supplies Session-list
projections and discovery sources, including search recents and message hits,
Machine recents, the mobile switcher, Home, tabs, widgets and composer suggestions.
Sources exclude matching Sessions before ranking, limits, pins or attention
promotion. Incidental references and window/page titles use a generic identity;
configured targets and navigation state are retained. Ambient activity snapshots
and notifications consume the same decision before native delivery.

Privacy follows the existing native recording state, including a pause and
finalization, and ends when that recording settles. On an opted-in Tauri client,
selected Sessions remain hidden until the first native state is known. If that
state is unavailable, they remain hidden until a later state update or until
the person clears the selected private tags. This avoids revealing private rows
while a recording's initial state is loading. The explicit
`screenCapture.privacy.set` client Action also turns privacy on while a person
shares their screen through another application or browser. That intent lasts
until turned off or this client closes; it is local presentation state, not an
Account preference or automatic detection of another app. Ending either source
restores Sessions only when the other source is inactive. Browser, phone and
Electron clients can use the explicit control without native capture support.

This is visual discretion in lists, not access control or concealment of an
already-open Session. The source path is implemented in unreleased 0.3; rendered
controls and the composed loaded-runtime journey still require validation.

### Native capture producer

Native screen recording is a separate desktop source owned by
`packages/desktop-native/rust/happier-desktop-native/src/capture/recording/`.
Native recordings are silent and include the cursor; microphone capture and
click highlights are not part of this flow.
Its macOS 13+ path uses ScreenCaptureKit and AVAssetWriter for silent H.264 MP4,
excluding Happier's own windows on display/area capture. Pause removes the paused
interval from sample timestamps; Stop ends the media session and awaits writer
completion before publishing a playable library result. Requested physical trims
use a finite AVFoundation export and retain the source. Odd-sized window inputs
keep their source dimensions through capture and writer setup; the encoder drops
the trailing odd row/column and the result reports the even output dimensions.
Area bounds expand to even dimensions using real display pixels.
The Windows adapter uses Windows Graphics Capture and an explicit H.264 MP4
encoder; selected-area rows are packed from the source stride before encoding.
Changed frames retain their actual active-time intervals, including a static
tail through Stop. Timed frames wait for native sample acceptance rather than
queuing an entire finite decode in memory; encoder settlement wakes failed
sends. Physical trim uses a finite Media Foundation source reader:
it seeks to the preceding keyframe, admits only decoded intervals overlapping
the selected range, and re-encodes them through the same silent writer. It does
not publish an edit-list-only trim. Media Foundation libraries load only for the
requested trim, so Windows editions missing the optional Media Feature Pack
can still start the app and report that operation's native failure visibly.
The Linux adapter encodes VP8 WebM through one GStreamer writer and awaits muxer
completion before library adoption. X11 uses `ximagesrc`: the P1-selected window
or frontmost window is bound by its exact `xid`, and a display/area uses P1's
physical pixel bounds through `startx`, `starty`, `endx` and `endy`. X11 does not
open a second portal picker. Wayland uses the system's window/screen choice,
retaining its granted PipeWire fd and optional stream serial through completion;
it makes no preselection or region promise. Linux whole-screen output may show
Happier controls, an accepted visible limitation. Window and region capture use
their selected pixels, with Capture controls placed outside the selected area.
X11 subscribes before opening its source: a destroyed/resized selected window
or removed/reconfigured selected monitor ends recording through the same awaited
EOS path, retaining playable content with a source warning instead of substituting
the root or a different area. Its Xlib trap chains unrelated errors to the host;
only the selected drawable and source-owned native teardown errors are intercepted.
Native desktop and compositor behavior remains a platform validation requirement,
separate from source-level owner tests.
Pushed timing anchors feed the existing elapsed hook and native tray presentation,
not per-second native IPC. The retained Capture authoring operation holds source-time
trim, pins, notes and P2 frame documents. Delivery selects distinct in-trim timestamps,
rebases their notes, burns current frame marks into PNGs and appends one image/video
batch through the existing Session draft owner. Both window text and the optional
unredacted movie consume the shared blur/disclosure rule; restoring either after blur
requires its warning decision. Included trimmed movies contain physically exported
bytes, not a playback-only trim. Hiding retains edits while ending player demand;
settlement retains the library source, while Discard follows the existing Undo hold.
Each sent still's inline Image reference accompanies a clip-relative timestamp,
explicit pin, note text and marked-frame kinds at that moment. The movie defaults
on in `auto` without blur. Composer finalization persists its bytes as input
SessionMedia on the target Machine; provider dispatch lists that verified file's
relative path, name, MIME type and size in the existing attachment context for
Claude and Codex. This is a readable file for tool-based inspection or frame
extraction, with selected PNGs delivered inline; it does not require native
model-video input support.
The loaded desktop composition and platform webview checks must still be observed
before claiming an end-to-end desktop recording feature.

Tray, attach-menu, selection-toggle, configured shortcut and Agent starts reach the
same native capture operation. Agent starts and frame-pixel reads default to Ask;
status, metadata reads and recording pause/resume/stop are Direct continuations.
Browser, phone and Electron clients return `desktop_only`. No recording CLI or
voice entry is exposed.

An explicit retry consumes the original mode, target and Session at the native
operation owner. A failed file adoption retries adoption without restarting or
refinishing the encoder. A finalized movie with a source-stop warning stays
available for review; acknowledging that recovery settles its normal-Quit work.
An unrecoverable preparation failure permits a fresh requested start, retaining
the partial library file. Failed renderer source/document reads reopen the same
capture. Holding a failure starts no automatic retry, permission probe or encoder.
Normal Quit finalizes through the existing desktop exit owner; forced termination
has no crash-repair promise.

On Wayland, the native owner first publishes the closed `system_selection`
snapshot with its existing operation reference and recording mode. The Capture
window explains that recording is window or screen only and region recording is
unavailable before the person continues into the system source dialog. Continue
commits that same native selection; repeated starts keep the note pending. Cancel
retires that operation. This is a local development-source lifecycle extension:
native producer, TypeScript projection
and strict Action output schema must load together, with no persisted format,
new wire epoch or mixed 0.2/0.3 compatibility adapter.

Capture-window placement reads permission-free display facts, rather than
discovering capture targets. The authoring operation retains its selected
display geometry after releasing native sources and window metadata. A system
monitor used only for placement has no capture-source id (`displayId: null`),
so a permission-denied page or Wayland source note can be placed without first
obtaining screen content.

The Rust `gstreamer` binding is pinned to `=0.24.3` under the Linux target only
and is optional, enabled by the native crate's `capture` feature. It is not a
dependency of macOS/Windows builds or native builds without capture. The Linux
Tauri app enables capture, so building it requires the GStreamer development
package and Xlib development metadata (for example, `libgstreamer1.0-dev` and
`libx11-dev` on Debian/Ubuntu). Both native bindings are Linux/capture-only.
GStreamer core is already a WebKitGTK runtime dependency;
capture-specific X11/PipeWire, encoder, muxer and decoder plugin elements are
detected at runtime rather than assumed present.

Linux prerequisite failures preserve concrete bodyless reasons across the native
adapter and Action result: `pipewire_unavailable`, `video_encoder_unavailable`,
`video_muxer_unavailable`, `video_decoder_unavailable`, `cursor_unavailable` and
`video_pipeline_unavailable`. Their recovery text identifies the missing capture,
encoding, container, decoding, cursor or video-pipeline prerequisite. Installing
that prerequisite and explicitly retrying is the recovery; ordinary app readiness
does not depend on recorder availability.

## Recording cursor and keystroke overlay

In unreleased 0.3 development, managed-Chromium `cdpScreencast` recordings paint a
cursor, pressed-pointer state and the latest keystroke/shortcut label into the
existing page JPEG source before the shared managed encoder. No second screencast or
recorder is allocated. The recording transport installs a document script in an
isolated world for the page's frames and subsequent navigations, and removes it
and the current frame overlays when recording stops. Live viewers of the same
page can see the overlay while recording is active.

The overlay shares the recording-only rendering lifetime described above;
neither requires bringing the recorded tab to the foreground. The published
[recording guide](../apps/docs/content/docs/sessions/session-settings.mdx#page-context-and-recording)
keeps this managed-Chromium behavior separate from other capture kinds.

Text-only agent/mobile input and paste show generic Typing/Paste labels without
reading their payloads. Key labels clear on focus changes and suppress password fields, password/OTP or
payment autocomplete fields, secret/private markers, credential field names and
CSS text-security fields. Uninspectable focused editors (such as closed shadow
roots) also suppress labels. Field values, clipboard contents and composition data
are never read for labels; key events stay inside Chromium. The existing input
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

The server's diagnostic `cursorOverlaySupported` bit is true only with recording
and managed-sidecar features enabled, matching the implemented CDP producer; the daemon's start context reports it only for the selected, available
CDP recording producer. Missing older payloads still default to `false`.
`nativeViewCapture` PNGs and arbitrary `streamFrameCapture` sources do not gain a
DOM overlay. Loaded browser appearance and cross-platform playback remain QA
obligations, not claims established by this source description.

## Browser producer lifetime

Managed Chromium discovery retains the control adapter's last terminal event per
logical view for that Session adapter's lifetime, replacing it when the view is
rebound. These projections carry the existing `viewClosed` or `adapterUnavailable`
event without capture readiness or CDP handles. Active-view inventory remains
separate, so late discovery cannot re-admit retired capture. The streamed UI
consumes that event; an absent row alone does not close a workspace tab. Older
daemons without terminal projections still deliver live lifecycle events; a
missed terminal event leaves the tab available for recovery instead of inventing
a close. This uses the existing version 1 view/event shapes, with no new wire
field, event kind, persisted state, timer or retention budget.
A terminal adapter/view failure keeps the recovery card and its cause, but says
the browser stopped rather than claiming the page is still open. Try again
rechecks discovery and reconnects available capture; it does not start Chromium.
If the producer still reports the terminal cause, the tab and failure remain.

Desktop recording capability uses the actual reverse-capture handler registration for the view's
machine as well as the native capture shape. The surface refreshes that capability when handler
readiness changes, preserving navigation state. The daemon carries the admitted requesting
Account from recording start to the reverse RPC send. Desktop frame capture requires that
Account to match the daemon's Account.

Every producer reuses `sessionMediaWriter`, the recording capabilities in
`browserCapabilities.ts`, and the retention/redaction model. In 0.3 development,
recording has no duration or byte caps: capture continues until Stop or lifecycle retirement,
including a delayed Stop. Duration/byte operands and their cap outcomes are absent from
the closed recording request, capability and reverse-capture contracts. The default
encoding cadence remains 12fps; `nativeViewCapture` remains the single PNG described above.
Session media ingestion keeps its own configured file budget. Producers persist media
by **reference** (`local-file` / `local-uri`), never inline bytes. No producer accumulates unbounded
frames in memory. The PMS `streamFrameCapture` producer proves streamed/simulator recording ONLY —
it is never cited as proof for a desktop WebView recording, and vice-versa.

## Managed output format (unreleased 0.3)

The shared daemon encoder owns format selection for Browser stream/CDP and Computer
recordings. It queries the existing managed executable, preferring software H.264
(`libx264`, then `libopenh264`) over listed hardware encoders. Every H.264 candidate
must successfully encode one generated frame through the fragmented MP4 muxer;
a compiled-in encoder without its runtime library, device or driver does not
establish support. With no usable H.264 candidate,
the existing libvpx/WebM arguments remain unchanged. No encoder or system-tool
dependency is added. The result is shared per executable filesystem identity
(path, device, inode, size, modification and change timestamps); replacement
invalidates it without a timer or polling.

Failed Stop results expose the daemon's typed outcome reason and, when supplied,
save-failure code through the existing Technical details alert for Browser and
Computer. No request id is fabricated when the lifecycle result supplies none.

Start capabilities and recording results carry the selected MIME. Stream adapters
pass the produced MIME to the existing Session-media writer, so stored references
and previews use the actual type. MP4 uses
`frag_keyframe+empty_moov+default_base_moof`, placing initialization metadata before
media fragments rather than depending on final-file metadata. The encoder owner
still rejects nonzero or signaled process exits and removes their partial output;
it does not publish a truncated successful recording. See the
[FFmpeg fragmentation contract](https://ffmpeg.org/ffmpeg-formats.html#Fragmentation).

Desktop-native Browser capture remains one PNG still, with an `image/png` artifact
and media reference even if the request names video. Simulator has no Record
control or recording operation in its current toolbar and device-operation catalog;
the shared adapter's ability to consume a simulator stream is not a recording entry.
Existing saved WebM recordings are unchanged. Playback support is decided by the
existing preview owner on the viewing device.

## Failed Stop diagnostics

The shared recording lifecycle carries an optional canonical `ActionFailureCauseV1`
and the real Stop invocation's `requestId` in failed Stop results for Browser and
Computer. It owns the `recording.capture_stop` or `recording.media_persistence`
phase; repeated Stop returns the retained terminal diagnostic and original request.
Older results without these optional fields remain readable. Strict 0.3 development
readers and producers must be updated together; this is not a released 0.2 protocol.

The shared ffmpeg encoder retains its selected encoder/container/MIME type, exit
code or signal, and a closed stderr class. Its one failure log contains only these
safe fields. Raw stderr, arguments and paths are never logged. The capture adapters
preserve the originating error; the existing recording alert passes its typed cause
and request to Technical details. These diagnostics describe the next failure;
they cannot recover causes discarded by an older daemon.
