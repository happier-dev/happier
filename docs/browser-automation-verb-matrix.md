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

The daemon automation service is the controller authority for sidecar/streamed views; in-app
engines use the UI automation control service. Human input takes control even when no action is
running, and that hold lasts until explicit handback through the existing presence/input controls.
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

In development source, daemon automation Actions targeting a mounted UI view use the existing authenticated
machine reverse RPC, addressed by `browserSessionId` and `viewId` and bound to the invoking Happier
Session. The mounted pane's Session context is the binding authority; slot-derived Browser Session
ids need not equal Happier Session ids. Another Session on the same machine cannot use that pane.
The daemon control broker's
registered adapters decide physical ownership; UI-owned or disconnected UI targets never start
Chromium provisioning. The UI handler delegates to the same mounted controller, preserving the
host-stamped cancellation authority: absent or non-`present_user` authority returns `owner_mismatch`.
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
including same-URL reloads. URL/title/loading and controller events feed the existing browser event
reducer; command success is not evidence of a document commit. This is unreleased 0.3 behavior, not
a claim that the composed stream journey has been live-verified.

In current 0.3 development source, the normal browser selector admits daemon-backed streamed
views for display and navigation. Session surfaces discover registered capture sources through
Session-filtered daemon discovery before a view is mounted, then refresh that projection when a
browser Action completes in the Session transcript. Watch resolves the exact named daemon view's
capture source, rather than reopening the Action's URL. Opened-view metadata and command results
feed the existing control reducer. There is no independent daemon-open push outside this Session
Action/transcript flow: an out-of-band open is discovered on the next surface mount or browser
Action completion. The engine capability table below describes local automation producers;
streamed rendering does not turn the viewer into a second automation owner.

Session browser presence uses that same daemon control route for `takeControl` and `handBack`.
The owner-scoped machine RPC stamps present-user authority; commands cannot supply their own
authority. Hand-back preserves input drain and requires a fresh successful snapshot before the
agent resumes mutations. In-app presence delegates to its existing UI control service.
Agent `browser.control.takeControl` and `browser.control.handBack` Actions use the same view-addressed
reverse route for mounted UI panes, with the existing Session binding and approval floor. The UI
command owner delegates to that pane's control service, not a fallback controller. Handback during
input settlement returns a retryable `permission_denied` command result rather than claiming success.

Browser Action admission derives input requester authority from the trusted host context:
`present_user` is human input and every other authority is agent input. A caller-supplied
`requestedBy: 'user'` without that authority is rejected. Authenticated stream viewer input
continues to enter through the human takeover owner. An uncertain stop stays visibly uncertain;
human input remains possible, and a fresh settled observation after takeover clears uncertainty
before handback. Native computer input shares this recovery owner.

Live browser events travel as strict metadata batches on the watched view's existing encrypted
frame transport. Each batch projects current engine navigation and automation controller state
from their owners, so the stream's latest-startup-observation projection retains both. The single
relay ingestion subscriber separates metadata from pixels, and the Session product model feeds
the existing browser event reducer without polling. Metadata shares the stream's credit window;
loaded-runtime QA must exercise saturation and reconnect as well as ordinary watching.
Rejected metadata is coalesced to its latest snapshot in the existing capture credit lifecycle
and replayed before recovered pixels. Resume and keyframe requests also refresh owner metadata.
Failed viewer input returns a nonterminal typed receipt, keeping healthy capture alive.

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

## Browser context and model images (development)

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

The proxy preserves header and meta CSP policies. A restrictive script policy returns
`collector_blocked_by_csp`; when scripts cannot run, the parent obtains that decision through an
authorized, exact-origin metadata-only probe rather than reading or cloning the guest document.
These are current 0.3 development-source contracts, not loaded-runtime certification.

An agent's Session-owned Chromium profile is its browser workspace. Ephemeral
storage retention does not make it private browsing: its owning Session may
capture screenshots. Session-bound daemon Actions reject a different Session's
browser target. Capture probes password-field presence before reading pixels or
writing media and uses the same Protocol privacy decision as UI context.
`sensitiveOrigin`, `sensitiveFieldsPresent`, and human private/incognito
`ephemeralOnly` facts still block export; missing or failed CDP privacy probes fail
closed. Linux sandbox setup and recovery are described in
[managed browser acquisition](./binary-runtime.md#managed-browser-acquisition-03-development).

Selected browser context is normalized once from `happierBrowserContext` into the Session's
canonical structured input. Admission rejects stale selections, unavailable or owner-only context,
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
  machine. Neither capture flag registers a collector automation action.
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
The protocol declares **25 action kinds** and **19 adapter capability kinds**. The table covers **10 engine capability scenarios**, not a fixed surface count.

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
- **Daemon uploads use the same content descriptors**, materialized into request-owned temporary
  files and supplied through CDP's native file-input operation. Temporary files are removed when
  the request finishes. Unlike an injected `File`, Chromium infers their MIME type from the name.
- **Injected `drag` synthesises the HTML5 drag sequence** (`dragstart`/`dragenter`/`dragover`/`drop`/`dragend`)
  with a real `DataTransfer`. Drag implementations built on raw pointer events rather than HTML5
  drag-and-drop will not respond; that is the same best-effort class as synthetic `click`.
- **Daemon `drag` uses native pointer input** between the resolved source and destination. It
  does not fabricate an HTML5 `DataTransfer` or claim identical behavior to the injected collector.
- **JavaScript dialogs are auto-dismissed** while an automation action runs (`alert` → dismissed,
  `confirm` → `false`, `prompt` → `null`), and the action result reports
  `resultSummary.javascriptDialogs` (`{ count, kinds, handling: 'dismissed' }`). Before this, a
  modal blocked the page thread and the action simply timed out with no explanation. Dialog text is
  page content and never egresses. The originals are restored when the command returns, so a
  page-driven dialog outside an automation action behaves normally.
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
