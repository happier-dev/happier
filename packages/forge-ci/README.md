# Forge CI

Shared CI reads and evidence for Project Actions, Session CI and Actions-backed
PR checks. This package is **0.3 development-source Developer Preview**. Registry
publication requires separate release-owner approval.

Import pure adapter, read controller, branch counts and evidence builders from
`@happier-dev/forge-ci/runtime`; controlled mounted hooks and presentation models
from `/ui`; translation contributions from `/translations`. Native forge plugins
bind ordinary Actions through `createForgeCiAdapterV1`. The runtime owns no
credentials, HTTP client, Session launcher or remote-effect policy.

Read invocations preserve canonical SDK `PluginError` refusal codes, including
the native diagnostic behind a broad host refusal. CI and Releases use the same
`forgeCiInvocationFailureV1(error, fallbackCode)` projection; it retains no raw
message, diagnostic details or private payload. Unrecognized exceptions keep
the caller's generic fallback. This read projection does not establish whether
a write or download happened: their uncertain outcomes remain explicit and
are never replayed automatically.

Mounted consumers pass their existing `RenderContext.signal` to
`useForgeCiReadsV1`. Same-origin peers within the same admitted invocation scope
share the host's execution-bound value,
while each query borrows its own mount's Action transport. Leaving a mount
releases its demand; the final mount releases the shared controller. An older
in-process scope without `acquireExecutionBound` is unavailable. Hosted frames
without a sharing scope use a local controller and make no cross-frame sharing
claim. Execution-origin sharing does not itself establish credential equivalence;
the invoking domain must supply its credential admission and invalidation.

For credential-scoped reads, pass the exact declared Action/input/purpose as
`readAuthority` to `useForgeCiReadsV1`. The hook admits the host's content-free
authority watch before loading. Withdrawal closes the watch without cancelling
an admitted finite read, discarding its result or reacquiring the shared value.
Each later Action request is admitted independently. A refused watch stays
unavailable without automatic retries; sharing does not require a retirement API.
GitHub's mounted binding supplies its existing declared Connected Account
purpose, including native-fallback currentness; display Account labels do not
qualify credential authority.

CI schemas and public conformance vectors live in the existing protocol-only
package at `@happier-dev/triage-protocol/ci/v1` and `/ci/testing/v1`.
Use the managed plugin-authoring workflow documented by the SDK to consume the
host's supported package closure.

For a presented collection or log window, use `reads.acquirePaged(...)` or
`useForgeCiPagedQueryV1(...)`. The returned lease keeps the ordinary value and
status subscriptions and adds `loadMore()`: another cursor is read only when
the caller requests it. Release the lease when its mounted interval ends.
Preserve a non-null continuation as incomplete coverage even when the provider
reports no separate `incomplete` reason. Later-page failures retain admitted
facts and their continuation for deliberate recovery; a failed Refresh does
not discard the loaded walk. The shared headless run, workflow and job surfaces
expose these same leases for their controls to consume.
Continuation represents unread pages; `incomplete` records a stopped walk,
such as an invalid follow-up or provider ceiling, and is not cleared merely
because another admitted page has no continuation.

For a selected workflow, `useForgeCiRunWorkflowV1` supplies the ref-specific
definition, reconciled form draft, dispatch and `{input,result}` receipt used by
`ForgeCiRunWorkflowForm`. An accepted receipt without a native run does not
identify a run to open. Repository environment choices are requested only when
the selected definition needs them; `environmentsQuery.loadMore()` admits
another page, and `environmentsStatus` exposes failure and explicit refresh.
Use those existing controls rather than crawling all environments or keeping
a second options collection. The controller does not choose a UI page cap.

Mounted tail selection requests the exact native tail when its evidence is not
already complete. The CI mounted adapter maps All to `setTailLines` with
`lines: null`; a tail requires a positive integer, so zero stays rejected.
A complete retained index instead borrows the same source
lease without another native read or index build. `useForgeCiLogViewerV1` exposes
the selected original `lines` while Find keeps the whole admitted index. During
a same-job query replacement, the headless job surface keeps the canonical
retained index visible; ambiguous log identities, another job or retired
authority never supply that fallback. The pending query and retained index's
coverage remain separate facts.
Released job bodies and their indexes retire after the last mounted demand,
at the end of the current effect turn. A same-turn same-job lease replacement
keeps tail and Find continuity; reopening a job after demand ends reads it again.
Use the log paged lease's `indexLog(steps?)` to index its window: that owner also
records its actual first-page observation. A changed observation/cursor cannot
reuse a completed old suffix merely because the first visible bytes match.

In the current Developer Preview, `listRuns`, `readRun`, `listJobs` and `readJob`
successes (including `notModified`) may carry provider-derived `refreshAfterMs`.
The read owner schedules eligible mounted demand from that timing; omission
leaves refresh manual. Adapters no longer supply a fixed poll interval. GitHub
uses its existing read-cadence owner for REST budget and provider timing facts.
Update the producer and consumer together: earlier closed result schemas reject
the new optional field. No persisted data changes.

Native hosts reuse that same index and Find model without a fabricated CI job
or plugin surface. In this Developer Preview, `buildLogIndexV1` from `/runtime`
accepts one already-admitted observation; `useLogViewerV1` from `/ui` accepts
explicit activity and the host's existing controlled `LogViewV1` port:

```ts
const index = buildLogIndexV1({
  sourceKey, // The canonical Resource key, scoped to the exact Account lifetime.
  positionBasis: 'page',
  log: { logId: page.sourceRevision, text: page.text, startLine: 1, startByte: 0,
    complete: false, continuation: page.nextCursor },
});
const viewer = useLogViewerV1({ index, active, view, surfaceId,
  containsFocus, isInputFocused });
// Register viewer.findRegistration with the native host's existing Find owner.
```

`all`, `excerpt` and `tail` select only admitted lines. Find searches that same
admitted index and reveals a match through the controlled selection. Native
`page` coordinates are page-relative, not native original line/byte positions;
even a final page with no cursor reports loaded, never complete-source,
coverage. The model neither retains a page history nor advances or decodes a
cursor. Resource admission, Account lifetime, refresh, follow/pause and source
changes remain with the caller's canonical Resource owner. CI's existing
wrappers retain original source positions and job/step attribution.

Failure-context reads retain exact selection and missing, ambiguous and omitted
evidence facts. `excerpt` selects step/context/tail evidence;
`maxSerializedBytes` belongs to the caller's prompt or transport owner. The
summary must also fit the canonical external-Action response carrier. The
builder returns data only, never a prompt or a Session send.

When a consumer has no excerpt or body-budget choice, use the producer-owned
`createForgeCiFailureContextReadRequestV1({ repository, selection, jobs? })`
from `/runtime`, then pass its result to `adapter.readFailureContext(...)`.
It supplies the required wire operands: failed/unknown-step evidence with no
added context or tail ranges, and the canonical Action carrier ceiling.
Explicit `excerpt` and `maxSerializedBytes` options are preserved unchanged;
the builder fits both the summary-body budget and the complete Action carrier,
including producer-observed missing evidence, and names the boundary that
actually caused any omission.

## Mounting the visible CI views

In this 0.3 development-source Developer Preview, `/ui` exports visible views
as well as headless controllers. Mount them inside a `defineUiSurface` tree
from `@happier-dev/plugin-ui`, so the existing host, theme, translation and
surface-activity providers surround every hook and control. Add this package's
`/translations` contribution to your plugin's translations. Do not install a
second Plugin UI provider around a nested CI view.

Build one `ForgeCiBindingV1` for the admitted repository and invocation scope.
Its `reads` comes from `useForgeCiReadsV1`; its `adapter` invokes your declared
Actions through `createForgeCiAdapterV1`. Supply the operation-indexed
`actionRefs`, forge/repository labels in `about`, and the admitted Connected
Account in `account` (or `null` when unavailable). An optional `fix` callback
hands selected failure evidence to your existing configured Session handoff.
The binding carries no credentials and does not select a second Account.

For an already selected run, use the shared detail with the mount's controlled
model. Here `ci`, `view` and `selection` are the existing binding and mounted
selection, and `state` comes from `useForgeCiMountedViewStateV1(view)`:

```tsx
import { ForgeCiRunDetailView } from '@happier-dev/forge-ci/ui';

<ForgeCiRunDetailView
  ci={ci}
  selection={selection}
  presentation="embedded"
  view={view}
  selectedJobId={state?.job?.jobId ?? null}
  onOpenJob={job => {
    void view?.invoke({ mountId: view.mountId, operation: { kind: 'selectJob', job } });
  }}
  onOpenSummary={() => view?.openSummary()}
/>
```

Choose `embedded` for a PR Checks body, `pane` for a narrow details pane or
phone route, or `page` for a full page; `page` also requires the host's declared
`pageKind`. The caller owns navigation through `onOpenJob`, `onOpenSummary`,
`onSelectAttempt` and optional `back`. For a pane whose header already carries
the run identity, use `useForgeCiRunPaneHeaderV1` and `identity="host"`.
`ForgeCiJobPanel` renders a standalone job with the same `ci` and `view`, a
host-owned Find `surfaceId` and `page`/`pane` presentation. Pass `admittedJob`
when the run already supplied its job projection.

Create the model with `useForgeCiMountedViewV1` using the host's `mountId`,
surface `signal`, phone placement and initial selection. Register that returned
model with your existing mounted Action owner, and publish its operandless
commands there; the hook does not register an Action. Route UI navigation and
presentation changes through that same model's `invoke({ mountId, operation })`.
Use `canApply` and `applyOperation` for the operations this particular view can
serve and for host navigation. The model becomes unavailable outside its active
mount. It owns presentation intent, not provider writes or Session delivery.

`ForgeCiRailPanel` consumes accepted checkout `context` and the exact HEAD's
`headRuns`; `branchRuns` supplies earlier pushes separately.
`ForgeCiOverviewGlance` consumes the default branch's runs and can include a
release glance. Both take explicit failure, observation time, retry and open-run
callbacks, so retain the read owner's unavailable and incomplete states.
`ForgeCiRunRow`, `ForgeCiJobRow`, `ForgeCiStateNotice` and
`ForgeCiElapsedText` are the same presentation leaves for custom composition.

Provider effects keep their declared Action confirmation and approval policy.
`useForgeCiMutationV1` serializes a view's mutation and asks the shared reads
owner to complete its readback; uncertain outcomes remain visible without
automatic replay. `useForgeCiDownloadV1` uses the host download path and
`ForgeCiDownloadNotice` presents the result. `ForgeCiRunWorkflowForm` uses
`useForgeCiRunWorkflowV1`; when a workflow detail already owns that controller,
pass it as `controller` to share the ref, draft and dispatch receipt. Its
`onStarted` runs only for an exact provider-returned run ID. An accepted dispatch
without a run remains accepted, and a lost answer remains unknown. Use
`ForgeCiTriggerFields` for the same declared input fields in custom forms.

## Evolving the ABI

The Forge CI domain owns this package. Explicit V1 protocol identities and
validated serialized values define interoperability; package-copy object
identity does not. Follow the canonical
[SDK protocol-evolution doctrine](../../docs/compatibility.md#sdk-protocol-evolution).
The runtime and UI package version is independent of the CI wire epoch.
