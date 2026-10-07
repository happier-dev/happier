# Triage source protocol ownership

Triage and independently authored source plugins share one versioned, source-neutral ABI. Triage owns the feature and configured-source lifecycle; each source owns its provider-specific discovery, reads and detail rendering. Generic hosts admit, invoke and mount contributions through the plugin platform.

This page describes **0.3 development / Developer Preview source**. Exact field layouts, exported names and bounds live in [`packages/triage-protocol/src/v1/index.ts`](../packages/triage-protocol/src/v1/index.ts) and its schemas, not a copied schema in this page. Registry publication and loaded external-provider validation are separate release/runtime evidence.

## Package boundary

`@happier-dev/triage-protocol` exposes only the explicit V1 root, `/v1` and `/testing/v1` entries in its [export map](../packages/triage-protocol/package.json). Do not add floating default/current/latest/legacy aliases. The package contains portable composable schemas, authoring values, source-neutral projections and conformance fixtures. Keep host registries/runtime, provider clients, credential materialization, HTTP, UI implementations and persistence outside it.

Schemas use the public SDK `/protocol` composition algebra and `/contributions` authoring seam. The [SDK feature-protocol dependency policy](../packages/plugin-sdk/src/featureProtocolPackagePolicy.test.ts) owns admissible public imports; do not import private `@happier-dev/protocol`, Zod, host internals or a source plugin, and do not handwrite a second JSON Schema/parser. Schema evolution follows [compatibility](compatibility.md#sdk-protocol-evolution).

## Contributions and caller-bound administration

[`contribution.ts`](../packages/triage-protocol/src/v1/contribution.ts) declares `happier.triage/sources` V1 and the target-owned point, with at most one contribution per source plugin. It defines the required list/scan/get operations and detail surface plus optional PR-status/workspace roles. Operation roles reference ordinary source Actions; they are not implementation imports, convention-derived Action ids or a source-specific host registry.

The public [source conformance check](../packages/triage-protocol/src/testing/v1/conformance.ts) reads requiredness from those canonical declarations. An optional role may be omitted; when supplied, its binding must still satisfy the declared Action or surface contract. Conformance maintains no separate list of optional role names.

Account-only sources declare their Action inputs with the shared
`TriageSourceConnectedAccountInputsV1` schemas from the same protocol owner.
These preserve each role's fields while requiring a configured-account instance.
Conformance accepts exactly that specialization or the generic role schema,
not an independently authored variant. Account-purpose declarations still have
to address an exact credential selection in every input arm; native-capable
sources use the generic schema and declare the native-service selection path.

[`sources/administer-v1`](../packages/triage-protocol/src/v1/sourceAdministration.ts) is the one caller-bound lifecycle mutation ABI: create, reconfigure, remove and reactivate. [`sources/read-configured-v1`](../packages/triage-protocol/src/v1/configuredInstances.ts) is its read half. An optional `source` names an admitted contribution address, never caller provenance. The host stamps provenance, and the target's [`callerSource.ts`](../packages/plugins/triage/src/actions/callerSource.ts) resolves the admitted source before either Action exposes or changes rows. Plugin callers stay within their own source. Host agent/MCP/CLI callers can read all admitted configured sources or filter by that address; create requires an exact admitted source address, while lifecycle operations resolve the source from their stored instance and reject an inconsistent supplied address.

Triage's [`administerConfiguredSourceInstance.ts`](../packages/plugins/triage/src/corpus/configuration/administerConfiguredSourceInstance.ts) owns configured-instance writes and the exact source-ownership comparison. [`readConfiguredSourceRows.ts`](../packages/plugins/triage/src/corpus/configuration/readConfiguredSourceRows.ts) supplies the shared active-row read and cursor handling. Discovery produces candidates, not automatic durable creation; mounted source Settings uses the administration Action rather than a direct Collection writer. The read ABI distinguishes complete from truncated results and refuses invalid or changed caller authority.

The source plugin retains its private configuration-token encoding and provider-specific behavior. Triage business behavior stays in `packages/plugins/triage`; shared host code stays source-neutral. Do not use this schema package as a new source service, credential store or corpus persistence owner.

### Native GitHub source bindings (0.3 development)

The canonical instance binding preserves the configured-account arm and adds
`{ purpose, source: 'native', service }`, where `service` is the qualified
Connected Service identity. GitHub discovery offers this candidate when the
executing machine's CLI login is usable and no explicit account is selected.
The shared source settings owner labels it **Use this machine's GitHub CLI
login** and persists it through `administerSourceInstanceAction`, exactly as
agent callers do. Neither configuration path contains a token.
When no account is selected and the machine login is unavailable, discovery
retains the native service identity with the authentication failure
`plugin_connected_account_native_unavailable`, exposing the sign-in remedy
instead of silently returning an empty candidate list.

Instance identity and currentness use the canonical binding components; native
bindings are distinct from configured accounts without a synthetic account id.
Session preparation, formal-review scope and comment publication carry that
same service identity through their existing owners. GitHub reads and writes
materialize the current credential on the executing daemon. Losing that login
requires signing in with `gh` on that machine, not creating a Connected Account.
Other first-party sources retain their account-only admission and reject native
bindings. Native selection does not weaken explicit-account precedence or
retired-subject checks; see [plugin platform ownership](plugin-platform.md#machine-native-github-credentials-03-development).

## Mounted page actions (0.3 development)

The client-target [`ui/mounted-v1`](../packages/plugins/triage/src/actions/mountedUiProtocol.ts) Action accepts finite semantic operations against a `mountId` from the current UI context. It opens/closes detail through the existing reducer and route settlement, controls the same detail Tabs and List/Board preference as the UI, applies a lens or saved view through the existing lens/view owners, sets bulk selection through the public Collection selection store, and refreshes/pages through the mounted window and continuation owners. `focusRow` requests the Collection's physical row focus without activation; `peekRow` expands that row's table peek without opening detail (`expanded: false` closes it). Repeating the same peek intent is idempotent. Both require a key in the current Collection. `retryRun` and `cancelRun` reach the mounted bulk controller's existing Try again and Stop operations, preserving its retained identities and completed outcomes. The local-state Collection APIs are unchanged.

The existing Account/plugin/generation ephemeral scope leases only the addressed page's callback. No React state, provider rows, or mount address is persisted. Choosing a saved view here applies its route lens, just like a shared view link; it does not write the Account's durable selected-view preference. Durable saved-view changes remain separately admitted Actions. An absent/inactive page or unavailable tab/selection/continuation returns `unavailable`; refused route settlement returns `rejected`. Agent/MCP callers require an answering mounted client; a headless CLI cannot operate another client's UI. Opaque current-context commands remain subject to the host's existing retirement and Action admission.

The same mounted dispatcher now reaches source-panel intents in development:
`selectSourceOccurrence` calls the source's incumbent selection controller, and
Sentry's `setSourceOrdering` changes its existing retained-event ordering.
Concealing already revealed user details is an ordinary mounted intent. Revealing
them uses `ui/reveal-source-user-v1`; adding the selected evidence uses
`ui/insert-selected-evidence-v1`. Both named Actions apply the shared manifest
default, per-surface Ask-first setting and explicit waiver. Sensitive operations
cannot be submitted through the ordinary `ui/mounted-v1` input.

Commands are published only by active source panels and carry the selected
occurrence identity. A changed selection, hidden/retired panel or absent mounted
owner returns `unavailable`, rather than selecting a substitute or rereading the
provider. Source controllers retain selection; the existing Triage disclosure
bridge issues the same identity-only candidate to the bound, revision-checked
Composer transaction. Sentry's evidence counts and exclusions remain visible
beside Add; approval itself belongs to the named Action, not a second local
confirmation. The admitted Action's cancellation signal reaches that same
transaction, so cancellation during its Composer read prevents the later apply.
PostHog's existing purpose-bound configuration-directory reader is
also admitted on UI, agent, MCP and CLI without changing its schema or account
authority.

## Configured Session actions (0.3 development)

The client-targeted `happier.triage/actions/sessions/run-configured-v1` Action runs a catalog `actionId` through the same configured action/profile/prompt and Session owners as a mounted press. Its exact input and result declarations are [`configuredActionRunProtocol.ts`](../packages/plugins/triage/src/actions/configuredActionRunProtocol.ts), not a second agent-only workflow. Callers supply exact `entries` (`entryRef` and `sourceInstanceId`) and a declared `destination`; optional settled `drafts` retain the host's canonical launch-input admission.

An incomplete start returns `recovery` when the existing single/bulk controller
still holds retry custody. Echo it as `resumeStart` with the same ordered entries,
source instances, action and destination. Single recovery repeats its retained
creation and delivery identities or resumes the reported phase. Bulk recovery
retries only incomplete units, retaining successful outcomes and the exact inputs
of units cancellation left unstarted. It does not resolve prompts or placement
again. A mismatched continuation is refused before dispatch. Cancellation reaches
the existing host/controller signal path; if a dispatched request has no answer,
the result preserves that uncertainty rather than claiming nothing happened.
These are invocation-local facts returned to the caller, not a durable retry
record. A lost outer Action response supplies no recovery object and must not be
treated as permission to start again. Prepared-workspace recovery obtains a fresh
authorization when needed; it never echoes a spent authorization carrier.

In current development source, agent/MCP/CLI contributed invocations route through the daemon's existing machine-scoped reverse RPC to an answering client, then through the ordinary Action executor and shared client dispatcher. The real invocation surface, exact contribution occurrence, cancellation and shared approval policy remain intact. A missing answering client fails closed before execution; loss of an issued acknowledgement is an unknown outcome, not permission to retry. This client dependency serves New Session authoring, input selection and navigation; it does not introduce a second Session creator.

For a single formal Review, optional `reviewChoices` uses the incumbent [`TriagePullRequestReviewChoiceV1Schema`](../packages/plugins/triage/src/actions/entrySessionProtocol.ts): required `engineIds` plus optional `launchSelection`, `outputs`, `comparisonSource` and `narrator`. Without choices, `awaitingReview` returns the prepared Session's review context and configured instructions rather than claiming an engine started. To continue that same Session, send `resumeReview: { result, instructions: reviewInstructions }` using the returned fields, with the same entry, configured action and `single` destination. This skips Session creation and reaches the same [`pullRequestReviewContinuation.ts`](../packages/plugins/triage/src/sessions/pullRequestReviewContinuation.ts) as the mounted chooser. Retained facts are not authority: the existing final source/workspace/scope verification and `review.start` engine owner still admit the effect. For a partial result, explicitly select only the engines you want to retry; an unknown outcome is never retried automatically. There is no Triage engine registry, duplicate scope resolver or new engine fan-out.

`reviewStarted`, `reviewPartial`, `reviewRefused` and `reviewUnknown` distinguish the outcomes. `reviewResult` carries the incumbent started/failed engine ids or refusal/unknown verdict; `sessionOpen` separately reports `opened` or `failed`. A transport failure is not proof that no engine started. Bulk formal `reviewStart` retains the existing `reviewStartUnsupported` refusal; these destinations do not imply bulk formal-review support.

Configured action Settings, launch inputs and settled drafts all admit profile
references through the Launch Profile V2 id parser: trim, then 1–256 UTF-16 code
units. The public SDK projection `ProtocolLaunchProfileIdV2Schema` delegates to
that parser; Triage imposes no competing generic-id or UTF-8-byte restriction.

## Refresh and provider settlement (0.3 development)

Manual Refresh respects provider retry deadlines and the mounted store's active
single flight, not local aggregate failure backoff. Automatic view demand retains
its existing pacing in the same refresh eligibility owner.

GitHub REST Checks and commit statuses follow validated provider continuation
links under caller cancellation, without the Search endpoint's local page/result
cutoff. The [check-runs endpoint](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)
exposes only the most recent 1,000 **check suites**. Suite saturation or a provider
total exceeding returned rows therefore discloses incomplete coverage; unreadable
rows disclose unknown coverage while retaining readable evidence.

After Azure accepts a merge, settlement serially observes the authoritative pull
request under the caller's lifetime, without dispatching another merge. Terminal
success and provider rejection are distinct; cancellation or a failed confirming
read returns honest pending. There is no local three-read/750 ms settlement window.

## Detail panels and cross-source fix links

[`descriptor.ts`](../packages/triage-protocol/src/v1/descriptor.ts) owns per-kind `detailTabs` and `detailActions`. Shared tab ids select the target's Overview, Activity, Files and Checks vocabulary; source tab ids keep source-owned names and append after the shared tabs. A source tab's optional `titleKey` resolves through that admitted source's projected translation bundle, with `title` as the fallback. Triage owns the frame and tab strip. A source renders the requested [`detail.ts`](../packages/triage-protocol/src/v1/detail.ts) `panel` through its existing detail surface; `detailActions: true` requests the `actions` panel in the header. Omission preserves the whole-detail path. A source using public Plugin UI `Tabs` consumes `tabList="host"` for a target-selected panel and `useTabPanelActivity().activeSignal` for retained asynchronous work.

The detail body keeps one mounted instance per entry/configured connection while
changing its `panel` input. Selection and settled evidence pages remain owned by
that source instance, never by Triage or a global cache. Public `Tabs.sharedPanel`
keeps a shared renderer mounted behind a changing strip; source host-mode Tabs
apply their own declared retention and end hidden panel intervals. Switching to
the linked PR or Session also withdraws the entire hidden source slot's activity.
Changing or retiring the entry destroys its source instance. The Overview rail's
`ScrollArea` stays mounted but disables scrolling for bounded source panels, whose
own collections then own the viewport.

PostHog's sensitive captured-variable reveal declares confirmation on its existing
Action, so the shared approval policy applies on UI, Agent, MCP and CLI surfaces.
The Stack trace panel invokes that Action through the host rather than making a
separate local consent decision. Explicit Ask-first settings and user waivers
retain their ordinary precedence. Revealed values stay in the active panel and
are discarded when it is left; unfinished reads use its activity cancellation.

[`TriageDetailInstance`](../packages/triage-sources/src/ui/detailPanel.tsx) binds
the source root to that same real Tabs activity owner, independently of the
selected source panel. Sentry summary/selected-event, PostHog summary/sample,
GitHub capabilities and Azure iterations abort unfinished root reads while the
source slot is hidden and resume them on return. Settled root evidence survives;
the shared exact-request authority hook replaces it when the configured account,
configuration or entry changes. Sentry also resets its selected occurrence at
that authority boundary, before rendering evidence for the replacement account.

The six first-party sources compose Overview through
[`TriageDetailStory`](../packages/triage-sources/src/ui/detailStory.tsx): the
source's ask, report or (for an error group, `kind: 'error'`) "What happened",
then changed-file evidence and a checks marker where that entry kind supplies
them. Sentry and PostHog put their selected occurrence (exception and top
application frame) in ① and their reach in ②
[`TriageDetailSpread`](../packages/triage-sources/src/ui/detailStory.tsx):
count tiles (events or occurrences, users affected, first release or first seen)
and the provider's own occurrence series — Sentry's `stats["24h"]` from the
existing issue read, PostHog's `sparkline` from the existing `query/issue/` read
(`includeSparkline`, provider-chosen buckets across the detail window). A fact
the provider did not state is absent, and those counts are not repeated in the
Facts list. A source control that points at a sibling panel ("Open the stack
trace") selects it through
[`useTriageDetailPanelOpener`](../packages/triage-sources/src/ui/detailPanelNavigation.tsx),
which the tabbed detail body backs with its own tab selection and offers only
for panels it shows. The shared composition uses public Plugin UI
`Step`; it does not own provider reads, selection, paging, or mutations. Host
stories are static content in Triage's rail, while the whole-detail source path
keeps its own scroller. Shared story copy enters each source's existing
translation bundle through the shared translation producer. Native changed-file
readers preserve their paging and incompleteness disclosures. Check markers
consume canonical provider rollups, never counts inferred from the loaded page;
missing, partial, unknown, and inapplicable evidence never becomes a passing
marker. Source-only evidence tabs and header write controls remain source-owned.

All six host Activity bodies render one chronological stream through
[`TriageActivityTimeline`](../packages/triage-sources/src/ui/activityTimeline.tsx).
Each source maps its provider records (remarks, reviews, threads, pushes,
state/label changes) into `TriageActivityEventV1` and hands them over unsorted;
the owner orders them (by instant, undated last, ties in source order) and draws
the marker rail, the sentence, any quoted remark and the time. Sources keep their
reads, dedupe and controls: thread replies and resolve/publication writes ride in
an event's `inset`, and every paged collection keeps its own continuation
(`reads: 'earlier'` above the stream for newest-first walks). Triage appends its
own `activityTail` after the panel. Azure's Overview
policy marker uses only its complete, untruncated evaluation result with known
approved/rejected/running/queued statuses; partial, unknown and empty evaluation
evidence yields no aggregate state. Commit statuses never establish policy
enforcement.
The known state meanings follow the source owner's
[Azure policy-evaluation endpoint](https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/evaluations/list?view=azure-devops-rest-7.1)
(`7.1-preview.1`): queued/running evidence is not approval. Other outcomes remain
visible in the native Policies plane without an inferred aggregate marker.
GitLab merge-request Activity uses its existing unified notes/event reader and
review discussions; it does not mount the separate issue-comments reader or
issue-comment publication control over those same notes.

[`fixPullRequests.ts`](../packages/triage-protocol/src/v1/fixPullRequests.ts) publishes the closed V1 fix-link caller schemas, result projections and exact qualified read/write Action references. Callers submit link/unlink intent through `marks/set-fix-pull-request-v1` and read ranked candidates plus the selected primary through `marks/read-fix-pull-requests-v1`. They do not receive raw mark rows, dismissals or co-linked entries to resolve themselves.

The private [`setPinned.ts`](../packages/plugins/triage/src/corpus/marks/setPinned.ts) remains the single `user-marks` writer. The private [`fixPullRequests.ts`](../packages/plugins/triage/src/corpus/marks/fixPullRequests.ts) resolves explicit links and Session-derived candidates, deduplicates origins, applies dismissals and chooses a primary that is never closed without merging. Mounted direct Account-data reads supply the admitted device projection; daemon reads obtain kind facts from the admitted source descriptors and lifecycle facts through the existing exact-get/reobserve owner and active configured-instance reader. Unavailable facts remain `unknown`; no provider observation is persisted. Triage mounts the primary PR's Files/Checks through that PR's source, including when the fixed issue came from another source.

The frame shows fix-link reads in progress and offers Retry when a read fails.
The primary PR's admitted kind declares its tabs independently of mount readiness:
Files/Checks remain selectable with the canonical unavailable state when the PR
is outside the current projection or its detail cannot mount. Durable explicit
links and dismissals do not inherit Session relationship query page limits;
the public read retains every explicit choice. Derived queries remain paginated
and disclose incompleteness rather than silently claiming a complete answer.

The agent step consumes the host Session snapshot's Work bucket and tone, with
Triage story copy and the shared Work semantic treatment. Its three-finding
preview offers See all through the canonical Session opener: the first omitted
finding's Session when named, otherwise the story's current linked Session for
scoped review rows without that optional field. A failed open is visible and retryable.

Known non-PR kinds are excluded by that resolver and rejected before a link write with `PluginError` code `triage_fix_pull_request_kind_invalid`. An unavailable descriptor is not evidence that a durable explicit choice is invalid: the writer preserves that intent and the read keeps its status unknown. Writes inspect admitted kind facts only, never fan out to provider reads.

The public [author recipe](../apps/docs/content/docs/plugins/ui/index.mdx) covers source detail panels and fix links; the [Collection composition](../apps/docs/content/docs/plugins/ui/react-native.mdx) uses public Collection, presentation, Step, Tabs and HappierDisclosure imports. The feature protocol exposes neither a corpus storage handle nor the mutation/resolution implementation.

## List Session facts (0.3 development)

“With an agent” is a cut of the existing Triage list, not a second Session list.
The mounted list pages the existing Account `session-links` index once per
window acquisition and keeps only relationships for the window's entries.
[`readEntrySessionLinks.ts`](../packages/plugins/triage/src/sessions/readEntrySessionLinks.ts)
owns indexed page acquisition and decoding for the list, detail and fix-link
resolver; it preserves the derived entry identity and Collection continuation.
Distinct linked Session ids go through Plugin UI's shared `useSessionStates`
read/watch lifecycle. The host's canonical Work bucket `working` supplies
`agentActive` to the existing list planner. Required attention still takes
precedence, and Pinned remains a separate leading section, including retained
pins outside the current window.

The join refreshes with mounted window acquisition, manual refresh and return
activity; Session invalidations re-read through the host. It creates no durable
projection, per-row acquisition or polling timer. Incomplete or unavailable
activity is shown in the list with an explicit retry. A failed link acquisition
keeps previously known relationships without claiming that missing entries are
unlinked; unreachable Session facts are not classified as working. A mount
without the Account Data client reports unavailable activity rather than
introducing a broader daemon read Action.

## Related

[Plugin platform](plugin-platform.md), [Actions](actions.md), [Collection presentation](collection-presentation.md), [encryption](encryption.md), [compatibility](compatibility.md).
