# `@happier-dev/triage-sources`

Shared Triage source runtime, authorization and UI helpers for plugins that
contribute to PRs & Issues. Source declarations and schemas belong to
`@happier-dev/triage-protocol/v1`; provider clients and credentials remain with
the contributing plugin.

In 0.3 development / Developer Preview authoring, declare this package at
`0.0.0` alongside the Plugin SDK, Plugin UI and Triage protocol. Happier's public
authoring commands prepare those packages through the managed toolchain.
Import detail helpers such as `useTriageDetailRequest` from
`@happier-dev/triage-sources/ui` and runtime helpers from
`@happier-dev/triage-sources/runtime`.

In unreleased 0.3 source panels, bind `useTriageSourcePanelIntentV1` with
`{ kind: 'loadMoreSourceItems', list: 'files' }` or
`{ kind: 'setSourceItemExpanded', list: 'files' }`. The source declares its own
list keys and publishes available operations in the binding's `commands`.
Expansion operations also carry `itemId` and `expanded`; paging operations
carry `list`. Call the returned intent from the visible control as well, so
UI presses and the public `happier.triage/actions/ui/mounted-v1` Action reach
the same mounted controller. The Action input is `{ mountId, operation }`.
An inactive panel, unknown list/item or exhausted page returns `unavailable`.
These mounted operations require an answering client and do not acquire a
second source reader or persist presentation state.

For a continuation button, `useTriageSourcePanelPagingV1(list, title,
canLoadMore, pending, onLoadMore)` registers that list's mounted operation and
returns the callback for the button. The callback and command advance the same
source-owned controller. Give independent nested lists distinct keys, such as
`thread-replies:<threadId>`. `TriageActivityTimeline` registers its supplied
continuation when an enclosing source-panel binding exists; standalone timelines
keep their ordinary continuation without requiring a Triage frame.

The same unreleased mounted Action also exposes Triage's existing presentation
controls: `setSourceManagementOpen` (including outside-source Review),
`setSourceDiagnosticExpanded`, `setOrganizing`, `openActionEditor`,
`closeActionEditor`, `setAddSourceOpen`, `configureSource` and `selectBulkAction`.
Editor opening takes the existing V1 action-editor launch input. Source
configuration opens the admitted source's settings page. Bulk choices use the
same workflow-subject offer planner as the visible picker. Commands describe
the current mount; they do not create another settings or selection store.

Bind `createTriageSourceSettingsSurface` to the source's discovery Action, Connected
Account service and `connectedAccountPurpose` (the discovery Action's HostAccess
request id). Its Connect/Manage link opens Happier's existing purpose setup for
that exact Action. Choosing an existing account or pool saves the host default;
return and Refresh to discover source candidates. Connecting an account without
selecting this purpose does not authorize discovery. Agent callers select the
same default through `connectedServices.purposes.default.set`, then invoke the
ordinary discovery and source-administration Actions.

In the current 0.3 development source contract, a source may supply
`readFixPullRequests` on its existing contribution. Its native associations feed
the ordinary owner-resolved fix-PR read alongside user choices and Session
links; they are not a second relationship store. Return native locators so an
associated PR outside the loaded list can be opened through exact reobservation.
In a framed detail, `useTriageDetailFixPullRequestNavigation()` from `/ui`
returns the already resolved primary PR's identity, title, provider URL and
`open`/`openExternal` callbacks, or `null` when unavailable. It shares the
frame's existing exact reader; source details must not acquire the association
again just to render these controls.

An exact `get` may return transient `dispatchEvidence` using the canonical
Session-input forge-evidence schema. Scans and retained snapshots do not carry
provider bodies. The existing composer renders this untrusted evidence through
the shared forge-content block; source UI requests Fix through
`requestTriageSessionHandoffV1` rather than framing evidence or starting Sessions
itself.

In current 0.3 development source, Sentry and PostHog reuse the finite issue
transition adapter from `/runtime` and the daemon-only checkpointed observer
from the Plugin SDK `/background-services` entry. Their existing native scan
owners retain credential admission, pagination and rate-limit evidence. The
person selects the check period in Event source setup; the stated default is
300 seconds (five minutes), and provider retry deadlines can delay a check.
The SDK owns the single observer lifetime and stops work without a current,
assigned consumer. The adapter advances effective per-issue checkpoints through
the declared Account Collection CAS only after safe Event admission and the notice commit.
Each source plugin declares `TRIAGE_ISSUE_CHECKPOINT_COLLECTION_V1` in
`accountCollections`. The adapter selects the current scan's opaque issue ids
in Collection pages and batches changed rows within the host's row and byte
limits. A settled unchanged scan writes nothing. The growing checkpoint set
does not consume Account KV's bounded logical-key map.
Before admission, the issue's private checkpoint retains the transition's immutable
first-observation time. Equal retries and reloads reuse it without another write;
native last-seen time remains evidence, never the Event's occurrence clock.

Native last-seen time is bounded evidence, not a status modification watermark.
The same native time can still produce a resolved/reopened transition. Missing
rows or incomplete scans never imply resolution; an initially resolved issue
establishes a quiet baseline. Notices reuse one item per configured source and
issue. Inbox is the default; automatic investigation requires an explicitly
selected configured Triage investigate Action and actual Event admission (or a
rejoin of that admission). Safely filtered or age-skipped Events may update the
notice but never start an investigation. Retained Inbox investigation
navigation remains an integration requirement, not a shipped claim.

## Composing a source detail story

The following recipe targets the 0.3 development-source contract. Import story
components from `@happier-dev/triage-sources/ui` and semantic content from
`@happier-dev/plugin-ui`. Mount the source renderer through `defineUiSurface`;
it supplies the Plugin UI providers. The enclosing Triage frame supplies the
detail navigation, page-scroll, evidence-disclosure and post-mutation providers.
A source consumes those bindings rather than installing another host provider
or keeping an independent copy of the aggregate entry.

`TriageDetailInstance` and `TriageDetailPanel` preserve the host's active panel
interval. When `input.panel` is present, pass it and `input.panelScrollOwner`
through to `TriageDetailPanel`, with content keyed by your source's declared
panels. An absent `input.panel` requests the whole detail body. Keep story reads
in their active interval and derive the exact source request with
`useTriageDetailRequest`. The story components render the evidence you already
read; they fetch nothing.

For a pull request with source-owned `body`, file rows and check facts:

```tsx
import { Text } from '@happier-dev/plugin-ui';
import {
  TriageDetailStory,
  TriageDetailChangeSummary,
  TriageDetailChecks,
} from '@happier-dev/triage-sources/ui';

<TriageDetailStory
  kind="ask"
  loading={firstReadPending && body == null}
  notice={readNotice}
  changes={<TriageDetailChangeSummary rows={files} more={hasMoreFiles} totals={totals} />}
  checks={<TriageDetailChecks
    title="Checks" titleKey="my-plugin.detail.checks"
    rollup={checkRollup} failing={failingChecks} latestCommit={isLatestCommit}
  />}
>
  <Text value={body ?? ''} />
</TriageDetailStory>
```

Use `kind="report"` for an issue and `kind="error"` for an error group.
For errors, pass `TriageDetailSpread` in `changes`, with source-reported `tiles`,
an optional oldest-first `trend`, `locale` and `nowMs`. Unknown counts stay
absent. Keep retained body text visible with its `notice` during failed reads;
`TriageStoryLoadingLines` is available for a source-owned initial loading state.
File rows use `TriageChangedFileV1`; `more` preserves unread pages and `totals`
contains only provider-reported whole-change counts. `summarizeTriageChangesV1`
provides that same summary for custom composition. A partial check rollup sets
`incomplete: true` and reports the failing/running counts actually read. A
complete verdict needs the provider's failing, running and passing counts;
`latestCommit` must come from the source's commit evidence. Use
`TriageChecksRollupLine` when your own checks list needs the shared sentence.

Keep mutations in the source's declared Action path. `TriageSourceWrites` and
`TriageSourceCommentComposer` present writes; `useTriagePostMutationCompletion`
returns the frame's exact re-read callback. Use
`completeTriagePostMutationIfNeeded` with the source's result classifier when a
settled result may have changed native state, including an uncertain outcome.
Do not treat an unknown write as rejected or automatically replay it. A primary
header write is offered through `useTriageEvidenceDisclosure().primaryWrite`
with `offer(write)` and cleared with `offer(null)` on cleanup. Keep the source's
existing `execute` callback and Action operands; the frame forwards that callback
through the ordinary confirmation path.

Presentation controls such as paging and disclosure use
`useTriageSourcePanelIntentV1` inside the active panel, as described above.
Publish the available `commands` and call the returned intent from visible
controls, so the mounted Action and UI share the same controller. These intents
do not replace provider mutation Actions or the frame's evidence-disclosure
transaction.

## Evolving the ABI

This package follows the Developer Preview support policy of the public Triage
protocol. V1 is the supported source-contract epoch. Keep shared source schemas
in `@happier-dev/triage-protocol/v1` and provider-specific behavior in the source
plugin. A breaking or independently versioned shared contract requires an
explicit versioned entry point. Developer Preview authoring availability does
not imply registry publication; external publication requires approval.
