# SCM comparisons, walkthroughs and commit proposals

This page owns the internal SCM explanation contract in **unreleased 0.3
development source**. It describes implemented owners, not release availability
or completed end-to-end certification. Package and loaded-runtime gates remain
open; the presentation gaps below must not be documented as completed flows.

## Owners and data flow

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
  projects each stop's first Explain occurrence per file once per reading.
  Hunk annotations look up those notes directly; they do not rebuild the reading.

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
returns `reviewed_marks_unavailable`; result deletion reports personal-mark
cleanup separately without changing that authority.

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

The GitHub source adapter invokes its configured safe changed-files Action with
`comparison: true`, starts at page one, and follows only source-minted
continuations. GitHub attests the merge base as the diff-before endpoint; its
base tip is a separate freshness witness, not the beginning of the patch. It
frames each provider hunk fragment with the exact before/after
paths (including renamed and quoted paths), then the comparison owner supplies
canonical occurrence references. A changed endpoint during pagination retains
the earlier prefix as stale/incomplete rather than appending another code basis.
Missing patch text remains unknown binary/content evidence, not an empty diff.

Files reads PR, branch and commit evidence through the same capture operation,
without a current-checkout diff fallback. Supplying `comparisonId` reads that
retained comparison through `readCapturedScmComparison`; it never recaptures.
Repository, authenticated Session and source must match, otherwise the operation
returns unavailable evidence. The strict optional id is an unreleased 0.3 input
extension, not a safely ignorable instruction for an older capture owner.
Captured Files does not offer working-file preview, staging, discard, or diff-area
controls. Its missing-content and freshness notices retain the original evidence.

The Triage PR-detail Walk entrance reads a source-owned PR comparison locator
from the transient `get` result, not from the persisted entry snapshot. It opens
the canonical comparison destination through typed `session.open` navigation.
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

## Saved edits, personal marks and offline access

`scm.diffSummary.result.*`, `refine` and `addOutputs` use the existing authenticated
machine/Session transport. Writes bind `resultId` and `expectedRevision`; the
machine uses protected atomic local state under the existing runtime directory
and serializes writers with its owner-file lock. Successful changes increment
revision. A stale write returns `revision_conflict` and the latest revision;
clients keep their draft for reconciliation. A refinement binds its output scope
and base before dispatch, so late model output cannot erase intervening edits.
Ordinary conversation prose does not mutate saved output.

Rename, prose edit, reorder, merge, output addition and immediate Undo preserve
unrelated outputs. Merge retains the chosen title and exact coverage. Undo is
revision-checked and preserves current generator linkage. Accepted application
states `applying|paused|unknown` lock editing, refinement, Undo and deletion.
Already-published leading commit groups remain immutable after the lock releases.

The result revision owner also persists walkthrough/stop edited-title provenance,
each stop's latest changed/moved revision, and an update notice identifying the
affected stops (and merged selections when applicable). Immediate Undo restores
the previous provenance and publishes an Undo notice. Host-only admission
progress preserves that same input's unchanged output basis without rebasing
over manual edits or refreshing unrelated pending inputs.

Results survive Run termination/cache eviction until explicit deletion. Personal
marks use `workspace:scm-reviewed:v1:<comparison identity>` with
`{ v: 1, comparisonId, reviewedChangeRefs }`. Both UI and Actions validate exact
membership and rebase the user's specific intent on a CAS conflict; unresolved
conflicts remain visible. The UI subscribes through the existing
`subscribeKvPrefixChanges`, scoped to captured Home/Account credentials. Account
JSON transport owns plain/encrypted envelope admission: plain Accounts need no
fabricated E2EE keys and unreadable/mismatched encrypted data fails closed.

A new code basis gets a different comparison identity and no fuzzy mark transfer.
Prose edits on the same selections keep their marks. A merged stop is reviewed
only when all of its selections were explicitly marked. Unloaded marks are
unknown, not a confirmed zero count.

Settings list count/bytes from the selected machine, not all machines. Its
confirmed Clear combines captured-Account mark cleanup with exact-revision result
deletion. Failed mark cleanup retains the result for retry. A concurrent edit can
refuse deletion after marks were cleared: this is reported partial success, not
an atomic distributed transaction. Combined UI Clear rejects API-token execution;
generic machine deletion retains its separate contract. Neither cache eviction
nor result deletion deletes review findings or Session checkpoints. Individual
machine deletion and optional mark cleanup can also report separate outcomes.

Offline clients can retain an already-loaded projection; they cannot write the
machine result, obtain fresh evidence or accept commits. There is no cold-offline
or cross-machine reconstruction guarantee. Reconnection reads current authority
before a revisioned write. Home/Account retirement withdraws requests/listeners.

## Generator interaction and settings

The runtime contract is `retentionPolicy: 'resumable'`, `runClass: 'long_lived'`,
with existing Session-owned retained interaction. It is not a new retention enum.
A settled output can leave a healthy generator idle. Per-turn structured output
is published by the host, not by observing arbitrary transcript JSON or prose.
The host remains the lifecycle, input-custody and streaming owner.

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
The Summary model and Prepare after each turn declarations use domain admission
before the Account settings CAS write. UI and `settings.set` use that same owner:
unsupported or unavailable model choices and preparation without a supported
selection are refused. Turning preparation off remains possible when the
previous model is unavailable. The existing scalar preference codec is unchanged.
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
