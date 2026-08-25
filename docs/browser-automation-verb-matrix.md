# Browser automation — surface × verb matrix

The browser automation protocol declares **21 action kinds** and **19 adapter capability kinds**.
Far fewer are live on any given surface, and until this page existed the only way for an agent to
find out was to dispatch a verb and read the failure. This is the canonical answer to "which
automation verbs actually work, where".

**The table below is generated, not written.** `apps/ui/sources/sync/domains/browser/adapters/automationVerbMatrix.closure.test.ts`
renders it directly from `buildBrowserAdapterCapabilities`
(`apps/ui/sources/sync/domains/browser/adapters/capabilities.ts`) and fails when the committed bytes
drift from what that builder produces. There is deliberately no second, hand-maintained table.
When the capability builder legitimately changes the answer, regenerate this section rather than
hand-patching it:

```
cd apps/ui
UPDATE_AUTOMATION_VERB_MATRIX=1 vitest run --config vitest.config.ts \
  sources/sync/domains/browser/adapters/automationVerbMatrix.closure.test.ts
```

## How to read it

- **Available** means the capability builder reports `available: true` for that surface. It is the
  host's advertisement, and the daemon/UI dispatch path honours it.
- A verb that is *not* available still parses and still dispatches — it comes back as a typed
  failure carrying the reason code in the third column, never a silent no-op.
- **Availability is not the same as consent.** Every mutating verb is additionally gated by the
  action-approval danger floor (`packages/protocol/src/actions/danger.ts`).
- **Concurrency is single-flight, not a lease.** One mutating action runs per view; a second is
  refused with `automation_busy`. The `leaseId` field and the `lease_*` reason codes were removed on
  2026-08-23 — no code path could ever mint a lease, which made all 13 mutating verbs
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
### Surfaces

| Surface | Automation verbs available | Disabled reasons reported |
|---|---|---|
| External URL · web (`webIframe`) | `snapshot`, `semanticSnapshot`, `locatorQuery`, `navigate`, `click`, `tap`, `type`, `press`, `scroll`, `hover`, `upload`, `drag`, `waitFor`, `elementPicker` | `browser_automation_eval_disabled`, `browser_recording_capture_adapter_missing`, `cross_origin_frame_unavailable`, `screenshot_reference_unavailable`, `trusted_input_unavailable` |
| External URL · iOS/Android (`nativeWebView`) | `snapshot`, `semanticSnapshot`, `locatorQuery`, `navigate`, `click`, `tap`, `type`, `press`, `scroll`, `hover`, `upload`, `drag`, `waitFor`, `elementPicker` | `browser_automation_eval_disabled`, `browser_recording_capture_adapter_missing`, `cross_origin_frame_unavailable`, `screenshot_reference_unavailable`, `trusted_input_unavailable` |
| External URL · desktop (`desktopWebView`) | `screenshotReference` | `browser_recording_capture_adapter_missing`, `desktop_webview_automation_unavailable` |
| Local service preview · web (`webIframe`) | `snapshot`, `semanticSnapshot`, `locatorQuery`, `navigate`, `click`, `tap`, `type`, `press`, `scroll`, `hover`, `upload`, `drag`, `waitFor`, `elementPicker` | `browser_automation_eval_disabled`, `browser_recording_capture_adapter_missing`, `cross_origin_frame_unavailable`, `screenshot_reference_unavailable`, `trusted_input_unavailable` |
| Local service preview · native (`nativeWebView`) | `snapshot`, `semanticSnapshot`, `locatorQuery`, `navigate`, `click`, `tap`, `type`, `press`, `scroll`, `hover`, `upload`, `drag`, `waitFor`, `elementPicker` | `browser_automation_eval_disabled`, `browser_recording_capture_adapter_missing`, `cross_origin_frame_unavailable`, `screenshot_reference_unavailable`, `trusted_input_unavailable` |
| Hosted plugin web view | _none_ | `hosted_plugin_automation_policy_unavailable` |
| Simulator preview | _none_ | `target_kind_unavailable` |
| Streamed browser surface (contracted, fail-closed) | _none_ | `streamed_browser_unavailable` |
| Chromium sidecar (no UI-reachable runtime) | _none_ | `sidecar_runtime_unavailable` |

### Capabilities

| Capability | Available on | Reason where unavailable |
|---|---|---|
| `snapshot` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `desktop_webview_automation_unavailable`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |
| `semanticSnapshot` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `desktop_webview_automation_unavailable`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |
| `locatorQuery` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `desktop_webview_automation_unavailable`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |
| `navigate` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `desktop_webview_automation_unavailable`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |
| `click` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `desktop_webview_automation_unavailable`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |
| `tap` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `desktop_webview_automation_unavailable`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |
| `type` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `desktop_webview_automation_unavailable`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |
| `press` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `desktop_webview_automation_unavailable`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |
| `scroll` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `desktop_webview_automation_unavailable`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |
| `hover` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `desktop_webview_automation_unavailable`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |
| `upload` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `desktop_webview_automation_unavailable`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |
| `drag` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `desktop_webview_automation_unavailable`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |
| `waitFor` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `desktop_webview_automation_unavailable`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |
| `evaluate` | **nowhere** | `browser_automation_eval_disabled`, `desktop_webview_automation_unavailable`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |
| `elementPicker` | External URL · web (`webIframe`)<br>External URL · iOS/Android (`nativeWebView`)<br>Local service preview · web (`webIframe`)<br>Local service preview · native (`nativeWebView`) | `desktop_webview_automation_unavailable`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |
| `screenshotReference` | External URL · desktop (`desktopWebView`) | `hosted_plugin_automation_policy_unavailable`, `screenshot_reference_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |
| `recording` | **nowhere** | `browser_recording_capture_adapter_missing`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |
| `trustedInput` | **nowhere** | `desktop_webview_automation_unavailable`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable`, `trusted_input_unavailable` |
| `crossOriginFrameAccess` | **nowhere** | `cross_origin_frame_unavailable`, `desktop_webview_automation_unavailable`, `hosted_plugin_automation_policy_unavailable`, `sidecar_runtime_unavailable`, `streamed_browser_unavailable`, `target_kind_unavailable` |

Action kinds with no capability bit of their own: `getStatus`, `queryElements`, `getDiagnosticsSummary`, `getActionTimeline`, `reload`, `goBack`, `goForward`, `focus`, `select`, `setValue`, `startElementPicker`, `cancelElementPicker`. They ride the surface's general synthetic-input path — navigation kinds are gated by `navigation.*` instead, and the rest resolve with the same injected-page runtime that backs `click`.
<!-- END GENERATED: automation-verb-matrix -->

## Notes the table cannot carry

- **`upload` is content-supplied, not path-supplied.** The injected page runtime builds a `File`
  from the payload (`files: [{ name, mimeType, text, base64? }]`) and assigns it to the input's
  `files`. A page cannot read a host filesystem path, so there is no "upload this local file" verb.
  The content field is named `text` because the egress redactor reduces that key to a length —
  uploaded bytes can never reach a timeline.
- **`drag` synthesises the HTML5 drag sequence** (`dragstart`/`dragenter`/`dragover`/`drop`/`dragend`)
  with a real `DataTransfer`. Drag implementations built on raw pointer events rather than HTML5
  drag-and-drop will not respond; that is the same best-effort class as synthetic `click`.
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
