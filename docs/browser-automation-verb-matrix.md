# Browser automation — surface × verb matrix

This development-source matrix distinguishes protocol action kinds, advertised engine
capabilities, and the executable installed-collector contribution. Their census is generated
below; an action parsing successfully does not make it executable on an in-app surface.

**The table below is generated, not written.** `apps/ui/sources/sync/domains/browser/adapters/automationVerbMatrix.closure.test.ts`
renders it directly from `buildBrowserAdapterCapabilities` and `INJECTED_PAGE_AUTOMATION_ACTIONS`
(`apps/ui/sources/sync/domains/browser/adapters/capabilities.ts`) and fails when the committed bytes
drift from what that builder produces. There is deliberately no second, hand-maintained table.
When the capability builder legitimately changes the answer, regenerate this section rather than
hand-patching it:

```
cd apps/ui
UPDATE_AUTOMATION_VERB_MATRIX=1 ../../apps/stack/bin/hstack-exec --local -- \
  node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts --maxWorkers=1 --no-file-parallelism \
  sources/sync/domains/browser/adapters/automationVerbMatrix.closure.test.ts
```

## Controller and cancellation (development source)

Managed Browser profile custody is decided by the product-side profile owner.
Requesters without Manage access cannot command an existing persistent-profile
browser, including navigation, close, target changes, Take control and Hand back;
commands return `profile_policy_denied` before controller changes or native effects.
Runtime automation, diagnostics, context and recording Actions naming that Browser
Session consume the same refusal before reaching their producers. Raw context,
diagnostics (including detail and watches) and recording RPCs use the same
predicate through shared raw admission. Recording IDs and lists use the stored
view and profile even after browser closure or profile changes; global
diagnostics and retention cleanup project only allowed targets.
Saved context IDs use their captured source and native profile for attachment,
clear and replacement, including after close or reopen. Selecting another view
does not change the saved context's custody or prevent valid attachment by ID.
The same predicate governs native streamed-source admission and list and watch
discovery. An explicit Session share governs the Session's ephemeral managed
Browser: View permits frames and Steer permits input, without a separate Machine
grant. Home consumes `resolveSessionAccessForOperation` and carries its canonical
capabilities through installed-source admission and the signed relay. Shared
Browser RPCs and streamed content use the Session encryption mode: E2EE uses its
Session key, and plaintext Sessions remain keyless. View cannot
send native commands or streamed input. Persistent profiles remain excluded for
nonowners on this Session-share path. Without a Session share, a Use guest can
access an ephemeral Browser only when the Session's existing requester attribution
belongs to that Account; missing attribution denies access (N14). Persistent-profile
views remain unavailable to Use guests. The Machine custodian and Manage requesters
retain their existing Machine-scoped access.

Browser address and navigation shortcuts use the existing keyboard command owner, including
user rebindings. Native desktop guests, same-origin iframes and cooperative preview frames
forward only its active Browser command signatures; composition and unrelated page keys stay
with the guest. Hidden guests release those signatures. Native desktop delivery also focuses
the host window so its address field can receive input. Uncooperative cross-origin iframes
cannot forward keys through their sandbox. Iframe sandboxes allow user-activated pointer lock
without adding same-origin privileges. Agent pointer actions restore a previously focused
host field only when the guest stole focus; a person's newer host selection takes precedence.

Original Account HTTP navigation retains the admitted UI host caller through the daemon's
shared Action executor into the canonical approval policy. Reversible in-place controls default
to direct execution; saved UI Require preferences and agent/MCP approval defaults still apply.

The Browser automation service owns connected human viewer identities and control custody.
A controlling viewer disconnect releases its physical input, then hands control back; the last
human stream also releases a toolbar-only hold that has not acquired a stream-input identity.
A passive viewer disconnect leaves agent admission unchanged. Presence consumes this controller
fact, rather than expiring it with a separate timeout.

Live-view rendering shares the [CDP capture lifetime](./browser-recording-capture-matrix.md#reference-only-invariant-brw-15)
with recording; the shared producer keeps hidden viewed pages rendering.

Managed Chromium publishes navigation readiness and history from native main-frame completion,
including BFCache restores, page load completion and same-document history changes. A same-document
change reuses the current document readiness query when loading; it does not imply a completed load.
Managed Chromium also publishes its page-reference, screenshot and annotation context support in
the discovered view capabilities. Streamed presentation preserves those producer facts; Attach page
uses the same mounted context owner before and after refresh or reopen.

`browser.view.setViewport` selects a per-view device preset or `fitViewer` through the
existing Browser command Action. Managed Chromium's `sidecar/viewport.ts` owns the complete
metrics, touch and UA/client-hint tuple. A fixed preset keeps its geometry when the controlling
viewer resizes; every streamed viewer contains the effective page geometry. `fitViewer` restores
the engine's ordinary identity and touch behavior and follows the controlling viewer again.
The shared preset catalog is exported by `browser/control/v1`; native views return the existing
typed `unsupported_command` result. These are development-source contracts, not physical-device
or Safari certification.

An approved first `browser.view.open` on a Machine retains the original command while managed
Chromium is installed. Concurrent requests share the existing provisioner. Installation is
followed by the canonical route refresh, then the original dispatch reads that refreshed control
route and opens its view. The product-source factory only resolves installed artifacts.
The explicit sandbox installer shares managed Chromium acquisition; if it installs the binary
after daemon startup, the dispatch provisioner refreshes the same routes without downloading
again. Daemon startup does not download Chromium. Control refusals preserve
`runtime_action_disabled` with distinct typed causes and phases: `browser_sidecar_disabled`
at `browser.control.feature_decision`, or `browser_control_route_unavailable` at
`browser.control.route_resolution`.
Product binary resolution owns managed-source eligibility and requires locally verified
provenance before returning a launchable binary; the factory consumes that result without
repeating the admission. Installed-source digest verification remains with `sidecar/source.ts`.

The canonical Action catalog owns Browser Action exposure. A context capture evaluates its
owner gate once, then reuses that admission while checking content privacy again before
publishing a page or screenshot. A newly sensitive page still suppresses its captured content,
and another Account never gains capture access through that admission.

The existing Machine Action operation owns this continuation beyond the RPC response. During
installation, the open returns `status: in_progress`, `phase: browser_runtime_provisioning` and
its `operationId`; acceptance does not mean the page is open yet. The operation retains the
terminal command result or a typed failure. A later fresh request may retry a failed install;
there is no automatic retry. Session-local control requests without an operation observer wait
for the same provisioner and dispatch. These are development-source contracts; loaded-runtime
first-frame validation remains a QA responsibility.

The operation scope comes from the installed requester's verified Machine admission, not the
daemon custodian or a caller-supplied Account id. Approval acceptance retains that private
requester custody until the original open settles. The requester can observe its operation;
another Account cannot read it or publish its snapshot through the custodian's channel.

The presented Session Browser also observes the broker's native view membership over
`daemon.browser.view.watch`, using the same Account/Machine transport and redacted
discovery projection as `daemon.browser.view.list`. This observation exists before
Chromium installation, so an Inbox-approved open becomes discoverable without a
local Action operation snapshot. One initial list is followed by one parked wait per
presented Browser host, rearmed after a membership change. Hidden hosts cancel the
wait; unrelated Sessions do not wake it. Older daemons keep one-shot discovery and
the existing retry path. There is no polling, extra view registry or revision owner.

Protocol's `daemon/browserProjection.ts` owns contributed Browser entry identities and
rendering-shape normalization. The daemon producer uses those shared identities and types;
the UI consumes that normalizer through its existing projection facade. This does not widen
Action policy or change the projection wire envelope: unknown entries remain non-rendered,
and Browser placements still cross-check the same generation's Action catalog.

Every admitted Machine `browser.view.open` uses that same operation runner, including
already-installed opens and approved Artifact replay. Route availability decides whether
provisioning is needed; it does not decide whether the open is observed. An invocation already
carrying that Action's operation acceptance continues its original operation. The Artifact
execution claim remains the replay authority, so repeating approval does not reopen the view
or create another operation.

Operation lists intentionally omit terminal result payloads. After reload, a UI bound to a
settled open fetches that exact operation through `action.operations.get` to recover its typed
command result; list absence of `result` is not a successful page-open outcome. Typed operation
failures remain on the list's `error`. Approval history may contain provisioning acceptance:
its `operationId` links to live operation state, while Artifact `executed` only means the
approved invocation returned that acceptance. These are development-source contracts.

Machine-targeted `browser.diagnostics.*` Actions use the same Machine Action transport as other
daemon-owned Browser Actions. The UI front door validates catalog input and requires an explicit
Machine target; it does not interpret the lack of a local diagnostics producer as global
unavailability. The runtime CLI admits the same diagnostics family through the canonical Action
surface policy.

In development source, the Diagnostics drawer acquires one view-scoped daemon snapshot while open,
presented and actively viewed, then watches the daemon owner's actual changes through a cancellable
Machine RPC subscription. Unchanged idle views perform no history reads. Closing or hiding it
releases the subscription; local and daemon collectors keep their existing lifetimes. Opening,
reopening or reconnecting acquires the selected view's daemon ring (by default,
1,000 events per view and 5,000 per Machine snapshot), with no promise of history beyond that
ring. Agent snapshot Actions read the daemon store directly and do not require an open drawer.
Managed Chromium views expose the same drawer using the host's explicit Machine/Home context
and the discovered daemon Session/view identity, including human-only Sessions and empty histories.
Opening the drawer starts snapshot/watch delivery; an unopened or hidden drawer does not read history.

The current development Diagnostics data contract adds correlated request metadata, console and
page-error text for a transport-verified person, page titles, collector availability reasons, and
ring/snapshot loss counts. Agent snapshots continue through the destination classifier. Opening a
selected request detail performs a separate, person-only read over the same Machine RPC; this
includes trusted Machine guests. Only that read acquires request/response bodies from CDP and
returns cookie values from the selected ring record's private ExtraInfo. Those values never enter
the pushed event history, agent Actions, transcripts or logs. Binary bodies retain their base64
encoding; missing, unfinished or evicted content has a typed unavailable result. Closing or hiding
the detail releases the UI's local values. This B5/B6 development path is ready for security review;
it is not a released availability promise.

Exact-Machine control and automation also use that transport when the managed view has no mounted
client presentation. Mounting a daemon-owned view does not transfer execution to the client; its
host projects returned control events through its existing reducer. In-app engines such as an
iframe retain their mounted executor. Missing or blank Machine targets are not inferred from a
Session's default Machine, and forwarding preserves the existing Action approval policy.

In current 0.3 development source, mounted automation dispatch asks the server's live exact-view
RPC registry rather than treating an absent positive registration hint as proof of unavailability.
A definitive missing-handler reply, whether from the Home or inside the UI's decoded acknowledgement,
remains a typed unavailable result. Transport loss after an
effect-bearing request was issued retains unknown completion; it is not safe to retry as though
the page action never ran. The mounted responder remains independent of the Diagnostics drawer.

A retained Browser page keeps its runtime owner, automation controller and exact-view reverse
responder with it when its pane is parked or its route leaves. Presentation visibility still
pauses presentation-only work; it does not retire the page's executor. Removing a Details tab or
group withdraws its canonical pane membership and retires its retained entries, including a page
already parked without a binder. Hiding Details or handing its route off preserves membership.
Controlled Details destinations borrow the live workspace's tab membership instead; removing that
destination also retires its retained content. Retirement is qualified by the existing rendered
node: an old close cannot delete or unmount a newer binding of the same slot. Explicit close tears
down the retained owner, and Home/Account retirement still refuses further Actions. This is a 0.3
development-source lifetime contract, not evidence that a running UI export contains the change.

Before a Browser view exists, `browser.workspace.open` admits a target through the same Action
front door. Its closed input names the answering-client workspace, command and Browser target,
not an arbitrary OS-open URL. The registered workspace owner captures the exact Home/Account
lifetime and re-resolves current policy and adapter availability after approval. UI and Agent
open the same deterministic tab resource; only the renderer materializes live Browser state.
Disabled/denied Actions, absent workspaces and retired Homes create neither a tab nor an OS open.
The resolved desktop adapter may hand an allowed target to the system browser, with failure
reported if the OS refuses. The Action is client-placed, dangerous and Ask-first by default for
Agents; no mounted Browser view is fabricated to dispatch it. This is unreleased development
source, not composed-live or native-platform certification.

The unreleased 0.3 workspace and view-open/retarget inputs accept an optional typed
`engineOverride` (`embedded` or `managed`). The existing adapter selector decides
availability; an explicit managed refusal remains a refusal. Workspace resources carry
the choice through the renderer's initial open and retained-view reopen. The daemon
refuses embedded opens before acquiring a managed runtime.

Workspace opens and address-intent `browser.navigate` share the Browser address resolver:
a matching running Service opens through its existing preview owner; other addresses
keep the ordinary Browser adapter route. `navigationIntent: 'target'` retains low-level
navigation within a known target. Chat links and the address bar consume this owner.
Saved-profile list/create/select/delete Actions use the daemon's existing profile store
and control owner; the profile popover dispatches those same Actions. Native Browser and
Computer viewer copy uses `clipboard.write`, including the answering device's Off/Ask policy.

Workspace opening resolves a known device-local Home profile through the canonical Home identity
before selecting the captured Account owner. Approval replay keeps the same Account and lifetime
checks. Local-service previews use this workspace path; daemon `browser.view.open` opens external
URLs in managed Chromium without a UI pane. If no daemon adapter supports the requested target,
it returns `adapter_unavailable` with `browser.workspace.open` as recovery for workspace targets.
The shared Browser Action adapter projects failed control results into Action failures, so a
refused command also records a failed approval execution rather than `ok: true`.

Mounted Browser navigation, open/retarget/close and presence commands enter through the canonical
Action front door before the existing runtime adapter dispatches them. The UI and Agent use the
same exact mounted-view registration and captured Home/Account lifetime. Continuous human input
remains on the existing sideband custody path, not a per-frame Action loop. A daemon command's
unconfirmed response cannot be projected as an accepted takeover or overwrite current owner events.

Whether a mounted view can perform `navigate`, `goBack`, `goForward`, `reload` or `stop` is
answered by one owner, `resolveBrowserNavigationVerbAvailability` in the UI's
`sync/domains/browser/adapters/capabilities.ts`, read from the view's published capabilities. The
toolbar and the navigation Actions both ask it. A third-party page in the web `webIframe` engine
keeps its history and loading opaque to the host, so it offers Reload only: the toolbar shows Back,
Forward and Stop unavailable with a reason, and `browser.goBack`, `browser.goForward` and
`browser.stop` return `runtime_action_disabled:browser:browser_page_history_uncontrollable`. The
system-browser escape stays in the toolbar overflow. Relay and local previews (whose documents carry
the navigation reporter), native WebViews and desktop WebViews that report history keep every verb.

In 0.3 development, mounted console evaluation, property reads, object-group release and element
picker Actions name both `browserSessionId` and `viewId`. UI controls enter the Action front door;
the default runtime and authenticated reverse dispatcher resolve the same mounted diagnostics
owner and its injected-engine bridge. Evaluation, property reads and picking require interaction
to be enabled on that surface; object-group release remains available for cleanup. A missing or
retired view refuses execution. The Action input selects client placement for `injectedPage` and
Machine placement for `cdp`. UI approval retains the mounted invocation and rechecks the view,
navigation generation and interaction state before delivery. Sidecar-owned views continue through
the daemon diagnostics adapter and CDP. These are current source contracts, not loaded-runtime or native-platform
certification.

In development source, injected and managed engines share the Protocol locator parser and
page resolver. `selector` and string `locator` inputs accept CSS, `role=`, `text=` and test-id
locators; retained structured locators normalize at that same boundary. Field contents never
select the target. Queries return every match. `setValue` replaces existing content, while `type`
appends by default. Managed keyboard input establishes focus before dispatch and refuses a missing or
unfocusable target. Injected uploads attach the complete admitted file set or return a typed
refusal. `waitFor` uses the containing Action's deadline, and cancellation retires its page timer.

Diagnostic scalar results and property expansion preserve full supported values. Object previews
retain their presentation bounds and disclose clipped values or omitted properties; the inspector
marks a partial preview with an ellipsis and keeps Expand available. Console and network summaries
read the canonical retained diagnostics and select newest evidence under the context protocol's
output budget before presenting it chronologically. Omitted summary material is flagged truncated.

The overflow menu and non-framable/slow-frame escape use `browser.view.openExternal`. Its closed
input names the Browser Session, view and command; the runtime resolves the current page URL from
that mounted owner and opens it in the answering client's system browser without navigating or
replacing the view. It has the existing dangerous Browser Action policy. A missing/retired view,
disabled Action or refused OS opener fails closed. This explicit operation is distinct from an
admitted `browser.view.open` whose resolved desktop adapter availability selects the OS fallback;
an unanswered desktop probe does not authorize that automatic fallback. These are unreleased
development-source contracts, not loaded-runtime or native-platform certification.

The daemon automation service is the controller authority for sidecar/streamed views; in-app
engines use the UI automation control service. Human input takes control even when no action is
running, and that hold lasts until explicit handback through the existing presence/input controls.
Focusing a daemon view only activates its target: it does not interrupt agent input or change
the controller. The command route still refuses non-human focus while observation is confidential.
Handback cannot free a still-draining mutation. Agents must obtain a fresh successful snapshot after
takeover or a document change before resuming mutations; stale navigation generations are refused.

Cancellation stops subsequent action phases, waits for issued CDP input and attempts to release held
mouse buttons/keys before acknowledging. `completion: stopped` means the issued work and cleanup
were acknowledged; `uncertain` means the host cannot prove that drain. Neither outcome promises to
undo effects already dispatched. Injected in-app engines have no physical cancellation acknowledgement
and report uncertainty while retaining admission until their boundary settles.
The presence capsule follows that owner fact: after a takeover it shows "Stopping…" while the
interrupted agent action still holds admission (the in-app controller snapshot's
`interruptionSettling`), then "You have control" with "its last action may have landed" when the
settled interrupted entry's completion is not `stopped`. It never claims control before settlement.
Daemon controller events carry the shared input owner's `interruptionSettling` and `uncertain`
facts too. A fresh settled observation after human takeover clears the latter and publishes the
new controller state; historical timeline entries do not reintroduce cleared uncertainty.

The timeline is recent activity, not an audit log. `automation/service.ts` owns
the daemon retention bound; neither the wire nor the UI control service supplies
a second fixed cutoff. Compact timeline summaries still use their separate
redaction/clipping projection rather than retaining complete Action results.
Closing a view still retires its controller and timeline at the existing lifecycle owner.

In development source, daemon automation Actions targeting a mounted UI view use the existing authenticated
machine reverse RPC, addressed by `browserSessionId` and `viewId` and bound to the invoking Happier
Session. The mounted pane's Session context is the binding authority; slot-derived Browser Session
ids need not equal Happier Session ids. Another Session on the same machine cannot use that pane.
The daemon control broker's
registered adapters decide physical ownership; UI-owned or disconnected UI targets never start
Chromium provisioning. The UI handler delegates to the same mounted controller, preserving the
host-stamped cancellation authority. Action policy decides approval once; admitted present-user
or Account-automation cancellation reaches the same input-control owner without another approval veto.
Missing authenticated authority still returns `owner_mismatch`.
Plugin Actions and Session execution-run Actions consume that same daemon composition; Session
clients retain its provider accessor so startup publication and retirement are visible per dispatch.
Room registration follows the mounted pane and its Account lifetime; a retired view fails closed.
Invoking cancellation travels through the existing RPC cancellation transport to the UI control
service's engine AbortSignal. Disconnect and handler retirement interrupt that same owner. An issued
effect whose acknowledgement is lost returns `status: interrupted, completion: unknown`, not
"unavailable" or an assertion that the effect did not happen. The UI retains admission until its
engine boundary settles; transport interruption does not grant human control or replay the action.
History/title-only updates retain the installed collector and mobile/desktop automation owner; a document
generation change retires that identity. These are source contracts, not a composed-live certification.

The sidecar's canonical view binding derives navigation generations from engine document events,
including same-URL reloads. Initial bootstrap also checks document readiness because a fast page
can finish before page events are enabled; a later document commit invalidates that readiness reply.
URL/title/loading and controller events feed the existing browser event
reducer; command success is not evidence of a document commit. This is unreleased 0.3 behavior, not
a claim that the composed stream journey has been live-verified.

In current 0.3 development source, the normal browser selector admits daemon-backed streamed
views for display and navigation. Session surfaces discover registered capture sources through
Session-filtered daemon discovery before a view is mounted, then refresh that projection when a
browser Action completes in the Session transcript or a retained Browser open operation reaches a
terminal state in the same Home, Account, Machine and Session. Provisioning acceptance alone is not
terminal completion. Watch resolves the exact named daemon view's
capture source, rather than reopening the Action's URL. Opened-view metadata and command results
feed the existing control reducer. There is no separate daemon-open push outside this Session
Action/transcript/operation flow: an out-of-band open is discovered on the next surface mount or
matching Browser Action completion. The engine capability table below describes local automation producers;
streamed rendering does not turn the viewer into a second automation owner.

Daemon discovery includes the current opening facts for every view: semantic target support,
adapter capabilities and Diagnostics fidelity. The UI projects capture identity for rendering while
retaining those daemon facts. Equal refreshes preserve row identity and emit no events; changed
binding facts hydrate the existing reducer record without resetting navigation or controller state
or replaying retained navigation history. Stream startup, resume and keyframe metadata reuse the
control adapter's current navigation event identity; attaching a viewer does not create a navigation.
The Browser capture registration belongs to the logical view. An ordinary daemon open that
rebinds that view to a new native page keeps the registered source and admitted observers. The
shared screencast producer serializes the native source change, discards retained/late pictures
from the old page and resumes all subscribers on the new handle. Only a real view unbind retires
those subscriptions; no viewer retry, polling or lease timeout owns that transition.

Session browser presence uses that same daemon control route for `takeControl` and `handBack`.
The owner-scoped machine RPC stamps present-user authority; commands cannot supply their own
authority. Hand-back preserves input drain and requires a fresh successful snapshot before the
agent resumes mutations. In-app presence delegates to its existing UI control service.
Agent `browser.control.takeControl` and `browser.control.handBack` Actions use the same view-addressed
reverse route for mounted UI panes, with the existing Session binding and configurable Action approval policy. The UI
command owner delegates to that pane's control service, not a fallback controller. Handback during
input settlement returns a retryable `permission_denied` command result rather than claiming success.

Browser control, cancellation and `browser.sandbox.install` use the canonical Action approval
decision, including configured Allow. Their executors retain authenticated targeting and OS
authorization without a second approval decision or a Browser-specific bypass stamp. The direct
CLI sandbox-install command retains its existing interactive OS authorization. These are current
0.3 development-source contracts.

Browser Action admission derives input requester authority from the trusted host context:
`present_user` is human input and every other authority is agent input. A caller-supplied
`requestedBy: 'user'` without that authority is rejected. Authenticated stream viewer input
continues to enter through the human takeover owner. An uncertain stop stays visibly uncertain;
human input remains possible, and a fresh settled observation after takeover clears uncertainty
before handback. Native computer input shares this recovery owner.

In unreleased 0.3, the Action route validates automation input once and the daemon service
consumes that typed request. The control broker validates external adapter results once.
The shared input-control owner decides confidential observation refusal for both paths;
human input remains available during the hold. Caller-selected automation deadlines have
no browser-specific 60-second ceiling. Human stream input follows viewer cancellation and
the input owner's lifecycle without a synthetic action deadline; key and text input have
no separate character-count ceiling.

Persistent-profile extension install/update reviews carry an active profile's restart
consequence with any new grants. Accepting that review covers the restart in the same
decision. Active-profile changes without a new-grant review still ask for restart confirmation.
Browser rendering checks the actual profile identity independently of feature admission;
its target-policy projection does not invent site-permission decisions.

Live browser events travel as strict metadata batches on the watched view's existing encrypted
frame transport. Each batch projects current engine navigation and automation controller state
from their owners, so the stream's latest-startup-observation projection retains both. The single
relay ingestion subscriber separates metadata from pixels, and the Session product model feeds
the existing browser event reducer without polling. Metadata shares the stream's credit window;
loaded-runtime QA must exercise saturation and reconnect as well as ordinary watching.
Rejected metadata is coalesced to its latest snapshot in the existing capture credit lifecycle
and replayed before recovered pixels. Resume and keyframe requests also refresh owner metadata.
Failed viewer input returns a nonterminal typed receipt, keeping healthy capture alive.

In unreleased 0.3 source, managed-browser viewport and DPR controls use the same controlling
viewer and control epoch as human input. The admitted viewer sizes the existing page with CDP;
unchanged geometry sends no additional CDP command. Other viewers consume that geometry and
fit the same picture rather than applying their own device emulation. This is viewer layout,
so it adds no agent viewport Action. The sidecar launch currently supplies no window-size
override; its initial numeric geometry must be observed on the running managed browser.

**Local managed-browser window prototype (unreleased 0.3).**

Managed Chromium uses `--remote-debugging-pipe` in both headless and window presentations.
The launch owner supplies child read fd 3 and write fd 4 (inherited handles on Windows);
the sidecar transport carries NUL-delimited CDP JSON over those descriptors. Automation,
screencast, diagnostics, recording and agents share that connection. No debugging port or
`/json/version` endpoint is opened. Missing pipes or a failed readiness handshake return
typed unavailable results without a TCP fallback. Stderr remains diagnostic input only.

The private `localWindow.showAsWindow(openViewCommand)` surface on the product sidecar
factory requests a window on the **execution Machine**, through the existing launch owner.
Ordinary Browser Actions continue to launch headless and stream. This prototype has no
published Action or UI control. It admits the daemon's own local graphical session once;
absent display, a non-GUI/SSH session, an unverifiable session and an unsupported platform
return typed unavailable reasons. It cannot open a remote Machine's window on the viewing device.

A running single-view Session restarts with the same profile directory and current HTTP(S)
URL. Multiple views, active input/commands and a conflicting profile return typed refusals.
The restart replaces the page target and CDP connection: cookies and persistent profile
storage remain, while page memory, form state and active capture subscriptions do not.
An already headful view is focused. The existing CDP automation, interactions and shared
screencast producer remain the owners; a viewer or recording must subscribe again after restart.
CDP page capture excludes Chromium's toolbar and extension toolbar popups. Persistent-profile
extension directories use the same launch flags in either presentation.

macOS managed launches also use `--use-mock-keychain` to avoid a login-Keychain
lookup during cookie encryption. This includes persistent managed profiles; see
the [at-rest protection trade-off](encryption.md#material-entrusted-to-a-shared-machine-unreleased-03).

The window is a separate Chromium top-level window, not a Tauri child. Windows
[SetParent](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent)
and X11 [XReparentWindow](https://www.x.org/archive/X11R7.5/doc/man/man3/XReparentWindow.3.html)
could support platform experiments, with style/DPI or window-manager integration work.
AppKit's [addSubview](https://developer.apple.com/documentation/appkit/nsview/addsubview(_:))
does not establish foreign-process window embedding. Wayland's
[xdg-shell protocol](https://raw.githubusercontent.com/wayland-mirror/wayland-protocols/main/stable/xdg-shell/xdg-shell.xml)
does not provide arbitrary foreign-window reparenting or absolute top-level placement.
Chromium's experimental [window-bounds CDP commands](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Browser.pdl)
can be investigated for best-effort adjacent positioning where the window system permits it;
there is no positioning or parenting integration in this prototype.

Real-window visibility, physical-click/agent interaction and extension toolbar-popup visibility
require GUI-host validation. Native clicks share the actual page, but do not currently produce
Happier's explicit Take control transition; shared page state is not control-arbitration proof.

The streamed human viewer consumes this same owner in 0.3 development source.
Managed Chromium runs as the Machine custodian. Protocol's browser Action role rule is
consumed by server admission and by Session control with the Session's private custody
role. Extension install/update/enable/disable/remove require Manage on both paths.
For Use guests, the shared execution-authorization mint admits Browser Session
operands only when the requester owns that Session or has effective shared access.
HTTP issuance and direct dispatch consume this same admission. Encrypted Action
envelopes project the non-content `browserSessionId`; the receiver binds it to the
sealed command before execution. Issued commands do not repeat Session authorization.
A requester without Manage can automate navigation only
to HTTP(S) or `about:blank`; other schemes return `access_denied`. Owner and Manage
Sessions retain their existing access. The managed source defaults to an ephemeral
profile per Session. Its profile-selection owner denies persistent profiles to non-Manage
requesters, including extension-page opens and reuse of an already-running persistent
profile. Owner and Manage opens can select persistent profiles, which may contain imported
cookies and passkeys. Session Actions cannot target another Session's managed workspace.
Direct navigation and external targets already require HTTP(S). Selector and chooser
uploads stage supplied bytes through the interaction owner, never a caller-selected
Machine path. Guests upload bytes they can read through their own execution identity.
`useBrowserStreamedSurfaceRuntime` projects interaction state and routes admitted
viewer input through the existing stream sideband; `BrowserPageInteractions`
presents page dialogs, file selection and download progress/Save. A page dialog
waits for an explicit human answer. File selection uses the viewing device's
picker, and Save transfers completed bytes to that device's existing file sink.
The focused input layer routes wheel and Ctrl/Cmd+C/X/V rather than typing their
letter keys; clipboard results return only to the originating viewer. Other
viewers fit the applied viewport without resizing the page. The phone viewer
offers Show keyboard for an editable target. Adopted popup events open workspace
Browser tabs using the existing exact daemon Session/view identity.

The Project right rail's built-in Browser destination defaults to More
(`rightSidebarBuiltinTabs.ts`); `ProjectRightPanelBrowserView` mounts the
workspace-scoped producer. Published usage lives in
[Session settings](../apps/docs/content/docs/sessions/session-settings.mdx#use-a-managed-browser).
These are current source paths, not evidence of a released or loaded build.

An editable-at-point probe returns only editable state, input mode, multiline and secret-field
hints to its originating human stream. It never returns a field value, name or label. The
mobile keyboard hook uses a hidden editable sentinel for committed text and backspace,
withholds IME candidates, and avoids sending the browser's final composition event twice.
The UI composition owns mounting that input and its keyboard affordance; mobile focus and
IME behavior still require the composed browser/device QA journey.

While an element action is active, controller state carries its action kind and an
`activeTarget`: centre `x/y` and width/height normalized to the visible page viewport. CDP and
the installed page collector use one Protocol rectangle projection. Its optional accessible
`label` uses the existing 512-character accessible-name convention and the Protocol automation
redaction owner; it never reads field values, typed input, or editable text. The presence capsule
uses it for labeled clicks and keeps generic narration when absent. In-app target progress is
collector/nonce/command-bound, not action completion. Settlement or takeover clears the target,
and a late callback cannot restore it. Semantic locator strings likewise have one Protocol
parser shared by daemon automation and transcript labels; CSS/test ids are not rendered as
human-readable target names. These remain development-source contracts.

Full `queryElements` Action results preserve all matching CSS elements and complete accessible
names; semantic locators retain their established first-match behavior with a complete name.
The daemon bridge and installed collector preserve complete query results and context snapshots.
Timeline projections retain the Protocol redaction/clipping owner. Full results still pass through that owner's security
redaction; query completeness does not weaken confidentiality admission or field-value exclusions.
This is a development-source contract; the composed live query journey remains to be validated.

## Browser context and model images (development)

Managed Chromium snapshots include current AX `value` text for editable text inputs, textareas and
contenteditable elements. Password and `autocomplete="one-time-code"` fields are excluded. DOM
metadata establishes field eligibility; values come from the accessibility tree. Missing metadata
omits the value and marks the AX projection incomplete, while preserving the structural snapshot.
Valid visible text, controls, selectors, accessible names and eligible values survive capture and
the strict snapshot reader without local count or text cutoffs. Incomplete extraction still sets
the corresponding truncation flag; malformed shapes and secret fields remain excluded. Empty
values remain explicit. `visibleText` remains the page's body text;
agents verifying typed input should also inspect `axNodes`. The daemon's capture owner masks
password, one-time-code and CSS `-webkit-text-security` values wherever they occur in visible
text, AX names/eligible values, control labels, page metadata or console summaries. Its Chromium
DOM/style census includes flattened shadow DOM and child documents; unreadable privacy metadata
or a changed sensitive-value census fails closed. A selector containing a secret is omitted and
the control list is marked incomplete rather than returning altered executable code. Snapshots
with sensitive fields retain useful text and structure but omit screenshot media. Ordinary-page
pixels are persisted only after the late census succeeds. Both daemon `snapshot` and
`semanticSnapshot` use this owner; an unavailable capture owner returns typed unavailable rather
than an unmasked text fallback. Confidential-input holds, owner authorization, sensitive-origin
and private-mode admission still apply. This is an unreleased 0.3 development contract.

Context capture checks Account ownership once at admission. The admitted finite capture
does not replay feature or permission decisions; late page probes still exclude secrets.
Eligible selections, summaries and full snapshots preserve their complete safe text through
capture, context items and attachments, without subordinate character budgets.

Diagnostics apply destination policy through Protocol's egress classifier. Nonce-bound
injected-page ingress validates and sanitizes external messages; the UI store and panels
consume admitted events without another sanitizer or retention/detail limit. The daemon
retains its 1,000-event per-view ring to bound long-lived memory; snapshots expose
any owner-level omission without a second wire collection ceiling. Diagnostics continue
to arrive through push.
The view subscription returns retained history on bootstrap or reconnect; subsequent
responses use its existing revision cursor and contain only events added or changed
after that cursor. Repeated equal events do not advance it.
Admitted owner-value capture preserves injected console, body, header, and storage text
without a separate 4,096-character cutoff. Existing transport boundaries and destination
redaction still apply. Reading a cloned response body does not delay the page's fetch response.

The unreleased 0.3 CDP mapper correlates request, response, completion and ExtraInfo
notifications in that existing per-view store, including redirect hops. It exposes
redacted URL structure, safe header bags, timing, encoded response bytes, cache/TLS
metadata and first-class failure text; it does not acquire bodies or cookie values.
Console primitive arguments, message text and structured exception source/stack
locations remain owner-only fields in the canonical destination classifier, including
for CDP fidelity. The same CDP transport reads the title at attachment and pushed
DOMContentLoaded notifications. Each publication reads the control adapter's current navigation
generation, so scoped snapshots and reconnects retain events from the current document. No second
connection or polling interval is used.

Current collector availability survives history eviction separately from content.
Snapshots report view-scoped history eviction and snapshot omission counts; actual
header clipping carries `redaction.truncated`. Client projections expose connection
failure and recovery without treating zero messages as unsupported. A failed daemon
connection marks its retained CDP data stale while independent local collectors stay
available. Iframe capability comes from actual collector installation/readiness and
publishes typed pending, available or unavailable reasons instead of empty panels.
Local filter, selection and copy APIs consume only this admitted projection.
The desktop native queue reports omitted envelopes at drain, including an oversized post
with no surviving messages. Its existing collector-degraded projection remains stale as
partial content arrives and recovers when the collector publishes availability again.

Owner-initiated eval and element picking have no automatic deadline or expression,
preview, or expansion-depth cutoff. The person can cancel an eval. CDP cancellation
requests termination in that runtime and can interrupt other concurrent evals or the
next script on the same target; an injected-page cancel discards a pending asynchronous result,
but cannot interrupt synchronous JavaScript that prevents the page from receiving the
cancel message. Cancellation does not roll back expression side effects or cancel
arbitrary page-owned asynchronous work. CDP marks termination experimental and defines
it for current or next execution ([official protocol](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json)); cancellation before issuing an eval only settles the invocation.
The unreleased 0.3 eval request/result schemas add cancellation and
remove the timeout field together with their callers; older closed-schema readers
cannot consume the new cancel variant. Ordinary eval requests without a timeout retain
their shape. This coordinated source change has no persistence migration.

The launch suggestion owner supplies detected-listener identity in
`sourceClass.inventoryEntryId`. Services Open, lifecycle controls, row/listener association and
daemon preview registration consume that projection; a launcher display id is not inventory
authority. Missing identity cannot register a detected preview or execute its lifecycle Action.

Isolated, host-origin local previews cooperate with the web pane through the authorized server
preview proxy. The pane supplies its collector identity; HTML navigation responses receive a
same-origin external loader running the shared `packages/peer-mediation/src/browser/collector/`
runtime. Readiness is admitted only from the exact iframe window and preview origin with the
current Session/view/generation/collector/nonce identity, then uses the existing UI automation
control service and reverse-dispatch path. Guest `pagehide` and a second document load retire that owner; it cannot
reuse an old readiness message. Ordinary preview requests, opaque path-mode frames and arbitrary
external sites do not gain collector access or a weaker sandbox.

Later iframe documents install the navigation-only reporter and bind to their exact parent pane
through `browser.collector.bind.request` / `browser.collector.bind`. The existing per-view identity
and nonce validate its reports and commands; shared preview admission cookies never choose a view.
Binding does not install the page automation owner in a later document.

The proxy preserves header and meta CSP policies. A restrictive script policy returns
`collector_blocked_by_csp`; when scripts cannot run, the parent obtains that decision through an
authorized, exact-origin metadata-only probe rather than reading or cloning the guest document.
HTML head admission and compression decoding are incremental; the HTML shell and body stream
without waiting for the upstream response to end.
These are current 0.3 development-source contracts, not loaded-runtime certification.

An agent's Session-owned Chromium profile is its browser workspace. Ephemeral
storage retention does not make it private browsing: its owning Session may
capture screenshots. Session-bound daemon Actions reject a different Session's
browser target. CDP captures use the snapshot privacy census before reading pixels or
writing media: password, one-time-code and CSS-masked fields include shadow and child
documents. AX value disclosure consumes the same census's node identities. Snapshot
URLs use the context URL redactor, which removes query values and fragments.
`sensitiveOrigin` and human private/incognito `ephemeralOnly` facts still block export.
`sensitiveFieldsPresent` continues to block standalone screenshot/context export; rich daemon
agent snapshots use the masking projection above. Missing or failed CDP privacy probes fail
closed. Linux sandbox setup and recovery are described in
[managed browser acquisition](./binary-runtime.md#managed-browser-acquisition-03-development).

Confidential Browser fill admits the person's private choice once at the Action continuation
owner. Material delivery and Browser preparation consume that admission without rechecking
`present_user`; the approval/current-field proof, Account and Home binding, observation hold,
and delivery-time document, origin and focused-field verification remain required. Native
`computer.secret.fill` is deferred beyond 0.3: its retained Protocol/catalog shape is unavailable
on all surfaces and has no daemon route or confidential target handler.

In development source, an input query can publish the exact confidential field identity while that
input is unfocused. At delivery, the Browser owner verifies that node, focuses it through isolated-world native DOM
bindings, and verifies the current document, origin, node and focus immediately before native input.
An unavailable focus or changed target refuses entry. Separate submit retains its own final proof
and does not reacquire field focus.

For confidential fill, the daemon's masked combined snapshot also carries the verified
focused-field descriptor: tab, frame, document, navigation generation, origin and field identity.
It uses the existing isolated-world field verifier; unavailable proof still refuses confidential
admission while the masked snapshot remains useful. Feature, Session policy and runtime admission
remain required, and an active confidential hold suppresses the whole snapshot, including this
descriptor. The former descriptor-only password-page projection is replaced by the same masked
snapshot used for ordinary agent observation. This is development source behavior;
the complete SavedSecret/Remember journey still needs validation on the loaded daemon.

Native desktop annotation and recording captures use the same source-owned,
presence-only password-field probe before reading pixels. Only an explicit
`false` probe result permits capture; missing, malformed or failed results deny
capture without registering media. The native view's existing navigation
generation and actual source lifetime are checked across asynchronous capture,
and annotation completion reconciles against the current context and upload
policy rather than restoring an old editor state. This does not introduce an
origin classifier: established privacy facts still use the Protocol export floor.

In development source, the browser-context composer producer writes selected facts into the Session's
canonical structured input; the Protocol admission reader still folds legacy `happierBrowserContext`
metadata into that envelope. Admission rejects stale selections, unavailable or owner-only context,
inline bytes and unsafe fields before persistence. The daemon still owns annotation grouping and
redaction; the prompt renderer treats the selected content as escaped data, not instructions.
Attaching an editor draft creates one composer card for the annotation group. The UI and daemon
share the Protocol structured-block projection, and the message carries every selected mark rather
than only the card's representative item.
Draft and single-capture page URLs use the existing Protocol URL-value redactor before storage,
so query values, fragments and token-shaped path segments are not carried into model context.

Screenshots and annotation crops remain durable references containing the actual Session scope,
storage location, path, SHA-256 and byte size. Desktop annotation capture succeeds only after the
existing Session attachment transfer stores its PNG. Daemon CDP capture uses `persistSessionMedia`.
Model delivery resolves those references through the Session's verified image reader; MCP returns
image content, ACP returns image blocks, and native Agent codecs consume the public `inputFiles`
service. Missing bytes, wrong scope and failed integrity checks are unavailable, never a successful
text-only screenshot. ACP and Codex reject unsupported image delivery; Claude's text-only terminal
transport rejects image input rather than silently dropping it. Claude SDK uses image content blocks.

These are development contracts, not release or loaded-runtime certification. The composed QA
journey must exercise desktop annotation attachment and MCP screenshot delivery in a real Session
with the loaded UI, daemon, Agent and model identified.

## How to read it

- **Available** describes an engine family's capability, not an installed collector on every page.
  In-app automation admission intersects the capability flags with the collector's actual declared
  actions. A missing owner or unsupported operation returns a typed failure, never a silent no-op.
- **Web frames require cooperation.** The host cannot inject a collector into an arbitrary
  cross-origin sandboxed iframe. A noncooperating external site is honestly unsupported for
  injected automation even when the `webIframe` engine family supports the operation. Native and
  desktop WebViews install their collector through their native engine; desktop additionally
  requires its actual native `supports.automation` fact to be true.
- **Desktop capture is a separate factual prerequisite.** The desktop scenarios below set native
  `supports.capture` to true; a host that does not advertise capture has no screenshot reference.
  Recording additionally requires the reverse-capture handler to be registered for that view's
  machine. Start resolves that producer through the live RPC registry, not a negative registration
  hint. The answering UI/native capture command validates actual platform support and the frame;
  a bound reverse transport alone cannot start a successful recording or produce an artifact.
  Neither capture flag registers a collector automation action.
- **Human navigation and diagnostics picking are separate paths.** The address bar and history
  use `browser.control`/`navigation.*`, and element picking uses the diagnostics bridge. Their
  availability does not register `navigate` or picker actions with the automation collector.
- **Availability is not the same as consent.** Every mutating verb is additionally gated by the
  action-approval danger floor (`packages/protocol/src/actions/danger.ts`).
- **Concurrency is single-flight, not a lease.** One mutating action runs per view; a second is
  refused with `automation_busy`. The `leaseId` field and the `lease_*` reason codes were removed on
  2026-08-23 — no code path could ever mint a lease, which made mutating verbs
  undispatchable. Do not reintroduce one.
- **Tamper-resistance differs by surface, and only for part of the operation.** A guest page can
  redefine the DOM APIs the injected-page runtime uses. The runtime treats a `dispatchEvent` that is
  missing or throws as a failure rather than reporting a false success, but a page that replaces
  `dispatchEvent` with a **silent no-op** cannot be caught from inside the page: any in-page oracle
  you would check the result with is subject to the same override. The daemon CDP path does not have
  that problem *at dispatch* — `click`, `type`, `press` and `scroll` synthesise input with
  `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText`
  (`apps/cli/src/daemon/browser/automation/adapters/controlBridge.ts:435-437,466,484-485,500`), which
  the browser delivers from outside the page realm where page script cannot patch it.

  **That immunity covers dispatch only — do not read it as end-to-end.** The same CDP path still
  *resolves* elements in-realm through `Runtime.evaluate` (`controlBridge.ts:275-276`); `click` and
  `scroll` locate their target by evaluating an element-centre expression in the page before
  dispatching to those coordinates. A hostile page can therefore still lie about **where** an element
  is, even though it cannot intercept the input event once sent. The daemon path is tamper-resistant
  where it dispatches and tamperable where it resolves.

  This is also the second reason the provisioning decision (DEC-13) matters. Installing the managed
  Chromium on first automation attempt is not only about lighting up an otherwise unreachable
  subsystem — it is what reaches the one automation surface whose input a hostile page cannot
  silently swallow.

<!-- BEGIN GENERATED: automation-verb-matrix -->
The protocol declares **31 action kinds** and **19 adapter capability kinds**. The table covers **10 engine capability scenarios**, not a fixed surface count.

### Surfaces

| Surface | Capability flags available | Disabled reasons reported |
|---|---|---|
| External URL · web (`webIframe`) | `snapshot`, `semanticSnapshot`, `locatorQuery`, `click`, `tap`, `type`, `press`, `scroll`, `hover`, `upload`, `drag`, `waitFor` | `browser_automation_eval_disabled`, `browser_recording_capture_adapter_missing`, `cross_origin_frame_unavailable`, `screenshot_reference_unavailable`, `trusted_input_unavailable`, `unsupported_action` |
| External URL · iOS/Android (`nativeWebView`) | `snapshot`, `semanticSnapshot`, `locatorQuery`, `click`, `tap`, `type`, `press`, `scroll`, `hover`, `upload`, `drag`, `waitFor` | `browser_automation_eval_disabled`, `browser_recording_capture_adapter_missing`, `cross_origin_frame_unavailable`, `screenshot_reference_unavailable`, `trusted_input_unavailable`, `unsupported_action` |
| External URL · desktop (`desktopWebView`) | `snapshot`, `semanticSnapshot`, `locatorQuery`, `click`, `tap`, `type`, `press`, `scroll`, `hover`, `upload`, `drag`, `waitFor`, `screenshotReference` | `browser_automation_eval_disabled`, `browser_recording_capture_adapter_missing`, `cross_origin_frame_unavailable`, `trusted_input_unavailable`, `unsupported_action` |
| External URL · desktop with reverse-capture handler | `snapshot`, `semanticSnapshot`, `locatorQuery`, `click`, `tap`, `type`, `press`, `scroll`, `hover`, `upload`, `drag`, `waitFor`, `screenshotReference`, `recording` | `browser_automation_eval_disabled`, `cross_origin_frame_unavailable`, `trusted_input_unavailable`, `unsupported_action` |
| Local service preview · web (`webIframe`) | `snapshot`, `semanticSnapshot`, `locatorQuery`, `click`, `tap`, `type`, `press`, `scroll`, `hover`, `upload`, `drag`, `waitFor` | `browser_automation_eval_disabled`, `browser_recording_capture_adapter_missing`, `cross_origin_frame_unavailable`, `screenshot_reference_unavailable`, `trusted_input_unavailable`, `unsupported_action` |
| Local service preview · native (`nativeWebView`) | `snapshot`, `semanticSnapshot`, `locatorQuery`, `click`, `tap`, `type`, `press`, `scroll`, `hover`, `upload`, `drag`, `waitFor` | `browser_automation_eval_disabled`, `browser_recording_capture_adapter_missing`, `cross_origin_frame_unavailable`, `screenshot_reference_unavailable`, `trusted_input_unavailable`, `unsupported_action` |
| Hosted plugin web view | _none_ | `hosted_plugin_automation_policy_unavailable` |
| Simulator preview | _none_ | `target_kind_unavailable` |
| Streamed browser surface (daemon-owned automation) | _none_ | `target_kind_unavailable` |
| Chromium sidecar stream (daemon-owned automation) | _none_ | `target_kind_unavailable` |

### Capabilities

| Capability | Available on | Reason where unavailable |
|---|---|---|
| `snapshot` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable` |
| `semanticSnapshot` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable` |
| `locatorQuery` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable` |
| `navigate` | **nowhere** | `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable`, `unsupported_action` |
| `click` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable` |
| `tap` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable` |
| `type` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable` |
| `press` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable` |
| `scroll` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable` |
| `hover` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable` |
| `upload` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable` |
| `drag` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable` |
| `waitFor` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable` |
| `evaluate` | **nowhere** | `browser_automation_eval_disabled`, `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable` |
| `elementPicker` | **nowhere** | `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable`, `unsupported_action` |
| `screenshotReference` | External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler | `hosted_plugin_automation_policy_unavailable`, `screenshot_reference_unavailable`, `target_kind_unavailable` |
| `recording` | External URL · desktop with reverse-capture handler | `browser_recording_capture_adapter_missing`, `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable` |
| `trustedInput` | **nowhere** | `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable`, `trusted_input_unavailable` |
| `crossOriginFrameAccess` | **nowhere** | `cross_origin_frame_unavailable`, `hosted_plugin_automation_policy_unavailable`, `target_kind_unavailable` |

### Action kinds and in-app injected dispatch

| Action kind | Installed collector capability | Engine scenarios advertising the injected operation |
|---|---|---|
| `getStatus` | _not registered_ | _none_ |
| `snapshot` | `snapshot` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) |
| `semanticSnapshot` | `semanticSnapshot` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) |
| `queryElements` | `locatorQuery` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) |
| `getDiagnosticsSummary` | _not registered_ | _none_ |
| `getActionTimeline` | _not registered_ | _none_ |
| `waitFor` | `waitFor` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) |
| `clipboardRead` | _not registered_ | _none_ |
| `download` | _not registered_ | _none_ |
| `getInteractionState` | _not registered_ | _none_ |
| `navigate` | _not registered_ | _none_ |
| `reload` | _not registered_ | _none_ |
| `goBack` | _not registered_ | _none_ |
| `goForward` | _not registered_ | _none_ |
| `click` | `click` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) |
| `tap` | `tap` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) |
| `type` | `type` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) |
| `press` | `press` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) |
| `scroll` | `scroll` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) |
| `hover` | `hover` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) |
| `focus` | `type` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) |
| `select` | _not registered_ | _none_ |
| `setValue` | `type` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) |
| `upload` | `upload` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) |
| `clipboardWrite` | _not registered_ | _none_ |
| `clipboardCut` | _not registered_ | _none_ |
| `answerDialog` | _not registered_ | _none_ |
| `drag` | `drag` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>External URL · desktop (`desktopWebView`)<br>External URL · desktop with reverse-capture handler<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) |
| `evaluate` | _not registered_ | _none_ |
| `startElementPicker` | _not registered_ | _none_ |
| `cancelElementPicker` | _not registered_ | _none_ |

Only actions declared by `INJECTED_PAGE_AUTOMATION_ACTIONS` enter the installed collector. Capability flags do not install that collector or prove that a particular page cooperates. Navigation commands use `browser.control` and `navigation.*`; diagnostics element picking uses the diagnostics bridge. Neither is an executable injected automation action. Screenshot references and recording have their own capture owners, not collector action kinds.
<!-- END GENERATED: automation-verb-matrix -->

## Notes the table cannot carry

- **The development daemon sidecar is session-scoped and headless.** `browser.view.open` and
  automation both use the existing managed-browser provisioning owner. Each real Happier session
  receives its own Chromium process and ephemeral profile; the existing profile store waits for
  process settlement before deleting that profile. Screenshots retain the same Happier session
  identity. This is separate from the in-app collector availability described by the table.
- **Managed Chromium provenance is platform-specific.** Linux ARM64 uses its own immutable
  version pin; the other platform pins are unchanged. Installation, detection and provenance
  resolve that version through the same
  [protocol descriptor](../packages/protocol/src/browser/sidecar/chromiumForTesting.ts), and the
  pinned archive digest is verified before unpacking. No system-browser fallback is added.
- **The CDP transport accepts the containing operation's cancellation and deadline.** It does
  not impose a separate five-second command deadline or one-MiB JSON-message ceiling. A large
  screenshot or browser event therefore does not invalidate unrelated pending commands.
- **Agent results and timeline summaries are different projections.** Agent results preserve
  useful valid data under the shared privacy floor; timeline summaries remain compact. Selectors
  are never shortened into different selectors, and omitted data is reported as incomplete.
  The UI controller projects the settled injected result through the same Protocol full-result
  redactor as the daemon; agent output is not reconstructed from timeline entries. Collector queries
  return all matches rather than silently slicing to 25. Forbidden keys remain rejected at the
  injected wire boundary, and unsafe URL values remain redacted from returned Action data.
- **`upload` is content-supplied, not path-supplied.** The injected page runtime builds a `File`
  from the payload (`files: [{ name, mimeType, text, base64? }]`) and assigns it to the input's
  `files`. A page cannot read a host filesystem path, so there is no "upload this local file" verb.
  The content field is named `text` because the egress redactor reduces that key to a length —
  uploaded bytes can never reach a timeline.
- **Daemon uploads use the same content descriptors**, materialized into view-owned temporary
  files and supplied through CDP's native file-input operation. Temporary files remain until
  the view closes because Chromium reads them on later form submission. Unlike an injected
  `File`, Chromium infers their MIME type from the name.
  In unreleased 0.3 source, an intercepted chooser can instead be answered with
  `{ chooserId, files: [{ name, dataBase64 }] }`. The chooser must still belong to that live view;
  callers supply bytes rather than paths on the daemon's Machine.
  A host file dropped on the streamed managed viewer uses the same upload staging
  owner and descriptors, with a page-coordinate target instead of a chooser id.
  The viewer consumes the host drop to prevent outer-page navigation; the existing
  input epoch and control admission govern delivery. CDP dispatches the staged
  files through the page's dragEnter/dragOver/drop lifecycle, retaining them until
  the view closes just like chooser uploads.
  This adds `fileDrop` to the unreleased closed Browser input union: Protocol,
  viewer and daemon reload together because older development readers reject
  the new kind. No released wire epoch, stored format, capability gate or
  predecessor adapter changes; the inspected `../0.2` frontier at
  `b825a99dfedcb68e223155a1ba0be84babe9e2d0` has no corresponding Browser input path.
- **Managed interaction Actions share the viewer's owner.** `clipboardRead` returns selected
  non-password text; `clipboardWrite` inserts text into the focused page. In unreleased 0.3
  source, `clipboardCut` returns the same permitted selection and deletes it only when editable,
  through the existing mutating-Action admission. The controlling viewer routes Cmd/Ctrl+C/X/V
  through these operations. `getInteractionState`
  reads pending dialog/chooser and download progress. `answerDialog` answers the pending
  `dialogId`. `download` retrieves a known completed download using explicit `downloadId`,
  `offset` and `byteLength`; it never accepts an arbitrary host path. Clipboard reads, uploads
  and downloads default to approval through the existing Action policy. Clipboard and download
  bytes use typed `interactionResult` responses and stay out of timelines. Download files stay
  private until the sidecar closes; closing a view removes its lookup and listeners, while
  already admitted downloads may finish. Setup failures appear in `interactionState.unavailable`.
  `browser.view.list` exposes the existing Session view list so agents can discover adopted
  popup tabs and use the existing focus/close Actions. These are managed
  Chromium development contracts, not support claims for injected engines or released clients.
  The product source delegates these operations and interaction notifications to the
  selected Session's existing sidecar interaction owner, preserving its CDP view bindings.
  The streamed capture takes keyboard focus on pointer input. Wheel input uses the existing
  browser-input contract with content-relative coordinates and pixel deltas; modifier chords
  preserve their modifier set instead of inserting the shortcut's letter. At the CDP boundary,
  letters, digits and named navigation keys also carry their virtual key code so Chromium's
  native editor can perform selection and shortcuts.
  Viewer Save dispatches `files.save` with `source.kind: 'browserDownload'` and the exact
  Machine/BrowserSession/view/download reference. The admitted answering-client owner
  retrieves completed binary ranges into the existing web/native download sink;
  the content codec supplies the negotiated frame budget, including encrypted-envelope overhead.
  Startup, recovery and incremental browser metadata use that same payload allowance.
  A metadata envelope that cannot fit ends capture with `max_frame_bytes_exceeded`;
  download ranges page the binary content within the remaining envelope space.
  Adopted popup discovery preserves the daemon Session/view tuple and opener relationship
  for the existing workspace details-tab opener, including after navigation or rediscovery.
  A terminal `capture_source_unavailable` receipt refreshes discovery once: removal of a previously discovered view
  follows the existing workspace tab-close path, which restores the previous tab. A view
  still listed without capture, or a failed discovery request, keeps its tab for recovery.
- **Managed snapshots share one privacy census.** Ordinary and semantic snapshots
  use the same CDP masking parser. Chromium's root `#document` layout row can have
  no computed style; that row is accepted without weakening required element-style
  data or password and CSS masking.
- **Injected `drag` synthesises the HTML5 drag sequence** (`dragstart`/`dragenter`/`dragover`/`drop`/`dragend`)
  with a real `DataTransfer`. Drag implementations built on raw pointer events rather than HTML5
  drag-and-drop will not respond; that is the same best-effort class as synthetic `click`.
- **Daemon `drag` uses native pointer input** between the resolved source and destination. It
  does not fabricate an HTML5 `DataTransfer` or claim identical behavior to the injected collector.
- **JavaScript dialogs default to dismissal** while an agent automation action runs (`alert` → dismissed,
  `confirm` → `false`, `prompt` → `null`). In 0.3 development source, managed Chromium also accepts
  one explicit `dialogResponse` on the same Browser Action: `{ kind: 'confirm', message: 'Continue?',
  accept: true }`, or `{ kind: 'prompt', message: 'Your name?', accept: true, promptText: 'Alice' }`.
  The kind and full message must match exactly; an unrelated or subsequent dialog is dismissed.
  Include this response when requesting approval for the action that opens the dialog. It shares
  that action's approval and deadline, without keeping a dialog pending across Actions. Plugins
  use the same Browser Action input through `@happier-dev/plugin-ui`'s ordinary Action API.
  Human viewer input without an explicit response leaves the managed page's dialog pending.
  Its existing private interaction state supplies the streamed answer controls, and the human's
  answer returns through the admitted viewer input relay and `answerDialog` owner.
  An exact pending-dialog reply continues the admitted interaction outside the ordinary input
  queue: Chromium cannot acknowledge the triggering click until this reply arrives. The reply
  keeps the same view/epoch admission and pending-dialog identity validation; it does not take
  over input or replace the active click's controller state.
  Managed results report `resultSummary.javascriptDialogs` with `count`, `kinds`, aggregate
  `handling` (`accepted`, `dismissed` or `mixed`), and `dialogs` containing each question's `kind`,
  `message` and `handling`. These messages are untrusted page content and use the existing
  result/timeline redactor. Prompt defaults and submitted answers are not included. UI injected
  engines retain automatic dismissal and refuse an explicit response as `unsupported_action`
  before executing the action; they do not claim to have answered it. Their original dialog
  functions are restored when the command returns, so dialogs outside an action behave normally.
- **Picked elements carry `componentName` and `sourceLocation`** where the engine can resolve them
  from React fiber metadata, so an attached element points at the edit site and not only the
  selector. Both are absent on non-React pages and production builds.
- **`trustedInput` is available nowhere.** Every synthetic event the injected runtime dispatches is
  untrusted (`isTrusted: false`). Pages that gate on trusted input will not respond, and the result
  says so rather than reporting a false success.
- **`evaluate`, `startElementPicker` and `cancelElementPicker` are `not_implemented`** at the daemon
  service regardless of surface. The element-picker capability that *is* live is the diagnostics
  family (`browser.diagnostics.elementPicker.start` / `.cancel`), which is wired end to end.

## Related

- `docs/browser-recording-capture-matrix.md` — the recording half of the same question.
