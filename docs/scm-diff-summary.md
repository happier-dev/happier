# SCM comparisons, walkthroughs and commit proposals

This page owns the internal SCM explanation contract in **unreleased 0.3
development source**. It describes implemented owners, not release availability
or completed end-to-end certification. Package and loaded-runtime gates remain
open; the presentation gaps below must not be documented as completed flows.

## Owners and data flow

Machine-captured repository comparisons are readable by a Session Review on that
same Machine and Home. The capture reader first checks the Session namespace,
then uses the repository capture only when that Session capture is absent.
Repository, comparison and source checks still apply; corrupt captures do not
fall back, and another Session's private capture is never searched. Investigation
uses the retained pins from the actual capture namespace. Explicit deletion keeps
its original namespace rather than deleting a Machine capture through a Session.

### Pull request description drafts (unreleased 0.3)

`scm.diffSummary.draftPullRequest` requests a summary whose `suggestedPrBody` is
an editable description. It uses the existing summary model and prose-language
selection, captured comparison, and the latest readable summary for that same
comparison and Session scope. The Git backend's existing compose read accepts
`includeTemplate` to read the committed base template through the same reader
used by ordinary PR creation. Missing or ambiguous template evidence refuses
drafting; an absent template permits a Changes/Testing draft. A backend that
does not return the requested template evidence remains unsupported for this
operation.

Testing context comes from the selected Session's paged transcript and canonical
command/result projection. Prose claims and template checkboxes do not prove a
test ran. Failed or unfinished commands and unavailable or incomplete transcript
reads remain explicit evidence. A command from the Session does not, by itself,
prove that it validated the captured comparison.

Template text, saved summaries and command output enter the existing prompt's
evidence context, never its user-instructions field. The machine result retains
that evidence privately for replacement generation and keeps the description
under the existing summary edit/revision/Undo contract. Draft requests bypass
analysis-cache reuse because the Session's testing context can change without a
code change. They never invoke PR creation, push or browser navigation. The PR
form (`GitPullRequestForm`, in the Git sidebar and in Details) offers the draft as
one quiet action beside the body. It invokes the Action for the form's head/base
as a branch comparison through the shared Session summary binding
(`useGitPullRequestBodyDraft`), so progress, model choice, typed failures and
Machine presence are the ones every summary surface already shows. An arriving
description fills the body only when the person has neither typed since asking nor
had text there to lose; otherwise it is held beside the body as "Use description"
or "Keep mine". This is unreleased 0.3 source behavior, not a claim of released
UI availability.

The Session draft repository retains the description request and any unapplied
candidate with the form. Moving between the sidebar and Details keeps the request
for the same Machine, Session directory and head/base comparison. The admitted
request observes the existing captured Account lifetime, surviving a form remount
while still rejecting publication after Account retirement. Late request updates read the
current draft before writing, preserving text entered in another placement. The
request retains the exact result identity from its Action acknowledgement; only
that result can settle the request or supply its description. A different saved
summary for the same branch cannot fill the form.

Unknown Start admission keeps the request pending and withholds another Write or
Retry. The hook exposes the shared binding's `admission` and `checkAdmission`:
the latter rereads this request's exact result without starting another Run, and
a later completed description still arrives once. Its `runId` and `cancel`
handoff use the existing `execution.run.stop` Action and Session Run stop owner,
including the Action's availability policy. A confirmed stop clears the
matching pending attempt while preserving the person's body and any candidate;
an unconfirmed stop keeps the attempt pending. Rendering the uncertain notice
and Cancel control is a separate UI integration step.

After capture, draft and ordinary generation failures use the same strict result
builder: requested outputs, failed progress with a typed `reasonCode`, and explicit
remaining analysis coverage accompany the captured inventory. Unavailable template
evidence returns `DIFF_UNAVAILABLE`; model refusal returns `MODEL_UNAVAILABLE` and
the existing model-selection action. Other known pre-Start failures use
`SUMMARY_FAILED`. Cancellation still propagates through the containing operation.

### Demanded entry history (unreleased 0.3)

`scm.history.entries` reads the latest reachable commit touching each demanded
literal repository-relative path at one captured HEAD. Its strict request and
result live in `packages/protocol/src/scm/entriesHistoryV1.ts`; the contributed
`read.historyEntries` operation is optional, and a backend without it reports
unsupported history rather than borrowing Git behavior.

The Git owner batches the current folder and visible entries into one history
traversal. Files match their exact path, directories match descendants, and
renames do not follow an old identity. Subjects and author names are native Git
facts, not inferred hosting identities. Unborn history is `none`; a shallow
boundary or failed/truncated read is `unavailable`, not proof of no commits.

The Git traversal consumes NUL-framed stdout incrementally through the existing
host command owner and stops once all demanded facts are established. It keeps
the command's existing byte and timeout budgets. Reaching the output boundary
retains already proven facts and marks unsettled demands unavailable; only a
complete traversal can establish `none`. Cancellation discards the batch.
The optional SDK streaming command operation must be present: a buffered-only
host reports unavailable rather than pretending it consumed or settled output.
An intentional stop returns `stoppedEarly` after owned process cleanup, retaining
the actual exit code of the terminated Git process.

`useWorkspaceEntryHistory` captures Home, Machine, root, folder, demanded paths
and HEAD. Retired or mismatched responses cannot replace the current view.
For a workspace below the repository root, it consumes that root from the same
SCM snapshot, prefixes outgoing demands and maps only demanded facts back to
workspace-relative rows. Root-folder history therefore excludes outside sibling
commits. Missing or incompatible repository-root evidence is unavailable, not
proof of no history; literal filename spelling is preserved through the existing
contained-relative-path owner.
On Windows, qualified root identities can lose directory casing. The Git batch
recovers its actual folder spelling through native filesystem resolution before
the existing literal Git filter and path matching; it keeps the original demand
keys in its response. It refuses physical alias/junction remapping rather than
following a different Git identity. POSIX case-sensitive names remain distinct.
History is transient and independent of the directory read: failed refreshes
retain known facts with a freshness notice, and valid files remain browsable.
This is not a persisted history index or a replacement for paged `scm.log.list`.

In this unreleased development flow, the full Code route opens folder and file
pages in the main column; the Files companion keeps its file-to-Details behavior.
Both consume the shared
[`ProjectBrowseFilesSurface`](../apps/ui/sources/components/projects/detail/surfaces/ProjectBrowseFilesSurface.tsx)
and existing file reader. In
[`WorkspaceFileDetailsView`](../apps/ui/sources/components/workspaces/files/details/WorkspaceFileDetailsView.tsx),
Raw downloads the actual file through the ordinary workspace byte transfer, not
the rendered preview or diff. Copy copies only complete loaded non-binary text;
it is disabled without that content, and a clipboard failure is reported. The
[inline transfer owner](../apps/ui/sources/sync/domains/transfers/runtime/transferRuntime/families/workspaceFileTransfers.ts)
rejects oversized or failed reads rather than publishing a truncated prefix.
Unavailable file content or history therefore remains unavailable, not an empty
file or a claim that no commit exists.

Cross-machine commit counts require actual common Git objects at the comparison
owner. A remote tip not present locally cannot supply a merge base; unrelated
histories cannot supply one either. Per-checkout upstream ahead/behind counters
are not cross-machine comparisons and must not be subtracted or combined to
invent them. The existing comparison owner reports unavailable evidence when
it cannot resolve the required local objects; entry history does not fetch or
introduce a second comparison engine.

Capture comparison evidence first, then optionally ask one analysis Run for
`summary`, `walkthrough`, `commitPlan`, or a combination. Capture requires no
model. Opening a Walkthrough destination does not start generation; Start does.

Attached Review and generation admission use the existing Execution Run start
RPC under the caller's cancellation lifetime, without the generic Session RPC
acknowledgement deadline. The response identifies the admitted Run; existing
Run and saved-result observation reports progress and completion. A delayed
acknowledgement does not authorize another start.
The Review dialog carries its mounted Action lifetime through the launcher.
Dismissing or unmounting ends that caller's wait and suppresses late local
navigation; it does not prove that an admitted Run was cancelled. A late receipt
never causes an automatic replacement start. The canonical forwarding owner
settles target-socket departure before acknowledgement as the existing uncertain
outcome, not proof that no Run was admitted. Caller cancellation and target
departure remain separate facts. In 0.3 development source the same transport
cleanup serves local and clustered forwarding; complete clustered cleanup
requires updated participating server dependencies.

Review output reports inspection separately from its findings array. The shared
Review normalizer preserves an explicit `reviewOutcome` of `complete`, `partial`
or `failed`; omission stays partial rather than establishing a clean review.
Reported failure, truncated findings and incomplete captured inventory cannot
be promoted to complete. The common review brief requires this outcome and
directs reviewers to available read-only workspace/SCM tools when shell
inspection fails. Unavailable inspection is failed, and partial inspection
retains supported findings. These are unreleased source semantics; previously
saved reports are not rewritten by this normalization change.

The host generation Action reads the Account's Explain setting before capturing
or reading comparison evidence, saving a result, or admitting a Run. Disabled
generation returns `SCM_DIFF_SUMMARY_DISABLED` for Session, detached and automatic
requests. UI operations present that refusal through the existing recovery notice;
opt-in checkpoint prefetch uses the same admission. Explicit comparison capture
remains available without generation.

Checkpoint prefetch leaves an unset model preference unset on the generation
request, just as Start does. The host's executable catalog chooses its default
under current sign-in and admission facts. Only a saved model override becomes
an explicit selector; the checkpoint trigger does not choose a static default.

The canonical generation brief orders explanations from contracts and data
shapes through their implementation to callers and UI, groups files by intent,
and places proving tests beside their behavior. Mechanical files retain coverage
in a short final stop. Diffs, PR text, comments, file contents and saved generated
prose are evidence, never user instructions. Review citations and settled context
require actual supplied review findings; generation alone establishes no review.

Walkthrough stops may carry optional `suggestedQuestions`, plain strings grounded
in that stop's captured evidence. Existing results without them remain readable.
The strict stop schema, revisioned result store and reading projection carry the
questions; merging stops combines their questions and Undo restores the previous
lists. Saved questions are context, not instructions. Choosing one prepares the
existing Ask composer with its exact stop and saved revision; Send uses
`scm.diffSummary.discuss` and the existing Execution Run recipient. It does not
regenerate or edit the reading. Question-chip presentation remains UI integration
work in this unreleased development change.

In unreleased 0.3 source, `scm.diffSummary.outputLanguage` uses the existing Account
settings owner. Its empty default follows the requesting UI's active locale;
explicit language tags select prose only. JSON keys, code, identifiers, enums and
exact references retain their original meaning. The language travels on the
existing generation request and separates analysis cache/request identities.
The saved generator retains that effective language for refinement, additional
outputs and a replacement Run. An explicit language on a later request takes
precedence. Earlier saved generators without a language remain readable and use
the normal request/Account fallback on replacement; their prose is not inspected
to infer a language. Replacement admission carries only the user's own text in
`instructions`; the profile rebuilds host tasks and saved evidence in their
separate prompt sections.
Headless Actions and direct Runs use the same Account preference resolver;
without a prose override they use Account `preferredLanguage` when available.
The Settings Action anchor is `sourceControl.outputLanguage`.

The saved generator also retains its admitted Connected Services selection,
including explicit absence of Connected Services. A model selection with no Provider
connection does not imply native credential routing. Replacement replays the
saved binding through ordinary current credential admission; no credentials are
stored in the generator. Account defaults can resolve after profile preparation;
the initial result bind takes the admitted Run's route so those late-resolved
bindings are retained as well. Earlier records without that selection can recover it
from the original retained Run only when its Agent, model and Provider agree
with the saved choice. If that Run is unavailable, its omitted binding cannot be
reconstructed from the model tuple. A known original Team route without a
representable saved credential choice refuses replacement rather than switching
to current defaults.

Output notification opt-in uses the existing `RunWorkNotifications` owner and
configured notification channels; it does not change Account preferences. An
explicit selected comparison, saved result and output are checked against
`execution.run.get` before the existing account-inline run-lifecycle trigger is
registered. Pending/writing output waits beyond that saved revision; already
settled output catches up immediately. The daemon consumes the existing
event-backed `waitForOutput` and Action-completion matcher, not the retained
analysis process's exit. Complete, partial, failed and cancelled output all end
that observation, so visible notice copy must describe an update rather than
claim success. Commit-plan output completion means proposal generation, not
application of accepted commits: application has its separate saved-result
state. The commit proposal keeps its existing notification control mounted while
that selected output is pending or writing, including when usable partial groups
are visible. Live delivery and populated presentation have not been certified here.

Cancelled pending or partial outputs retain their usable value and publish
`reasonCode: 'generation_cancelled'` through the existing strict saved-result
contract. The UI maps that code to the existing cancellation notice; it does not
parse diagnostic prose. Already complete outputs remain complete when their
retained conversation is stopped.

A Start refusal proven to have created no Run can save a failed output while
keeping its captured comparison. A temporarily absent receiver carries
`reasonCode: 'RPC_CLIENT_NOT_AVAILABLE'` as well as its diagnostic reason. This
does not authorize resending Start. An uncertain or lost Start observation keeps
the original pending revision so the original request can still publish into it.

`scm.diffSummary.investigateSurroundingFiles` is off by default in unreleased
0.3 source. Generation uses the Account preference when the request omits
`investigateSurroundingFiles`; an explicit boolean overrides it for that request.
The effective value follows the cache identity, saved generator and Run policy. Enabled and
disabled analysis have different cache identities without changing comparison identity.
When enabled, the capture owner materializes raw Git blobs at both exact captured
endpoints, bypassing checkout filters and export attributes. The Run starts in the
after directory and receives the before directory as read-only context. Missing
local endpoint objects, unrepresentable paths or escaping symlinks produce
`DIFF_UNAVAILABLE` before Run creation; there is no fetch or live-checkout fallback.
Submodule working files are not materialized from Gitlink identities.
Immutable checkpoint reads ignore mutable Git replacement refs. For retained
local captures, native Git applies their available patches to a private index
and checks resulting file objects against the captured lineage; current diff
formatting is not the witness. A mismatched retained capture is unavailable.

The existing Run tool policy admits reads and denies workspace writes; it does
not introduce another filesystem sandbox or broaden network permissions. Disabled
generation uses the existing no-tools policy. Surrounding reads cannot invent
captured references or establish host analysis coverage. The machine result store
retains the pinned directories for resumable conversations and removes them on
saved-result deletion under its existing lock. The Settings Action anchor is
`sourceControl.investigateSurroundingFiles`.

For an attached automatic summary Run, the runner first inherits the parent's
applied model and route. An unavailable parent selection falls back to the
configured summary model and that Agent's canonical Account default route;
explicit model choices retain precedence. A different default Agent passes
through canonical Action admission only after the parent attempt proves no Run
was created. An unknown admission outcome is never retried. The bridge resolves
selection before summary-profile preparation so the saved generator and Run agree.
This is development-source behavior pending daemon and runner reload validation.

The summary fallback (and detached generation) resolves an unset preference to a catalog model in the `low` cost tier
with admitted structured-output support. Automatic native candidates also require
the Agent's existing sign-in probe to report signed in on the executing machine;
static model membership alone does not establish executable credentials.
The same catalog also considers the Agent's canonical connected-account default
route, independently of native sign-in, and uses the canonical model probe when
an executable Agent supplies no static model list.
An unset UI preference leaves the generation model selector absent so this
host owner can choose from that evidence without a client-side Agent/model pin.
In 0.3 development, the Summary picker and its Settings admission read this same
executing-machine catalog through `agents.models.list` with
`purpose: 'scm_diff_summary'` and the exact `machineId`. The observation separates
offered `profiles` from `automaticProfiles`; only the latter enter the shared
default ranking. The catalog owner also reads admitted configured ACP definitions
and selected-model evidence through its existing configured/explicit probe branch.
`discoveryTargetKey` requests fresh model evidence for that admitted target, and
`modelSelector` carries the selected model for Settings admission. The returned
`discoveryTargetKeys` keep discovery reachable when a configured target has no
proven JSON model. Unknown ACP capability evidence never becomes JSON support.
All Account reads and currentness checks use the invocation's captured operation
context and Home; Connected Account purpose requests retain its request
authorization. These observations do not replace the daemon's ambient Account.
Summary catalog preparation reads only the admitted purposes row and Account
encryption currentness through the existing catalog refresh/publication owner;
it does not transfer retained Settings or clean their history. Its signed
Account root cannot read the full Settings envelope or `/v1/account/encryption`.
An absent, unadmitted or unreachable purposes row withholds automatic candidates
whose authentication depends on that metadata and returns the strict observation's optional
`unavailableReason: 'account_metadata_unavailable'`, including when configured
ACP profiles remain available. Consumers can explain incomplete automatic
choices, retain configured/last-good choices and retry without representing
missing Account metadata as native sign-out or an Agent launch failure. The
reason is absent after a successful purposes read; picker presentation is a
separate UI handoff.
The same observation retains enabled Agent discovery targets even when their
default route cannot authenticate. Its optional `unavailableTargets` distinguishes
`native_sign_in_required`, `native_auth_unavailable`, `account_metadata_unavailable`
and `connected_default_unavailable` for automatic authentication. Explicit models
and discovery remain available in `profiles`, including when several connected
accounts exist without an Account default. They do not enter `automaticProfiles`
without the existing sign-in or canonical default evidence. Choosing a model does
not choose or persist a connected credential; the existing Session/Run admission
still resolves an explicit or applied-parent route.
A missing observation supplies
no candidates; static UI descriptors and failed native probes cannot create a
default or restore a signed-out route.
Explicit selections and attached applied-parent routes retain Run admission.
The picker, prefetch and direct generation
Action consume the same selection owner; explicit selections retain precedence.
Resolving the default does not persist a model preference. Without an admitted
fallback candidate, a known attached parent remains usable; detached generation
reports model unavailable and retains the captured inventory.
If attached Run admission proves the parent unavailable and no fallback can be
admitted, generation also returns `MODEL_UNAVAILABLE`, keeping its captured
evidence and failed saved result available. This typed refusal carries
`nextAction: 'chooseModel'` for UI and Action callers. An unknown Start outcome is not
reclassified as an unavailable model or retried. It leaves the saved output and
revision unchanged: the original request may still be preparing, and must remain
able to bind its captured revision and publish. Reconciliation reads that same
saved result through the existing generation admission receipt. Those
receipts retain Run/input identity and `admission: 'outcomeUnknown'` across
ordinary generation reuse, PR drafting and saved-result reads, without changing
the pending output or revision. Draft evidence still excludes that result from
ordinary analysis-cache reuse; it does not exclude its admission receipt.
A known original Run binding supersedes that observation. The UI state projection
reports `unknown` with retry withheld; its `admission` and `onCheckAdmission` props
are the handoff for an uncertain-reading notice. That callback rereads the exact
saved result and never sends Start. A fresh attempt remains explicit Regenerate
or deletion followed by generation; no eventual receiver or automatic resolution
is guaranteed. SCM Machine
effects use the captured Action's lifetime rather than a subordinate RPC deadline.
The Start owner distinguishes preparation and preflight failures from dispatched
requests. A proven pre-send refusal or exception, deferred approval, or explicit
`noRunCreated` receipt settles generation as a failed saved output with its typed
`reasonCode`; it does not leave a pending uncertain revision. Deferred approval
does not claim a Run exists. Dispatched failures without affirmative no-Run
evidence and malformed replies remain uncertain, with no automatic resend.
Each nested Start writes one content-free file-log observation containing the
saved result id, outer Action request id, entry flag, outcome class, closed error
code or class, and Run-creation evidence. Prompt, diff, arbitrary error prose and
credential content are excluded.
The executor preserves a closed exception class in the Start evidence when it
returns a caught exception. The log also recognizes the canonical Agent-start
refusal codes; an unrecognized code is null, never relabelled `action_failed`.
The returned failure envelope may itself represent a lost dispatched reply;
its Run-creation evidence, rather than the fact that the executor returned,
decides whether a new attempt is safe.
The native Start owner acknowledges a Run it has already created even when
initial publication, runtime construction or initial-input admission fails.
The caller observes that same Run's failed or recoverable state instead of
mistaking initialization failure for uncertain Run creation. A failure before
creation carries `noRunCreated`; a lost Start reply still cannot prove creation.
Initial output admission and publication use the Run's existing initial input
identity, including its host default when no explicit input id was supplied.
Ordinary later discussion retains an empty output scope.
A Machine-custodian request that names a Session derives that Session's backend target from
its metadata, as the Session route does, so an unset model preference can inherit the attached
parent there too. When Run start is refused before any Run exists, the failed output's reason carries
the typed refusal code and its reason text (for example `execution_run_profile_preparation_failed:
<reason>`), and the host logs the same reason; a refusal that already has its own typed code keeps it.
Clients surface that reason through the existing generation-failed state rather than inventing a copy key.
The relative cost tier is not a token price: current catalogs supply no unit pricing,
so clients must keep that cost unavailable rather than invent an amount.

Walkthrough reading keys use the mounted reading surface. Plain-reading pointer
engagement transfers focus from chat without scrolling; visible editors retain
their keys. A maximized reading surface recovers J/K, reviewed-toggle and Ask keys
from a retained hidden composer before that input receives them. Hidden or inactive
walkthroughs do not handle keys. The composed source tests cover these transitions;
the standalone loaded-pane focus/J/R replay passed. Authenticated chat and maximized
panel replay remain part of the program's live validation.

The unreleased PR triage default catalog includes a PR-only explanation action.
It reuses configured-action recipients and canonical context attachments, sends an
ordinary session message, then opens the session. The catalog parser preserves
configured rows and their order, then appends missing built-ins in default order,
including for a stored empty catalog. Explicitly disabled built-ins stay disabled;
deleting one records `enabled: false`, while deleting a custom action removes it.
Reset removes the stored override and restores the current built-ins. Unreadable
catalogs remain unavailable. UI offers, configured-run admission, bulk retry and
review continuation consume the same enabled/coherent/subject-aware selection;
none may dispatch a disabled built-in through an alternate entrance. See
[Triage sources](triage-sources.md) for the catalog owner.

Ordinary generation does not request a repository PR template. Explicit PR
description drafting uses the committed-template evidence path described above.
The Git PR writer applies its existing template only when no body was supplied;
it does not replace an explicit draft with generated prose.

- [`comparison.ts`](../packages/protocol/src/scm/comparison.ts) owns source
  selectors, captured inventory, occurrence identities and path classification.
- [`diffSummary.ts`](../packages/protocol/src/scm/diffSummary.ts) owns the strict
  output envelope and model-output normalizer. Aliases resolve only against the
  captured inventory; persisted selections use occurrence IDs.
- [`captureScmComparison.ts`](../apps/cli/src/scm/comparisons/captureScmComparison.ts)
  owns machine evidence and retained endpoint refs. Public capture/generate
  Actions supply authenticated checkpoint-history and PR-source readers. Direct
  low-level Run starts without saved evidence cannot infer those transports.
- [`ScmDiffSummaryProfile.ts`](../apps/cli/src/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/ScmDiffSummaryProfile.ts)
  consumes the host's retained-turn publication seam. Both generation and review
  narration publish through this profile and the same machine result store.
- [`resultStore.ts`](../apps/cli/src/agent/executionRuns/tasks/scmDiffSummary/results/resultStore.ts)
  owns editable output, revisions, immediate Undo, generator linkage and commit
  application progress. Device projections and the analysis cache are readers,
  not alternate editable authorities.
- [`useScmCommitPlan.ts`](../apps/ui/sources/components/sessions/files/commits/useScmCommitPlan.ts)
  projects saved commit plans and sends their revisioned edits, acceptance,
  stop, cancel, hook inclusion and recovery through that result owner.
  [`ScmCommitsView.tsx`](../apps/ui/sources/components/sessions/files/commits/ScmCommitsView.tsx)
  is the shared presentation; Session adapters retain their authorized composer
  affordance without becoming a separate commit-plan controller.
  The comparison binding observes its selected model through
  [`useScmDiffSummaryModelChoices.ts`](../apps/ui/sources/components/settings/sourceControl/useScmDiffSummaryModelChoices.ts),
  the same offered-model projection consumed by its picker and Source Control
  settings. A restored proposal does not depend on mounting an empty-state
  picker to establish model availability.
- [`WorkspaceCommitsView.tsx`](../apps/ui/sources/components/projects/scm/WorkspaceCommitsView.tsx)
  is the Project consumer of the same controller and presentation, rendered by
  [`WorkspaceScmReviewDetailsView.tsx`](../apps/ui/sources/components/projects/panes/details/views/WorkspaceScmReviewDetailsView.tsx).
  Its workspace binding uses the admitted Home/Machine/root with null Session
  identity, not a
  borrowed or synthetic Session. Only current working-tree selection exposes a
  proposal and its application controls; committed evidence does not substitute
  pending changes. Retiring the selected host stops foreground observation,
  not the accepted machine application. Package and composed live validation of
  this consumer remain open.
- [`reviewedMarks.ts`](../packages/protocol/src/scm/reviewedMarks.ts) owns personal
  mark intent and per-key CAS; Account KV stores the marks separately from results.
- [`SessionScmReviewDetailsView.tsx`](../apps/ui/sources/components/sessions/files/views/SessionScmReviewDetailsView.tsx)
  projects Files, Walkthrough and pending-only Commits through `scmReview`.
  The shared comparison binding restores saved results without generation.
- [`WorkspaceScmReviewBody.tsx`](../apps/ui/sources/components/projects/scm/WorkspaceScmReviewBody.tsx)
  owns the shared comparison body for Project, live Session and captured Session
  hosts. Hosts supply their admitted authority; a Project presentation key is
  not a workspace permission id. Missing or ambiguous accepted workspace refs
  leave Project analysis unavailable rather than manufacturing a Session.
- [`walkthroughReading.ts`](../apps/ui/sources/components/sessions/files/walkthrough/walkthroughReading.ts)
  projects Explain notes once per reading. Each stop's first matched hunk carries
  its gist; later files and secondary stops use title-only notes. Hunk annotations
  look up those notes directly; they do not rebuild the reading or generate prose.
- [`resolveMobileBottomChromeModel.ts`](../apps/ui/sources/components/navigation/mobile/chrome/resolveMobileBottomChromeModel.ts)
  hides cockpit bottom tabs for a pushed Session Details `scmReview` destination,
  before considering a registered cockpit fallback. Files and Walkthrough retain
  their own reading controls and Back; unrelated Details routes retain their
  existing chrome.

The existing Action catalog and machine/Session RPC dispatcher remain the public
entry points. See [Actions](actions.md) and the generated
[host Action reference](../apps/docs/content/docs/plugins/api/host-actions.mdx)
for current inputs, outputs, placements and confirmation policies. There is no
second walkthrough generator, publisher, result registry or Git writer.

Saved-result admission is enforced by `executeScmActionOperation` before
inventory metadata, prose, provenance or effects are returned. Workspace-native
results require the authenticated Home/Machine and filesystem root. A retained
Session namespace or Session-derived source additionally requires separately
verified Session authority through the existing `session.write` RPC proof;
caller-supplied Session and root selectors never grant access. The fixed Run
profile scope enforces the same rule: detached intent input cannot open a
private capture or saved result by naming its Session.
For raw SCM calls, the canonical RPC authorization map keeps Session-scoped
Discard at `submitAgentInput` authority and private branch/PR evidence at
`readTranscript`. Machine-only workspace admission remains independent. Ordinary
local callers carrying Session proof use verified Home/Machine ingress rather
than dropping that proof through the in-process adapter; already-admitted
host-private requester custody stays with its installed owner.
In the Project Changes destination, Session choices come from the canonical
admitted Project Sessions roster, narrowed to the displayed Machine and checkout.
The optional `evidenceSessionId` travels with the review target and URL; it is a
selector, not authority. Selecting a Session or its latest turn uses that
Session's existing comparison binding. Withdrawal removes the choice and leaves
the selected private source unavailable, without substituting working-tree
evidence or borrowing another Session.
Local retained reads also bind explicit Home overrides to the active Home's
canonical public/API URL identity; an alternate Home with the same Session ID
does not open this Home's files. Native profile capture applies the incumbent
Machine filesystem policy to an intent's directory, without narrowing an
existing OS-user-wide grant to string equality with the launch directory.

Workspace generation and discussion reuse detached execution Runs with
`sessionId: null`. A successful generation returns its actual initial `inputId`,
also retained in the existing generation receipt. Clients can await that exact
input through Run Get's `waitForInputId`, then reread the saved-result owner;
they do not wait for a resumable Run's lifetime to end. Later discussion and
refinement return their actual admitted input identity through the same owner.
Personal reviewed marks use the requester's Account material, never a Machine
custodian's material on behalf of another actor. Missing requester material
returns `reviewed_marks_unavailable`. In current 0.3 development, admitted native
mark/unmark uses the existing signed Home request for Account currentness and
the reviewed-mark KV namespace only. It grants no access to other Account
settings or KV keys, and inconsistent Account mode still refuses the write.
Deleting a saved explanation leaves these personal content marks intact.

Stored comparison, result and personal-mark readers use the canonical recursive
stored-read normalizer: unknown fields are removed at known nested schema
boundaries, while malformed known fields still fail. Request/model schemas stay
strict and writes produce the canonical current shape.

The Project Git pane and Local Changes widget share the workspace SCM operation
owner. A commit-message suggestion uses the existing bounded, ephemeral,
request-response `scm_commit_message.v1` Run with no tools, null Session and the
accepted Home/Machine/root. It changes only the matching current editable draft;
it does not commit or send. A wait timeout is pending observation, not Run
failure: the accepted handle is retained for Get or explicit Stop on its original
target, and Stop acknowledgement is not a terminal fact. Session suggestions
consume the same operation and observation owner.
Selected paths and patch paths retain literal filename whitespace through UI
selection, include/exclude scope matching, native SCM reads and model context.
An empty path is omitted; a whitespace-only filename is not empty, and a spaced
filename never selects its stripped sibling.

Project Explain and Ask seed the ordinary editable New Session draft with its
captured checkout origin and authorized displayed evidence. They do not create a
helper Session, send automatically, or dispatch another analysis Run. Local
Changes promotion selects working-tree Files through the existing comparison
destination and qualified focus request, not a competing File Details tab.

Omitting `outputs` preserves summary-only generation. Its value contains the
existing `summaryMarkdown`, optional risks, test impact and suggested PR body.
Walkthrough adds title/intro and ordered stops referencing exact changes;
commitPlan adds ordered message/rationale groups and explicit left-out refs.
Unrequested outputs are absent, not empty completed results. Adding an output
continues a supported generator or explicitly seeds a replacement from saved
context, without giving prose or proposals Git authority.

## Source meaning and coverage

| Source | Captured comparison |
| --- | --- |
| `workingTree` | Captured HEAD to pending content, retaining staged/index, unstaged and untracked layers. Only this source can authorize commit proposals. |
| `session` | Initial pre-dispatch checkpoint to a newly captured worktree endpoint. Initial dirt is the baseline; a later edit and reversion disappears from the net diff. |
| `turnCheckpoint` | Canonical start/final checkpoint receipts for the selected turn. Explicit `agent_reported` mode instead retains tool fragments and reports incomplete repository coverage. |
| `branch` | Resolved merge-base of base/head to the resolved head. Pending work is not included. |
| `commit` | Selected parent to the immutable commit; a root uses the empty tree and a merge requires an explicit parent. |
| `pullRequest` | Source-attested repository/PR identity and merge-base-to-head diff endpoints, with a separate base-tip freshness witness and paged evidence from the hosting source. |

In unreleased 0.3 source, the canonical Git checkpoint command owner ignores
mutable replacement refs for immutable checkpoint/comparison reads. Captured
inventory, patches and surrounding-file materialization therefore refer to the
same actual object identities, including when a replacement ref predates capture.
Ordinary non-checkpoint Git commands retain their existing semantics.

### Usage Work correspondence (0.3 development)

The existing PR list/get reads accept an optional `workEvidence: { sessionId }`
selector. The host admits that Session and filesystem scope before reading and
again before returning private evidence. Older readers can omit this optional
projection; absence is unavailable evidence, never a complete empty ledger.

In 0.3 development, the existing `scm.branch.list` read accepts the same
selector and returns exact checkpoint/commit witnesses for local branch heads.
The branch identity combines the device-local opaque repository identity,
full ref and captured immutable head object id; a branch name alone is never
an allocation join. The read does not fetch or write Git objects. Missing
checkpoint receipts or objects remain unavailable, and a commit witnessed in
several branches remains ambiguous rather than being charged to each branch.

`scm/checkpoints/sessionEvidence.ts` verifies retained start/final checkpoint
receipts against their scoped Git refs, exact selected turn and capture phases,
and actual object trees. Native turn-start alias receipts pin the commit OID;
their tree is resolved from that exact retained object. Any supplied tree must
agree, and a moved ref or contradictory receipt is rejected. A single-parent commit
links only when its parent tree and tree exactly match those endpoints. The
hosting reader supplies PR identity and immutable base/head OIDs; membership in
that Git graph completes the link. Repository identity uses the existing
`scm/hostingRepositoryIdentity.ts` owner. Branch names, authors, timestamps and
directories never establish correspondence. Missing objects, pruned or changed
refs, rewritten content and unmatched partial commits remain unlinked. No Git
fetch, checkout or publication is performed by this read.

The Work allocation consumes U0's resolved accounting contributions unchanged.
Each contribution goes to its unique witnessed PR, or stays unallocated when
turn evidence is missing, outcomes conflict, or writers are uncertain. Sessions
and PRs may relate many-to-many through distinct turns. Every token and cost
kind remains in exactly one allocation row; there is no allocation record,
equal split, cloned event or attribution editor. Exact content correspondence
is not an authorship claim: even `no_happier_checkpoint_overlap_observed` is
bounded process-local evidence. Branch-scoped PR discovery reports partial
coverage independently of the exact linked rows. Native PR dates are optional;
a last-update timestamp is not a merge timestamp.

The branch ledger is a separate projection of these same resolved contribution
rows, including standalone branches with no PR. It does not add its amounts to
the PR-linked total or change PR allocation. Both strict projections are
re-derived from admitted contribution and SCM witnesses by
`allocateUsageOutcomes`; neither introduces stored allocation records.

### PR comparison reads

The GitHub source adapter invokes its configured safe changed-files Action with
`comparison: true`, starts at page one, and follows only source-minted
continuations. GitHub attests the merge base as the diff-before endpoint; its
base tip is a separate freshness witness, not the beginning of the patch. It
frames each provider hunk fragment with the exact before/after
paths (including renamed and quoted paths), then the comparison owner supplies
canonical occurrence references. A changed endpoint during pagination retains
the earlier prefix as stale/incomplete rather than appending another code basis.
Missing patch text remains unknown binary/content evidence, not an empty diff.

In unreleased 0.3 development source, GitLab merge requests use the same host
comparison reader through their existing Changes Action with `comparison: true`.
The repository locator includes the normalized deployment so identically named
projects and merge requests on different GitLab instances cannot share a scope.
The source pins `diff_refs.base_sha` as the before endpoint, `start_sha` as the
target witness and `head_sha` as the after endpoint; its native head must agree.
Each page is bracketed by identity-checked metadata reads. Continuations retain
the pinned tuple and cumulative coverage, and stay inside the selected diff
resource. A changed tuple stops the walk as stale rather than mixing versions.
GitLab's capped or unpopulated `changes_count` becomes an unknown total (`null`),
which the host accepts only as incomplete inventory. Missing, collapsed,
too-large and unproven patch content stays explicitly incomplete. The existing
Action response byte boundary can omit patch text while retaining file identities.
These are source contracts; loaded GitLab tenant verification is separate.

Files reads PR, branch and commit evidence through the same capture operation,
without a current-checkout diff fallback. Supplying `comparisonId` reads that
retained comparison through `readCapturedScmComparison`; it never recaptures.
Repository, authenticated Session and source must match, otherwise the operation
returns unavailable evidence. The strict optional id is an unreleased 0.3 input
extension, not a safely ignorable instruction for an older capture owner.
Captured Files does not offer working-file preview, staging, discard, or diff-area
controls. Its missing-content and freshness notices retain the original evidence.

The comparison menu's PR choice uses the existing ephemeral input picker.
Triage supplies the `pull-request-comparison` input from its admitted source
reader, including the source-owned locator and Action. Completion returns that
comparison to the incumbent Project or Session review; cancellation keeps the
previous comparison. The host does not parse a hosting URL or navigate away to
Triage's ordinary app page to select this input.

The Triage PR-detail Walk entrance reads a source-owned PR comparison locator
from the transient `get` result, not from the persisted entry snapshot. It opens
the canonical comparison destination through typed `session.open` navigation.
That development destination supports `files`, `walkthrough` and `commits`.
`commits` requires a `workingTree` comparison; Session, turn, branch, commit and
PR sources return `commits_require_working_tree` before navigation. Opening the
view grants no commit authority; acceptance remains a separate SCM Action.
The same unreleased `scmReview` destination accepts `explain: true|false` for
Files. UI toggles and Action callers update that shared pane target; the choice
only displays saved walkthrough notes and does not generate another output.
A linked Session is reused only when its Account-scoped Home and machine have
a reachable placement in the existing project registry;
otherwise the incumbent New Session placement and entry-session flow create/link
a reference-only Session without checkout preparation or prompt delivery.
Formal Start review retains its prepared-workspace flow and captures PR evidence
before passing `comparisonId`, requested `outputs` and `narrator` to `review.start`.
Walkthrough is selected by default; missing comparison evidence must be resolved
or walkthrough deselected before starting a findings-only review. The canonical
review admission owner validates those inputs. The human Request review flow is
unchanged. Before capture or review dispatch, Triage consumes the public host
`selectActionInput` review-launch projection. The host reuses the canonical
review launcher's exact Account/Machine admission, stopped-Session resume, and
Secret/Team controls and defaults. Only admitted credential references and
consent are relayed; neither credentials nor readiness are inferred by Triage.
Cancellation dispatches no capture or review. Loaded-runtime certification of these development entrances is still
open; source and owner checks alone do not close that gate.

The initial Session basis is retained/recovered by the existing checkpoint
lifecycle. Missing, pruned or mismatched receipts produce unavailable evidence
with a reason, never substitution of HEAD or current pending changes. A shared
worktree comparison is not exclusive Agent authorship: attribution is separate
from exact content. Chronological turn fragments remain useful for navigation
but cannot establish the net Session tree.

Three facts remain independent:

1. **Source coverage:** inventory `complete|incomplete|unavailable`, explicit
   missing reasons, per-file/per-occurrence textual availability and freshness.
2. **Analysis coverage:** supplied, analysed and remaining occurrence refs, plus
   per-output `pending|writing|complete|partial|failed|cancelled` state. Completion
   of requested analysis does not prove complete source data.
3. **Personal review:** only explicit mark/unmark intent. Generation, navigation,
   finding resolution and a completed review never create these marks.

Generated files and lockfiles remain inventory, labelled through the shared path
classifier; collapse changes presentation only. Missing hosted patches leave
binary status unknown (`null`), rather than proving a binary or clean file.
Unavailable layers may retain usable supplied diff bytes.

In 0.3 development source, native catalog observations retain the Agent's declared
context window, constrained further by a smaller reported Provider window. Claude
Code's standard opt-in-context models publish the existing 200k native window;
their separate `[1m]` variants do not enlarge the standard model's input budget.
This distinction applies to both selected Connected Accounts and local native
credentials. Models without a declared or reported size retain unknown capacity.
The host enumerates evidence before model admission. For initial generation and
review narration, when the selected offered model reports a context window, the progressive owner plans occurrence groups
and textual fragments before admission, charging rendered UTF-8 bytes
conservatively against that window. This is not an exact tokenizer or a guarantee
against native framing, retained-history or output overhead. A separate output
capacity is not currently reported by this model catalog. Unknown capacity keeps
native admission authoritative; `agent_context_window_exceeded` refines the same
owner's boundaries without a guessed fallback ceiling. Fragments retain exact
UTF-16 offsets into the captured unified diff, the original file/hunk headers and
partial neighboring-line orientation that shrinks with the actual fragment.
All captured evidence remains in the fragments; orientation is not counted as
new analysis. Subsequent admissions remain in the same Run, and the
initial retained context does not repeat the full evidence behind a planned part.
`analysis.parts` projects confirmed evidence-part admissions, completions, total
parts and the evidence/integration/done phase; native rejection can increase the
total. Integration is not another evidence part. Valid structured publications
retain usable outputs and coverage. Undo restores editable prose and provenance,
not the factual admission/completion counts.
Saved-result discussions and scoped refinements retain their existing native
admission and revision-scoped publication; they do not acquire whole-result
multipart generation authority merely because a context capacity is known.
Cancellation or
failure leaves evidence and earlier prose available. Unknown capacity is not
permission to silently slice the source. Model aliases, renderer keys, fuzzy
anchors and line ordinals do not authorize mutation. Shared anchor resolution
qualifies ambiguous, stale, missing or unsupported navigation; it cannot transfer
marks or replace exact occurrence selection.

## Comparison Discard and guarded Undo

In unreleased 0.3 source, `scm.change.discard` retains its HEAD operation and adds
a closed `kind: 'comparison'` entry. Comparison selectors never downgrade to
HEAD. A present UI user can discard selected comparison runs directly; HEAD
discard still confirms, and Agent, MCP and CLI calls retain danger approval.
The same executor checks Session authority and exact selected-key membership.
It consumes Protocol's hunk engine, the backend's `fileAtRevision` bytes, and
`commitGuardedFileReplace`; it does not add another parser, blob reader or writer.

Run discard requires strict UTF-8 and exact context. Whole-file restore is
binary-safe. Staged selections, renames, copies and untracked files refuse this
operation. An added file is deleted only while its current bytes still match the
captured after blob; an edited added file is kept. An absent deleted file can be
recreated, without Undo because no current file was overwritten. Every write
uses its observed current-byte hash or absent-file expectation, preserving a
concurrent edit instead of overwriting it.

The File-review facade offers one sticky, hash-guarded Undo, retired by dismissal
or the next review action. Small unit inverses retain only changed text; whole-file
preimages use inline bytes or the existing prepared export. When an inverse would
exceed the actual aggregate routed response budget, the same result instead
contains its exact preimage export. Export preparation precedes every entry's
write; there is no truncation or file-size cap. Exported preimages
are downloaded and verified before ready Undo is offered, released through that
transfer owner, and held only in the result/notice closure until retirement.
A failed preimage download reports the completed mutation with unavailable Undo;
it never repeats the mutation. The rendered File-page integration remains a
separate presentation handoff, not a completed flow established by this helper.

Small local Session inverses remain usable without a daemon. Only when the
canonical all-entry preflight proves that Undo needs an export does that caller
delegate the unchanged request to its selected Machine's existing SCM transport.
The Machine revalidates and owns the mutation and note; no local entry is written
first. A proven unavailable transport refuses before mutation. A lost
acknowledgement remains an unknown outcome, never an automatic local retry.
This uses the existing daemon export lifecycle, without introducing a Session
publisher, listener or preimage store.

The executor emits one `file_review_note.v1` item per successful Discard/Restore
Action and receiving Session for all callers. The UI emits only a successful
Undo's note. Keep, refusal and `kept_edited` emit none. These are explicit
`next_turn` inputs and do not wake an idle Session. Note-delivery failure is
reported separately from a completed filesystem mutation and never replays it.
Only run-key selections carry a numeric change count; captured Git-hunk refs and
HEAD selections omit it rather than treating a hunk as one review run.

## Saved edits, personal marks and offline access

Files, Walkthrough and Commits restore through `useScmWalkthroughState` and the
same machine saved-result reader. Its `idle|restoring|ready|unavailable` state is
separate from generation: a pending read is not an empty result, and a failed read
offers retry rather than a new-generation empty state. An exact metadata target
can be read before presence hydrates; unknown reachability is not offline.
An unavailable or ambiguous Session target settles as unavailable. Only confirmed
unreachability warrants offline copy; unknown presence uses a reachability notice.

Restoration and in-memory selection are scoped to Home, Account, host, repository,
comparison and requested output, ordered by saved inventory recency. A newer
failed/cancelled attempt without that output's value can fall back to an older
published value. Failure of a sibling output cannot hide a newer usable commit
plan or relabel a completed walkthrough. Pending/writing/failed/complete projection
also follows the requested output when it was added after the original request.
Run-observation refusal preserves the last saved projection and does not establish
generation failure. Typed admission failures remain visible over retained content;
only model-related failures offer model selection as recovery.

In unreleased 0.3, restoration sends the checkout, optional Session and requested
comparison/output selectors to `scm.diffSummary.result.list`. The machine result
owner selects references from its protected `selection.json` metadata projection;
opening a comparison does not decode unrelated saved results or read Run usage.
Only the chosen result bodies are read. Known result identities go directly to
the canonical body reader, which admits the stored repository and Session scope
before returning contents. Selectors never grant access, and inventory counts and
bytes include only admitted results.

The projection contains selection metadata, not captured diffs, generated output
bodies or Undo. Every result writer invalidates its row before committing the
canonical body, then republishes metadata under the existing filesystem exclusion
primitive. Missing or malformed projection data rebuilds from canonical files;
one malformed result cannot hide unrelated valid records. Interrupted metadata
publication does not turn an already committed edit into a reported failure.
Normal restart reads the retained projection without reopening result bodies;
cold repair must decode records whose metadata is missing. Deletion removes the
row before its body, so an interrupted deletion with a retained body can recover.
This unreleased replacement requires reloading existing result writers; it does
not promise freshness for arbitrary external file edits or older loaded writers
that do not maintain the projection.
Settings explicitly requests `includeUsage: true` for the separate seven-day
retained-Run cost projection; normal inventory/selection omits that optional field.

`scm.diffSummary.result.*`, `refine` and `addOutputs` use the existing authenticated
machine/Session transport. Writes bind `resultId` and `expectedRevision`; the
machine uses protected atomic local state under the existing runtime directory
and serializes writers with its owner-file lock. Successful changes increment
revision. A stale write returns `revision_conflict` and the latest revision;
clients keep their draft for reconciliation. A refinement binds its output scope
and base before dispatch, so late model output cannot erase intervening edits.
Retained discussion carries the full current saved outputs and comparison, even
when a question names one stop. The shared prompt requests prose for ordinary
questions and structured output when the person asks to change the saved result.
The Run composer uses that same discussion Action with a freshly read revision.
An ordinary prose answer publishes no edit. Selected stops identify the requested
context; they do not replace the rest of the saved walkthrough. The initial turn
of a seeded replacement conversation still admits no structured outputs. Every
structured publication retains the existing revision check. Binding the replacement Run changes
linkage and provenance while preserving the saved story and unrelated outputs.

Rename, prose edit, reorder, merge, output addition and immediate Undo preserve
unrelated outputs. Merge retains the chosen title and exact coverage. Undo is
revision-checked and preserves current generator linkage. Accepted application
states `applying|paused|unknown` lock editing, refinement, Undo and deletion.
Already-published leading commit groups remain immutable after the lock releases.
A completed application is no longer editable. When an unlocked application has
unlanded groups, only those remaining groups can be edited; left-out/move controls
follow that same proposal editability predicate. Landed rows retain their SHA and
actual message without offering to rewrite them.

The result revision owner also persists walkthrough/stop edited-title provenance,
each stop's latest changed/moved revision, and an update notice identifying the
affected stops (and merged selections when applicable). Immediate Undo restores
the previous provenance and publishes an Undo notice. Host-only admission
progress preserves that same input's unchanged output basis without rebasing
over manual edits or refreshing unrelated pending inputs.

Results survive Run termination/cache eviction until explicit deletion. Personal
marks use `workspace:scm-reviewed:scope:<encoded scopeId>` with
`{ v: 1, scopeId, reviewedChangeKeys }`. The scope identifies the repository root
and source selector, independently of captured endpoint revisions. PR reviewed
scopes reuse the existing comparison identity without endpoint or request-witness
inputs; request freshness still uses its unchanged, witness-sensitive source key.
Each change
key identifies path, layer and exact removed/added line content, with an ordinal
for identical runs. `buildReviewUnits`, `buildScmFileReviewUnits` and
`buildScmChangeKeys` in Protocol's occurrence owner supply that identity to the
renderer, controller, Walkthrough and Actions. Captured Actions still validate
exact occurrence membership before translating refs to keys; live working-tree
Actions recompute key membership without creating a capture. Both paths rebase
the specific intent once on a CAS conflict; a further conflict remains visible.
The UI subscribes through the existing
`subscribeKvPrefixChanges`, scoped to captured Home/Account credentials. Account
JSON transport owns plain/encrypted envelope admission: plain Accounts need no
fabricated E2EE keys and unreadable/mismatched encrypted data fails closed.

Metadata-only marks use path, previous path and change kind, not blob content.
A binary replacement with that same metadata identity therefore retains its
metadata-stop mark; it does not have the textual run's content invalidation.

The capture owner publishes resolved Session/turn/receipt selectors rather than
a contextual bare turn selector. Its retained-capture and saved-result readers
(including revision Undo) project those selectors from authoritative stored
metadata without changing comparison IDs, occurrence IDs or inventory. Earlier
ambiguous bare-turn Account mark records are left untouched; readers do not
guess which turn should inherit their marks.

An unrelated edit or line shift can change the comparison identity without
dropping marks for unchanged content. Rewriting the run makes it unreviewed;
the same content in another file, layer or source scope has its own identity.
Absent keys are retained, so content that returns is reviewed again. An explicit
Reset review clears the scope. Prose edits keep marks, and a merged stop is
reviewed only when every run of all its selections is marked. Unloaded marks are
unknown, not a confirmed zero count. The native UI writes displayed key intents
through Account KV; an offline Machine does not block Keep.

Settings list count/bytes from the selected machine, not all machines. Confirmed
Clear uses exact-revision result deletion and retains application-lock admission.
It does not read or clear personal marks. A concurrent edit can refuse deletion;
other selected results can still succeed and report their own outcome. Neither
cache eviction nor result deletion deletes review findings or Session checkpoints.

Offline clients can retain an already-loaded projection; they cannot write the
machine result, obtain fresh evidence or accept commits. There is no cold-offline
or cross-machine reconstruction guarantee. Reconnection reads current authority
before a revisioned write. Home/Account retirement withdraws requests/listeners.

Session entry points without an explicit Home resolve their unique Home through
the Session scope owner before binding credentials. An explicit Home remains
authoritative. A settled Home credential failure or unknown Home ends restoration
as unavailable; explicit Retry delegates unreadable device storage to the existing
credential owner before restoring the saved reading.

## Generator interaction and settings

The runtime contract is `retentionPolicy: 'resumable'`, `runClass: 'long_lived'`,
with existing Session-owned or detached Run interaction. It is not a new retention enum.
A settled output can leave a healthy generator idle. Per-turn structured output
is published by the host, not by observing arbitrary transcript JSON or prose.
The host reads a turn's reply through the shared Run-output JSON reader, so a reply a model
wraps in prose or a code fence still publishes; the strict protocol schema and complete
coverage check remain the contract.
The commit-message Run reads its reply through the same reader and keeps its plain-text title and body fallback.
The host remains the lifecycle, input-custody and streaming owner.
Fresh pending results retain their generation prompt; an existing usable
reading supplies saved context without overriding the current request. Agent codecs correlate foreground committed
assistant text with its admitted turn so retained Runs can publish the reply;
history and native sidechains do not acquire foreground result authority.

In unreleased 0.3 source, the Run intent's transcript projection applies to both
streamed text and native committed messages. Structured reply JSON stays available
to host parsing without becoming assistant prose; ordinary discussion remains
visible. A changed saved output publishes one host notice with the existing
`happier.kind: 'scm_diff_summary.v1'` saved-result payload and a typed
`scmResultUpdate` publication receipt. The receipt identifies changed output kinds,
whether each value was created or updated relative to the saved value, and the
saved result's Undo availability. Update receipts also carry the result owner's
update notice and whether a manually edited title was retained. The receipt
reader rejects an update notice for a different result revision. It is derived from successful saved publication,
not a revision guess or a separate status store. Baseline metadata, prose-only
discussion, unchanged values and refused/conflicted writes do not carry a success
receipt. The UI receipt adapter validates this metadata alongside the saved
result identity, revision and comparison without interpreting transcript JSON.
Metadata-only baseline and progress completions update Run state without writing
an empty assistant transcript record. Committed person questions belong to the
Run's sidechain and pass through the same reducer projection with or without a
parent tool marker. The shared Run visibility projection uses the existing
host-input provenance classifier to omit host setup prompts at both Run entrances
and in parent previews and Find. Person-facing previews use the canonical display
text rather than the expanded generator context. A receipt with Undo permission
exposes the existing Undo intent without loading SCM data on mount. A known newer
admitted revision disables that intent immediately. Otherwise, the intent reads
the exact saved result through the existing Action and requires the receipt
revision, Undo availability and unlocked application before invoking
revision-guarded Undo. Stale reads return a typed conflict without mutating a newer
result. Reads and successful Undo responses enter the canonical saved-result
store; the receipt creates no inventory, revision cache or guessed request key.
For a Session-owned retained Run, the host notice reaches the existing durable
sidechain writer before native terminal settlement. Its actual committed message
is the input's reply result; the hidden consumed structured-source record is not.

In unreleased 0.3 source, `review.start`, `review.walkthrough` and
`review.explain_findings` accept an explicit `target: { kind: 'detached' }` on
the admitted Home/Machine/root. Run association stays `sessionId: null` even
when the caller has a default Session. Narration reads the selected review's
captured comparison and retained findings, then continues that reviewer or
starts the existing seeded narrator. Detached input uses the canonical Run
sender with its exact input identity; Session input keeps Session Pending
admission. Selected Runs must share their repository and protected requester
scope. A private Session capture or saved result cannot be selected by dropping
its Session identity. Finding explanation returns targeted refinement to the
existing SCM Action, retaining saved-result authorization and revision checks.
These source contracts do not establish loaded-runtime certification.

Discuss/Ask uses actual authenticated Run send/resume affordances and the existing
`execution_run` recipient. Stop context carries the displayed result/revision.
The Run transcript is separate from human discussion. When continuation is
unavailable, Start a new conversation installs a pending recipient in the existing
Session composer; its first submitted message requests a seeded Run. Accepted
admission alone does not prove backend provisioning or saved linkage. Provenance
changes only when the canonical host binds the new Run. Ask this session switches
back to the Session Agent. There is no second composer or silent fresh reviewer.

Source control settings retain `scm.diffSummary.*`. Explain changes defaults on;
Prepare after each turn defaults off and uses completed durable
checkpoint receipts only, with the existing dedupe owner. It does not prefetch
pending/PR sources. The machine result owner coalesces concurrent generation for
the same captured comparison, requested outputs, backend/model/profile and
Session identity through its existing filesystem exclusion owner. Matching
requests reuse the saved result, including manual edits, and its actual admitted
Run; failed or unknown admission is not silently retried by prefetch. Explicit
Regenerate bypasses that reuse. Summary model and Start share the offered model catalog and
structured-output capability admission. Unknown/unsupported capability cannot be
made supported by a default model name; continuation is a separate capability.
In 0.3 development, UI and CLI Run preflight share Protocol's observation
classifier. A missing method or unsupported protocol reports
`execution_run_protocol_unsupported`; a transient or typed failed observation
reports `execution_run_target_unavailable`; cancellation reports `cancelled`.
The Summary model and Prepare after each turn declarations use domain admission
before the Account settings CAS write. UI and `settings.set` use that same owner:
unsupported or unavailable model choices and preparation without a supported
selection are refused. Turning preparation off remains possible when the
previous model is unavailable.
In 0.3 development, background model choices share `useAgentModelChoices` and
`projectAgentModelChoices`: walkthroughs require admitted structured output;
Replay summaries can use text-only models and custom native model ids. Both use
Protocol's `ProviderBoundModelRef` payload (`agentTargetKey`,
`providerConnectionId: null`, `modelId`). The Summary scalar preference encodes
that payload with its existing `model:` carrier; Replay's runner wrapper stores
it as `modelSelection`, keeping task permission separate. The runner reader
normalizes 0.2's backend/model fields and drops unknown stored fields; current
writes use the canonical reference. Session models, Provider routes and
review-engine fanout retain their own admission and lifecycle owners.
Seven-day cost uses reported execution records and exposes partial/unavailable
coverage rather than inventing prices. The current reader counts retained
`scm_diff_summary` records in the interval and may see only a Run's latest turn;
retired Runs are absent. A priced subtotal is always partial, not a complete
historical charge ledger.

## Review narration

`review.start` preserves findings-only behavior when optional outputs are absent.
Requested walkthroughs bind a captured `comparisonId` and typed narrator
selection. The strict Review normalizer owns findings; `ReviewProfile` publishes
findings before requesting a walkthrough through the shared SCM profile/store.
A single eligible reviewer continues its Run. Multiple/findings-only engines
use one selected narration-capable narrator, retaining physical reviewer Run
identities and launch failures. Narration failure does not erase findings.
Built-in Agent and review-engine inventories remain available when the optional
configured-ACP catalog is unobserved or unavailable. Configured choices are
listed only from ready catalog authority; configured launch still checks its
currentness. Finished-review narration receives the host's captured ACP catalog
instead of borrowing an ambient catalog or fabricating an empty ready one.

`review.walkthrough` reads effective findings at the host for the named Session
Runs. Eligible continuation requests output without repeating review; a seeded
narrator is labelled as reading diffs, not reviewing them. Provenance carries
review outcomes, continuation/seed mode and `unchanged|changed|unknown` freshness.
Partial/failed/unavailable output is never a clean review.
Current engine publications do not report files-read counts. Missing counts are
unavailable; captured file totals, finding counts and finished engines are not
evidence of files read.

The Protocol `projectReviewFindingsOverlay` owner maps only safe comparison-bound
locations; ambiguous/stale/unmatched findings remain unmapped. Follow-ups retain
Run identity. Overlay changes make no model call. `review.explain_findings` is an
explicit targeted refinement through the existing result owner; ReviewComment
continues to own persisted dispositions.

Review findings bound to a captured comparison materialize their comment snapshots
from its immutable file blobs, including the before side of a deletion or rename.
Later working-tree edits or moves do not change those snapshots. If the captured
path, object or exact line range cannot be verified, the durable comment uses a
finding-level anchor with no code snapshot; the Review publication keeps the
finding's reported location. This leaves it reachable as unmapped without failing
the Review. Comment authorization, encryption and persistence failures still
produce partial or failed materialization.

Post-hoc continuation uses effective findings, including follow-ups, in both its
private narration context and queued instructions. Its provenance carries the
review publication evidence and available receipts through the canonical schema.
The composed review UI journey remains open in this development integration.
These contracts do not establish released UI availability or resolve
the separate E2EE review
materialization limitation documented in [CLI architecture](cli-architecture.md#review-verdict-ownership-03-development).

## Git writer, private index and version behavior

[`commitOperations.ts`](../packages/plugins/scm-git/src/operations/commitOperations.ts)
captures admission-time parent/ref and delegates to
[`commitPublication.ts`](../packages/plugins/scm-git/src/operations/commitPublication.ts).
Ordinary scoped commits, stacked-request commit phases and accepted plans use
this same Git-plugin writer. Older callers without expected-base fields still
get admission-time capture. Capability negotiation governs new explicit authority.

[`gitTemporaryIndex.ts`](../packages/cli-common/src/scm/gitTemporaryIndex.ts)
owns only setup/seed/disposal: empty, captured tree or current-index snapshot,
Git-resolved per-worktree index path and split-index independence. Both commits
and CLI checkpoints consume this Node/filesystem subpath. Checkpoint identity,
hooks, publication and live-index reconciliation retain their respective owners.

The writer runs pre-commit, prepare-commit-msg and commit-msg against the private
candidate, using Git hook discovery, message cleanup and identity. It compares
the tree after all pre-publication hooks: content expansion returns
`COMMIT_HOOK_CONTENT_CHANGED` before publication, while message rewrites retain
the actual message. Configured signing creates the candidate before publication;
there is no unsigned fallback. A real index lock protects staged-intent
reconciliation. A prepared native ref transaction checks parent, branch identity
and repository operation state before publishing the known candidate. Conflicting
stage intent fails before publication, rather than resetting the live index.

The backend-owned version detector observes Git once per backend occurrence:
Git 2.36+ uses `git hook run`; older POSIX Git runs the resolved executable hook
through Git's shell-alias executor, honoring `core.hooksPath` and inherited
configuration. Pre-2.36 Windows commits refuse unsupported hook execution.
Below Git 2.40, a commit requiring staged-intent merge returns
`COMMIT_STAGING_CONFLICT` and preserves staging; ordinary non-merge cases remain
usable. These are implementation branches, not a new universal Git version floor
or certification of every historical binary/platform.

After publication, index replacement, post-commit, amend post-rewrite and cleanup
can still fail. Responses retain `publication.state: not_published|published|unknown`,
known candidate/commit OID, expected parent/ref, actual message and reconciliation
state. A false `success` or timeout alone cannot authorize retry. Consumers normalize
known publication first and refresh/reconcile instead of replaying. Existing native
worktree patch application retains its repeated-line relocation limitation; this
writer correction does not claim to fix that separate path.

## Commit proposal acceptance and application

Model output is ordered message/rationale groups plus explicit left-out occurrence
refs, never executable patches or implicit approval. The revisioned result owner
validates membership and disjointness. Only a current `workingTree` comparison on
a backend advertising safe-plan capabilities is admissible.

Accept binds result revision, exact repository/comparison, parent/ref, groups,
messages and exclusions through shared Action confirmation. The host
[`materializeCommitPlan.ts`](../apps/cli/src/scm/commitPlans/materializeCommitPlan.ts)
constructs cumulative target trees; each step consumes the preceding verified
commit/index, rather than replaying a full-base patch. Unsafe overlap or source
drift refuses the remaining sequence.

Working-tree capture obtains the parent/ref witness from the registered canonical
writer, separately from its diff-before tree. An unborn symbolic branch records a
null parent even when retained comparison refs exist; its first commit has no
parents. Normal and detached parents still require exact matching at acceptance.
A backend without target capture can supply read-only evidence, not acceptance.

[`executeScmCommitPlanAction.ts`](../apps/cli/src/scm/commitPlans/executeScmCommitPlanAction.ts)
calls the canonical writer one step at a time. Include hook changes binds the
displayed tree delta and revision; further expansion pauses again. Stop after
this lets the active writer resolve and admits no next group. Failure/cancellation
preserves the published prefix and hook-created worktree changes. Recovery
resolves recorded candidates through the writer without replay; uncertain outcomes
stay unknown. A remaining suffix needs fresh explicit acceptance, and missing
verified index reconciliation requires a fresh pending capture. There is no
rollback, push or rewriting of landed commits in this operation. Git-pane proposal
selection highlights refs; it does not change ordinary staging or accept a plan.
Before Include is available, wide and phone proposal views read the recorded
before/after tree pair through the existing SCM diffCommit seam and verify its
witnesses and file inventory. Highlighted rows expose stats and exact diffs,
including hook-added files. A renewed pause invalidates the earlier inspection;
the current worktree is never used to reconstruct this delta.
The Commits view adds `commitPlan` to an existing saved pending walkthrough when
available. Discard removes the whole saved result only when it contains nothing
but an unlanded, unlocked proposal. For mixed-output results it removes only
commitPlan through the revisioned owner, preserving other outputs and immediate
Undo. It never discards repository content.

## GitHub evidence and current presentation limits

The configured GitHub source's existing `list-github-changed-files` Action accepts
`comparison: true`. Its admission, account materialization and validated Link
owners retrieve source-minted pages, reread base/head around each page and retain
patch/missing/truncated facts. The host
[`readPullRequestComparisonPage.ts`](../apps/cli/src/scm/comparisons/readPullRequestComparisonPage.ts)
adapts attested source facts into this comparison, without choosing credentials
from display fields or treating `diffAvailable` as evidence. Failed pages retain
the usable prefix and explicit incompleteness; endpoint changes require refresh.
The source's real provider/transport boundaries can leave content incomplete.
Reading does not checkout/fetch into the user's worktree. PR sources cannot
authorize local commits. [Triage sources](triage-sources.md) owns source routing.

Current UI scope types cover pending, Session, turn, branch, commit and PR.
[`filesComparison.ts`](../apps/ui/sources/components/sessions/files/comparison/filesComparison.ts)
routes Session, branch, commit, PR and pinned comparisons to
captured inventory through the evidence-only Files renderer, without local
checkout reads or mutations. Unpinned turn Files retains the existing turn
evidence projection. The comparison bar consumes the canonical Start
review dialog, forwarding the captured comparison and requested walkthrough;
this does not certify a loaded end-to-end reviewer journey. PRs & Issues has
the development-source Walk and Start review entries described above; their
loaded end-to-end certification remains open.
Files Explain projects saved prose per file; per-hunk alignment and finished
review presentation remain separate validation obligations. Commit acceptance
and hook inclusion now supply a fresh Action request ID through the shared
confirmation owner, with real ASK-origin approval tests proving that approval
creation does not invoke the SCM mutation. Do not turn remaining integration
gaps into public promises.

## Related

[Runtime ownership](runtime-core.md), [CLI architecture](cli-architecture.md),
[plugin platform](plugin-platform.md), [Actions](actions.md),
[encryption](encryption.md), [compatibility](compatibility.md),
[published diffs and review](../apps/docs/content/docs/code/diffs.mdx),
[published Git guide](../apps/docs/content/docs/code/git.mdx).
