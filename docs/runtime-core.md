# Agent runtime ownership

The host owns the executable Session and turn lifecycle. An Agent plugin supplies its native protocol, correlation and evidence through the public SDK; the host admits input, coordinates work, publishes lifecycle and writes the canonical transcript. Session interaction and finite Execution Runs use that same ownership boundary.

Hosted runner startup failures retain the existing typed `failureCause` in that
Session's scope and local end response. The daemon forwards it through the ordinary
spawn failure projection; it never attributes the shared host's stderr to an
individual Session. Older local end responses without a cause retain their exit
code. A missing admitted runner source names
`RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING` at `client_start`.

Hosted Sessions bind physical Stop to the runtime's ordinary Stop callback before native construction. A native-open refusal can therefore keep serving Pending input and still stop through its existing cleanup owner. Caller-owned child runtimes retain their caller's Stop binding; ending one Session never signals the shared host.

Restart eligibility and runtime status read a hosted Session's own launch mode,
captured from its runner arguments and retained in its daemon marker across
reports and daemon reattachment. The shared host's OS command has no per-Session
launch mode. Direct runners retain command-based mode discovery. Earlier hosted
markers without the captured mode remain unknown and require a fresh resume
before a mode-dependent restart can be admitted.

This page describes **0.3 development source**, not a shipped release or a completed live-validation gate. It is the standing architecture reference; approved plans remain the execution contract for their assigned work.

Native Agent adapters read their inherited configuration selectors through
`context.services.exec.readEnvironment(keys)`. The Exec invocation captures
the Session's existing environment reference and retains it when process
ownership is rebound. Agent-owned selectors remain separate from the narrow
child launch environment; the Agent applies explicit launch values and unsets
over the inherited values. A host lacking this operation reports the existing
`plugin_service_unavailable` error rather than reading another Session's
physical process baseline.

Native skill changes use the strict `catalog-changed` Session runtime event with
`catalog: 'skills'`. The host publishes a content-free observation token in
`agentState.nativeCatalogChangesV1.skills`. The existing Session catalog reader
records the observed token with its snapshot; an open skill query refreshes when
that token changes. Closed queries do no catalog work. Finite Execution Runs have
no Session catalog consumer and do not publish this event.

Native permission requests use the existing Session permission occurrence. A runtime
publishes `nativeChoices` with its requirement identity, readable offered labels,
scopes and canonical response payloads. Clients answer with `nativeChoice`
(`requirementId`, `choiceId`, optional permitted feedback); they do not choose the
effective decision or grant payload. The permission response owner resolves the
stored offer, refuses missing or stale native answers, and applies the native
decision before reporting success. Application failure leaves the occurrence pending.

In 0.3 development, native Review runs can ask structured clarification questions
through their existing execution-run response target, including detached runs.
The interaction policy distinguishes questions from tool permission requests:
read-only tools keep deterministic decisions, and a missing or unsupported answer
target reports interaction unavailable. Answers and cancellation retain the exact
run and controller occurrence; final-result Review questions remain follow-up content.

Application uses each transport's existing decision boundary: MSP awaits its
separate `approval/decide` command result; ACP returns the chosen permission option
from its handler; Codex app-server sends its existing approval response. Response
transports record that decision through their existing return/response path and
do not add an early-response API or wait for a second acknowledgement.

The same response owner requires the attributed Account owner for durable grant
carriers, including rule, mode and execution-policy changes. Shared approvers may
answer once or Session choices that carry no such grant. Caller-specific pending
availability is a projection of this authority, never a globally stored native
fact. Old occurrences without `nativeChoices` retain their frozen reader; current
plugin producers own offered choices. Ask captures the selected occurrence's safe
label and scope through the existing Session status read, without retaining its
executable response payload as presentation data.

An offered choice may include one producer-owned `followUp: { actionId, input }`
for an existing Action. The choice submitter captures it from the stored offer
and executes it only after the native decision succeeds. A catalog save failure
uses the existing `save_failed` recovery; retry applies only that Action and never
repeats the native decision. Claude MCP catalog-saving choices use this carrier,
and all live permission producers publish offered choices; the frozen reader
serves old stored occurrences only.

Session sends, Session runtime events and finite Run events preserve complete
valid text and strict JSON without an aggregate candidate byte ceiling. Their
schemas retain the closed event grammar and identity bounds; transport,
persistence and native-provider limits belong to those boundary owners. Run
markers retain the result's byte size as a nonnegative safe integer independently
of its content size.

ACP tool calls remain Running until native terminal evidence or an explicit host
lifecycle action settles them. Elapsed time alone does not manufacture a failed
tool result. The development transport and plugin declarations have no tool-call
watchdog budget; initialization, idle and prompt-completion waits retain their
existing owners and cancellation behavior.

ACP `session/prompt` provider errors, including JSON-RPC internal errors (`-32603`)
and Gemini's HTTP-shaped codes (`400`, `429`), settle a failed turn even when
generation produced no assistant output. JSON-RPC invalid-request, method-not-found
and invalid-params refusals (`-32600`, `-32601`, `-32602`) remain input rejections.
The host's existing runtime-issue classifier and failure
transcript projector preserve provider messages and typed usage limits for
Session, UI, Voice and finite Run consumers. Nonterminal provider retry activity
does not establish turn completion.

An ACP Agent may project an exact native error emitted as assistant text through
`sessionUpdates.projectOutputDiagnostic`. The host applies that Agent-owned codec
once to the final assistant segment at terminal completion, validates its existing
diagnostic carrier and publishes a failed Session turn or finite Run while retaining
the original text. Copilot uses this for native HTTP errors returned with `end_turn`;
Antigravity uses it for the exact Gemini invalid-API-key response returned the same way.
Ordinary prose, quoted errors and code examples remain assistant content. This
executable development-source contract requires matching SDK, host and plugin
source; older hosts do not consume the optional codec.

Native configuration refusals retain their typed diagnostic through Role policy
preparation. The host's runtime-issue classifier supplies the same sanitized
cause to the Session issue and Pending input settlement. Preparing input before
dispatch does not turn an identified native configuration refusal into a
document or Home dependency failure.

Unclassified typed native turn errors retain `failureCause.phase: turn`,
`failureReason: unclassified_provider_error` and their diagnostic code through
the shared Session classifier. An explicit native cause or known startup phase
takes precedence; the classifier does not infer a transport or authentication
cause from a generic termination message.

Launch and turn wrappers use `projectSessionRuntimeFailureCause` at that existing
Protocol owner. It retains an admitted native Session cause first, then projects
an unstructured exception through the canonical Action diagnostic. The optional
`failureCause.actionCause` keeps that original sanitized Action class, code,
status and phase through Session wrappers and subsequent Action boundaries.
Agent-specific RPC and authentication normalizers still supply their native
facts before the generic fallback; raw exception context is not retained.

Native startup failures retain a redacted native code and the first message line
through the shared startup diagnostic projection. The classifier publishes these
as `failureCause.providerErrorCode` and `providerErrorMessage`; the construction
file log uses that same cause. Native data, stderr and stacks are excluded from
this projection, which reuses the Session issue preview budget. Daemon open
attestation continues to omit provider prose.

Native startup authentication reasons and safe recovery text are projected by
the Agent plugin before host classification. The host consumes their typed source
and sanitized failure cause. The shared unstructured-output classifier recognizes
explicit HTTP/authentication failures; mentioning a vendor environment variable
alone does not establish an authentication failure.
In 0.3 development, Pi and OpenCode decode vendor error facts through
`readProviderErrorDiagnosticFacts` and classify turn refusals through Protocol's
`projectProviderSessionFailureCause`. Google `ErrorInfo.reason=API_KEY_INVALID`
remains an authentication refusal even with HTTP 400. Known typed refusals take
precedence; provider prose is never copied into this typed cause. The host consumes
the projected reason when choosing the public issue source.

Native Codex user messages share one ingress parser for attached-client events and
external history. Text annotations, skill/file references, and image/audio URL,
file-id or local-path parts survive as opaque `nativeContent` on user-only
`transcript-message-committed` events. The host stores that value explicitly in
`raw.meta.nativeContent`, including external terminal replay; native bytes do not
supply provenance, permissions, routing or rendered markup. Display text names
references and marks media previews unavailable; local media files are not copied.
Native subagent activities, collaboration and dynamic tools use the existing shared
tool projector. An activity occurrence never establishes child-thread completion.
Unknown history records use the shared unsupported-content row and safe diagnostic;
attached-client user messages use the same SDK-owned fixed text and a payload-free
warning. Source ordering, paging identity and the actual reply-byte allowance remain intact.

## Idle compaction (unreleased 0.3)

Idle compaction belongs to the Session host. One compaction descriptor, authored
with the Agent definition and resolved for the opened runtime, declares manual
control and native- or host-owned idle support. The host resolves three deliberate
per-Agent Account preferences once at Session start: enabled, minimum conversation
size, and an optional cache-window override. These use the existing settings
Actions; plugins do not add their own settings or watch the preference store.
Changes apply to newly started Sessions.

In 0.3 development, manual `session.compact` Action requests and materialized
composer `/compact` text converge at the host's compact queue insertion. The
host checks manual support, isolates the item from ordinary input, and deduplicates
queued or running compaction. The loop's existing compaction lifecycle tracks
running work; native execution and lifecycle projection remain plugin-owned.
Action admission reports queueing rather than completion. Unlike composer Pending
text, a queued Action request is held in host memory and can be retried after a
host restart. Manual admission has no minimum context-size floor and does not
change idle scheduling.

For host mode, the latest attributed `usage-observed.promptCache` supplies
`lastUseAtMs` and optional `ttlMs`. A clock without a lifetime is useful when the
person chooses a cache window; an override replaces the detected lifetime.
Missing clock remains ineligible even with an override. The host owns the single
Session timer, its fire-time idle decision and `compact({ trigger: 'idle' })`
admission; plugins own only the native operation and its lifecycle evidence.
There is no plugin timer, polling, restart re-arm or retry.

Codex App Server, Pi RPC and OpenCode server map live turn start and non-model
item completion into the public SDK's `resolvePromptCacheLastUseAtMs` helper.
It selects the last non-model item's completion, otherwise turn start; model
completion, usage receipt and historical accounting recovery are not request
clocks. Claude uses its observed native request-start clock directly. Lifetimes
come from the canonical vendor facts only when the route/request evidence makes
them applicable. Codex's GPT-5.6+ lifetime additionally requires a positive live
probe for the route in use. The 2026-11-01 installed-native probe retained the
measured prefix after about 25 minutes on `chatgpt` authentication, native
`modelProvider: openai`, and effective model `gpt-6.1-sol`; API and compatible
routes were not exercised. The recipe and sanitized evidence pointers are in
[the approved research](../.project/plans/2026-11-01-idle-compaction/research/PLUGINS.md#11-codex-actual-route-cache-probe-recipe).

Claude SDK controls resume the existing native Session through the same launch
options as a turn. Their owned query publishes compaction evidence, without
acquiring foreground turn ownership. A matching main-chain `message_start`
supplies its usage clock; replay, sidechains and result totals cannot refresh it.
Claude unified terminal instead delegates idle scheduling to Claude Code and
retains its existing large-session resume choice. Both selected modes default
to enabled at 200,000 tokens; only SDK host mode honors a cache-window override.

These three host integrations are default-off. Codex's default minimum is
180,000 tokens; Pi/OpenCode's proposed minimum is 100,000. OpenCode ACP and the
other surveyed ACP Agents gain no idle capability merely by sharing usage or
transcript readers. Finite Execution Runs have no persistent Session idle flow.

The canonical compaction event projector folds lifecycle events into one row.
The shared attention classifier makes only idle-origin compaction quiet across
plain and encrypted Sessions: no unread, meaningful list activity, foreground
turn or ready/push notification. Measured before/after counts remain optional;
Codex, Pi and OpenCode currently have no characterized measured pair. Coach
cache-expiry diagnosis and remedies are deferred. This section describes the
unreleased development contract, not loaded-runtime or release certification.

## ACP model-selection intent (0.3 development source)

The host projects qualified user/Action model intent as
`configuration.model.selectionSource: 'explicit'`; inherited or unqualified
state remains `inherited`, including omitted historical provenance. The generic
ACP configuration owner applies standalone route controls before model selection.
An inherited unlisted startup choice clears to the native default; an
already-current custom model remains selected. A custom Agent definition can set
`allowExplicitUnlistedModels: true` to forward explicit unlisted choices for native
acceptance or visible refusal. FX uses this policy; the host does not duplicate
its route-specific model validation. Interactive Sessions and Execution Runs use
the same ACP owner. See the [ACP author guide](../apps/docs/content/docs/plugins/agent-runtimes/acp.mdx#configuration-catalogs).

## Shared-Machine runner and payload custody

The daemon and trusted Session runner retain transport, encryption and lifecycle
authority. Agent payloads, requester-selected commands and third-party stdio MCP
servers are untrusted execution; separating their OS identity does not move the
trusted runner. The existing host Exec identity finalizer owns that decision.
Session birth attribution survives resume/recovery; a viewer, editor or approver
does not rebind the Session's execution identity. Missing historical attribution
requires explicit recovery rather than adoption as the custodian or latest actor.

In the unreleased 0.3 MI-1 work, non-owner terminal/raw execution/MCP and
filesystem deputies must consume the same verified requester authority or refuse
before effects. Only the authenticated present Machine custodian may use the
host-issued custodian-terminal recovery path. Agent context, including copied
owner Session MCP context, cannot establish present-person authority. Filesystem
and transfer effects retain their existing path/byte owners rather than gaining
authority from a Session-selected root.

MI-1's shared `happier-agent` user includes the owner's isolated Agent. Peers can
copy selected credentials, Direct-delivered keys and readable Session context;
socket ACLs plus a bearer do not distinguish Accounts sharing that user. This
step separates daemon-private source custody, not all Account material. The
Machine owner can inspect material delivered there even after MI-2 introduces
separate requester users/private checkouts. Native readiness, physical process
custody and the composed Linux journey are not established by registration,
desired enablement or a typed refusal. See [CLI architecture](cli-architecture.md#shared-machine-execution-and-filesystem-custody-unreleased-03).

MI-2 development preserves that host/Agent split and consumes the same admitted
requester through member provisioning, materialization and native launch. Its
ensure-on-use is pre-payload, not a new Session admission or automatic retry.
Session birth identity survives continuation; open-ended access closes on
revocation, while admitted finite work reaches its natural boundary. Native
retirement must not mistake an idle hosted Session or an empty PID map for
confirmed private-resource cleanup. These are development contracts, not a
claim that the pending composed native/security gates have passed.

A new Session start admits the requester's Machine authority once; preparation
and nested readers do not re-admit that start. Machine revocation refuses the
next start, while Home still authorizes each server call against its own Account
and authentication facts. Protected credential custody retains its post-binding
verification until runner exit on the first refused Home call is established;
the existing access-loss cleanup remains responsible for live-work retirement.

## Session input and inline references

In 0.3 development, native Action schema and options discovery use the native
executor; contributed Action metadata uses the plugin placement owner. Session
send preserves an explicit Session-input rejection code as a `rejected` domain
result, including a schema refusal before dispatch. An unanswered transport call
can still settle `outcomeUnknown`. Triage links the created Session before its
one idempotent input admission; it does not put the receipt in spawn initial input.

Image admission is a concrete dispatcher fact, published in owner metadata at
`agentRuntimeCapabilitiesV1.backend.session.media.acceptsImageInput.supported`.
ACP publishes its negotiated image-prompt support. Claude publishes support for
the SDK transport and refusal for its terminal text transport; Codex's native
app-server declares support. Catalog defaults do not supply this fact. The UI's
`sessionImageInputAvailability` owner serves both compact Session chooser rows
and composer image attachment options. An absent publication keeps those options
available; the dispatcher's typed refusal remains authoritative at Send.

The composer persists token-bearing text. Protocol's
[`inlineReferenceTokenV1.ts`](../packages/protocol/src/runtime/input/inlineReferenceTokenV1.ts)
owns `[label](happier-ref:<scheme>:<opaque>)`: the destination is the existing
percent-encoded MentionRef identity, and the nonempty label folds line breaks
to spaces and escapes `\`, `[` and `]`. The prefix is exported once as
`INLINE_REFERENCE_HREF_PREFIX_V1`. Labels are advisory presentation; tokens
do not create identity. A draft chip requires a matching typed reference range;
a message chip requires a matching envelope mention or attachment record.
Unbound tokens project to their label as plain text.

[`renderSessionInputContextPromptV1`](../packages/protocol/src/sessions/messages/sessionInputPromptContextV1.ts)
owns prompt composition. Its `references` input feeds
[`projectSessionInputReferencesV1`](../packages/protocol/src/sessions/messages/sessionInputReferenceProjectionV1.ts),
which rewrites tokens in place and renders one `<happier_references v="1">`
block for the distinct selected references. Ordinary input places that block
before the user text; `userTextPlacement: 'beforeContext'` preserves a native
command's first-line grammar while applying the same projection. Provenance,
browser and Discussion context retain their separate meanings and blocks.

| Bound reference | Readable marker |
| --- | --- |
| Dispatched image | `[Image #N]` |
| Other uploaded file or composer attachment | `[File: name]` |
| Uploaded directory | `[Folder: name]` |
| Workspace file or folder | `@path` or `@path/`, quoted when needed |
| Session | `@Session "label"` |
| Skill or vendor plugin | `$name` or `@name` |
| Workflow or widget | `@Workflow "label"` or `@Widget "label"` |
| Contributed reference | Its trigger and resolved label |

The CLI's
[`resolveStructuredInputProviderContext`](../apps/cli/src/agent/runtime/turns/resolveStructuredInputProviderContext.ts)
builds reference facts after finalizing dispatched image order. Image numbers
are derived by id from that order and never persisted. Upload descriptors in
`attachments.v1` and structured image inputs carry the tray id; contributed
attachments use their existing `instanceId`. An attachment retained after its
chip is deleted remains in the block without an in-text marker.

Session entries carry an id and read-with-a-tool guidance, never pasted
transcripts. Workflow and widget entries use current send-time identity/title
resolution and a read Action when one exists; unavailable references are data,
not a failed send. Contributed context is escaped as data. Existing resolved
context budgets remain in force; replay reservation measures the bounded
reference portion in UTF-16 units. Upload listings remain outside that budget.

New writes use this single projection rather than appending an upload listing
to message text. The [legacy reader](compatibility.md#composer-inline-references-03-development)
preserves 0.2-created messages and normalizes positioned legacy drafts.
[`messageStructuredReferences.ts`](../apps/ui/sources/components/sessions/transcript/references/messageStructuredReferences.ts)
owns inline bindings, legacy row entries and image numbers; its path scan
excludes inline-token ranges. Human readers share
[`messageDisplayText.ts`](../apps/ui/sources/components/sessions/transcript/messageDisplayText.ts),
while only the bound Markdown renderer consumes token-bearing source.

In 0.3 development source, transcript passage **Quote** appends ordinary fenced
text through the mounted Composer transaction Action. **Annotate** instead adds
the first-party `happier.app-context/transcript-annotation` attachment, containing
the exact quote, note and committed `SessionMessageRefV1`. Both target the current
Session draft independently of the source message's identity; neither submits.
Several notes can reference the same message. The contribution's preview edits
the note through the same revision-bound attachment transaction owner, and normal
submission snapshot/accepted-input custody owns sending and clearing it.

The app-context dispatch resolver supplies the quote as escaped data and the note
as the user's comment in the existing `happier_references` block. Only quote and
note reach the model; source identity stays in attachment/navigation metadata.
Sent-message presentation reads
only the admitted quote excerpt, note excerpt and optional typed source link in
attachment presentation facts; it never resolves historical plugin values.
Web uses the transcript selection control; native prose exposes OS selection-menu
actions through Markdown. Uncommitted, streaming, thinking, discarded and
read-only sources are excluded. While a queued message is being edited, the
ordinary Session draft stays available to its background document owner but is
not a mounted presentation target for Quote or Annotate.

## Discussion input and answer lifecycle

In 0.3 development, a committed Discussion question enters the existing Follow
and Pending owners, not a separate Agent runner or delivery queue. Its exact
question, participant and `throughSeq` cutoff travel with protected input
custody into the host turn witness. Injected context and bounded Discussion
reads use that cutoff; this does not erase a native continuation's prior history.

Attachment hydration consumes that same protected source, not a new queue or Agent
plugin API. `readDiscussionInputMessages` supplies the exact original and admitted
ancestors; `materializeDiscussionInputAttachments` opens only their qualified Home
leaves with the Discussion key. The target-neutral `materializeSessionAttachments`
uses the receiving Session's existing encrypted upload/folder-finalization owner
and real issued handles before ordinary structured-file/native-image projection.
No path string supplied by Discussion content becomes local filesystem authority.
Final normal and steer dispatch share this preparation and the incumbent Pending
readmission before/after its asynchronous work. Missing sources, keys or issuance
produce `discussion_attachment_preparation_unavailable`; no attachment-bearing
original is silently downgraded to text. Source tests and loaded Home/runtime
validation remain separate evidence.

The existing Session reply owner arbitrates an explicit reply against the exact
turn's final-result fallback. The Discussion append transaction commits the
publication and settles that original together; a committed explicit reply
suppresses later fallback, including after a lost acknowledgement. Watch-policy
final outcomes are released without automatic Discussion publication. A private
draft instead hands off to the existing person-only Action review: publication
rechecks the approved body and current access; Decline settles the original
without posting. See [Discussion provenance and answer custody](session-collaboration.md#discussion-provenance)
for those owners, policy/review details and current integration limits, and
[Pending delivery](pending-delivery.md#live-runner-wake-up-recovery-development)
for receipt readmission and withdrawal. These are development-source contracts,
not a claim that every native or loaded-runtime journey is verified.

## Session and turn lifecycle

In 0.3 development source, native `runtime-ended` evidence is admitted even when
a turn or accepted delivery remains pending. The host turn lifecycle settles its
exact active turn as failed through the existing failure publication path,
preserving the native diagnostic or using `provider_runtime_ended` when absent.
An idle runtime end does not manufacture a turn, and post-end events stay fenced.
The host's existing completion owner also rejects unfinished turn waiters on
runtime end, preserving the native failure without another deadline.

The host checks the first reported provider Session identity against an explicit
resume target. After that match, a provider-reported rekey within the same Happier
Session replaces the retained resume identity and reaches the existing runtime
subscribers. Claude `/clear` uses this path; Claude's durable transcript evidence
still owns when its new native identity is resumable. Run recovery applies the
same first-identity rule separately to each replacement runtime.

In 0.3 development source, Claude transcript identity readers prefer the native
JSONL `sessionId` over an embedded SDK `session_id`, which can retain the prior
conversation after `/clear`; SDK-only records still use `session_id`.

In 0.3 development source, the native host ingress validates canonical runtime
events once before Session consumers receive the typed event. The Session loop,
stateful transcript projector, turn lifecycle, terminal adapter and checkpoint
observer consume that admitted value. Independent raw transcript replay and ACP
publication retain their own ingress admission. Strict event grammar and the
containing event/send byte envelopes remain; input text, committed transcript
text and file-edit content have no smaller candidate-only quota.

In 0.3 development source, native silence does not schedule diagnostics or
establish a stalled, failed or completed turn. The host consumes actual native
progress, waiting and terminal facts; computer presence remains a separate
authority. Interactive Sessions and finite or detached Runs have no native
silence watcher.

A failed historical Turn remains terminal when a later begin or completion
repeats its native Agent and turn identity. Matching identifiers and a newer
timestamp do not establish recovery. A newly admitted Turn can progress and
complete normally; exact late transcript annotations retain their existing
terminal-state rules.

In 0.3 development source, standard ACP `session_info_update` notifications
reach the host independently of an active prompt turn, including during Session
opening. A nonblank native title seeds an untitled Session through the canonical
`display.title` metadata binding; a valid native `updatedAt` is retained as its
timestamp. The existing `preserveExistingValue` policy keeps any established
title, including a person's rename, and repeated native info does not publish
timestamp-only title changes. Explicit Rename and `session.title.set` continue
to replace the title through the same binding. Execution Runs have no interactive
Session title target.

In 0.3 development source, a correlated JSON-RPC application-error response to
Codex's first `thread/start` or `turn/start`, before provider effects or acceptance, settles input custody
as a nonretryable refusal. The SDK's `exec/protocol-clients` outcome owner keeps
the numeric provider code, request method and message class without publishing
provider prose or payloads. Codex retains model-entitlement refusal semantics;
its structured `input_too_large` response becomes `provider_input_too_large`
with provider-stated character counts. Happier mirrors Codex's native Unicode-scalar
text bound for preflight without adding another input cap or truncation; native
refusal remains authoritative.
Other application refusals use `provider_request_rejected`. Transport loss,
timeouts and errors after observed provider effects retain unknown custody.
Structured image/skill invalid-parameter refusals retain their existing
unsupported-input diagnostic and the same safe provider response identity;
for a new turn, provider-stated size evidence takes precedence. Neither refusal retries as text.
New-turn lifecycle reaches the host only after input acceptance, including when
an attempted send fails. Steers target an already accepted turn, whose output
continues even if the steer input is refused or its custody is unknown.
A refused turn joins its existing quota-evidence
settlement before admission releases that buffer or the host disposes the
runtime. The host turn invariant remains the admission authority.

In 0.3 development source, Claude accepts an SDK prompt from the exact native
`command_lifecycle` started receipt for its submitted UUID. For a brokered Team
credential, the host exposes `activeInput.awaitTurnPublication` from the admitted
credential delivery mode. Both Claude SDK and Unified Terminal await that port
at native `UserPromptSubmit`, before generation. The existing durable outbox
supplies the exact Home acknowledgement: an applied begin releases the effect;
a settled refusal or failed publication explicitly stops that input. Local
journal custody still releases ordinary lifecycle work. Direct credentials do
not install this broker publication barrier.

Claude's failure projection retains an existing typed `failureCause` through the
Protocol runtime-issue reader, shared with host and Codex consumers. Public
runtime diagnostics retain closed cause fields and omit provider error prose;
the existing diagnostic sanitizer remains responsible for sensitive previews.

Codex's native failure reader recognizes an upstream JSON `model_not_found`
code even when app-server flattens the envelope into its error message. The
existing `provider_model_not_found` diagnostic asks the person to choose another
model without forwarding upstream prose. This development behavior does not
infer account entitlement or a later HTTP 503's cause from that earlier refusal.

A structured Codex app-server HTTP 401 without a Connected Account selection
uses the existing `provider_endpoint_auth_required` code in the Session issue
and Execution Run error. The native failure asks the person to sign in to Codex
or choose a Codex account. Connected selections retain account-auth recovery;
specific refresh and workspace-routing evidence keeps its classification.
Protocol's `readSessionRuntimeIssueNativeAuthAgentId` owns the native-auth
discriminator shared by the CLI issue classifier, failure transcript formatter
and UI presenter. Stored previews and message text retain the sign-in guidance
for text-only readers; real Provider credential failures keep Provider guidance.
The host writes one visible diagnostic per failed turn beside its non-rendering
lifecycle marker, whose receipt still anchors the failed turn's history.
This is development-source behavior. It adds no launch-time credential-file
gate: native environment keys and custom Provider configurations still launch.

In 0.3 development, finite Codex Execution Runs disable native
`features.unbounded_connection_retries` when starting or resuming a thread.
Session-owned Runs carry their existing Run id in the host-created
`context.session.executionRunId`, including retained conversations; their
native events keep the Session identity. Detached Runs supply the Run id
directly. Both reach the same thread-config owner. Interactive Session
contexts omit the Run id. The existing runtime debug log records only the
thread request method, whether it belongs to a Run, and the presence and boolean
value of this retry override, including permission-fallback requests.
Codex owns the configured stream retry count, transport fallback and server
retry advice; Happier adds no turn deadline. Interactive Sessions retain their
native connection retry policy. An app-server `error`, including one with
`willRetry: false`, remains diagnostic: only the matching terminal turn event
or proven process loss releases ownership and publishes the typed failure.

In 0.3 development, an Agent's correlated retry notification adds bounded
`retry` evidence to `turn-progress`: a positive attempt count and a closed reason,
never native error prose. The host turn lifecycle alone projects the current
`retrying` phase through registered `runtime.turnProgress` into shared-only
`sessionTurnProgressV1` metadata, so owners and shared editors read the same fact.
Repeated evidence does not republish unchanged phase state. Matching foreground
output or ordinary progress clears it, as do terminal evidence and Stop; a native
turn-id observation alone is not recovery. This is visibility, not a retry budget
or a new turn-settlement authority. Agents without a concrete retry signal do not
manufacture one. The existing activity/phase presenter owns visible copy.

Startup model-intent reconciliation preserves a recognized closed refusal code
through runner diagnostics and the Session issue. Other failed transition results
use `agent_startup_model_reconciliation_failed`; their phase is recorded as failed.
Unrecognized transition prose is not copied into the startup failure.

In 0.3 development, ACP startup Errors retain the numeric request code and a
strict diagnostic carrying the sanitized provider message. The generic Session
construction failure path feeds its accepted failure through the same
[`runtimeFailureTranscript`](../apps/cli/src/agent/runtime/session/transcripts/runtimeFailureTranscript.ts)
writer used for turn failures, so the existing transcript failure row receives
the reason even when no assistant output was produced. Typed native refusals
that precede input admission retain their existing no-synthetic-turn path.
Successful recovery from a named MCP startup failure publishes a normal Session
capability notice through the existing durable transcript service. Neither path
adds a rendering primitive or a second lifecycle owner.

After the native Session factory confirms open, the host publishes `session_opened`
through the existing durable turn-mutation owner before entering the Session loop.
Home clears an older closed startup issue from `Session.lastRuntimeIssue` without
allocating a new turn or changing the failed historical `SessionTurn`. The existing
`latestTurnStatusObservedAt` frontier advances with that resolution, so a late
heartbeat cannot restore the old issue. Non-startup issues and newer failures remain
unresolved. Failed local publication custody preserves the opened runtime, following
the existing lifecycle publication contract; accepted mutations use the durable
outbox's retry owner. This is an unreleased 0.3 contract under the all-component direct cut;
the strict V1 mutation envelope is unchanged and gains this host lifecycle arm.

In 0.3 development, Session heartbeats record liveness only. Canonical turn
mutations commit the turn and its Session projection together; a heartbeat does
not reread historical turns or repair that projection.

Codex app-server can finish a native turn while an already-started tool is still running. The
host records the missing result truthfully. A later result for that exact native
thread, turn and known tool call corrects the same transcript row through the
existing source-timestamp and Message revision owner. It does not reopen the
completed turn or admit another input. Unknown calls, foreign threads and
duplicate completions cannot introduce another tool effect.

Session awareness keeps a completed foreground Turn separate from continuing background work.
`projectSessionAwarenessOperationalV1` suppresses operational readiness while the runtime still
reports background activity; `readSessionAwarenessWorkStatusV1` maps that activity to Working.
The Session-list presentation owner composes these facts with the Account's
`sessionListBackgroundWorkAttentionModeV1`: show a blue center dot on the working indicator for unread replies
(default), show unread status within Working, or temporarily move unread replies to Needs
attention. Reading returns the latter two to working presentation while work continues.
This preference never changes the Protocol-owned personal attention, read cursor, Follow or
access facts. Legacy owner rows translate their existing completion/read evidence before
using the same presentation policy.

Session capability edits converge through the host's
[`capabilitySelectionSynchronizer`](../apps/cli/src/agent/runtime/capabilitySelectionSynchronizer.ts).
It observes the canonical desired selection and applied metadata baselines plus
skill and MCP rules published through the host's captured Account subscription. MCP
observation retains the launch resolver's realpath, Project, Agent and plugin-item
context and its resolved server-selection baseline; it does not substitute a later
catalog for the launch decision. The
Session client's content-free `account-change` ingress and change-feed recovery
refresh the MCP and prompt-library catalogs for the admitted Home and captured
Account lifetime. The foreground Session's demanded Active Account MCP catalog
and an invocation-only Execution Run's captured MCP catalog retain their own
existing hydration owners; refreshing the Run holder does not refresh the
foreground Session's rules. They join the existing in-flight hydration and re-observe rows
after an invalidation. Refreshed rules reach the same synchronizer as Session
selection edits. The Protocol resolver compares effective selections after
Session overrides, so unrelated and overridden rule changes do not apply. The startup rule observation
remains the baseline until native acknowledgement or restart; an unavailable
rules read never becomes an empty rule set. Skills admission demands an absent or loading prompt-library catalog
through the existing captured Account hydrator. An in-flight observation is
not a completed unavailable read: admission must retain the resolved rule
context so later Account wakes can compare Machine and Project rule changes.
Completed unavailable reads retain their typed failure and do not become retries.
Skill delivery resolves referenced candidates from Reach rules and Session
overrides, then opens only selected Artifact bodies through the shared skill-plan
preparer. Startup, Session-owned Runs and live reapply do not enumerate unrelated
Account Artifacts. Machine previews still supply a complete choice inventory to
that same preparer; library listing and cache collection retain their inventory owners.
In 0.3 development, daemon folder materialization correlates the supplied Session
id with its host process through the shared Session correlation owner. Several
Sessions may share a PID; the PID alone cannot select their skill delivery.
Built-in skills use this same delivery path. Their content is bundled, but a
delivery failure still makes them unavailable. The daemon returns a closed
materialization cause, which the client preserves in the Session capability
notice rather than replacing it with the generic `skills_unavailable` code.
An exact Artifact read confirming absence makes retained skill rules and Session
includes inert: the deleted skill is not delivered and emits no load warning.
Read failures and malformed existing content remain unavailable; a readable
Artifact title supplies the warning's name when its skill content cannot be read.
The synchronizer waits for a settled turn and uses P3's `reapplySessionSkills` for declared library-skill
live reload. Native-skill overlay changes and MCP changes use the daemon's existing
restart-with-resume owner with reason `capability_selection_change` and
`force_current_cli`; they never create a fresh conversation as a fallback.
Turn/approval busy refusals wait for the next settled turn.
Capability replacement, runtime refresh and planned Connected Service switches
share the daemon's final replacement gate. It closes Run Start, Ensure and
Ensure-or-Start admission, including aliases declared by their canonical Actions,
at the receiving Session RPC owner and joins requests
already received, including authorization and cleanup before a public Run exists.
The same gate then rechecks child and foreground activity, captures the departing
process tree and verifies process identity before signalling. Creation cannot
enter during those asynchronous checks. Unrelated long-lived readers do not hold
the drain. A creation received during the hold waits under its own cancellation
lifetime without joining the already-received creation drain. Cancellation
retains typed `noRunCreated` evidence through local and transported dispatch.
Initial work admitted by Start remains active while Pending prepares its first
native input, even after the runtime address exists; that preparation cannot look
like an idle retained conversation to the replacement gate.
Before Start reaches the runner, a Session-targeted Machine Action can still be
preparing evidence or awaiting its acknowledgement. The receiving Action adapter
adds its Session and Action ids to the RPC owner's existing active execution
record. The daemon's same replacement activity projection consumes those records
through request cleanup. Read Actions and effects targeting another Session do
not block replacement; the refresh Action itself is excluded from its own check.
Native turn completion also remains active while the host publishes its result.
A profile-authored next part, including review narration, retains that activity
through preparation and Pending admission until the native Agent accepts it or
the host receives a definite refusal. Completed idle results remain replaceable.
The admission hold remains an in-flight private RPC
request after a separate readiness response. Existing request cancellation and
transport retirement reopen admission, without a release-message dependency or
an expiry timer. A clustered room broadcast can lose cancellation without
disconnecting the receiver. When creation encounters a closed gate, or a new
restart attempt encounters an older hold, the receiver checks that exact PID
and attempt through the existing authenticated local daemon control channel.
Only a definite retired result releases the hold; an unreadable daemon leaves
admission closed. The waiting creation registers its cancellation and existing
deadline before this read. Each read follows both that caller and the hold's
lifetime; a cancelled or disconnected creation settles as `noRunCreated`
without entering its handler or releasing an independently live hold. The daemon
retains the attempt's existing request signal on its tracked runner, without
persistence, polling or an expiry timer.
A signalled runner keeps the hold through retirement; normal
completion of the Connected Service deferral callback does not release it. The daemon
refuses to signal if that live request is lost during its final checks. The exact
runner PID and attempt pair readiness with its own hold; a delayed older request
cannot release or authorize another attempt.
An older runner without this operation returns `restart_admission_unsupported`
with the existing Stop-and-Resume recovery, rather than indefinite activity deferral;
security-driven request-auth source cutover retains its interrupting path.
Missing resume evidence
or a launch mode requiring a person's restart leaves the selection pending, with
an apply-status projection rather than a queue or timer. Effective skill- and MCP-rule
changes publish that same projection with `source: 'rules'` before waiting for
settlement or native acknowledgement, so unchanged Session overrides cannot hide
the pending change. The one composer notice reads this status as well as explicit
selection markers, using the admitted Agent timing even before the sheet is opened.
Actual startup
or native acknowledgement clears it, and restoring the effective baseline
withdraws the refusal without reload. Attach preserves the applied baseline;
actual startup application or live-reload acknowledgement
clears the corresponding pending marker, as does restoring the known applied
selection through Undo. Positive skill or MCP launch resolution takes precedence
over an earlier runner's retained rule-pending notice, preventing repeated
replacement before the first input. An attach's current-rule read alone cannot
acknowledge that notice. Explicit current terminal/Windows-hosted launch facts
take precedence over a retained daemon projection when deciding manual restart.
Host publication records the admitted
Agent's resume/live-reload facts in `agentRuntimeCapabilitiesV1.capabilitySelection`
so clients can decide timing without a live Machine round trip. Initial facts use
the descriptor returned by the admitted native factory, retained through host
identity decoration; launch options can predate that concrete runtime choice.
Daemon-started runners resolve these facts from their admitted retained Agent
catalog entry after native-source preparation. The retained leaf projects the
same experimental-resume predicate as the ordinary executable catalog, and
retires it on disposal; a process-global catalog cannot supply a different
generation's resume decision. Codex app-server therefore keeps its declared
experimental resume support for capability changes, while unsupported native
runtime choices continue to fail closed.
These source paths
still require the program's composed live journey before certification.

In 0.3 development source, Session input routing uses Pending's committed
`runtimeMachineTarget` through `readCurrentCommittedSessionInputMachineTargetInTx`.
Input can therefore reach its existing custody while a planned replacement has
no live publisher socket. Archive, Account access and current Machine installation
checks still apply. Runtime effects continue to require a current publisher.
If an admitted Session runtime effect has no current publisher, the existing
RPC classifier returns `target_unavailable`; a current publisher lacking the
method still returns `RPC_METHOD_NOT_AVAILABLE`. A submitted mutation whose
publisher disappears retains `RPC_OUTCOME_UNKNOWN`, not a retryable absence.
When the send requests Resume, the daemon consults the existing intended-respawn
state and signaled-restart PID set for that exact Session, after requester
validation. A pending replacement retains launch ownership; the replacement
consumes the canonical Pending row under its existing local-id deduplication.
This adds no input queue, retry, timer or restart state.

For app Resume in this development source, an issued Machine RPC whose outcome
cannot be confirmed retains `RPC_OUTCOME_UNKNOWN` through the existing Resume
result and `session.open` Action. The shared alert presents **Outcome unknown**
with check-before-retrying guidance and optional technical details. It neither
retries automatically nor claims success from a Ready projection or a completed
native turn; those facts do not establish that the outer RPC reply arrived.

The foreground Pending consumer honours the materialization owner's retry delay
for the same retained claim until settlement or caller cancellation. Repeated
uncertain acknowledgements do not exhaust a separate consumer retry allowance
or require a new Pending event. Results without a retry hint still wait for the
existing queue, metadata or connection wake; input is never enqueued again to
recover a lost settlement receipt. This is 0.3 development-source behavior.

Protected Session inputs re-enter that same Pending admission owner after host
prompt preparation and checkpoint scheduling (or capture for runtimes without
pre-effect tool interception), immediately before a new turn or in-flight
steer reaches the native Agent. A local queue copy or committed user transcript
row does not authorize dispatch after the Pending input is discarded. The host
refuses native delivery when admission is rejected, held or unavailable.
Protected originals retain independent
queue entries so one cancellation cannot reject a valid peer. This applies to
bundled and installed Agents; context-only host inputs retain their existing
separate admission owner.

The host's native foreground assistant projection waits for Home acknowledgement
before publishing terminal Turn anchors. The lifecycle joins the exact input's
existing Pending settlement attempt before reading acknowledged user sequences,
and retains the transcript writer's acknowledged assistant sequence in the
ordered per-turn projection. The bounded notification-preview snapshot is not
terminal-anchor authority; clearing it cannot discard a committed reply. A
foreground turn that emitted text but has no acknowledged reply sequence fails
transcript custody instead of publishing a successful empty result. Workflow
readers keep missing text in result-unavailable attention; an explicit pass
retains its distinct no-answer outcome. Recovery publishes that same attention
on the original invocation without advancing the Workflow or settling its input
custody; an outstanding Stop remains pending until its own outcome is known.
A settled attempt alone is not commit
evidence. The Session client keeps the existing
outbox and close/cancellation lifetimes; sidechain output retains its own path.
The [Session result reader](pending-delivery.md#correlated-session-answers-03-development)
owns observation of retained turns with incomplete anchors.

A host-proven native-mode startup refusal uses that same exact-input outcome
owner in 0.3 development source. Session creation can be acknowledged before its
caller offers the first input, so the failed host keeps its existing Pending
consumer available until ordinary Stop. Later originals receive the terminal
pre-effect refusal; no native prompt, Ready event or successful startup hook runs.
The native-open owner records a refused outcome through its existing runner
attestation before entering that resident refusal path. The daemon observes it
under the same exact runner and Agent-source custody as a committed open; it
never projects refusal as a successful native open. A cold Session startup
refusal does not allocate a synthetic Turn: no input has been admitted, and
the startup operation and exact Pending outcome retain its typed failure.
Other construction failures that publish a diagnostic Turn serialize its begin
and terminal mutations through the same lifecycle owner, including before
daemon turn-marker callbacks exist. A cold Session startup
operation retires the runner it spawned through the daemon's normal Stop owner
before reporting that original failure; it does not wait for a person to Stop.
The observation retains that exact tracked runner and its copied birth identity
for Stop's existing exact-runner selection. A replacement of the same Session
does not inherit the refused runner's cleanup or Stop mark. Failed or incomplete
retirement still reports the original typed startup refusal.
Workflow consumes the failed operation before offering its first input. Native
fork retains its existing child-retirement scope. A refused host without an
observed startup operation retains the late-input consumer described above.
Mode availability is checked before committing successful native-open attestation,
including when the plugin returns a Session before the host refuses its mode.
Plugins that apply configuration during native open publish their observed mode
inventory first. During open, the host checks that publication through its
canonical mode assertion without interrupting construction. A completed open
uses the final inventory and accepted current mode; a mode-specific failed open
uses the latest observed availability evidence from that attempt, retained across
producer cleanup. Later valid current-mode facts clear earlier refusal evidence.
A public error code without matching evidence retains ordinary cleanup.
Native forks observe the same attestation inside their fork owner's child
cleanup scope. The shared Project startup wrapper returns the physical child
identity to that owner, which attempts the existing Stop and archival cleanup
for a refused or exited child before reporting fork failure.
An attested refusal carries its captured runner witness into that same cleanup
scope. Cleanup uses local exact-runner Stop even when the child has a Machine;
incomplete or throwing Stop preserves the refusal without Session-wide fallback.
The existing retained-settlement owner reoffers a failed terminal-block write on
its normal connection/materialization wakes, without redelivering input. Generic
plugin errors, generation retirement and native-resume failures retain their
normal cleanup behavior. No Pending format or public plugin error contract changes.

In 0.3 development source, Role, prompt Artifact and Session Project association
preparation classify Home read failures through the shared endpoint policy.
Network, timeout and retryable HTTP failures publish the existing
`preparation_pending` issue. During startup,
the runner exits with failure after publishing that issue and releasing its
construction resources, so the daemon's existing respawn budget can retry with
the retained initial input. Definitive Home refusals publish terminal attachment
failure instead. File diagnostics retain only endpoint classification and status;
they do not include response bodies or request credentials. Loaded-daemon
recovery still requires the program's composed live replay.

Session metadata tuple publication uses the same Home endpoint failure policy.
A retryable HTTP failure may follow a committed write: the existing tuple
coordinator accepts an exact observed result or retries an unchanged source,
within its existing attempt budget and publisher-currentness checks. If the
result remains ambiguous during construction, the host publishes
`preparation_pending` before cleanup and exits with failure so the daemon can
retry startup with the retained initial input. This applies to bundled and
external Agent plugins without a provider-specific retry path.

Bootstrap HTTP 5xx failures from Account-mode/currentness reads, Machine and
Session admission, and Session/Machine access-key lookup or binding retain their
Home evidence through the same canonical issue classifier and command reporter.
Access-key preparation also retains timeout and network failures. During runner
creation it reuses Session creation's existing retry budget and backoff. Every
attempt rejoins the same creation tag and Session/Machine tuple;
a lost binding receipt never overwrites an established key. Exhaustion preserves
the preparation failure rather than reporting that no durable Session exists.
After Session custody exists, construction publishes `preparation_pending` before
cleanup; the runner preserves a nonzero exit for existing daemon recovery.
Account-mode bootstrap does not reinterpret Home unavailability as missing keys.
Authentication and definitive client refusals retain their existing disposition;
native Provider HTTP failures are not classified as Home preparation failures.
This is 0.3 development source; loaded-runtime recovery requires a separate replay.

Account catalog hydration also distinguishes a retryable Home-currentness read
failure from missing or mismatched E2EE material. The former retains the existing
`unreachable` catalog result; no private row is opened without successful
currentness admission. Optional MCP preparation may omit that unavailable catalog
with its existing notice. Strict MCP preparation instead publishes
`preparation_pending` and exits with failure so the daemon's existing respawn
owner can retry the retained input. Actual missing material remains closed and
does not acquire this transient recovery disposition.

Metadata PATCH transport uses that mutation's caller lifetime and cancellation,
including explicit Stop intent and terminal-control retirement. The generic
Session HTTP read timeout does not shorten a metadata mutation. CLI and UI Stop
both reach the owning daemon's physical Stop owner. In development source, their
Action adapter uses the incumbent exact-Machine dispatcher, preserving admitted
requester custody for local execution and authenticated RPC for other targets.
The Stop service reads either the physical daemon receipt or a requester
executor's canonical public Stop result for that exact Session; a confirmed
public receipt is not reparsed as an unavailable daemon, and an unconfirmed
receipt remains unconfirmed. Their
Account front doors classify `session.stop` once: an omitted public `stopIntent`
means `explicit_stop`; resource surfaces declare `lifecycle_control`. Internal
Stop ports require that intent. Info and CLI Stop attempt to persist the explicit hold before
the physical operation. Processes, widgets, Guard, Storage holder cleanup and
Machine Runs Stop release the runner without creating or clearing a hold, so the
next ordinary message remains eligible for automatic wake under the existing
resume policy. A pre-existing hold still applies. Both Account writers use the
Protocol `buildSessionStopHoldV1` record builder. UI uses the scoped Sync metadata
tuple writer and preserves the admitted Action context; automation cannot acquire
a person's hold. A failed hold write does not prevent the existing physical Stop
owner or runner-RPC fallback from receiving the request. A confirmed Stop with a
failed hold write returns `stopped:true, holdRecorded:false, holdFailure:<code>`;
the code comes from the metadata writer's closed, payload-free failure vocabulary.
The explicit Stop operation reports failure even when physical Stop succeeds:
UI returns `success:false` with the metadata failure code and a localized retry
message; CLI and Agent Actions return that code in the failure envelope. The
physical receipt remains available alongside the hold facts, including in the
CLI failure details. Physical-stop confirmation and hold persistence remain
separate facts. The UI's existing Stop error presenter shows the
failure instead of announcing success or advancing to Archive.
The metadata writer retains its existing retry policy; Stop adds no retry loop or
later hold scheduler. Without a recorded hold, later input may wake the Session.
Account/caller retirement and cancellation still fence physical dispatch. This adds no Account credential to restricted Session runners and no
second Follow admission guard. A lost receipt
or cancellation after emission remains uncertain and does not prove retirement.
The daemon uses the admitted runner's matching Account credentials for its own
Stop metadata and retirement, without rebuilding requester execution services.
Foreign Account custody retains its existing requester authority checks. Local
control binds preparation and metadata writes to the request connection; an
unsettled explicit Stop returns `incomplete / explicit_stop_failed` rather than
claiming that its runner retired.

In 0.3 development, Stop and archive inactivity observation follow the caller's
cancellation lifetime without a separate ten-second cutoff. They wait for the
existing Session event source, with no idle reads or repeated archive writes.
The transactional archive owner publishes only real archive-state changes:
repeating archive preserves the first timestamp, and repeating unarchive leaves
the Session and Account cursors unchanged. Tag rejoin still records its genuine
activity transition. Each new archive request retains its normal access admission.

Admitted Follow originals retain their server-validated input admission receipt
through canonical and legacy message projections. A required original's transient
Home source-read failure uses the same pre-turn preparation wait, retaining the
exact input until recovery. Definitive Home refusals remain terminal. Optional
Follow context still omits unavailable content without turning it into required
input or a runner restart. These are 0.3 development-source contracts; loaded
original acceptance remains a separate live check.

Development question offers bind the original request's existing `currentHandler`
to the admitted Follow input. Pass-up uses the request notifier again; the source
dispatcher reads that assignment from its already-authorized AgentState snapshot
and merges the exact handler with ordinary and rule routes. An ancestor needs no
permanent Follow of the worker. An assignment-bound offer remains distinct from
an earlier generic notice of the same question, while retries of that assignment
reuse its existing input identity. Source disclosure, keys, mute, Stop and native
acceptance retain their existing owners. Hydration rechecks the exact live request
and handler before presenting its form; BasePermissionHandler alone decides answer
eligibility. No second question, queue, handler writer or escalation timer is added.

In 0.3 development source, the daemon's planned-restart activity gate also reads
child work from the Session's live Execution Run manager. A retained idle Run
does not prevent replacement; an active child turn defers the signal. The execution
registry's existing change notifications wake that wait. The daemon lifetime or
Connected Account deferral owner cancels it before a late signal can escape.
Only accepted exact foreground-turn custody updates the restart deferral queue;
legacy transcript notifications without a turn identity retain their downstream
recovery role but cannot mark the foreground busy or clear a live turn. Busy
restart results identify the activity source in their existing diagnostics.
An unavailable child-activity observation refuses replacement with a partial
failure, rather than claiming that a turn is in progress.
Ordinary runner refresh also reads native Agent work through the existing
requester-qualified Session input live-work RPC. The host Runtime Activity owner
exposes its Agent slot separately from its Execution Run slot; an active child
therefore keeps the existing drain behavior rather than becoming a native busy
refusal. Active native work returns busy. A successful unknown or absent native
report permits refresh, preserving compatibility with non-reporting runners;
an actual read failure refuses replacement with the existing activity-observation
failure. The same native decision governs previews and signaling, and is checked
again after a child drain and process-tree capture. Session-wide Runtime Activity remains the aggregate presentation
and settlement projection, not a second native-work authority.

A manual app restart confirms possible interruption of background work. The
confirmed operation uses the unchanged ordinary V1 or process-attested recovery
V2 request through one dedicated authenticated machine/local-control route and
sets only the existing restart owner's internal native-interruption permission.
It never bypasses foreground-turn refusal, child draining, process identity or
Provider binding validation. A request reason is descriptive and cannot provide
this permission. On an older daemon that lacks the dedicated method, the app
sends the matching unchanged V1/V2 operation only after consent. Authentication,
cancellation and other failures do not trigger that fallback. Connected Service
switches and private request-auth source cutover retain their existing policies.
Refresh completion follows the canonical respawn operation through retirement,
preparation and its existing spawn budget; a separate handoff timer cannot expire
a healthy replacement. Equivalent refresh requests keep joining the reserved
attempt while it waits. The adopted-runner physical exit observer retains its
existing observation budget. Refresh eligibility
reflects explicit replacement support; unattested generation freshness remains
unknown and cannot authorize an automatic `if_stale` refresh.
Foreground-turn refusals keep their existing retry behavior. Credential retirement,
request-auth source cutover and other security retirement paths retain their
interrupting behavior. Refresh and respawn diagnostics retain the caller's reason
rather than labeling every planned replacement as a Connected Account switch.
The development `session.runtime.refresh` Action reads the hosting Machine's
current runner status and defaults to the banner's guarded `if_stale` request.
Its explicit `mode: 'force_current_cli'` uses the existing V2 exact-process
restart for same-Session model changes and reviewed Provider binding recovery.
The UI dispatches that same Action with the exact previous/next binding security
confirmation when needed; spawn-time continuity remains its authority. The UI
retains background-work confirmation, while a headless caller receives the
daemon's typed busy refusal rather than silently consenting. All callers wait
under their lifetime while the daemon defers replacement; they do not impose a
shorter client completion deadline. The extended closed Action input requires
matching 0.3 development Action hosts; existing stale-refresh inputs and V1/V2
daemon requests are unchanged.
Status reads preserve typed transport failures and reject mismatched Session or
Machine identities as `partial_failure` with `invalid_response`. Only a missing
daemon RPC method (or the daemon's explicit unsupported-version response) produces
`unsupported_daemon_version`. Before a runner starts, the existing identity guard
returns `runner_not_active` with `no_tracked_process`; a missing V2 process witness
on an active runner is `version_unknown`, not proof of an old daemon. The UI
offers startup recovery, daemon update, or connection/status checks accordingly.
Explicit V2 Provider binding recovery can complete an incomplete tracked process
witness from a fresh OS observation when the existing launcher/runner identity
and the person's expected runner still match. It then uses the ordinary guarded
stop-and-resume path, preserving the conversation and passing the exact binding
change confirmation only to the replacement attempt. Passive status reads and
automatic refresh do not change the binding or repair these witnesses. Machine
Provider consent and spawn-time binding continuity remain the authorities.
Loaded-daemon replay requires the orchestrator's next authorized reload.

## Native Agent seam

In 0.3 development, ACP prompt usage projection may complete asynchronously at
the existing prompt-response boundary. The host supplies the native Session id,
effective process environment and cancellation signal to the
Agent's optional completion context. CodeBuddy reads its existing native journal
only when the ACP result has no usage, correlating the result's user message and
conversation request with immutable native message identities. The ordinary
Session usage publisher remains the accounting owner. Missing native facts remain
unavailable; this adds no collector, background reader, polling or synthesized
counters. Matching SDK, Agent and host development readers reload together.

Native skill changes use the strict `catalog-changed` runtime event with
`catalog: 'skills'`. The existing native Session publication owner records one
content-free `agentState.nativeCatalogChangesV1.skills` token from its runtime
incarnation and admitted event sequence, within that publisher's current lifetime.
The UI's existing skill catalog owner compares this opaque token with the local
snapshot observation when skills are demanded; an open skill query refreshes on
change, while a closed composer performs no catalog read. This unreleased 0.3
contract moves Protocol, SDK, host and UI readers together in the current epoch;
absent observations preserve existing snapshots. It adds no background reader,
second catalog store, timer or retry.

In 0.3 development source, the terminal host owns native exit observations.
Borrowed foreground launches keep their qualified IPC producer. Independently
created Herdr hosts with a direct native invocation capture a positive PID and
exact argv observation, then use the existing process fingerprint custody check
to prove exit. Foreground absence, a different foreground command and failed
discovery remain unknown; an alive retained shell is a separate pane-liveness
fact. Herdr has no native lifetime push for these panes, so the private host
observer checks custody on the established 30-second cadence while exit
subscribers exist and stops on unsubscribe, retirement or replacement. Adopted
hosts without their original native invocation remain unqualified. Existing
Agent consumers own turn failure and recovery from the qualified exit event.

In 0.3 development, foreground Stop aborts the prompt-loop lifetime and starts
native turn cancellation alongside permission withdrawal. A pending Home write
for withdrawn permission requests must not delay the native interrupt. The Stop
operation still joins both outcomes. Once the native runtime reports cancellation,
the host publishes its cancellation marker and cancelled turn independently of
pending transcript finalization. It still drains every durable text/tool write and
then appends acknowledged reply anchors to that same turn. Successful completion
continues to require transcript custody before publishing completion. Independent
Runs keep their own permission and cancellation lifetimes. A late acknowledged
partial can enrich the same unreturned cancelled reply; an already returned reply
is never replayed.

[`AgentRuntime`](../packages/plugin-sdk/src/agentRuntime/runtime.ts) has two mutually exclusive forms: a Session factory or an execution-only Run factory. A Session-capable Agent does not add an independent Run lifecycle. For Session-owned Runs, the host binds its Session runtime into the shared Execution Run adapter in [`nativeAgentExecutionRun.ts`](../apps/cli/src/agent/runtime/bridges/executionRun/nativeAgentExecutionRun.ts). Detached execution requires the Session factory's declared `executionRunContextV1` facet; it cannot fabricate a parent Session. The shared SDK implementation in [`executionRun.ts`](../packages/plugin-sdk/src/agentRuntime/executionRun.ts) owns correlated Run events, cancellation, terminalization and disposal for the finite/conversation adapters.

In 0.3 development, a detached native Run with host-owned MCP placement receives
Happier Action discovery and execution through its own bound invocation services.
The existing Action owner supplies the Run identity and admitted permission ceiling;
the bridge supplies no Session identity. Native admission selects authenticated
loopback or the invocation's prepared transport, and the Run's native launch
qualifier retains that selection. Disposing the Run retires its exact MCP
registration. Runner-delegated native launches retain their existing admission
path without claiming local host endpoint custody.

The engine registry's [`runtimeCore.ts`](../apps/cli/src/agent/runtime/registry/engineRegistry/runtimeCore.ts) resolves the admitted Agent runtime and composes host services. Agent code receives the scoped public context, not raw host lifecycle controls. Agent-native configuration in `RuntimeDescriptorV1.agent` is interpreted by its Agent; generic host code must not infer its meaning from an Agent id.

In 0.3 development source, an Agent declares equivalent permission-request coverage
through `requestCoverage` on its contribution, derived from the same Protocol shape
as `AgentDefinition.requestCoverage`. The admitted host uses that exact declaration;
the UI uses the selected Machine's existing Agent projection. The shared Session
core consumes the supplied options. The live SDK and remote CLI Follow/awareness
readers have no producing Machine contribution input and use the selected bundled
declaration available to them; dynamic coverage is unavailable on those paths.
Local CLI runtime readers use their selected installed declaration. Source names and
completion reasons belong to the Agent declaration. The existing completion window
and same-request comparison remain shared runtime behavior.
Permission producers may provide a structural `traceSummary` through
`session.services.permissions.requestDecision`. Generic permission traces retain
the redacted marker and that safe summary, and never fall back to request input.
Dialog text and choices remain private to the permission flow.

In 0.3 development source, an Agent's accepted native mode completion uses the
optional `session.services.modes.complete({ modeId })` operation. The host clears
only a matching saved mode selection through the canonical Session intent writer,
under the current runtime and publisher authority. `modes.bind` continues to
publish observed inventory and current-mode facts. Claude invokes completion for
Plan after an approved SDK permission or exact main-session native ExitPlanMode
acceptance; denial, feedback and failed native hooks do not clear Plan. The native
follow-up permission choice keeps its existing owner. A failed completion emits
a warning without changing the accepted tool result.

In 0.3 development source, daemon engine resolution carries the executable catalog
entry already acquired from its runtime lease into native-home and authentication
service composition. A declaration-only projection cannot supply those executable
hooks. A retained Session runner keeps its exact admitted contribution and catalog
entry, so its services remain bound to that generation.

Long-lived Runs retain their native interaction until host settlement under both
ephemeral and resumable retention. Retention determines recovery after settlement,
not whether a running conversation accepts another turn. Session-owned Runs
forward their foreground native tool calls and results through the existing
Run transcript publisher, which owns sidechain identity and publication custody.

In 0.3 development source, Pending-target reconciliation uses that live interaction
for both request/response and streaming Runs, including before the first input.
Without a controller, the canonical Run lifecycle decides whether queued input can
recover the retained conversation. Transcript I/O and retention do not independently
mark a live target unavailable. Loaded-runtime replay remains separate evidence.
Bounded execution retains its own turn queue rather than consuming target Pending.
An exact Run-input wait observes that Run's Pending delivery status before waiting
for its transcript anchor: a proven block returns its typed refusal, not an
outcome-unknown timeout. Missing evidence still means unknown; observing a refusal
does not resend the input or implicitly recover its native occurrence.

Detached long-lived Runs select the same retained-interaction
eligibility owner as Session-owned Runs. They open the optional
`sessions.executionRunContextV1.openConversation` operation, which returns the
existing scope-neutral `AgentExecutionRunConversationRuntimeV1`. The host admits
each input, correlates its turn, and settles its output without disposing the
conversation. Host Run settlement disposes it. Missing conversation support
refuses that retained operation before native opening; the finite `open` facet
keeps its single-turn terminal semantics. Bundled and installed Agent factories
use the same operation discovery. Neither open nor recovery supplies a Happier
Session identity for a detached Run, and recovery retains canonical credential
preparation and exact native checkpoint admission.

Detached input admission uses the Run's permission-policy owner for both public
Actions and Agent input. Public input receives a fresh ceiling from the admitted
Run mode. Agent input preserves its original causal ceiling while its private
current caller mode bounds that turn; the host carries that mode through direct
IPC and input metadata into permission and nested Action admission. It never
passes the private mode in Agent SDK send options. An idle conversation has no
active input authority, and lost private authority refuses rather than inheriting
the opener's ceiling.

In 0.3 development source, host Exec executable resolution and launch preparation mark a typed
`PluginError` with `execLaunch: 'notStarted'` only when it refuses before starting
the requested process. The SDK's canonical `isPluginError` reader recognizes the
typed error across bundled SDK copies. A native send adapter must
also establish that its input was not dispatched: the launch marker alone does
not settle an earlier input's custody. Codex preserves a known prelaunch refusal
as `input-rejected` with its original code, which the shared Execution Run adapter
projects as `run-failed`; errors after native input dispatch remain outcome unknown.
This contract applies to host Exec services for bundled and installed Agents.

In 0.3 development source, Claude's SDK query correlates initial and in-flight
user input with native UUID acknowledgments requested through
[`--replay-user-messages`](https://code.claude.com/docs/en/cli-reference).
A successful stdin write alone leaves acceptance pending. A submitted record
without its matching nonsynthetic main-chain user acknowledgment at exit,
abort or disposal remains outcome unknown, preserving the existing Pending and
replay-seed custody without automatically resending it. The host's correlated
acceptance outcome retires the seed; native transcript resume proof remains
separate.

Primary Session input admission projects its immutable causal permission ceiling
into the effective queue mode once, through `modeFromUserMessage.ts`. Ordinary
messages and host-only Workflow steps use that owner. New turns, queued inputs,
resume and replacement consume the admitted mode. In-flight steering requires
that mode to be effective already, or an applied native configuration change;
a scheduled change is insufficient and leaves the input queued for a new turn.
The Session's owner-selected baseline is unchanged. ACP and App Server use their
existing configuration and approval-policy owners to enforce the admitted mode,
or refuse before provider effect when enforcement is unavailable.

The new conversation operation also enforces each input's resolved public
`permissionIntent` before native input effects. The host derives it through the
same Run authority owner from the Run mode, original causal ceiling and current
caller mode; the original causal witness is not rewritten. Claude, Codex and ACP
use their existing native configuration owners to apply it, or refuse the input
when enforcement is unsupported. Host approval callbacks alone do not constrain
native tools running under an unrestricted opener policy. Finite V1 sends do not
receive this new option.

Claude's canonical `read-only` intent maps to native `plan`, not `dontAsk`:
allowed native writer rules must still reach the host's read-only decision.
When the SDK query has a host `canCallTool` callback, stdio retains prompt
ownership; an advanced custom prompt tool cannot redirect those approvals.
Standalone queries without that callback retain their custom prompt tool.
Claude's terminal controls consume that same mapping. Configured ACP requires a
concrete native permission-mode mapping from the existing Account catalog's
`runtime.permissionModeMapping` and refuses an unenforceable intent.
Kilo's launch-only policy can admit only an intent proven to match its canonical
launch environment; it refuses narrowing or unproven native overrides instead
of pretending to update the retained conversation.

In 0.3 development source, native Session and Session-owned Run launches share
[`launchEnvironment.ts`](../apps/cli/src/agent/runtime/launchEnvironment.ts).
It carries the admitted runner's command-search `PATH`, Windows machine paths,
host TLS trust and documented tool-idle values captured at Session start alongside
explicit launch values. The tool-idle table in `processes/toolIdleTimeouts.ts`
owns that selection; Off creates no value here. Explicit overrides and unsets
survive the existing platform-aware environment composer. Other ambient credentials and
host controls remain private. Both Claude SDK and Codex isolated launches consume
this environment; terminal hosts retain their existing environment owner.
Windows machine paths, including `ProgramFiles` for Docker CLI plugin discovery,
share the `utils/processEnv/environmentKeys.ts` owner with standalone Runner
filtering and environment-key validation. Inherited values and spelling are
preserved, including `ProgramFiles(x86)`. Explicit overrides and unsets still win;
isolated Runner Homes and credential filtering retain their existing owners.

Runner-hosted plugin Exec requests also inherit this captured Session or Run
environment before daemon launch authorization, using the same platform-aware
composer. Explicit request values take precedence. Reused Session services read
the final scope after late profile or Provider materialization; Run services keep
their own scope. This applies to bundled and installed Agents.
Codex's live app-server Goal and usage checks use the opened runtime's retained
native client. The host selects `AgentSessionRuntime.goals` and
`AgentSessionRuntime.usageLimitRecovery` ahead of their factory facets;
factory controls remain the default for Agents without a per-open control.
The existing manifest declaration, native support signal, turn serialization,
publication and disposal fences still apply. This public SDK seam is shared by
bundled and installed plugins and introduces no native-client registry.
Codex's factory Goal facet serves inactive Sessions; a live call through that
facet refuses without spawning when the runtime-bound control is unavailable.
Codex ACP opens explicitly suppress native Goal controls because the ACP
transport has no native Goal port; the existing host Goal fallback applies.
Explicit app-server usage checks read fresh quota on the retained connection,
without launching a control process or disposing the Session's client. Inactive
checks retain their short-lived admitted control client. ACP has no retained
app-server quota connection and retains the factory quota probe.
Other runner-hosted control clients inherit the Session's scoped `CODEX_HOME`.
Fully resolved native launch tuples retain their already-composed environment.

Inactive native Goal, catalog and usage controls obtain their scope from the
daemon's admitted Session launch composition. The persisted Session snapshot
selects its Launch Profile and Connected Account; the existing spawn Profile,
Provider, Connected Account materializer and child-environment owners resolve
the native scope. The control retains those resources through acknowledgement
and cleanup. Missing admission, an unreadable binding or a different Account
returns `inactive_agent_launch_scope_unavailable` before native execution;
there is no fallback to the daemon's native account home. Bundled and installed
Agents consume the same host boundary. The control context carries this
admitted target `launchEnvironment`, so Codex passes its values to the native
client before startup-lock and SQLite argument
selection. `CODEX_SQLITE_HOME` selects that client's existing `sqlite_home`
override; inheriting the variable only at Exec authorization is too late for
that selection. Missing scope refuses before native execution. A caller
addressing another Session uses the target's live runtime or admitted inactive
scope, never the caller's native home.
This is development-source behavior; loaded-daemon replay remains separate
verification. A managed Provider whose final endpoint scope requires a running
Session is refused until that scope can
be admitted; inactive controls never substitute native-account defaults.

Session-owned bounded Runs whose Agent declares new-turn delivery keep the native
Session available until the host's bounded loop settles. A first native turn can
require the profile's structured-output repair turn; it does not complete the
host Run. The existing conversation adapter serves those turns, and host
settlement disposes the Session, including for ephemeral Runs.

In 0.3 development source, a Run's structured result uses the last assistant
message of the turn, including corrections to that message. Plain-text results
retain earlier message artifacts, and the sidechain transcript keeps all messages.
The execution Run message handler selects the result using the admitted turn's
prepared contract; strict decoders receive no commentary
prefix. This covers bounded, direct and retained-input completion paths.

In 0.3 development source, Session-owned Run output enters the Session's durable
transcript journal with sidechain provenance, including final results rendered
on the parent's tool call. Journal admission releases the Run's publication
wait without awaiting Home acknowledgement; the same outbox retains delivery
and recovery custody after native cleanup. An explicit `requireDelivery`
admission still waits for Home, preserving ordered foreground observations.
This correction requires a fresh runner for loaded-runtime replay.

Voice Run stop and Session disposal release acquired native runtimes before
joining their active turn or lifecycle work. The existing Voice instance owns
its chat, isolated commit, and provisionally opening chat replacement; retirement
releases each through the same runtime disposer. A late cancellation cannot
acquire a replacement after that instance has retired. This is development
source behavior, not a change to retention or the existing idle-lifetime policy.

In 0.3 development source, Voice chat, isolated commit, and replacement runtimes
use the selected ordinary permission intent without a Voice-only native tool
ceiling. Canonical Action effect approval remains owned by the Action executor;
an explicitly selected read-only intent still applies. Existing daemons need a
reload to consume this change.

Codex host function delivery is independent of that native permission policy.
Unrestricted recipes advertise flat host functions directly to code-mode-only
models, so OpenAI-compatible providers do not have to preserve a custom function
namespace. Explicitly restricted recipes retain the isolated `happier_host`
namespace: exposing native `functions` there would also expose excluded native
tools. Local Voice uses Protocol's Action catalog and the shared UI Action
executor. A requested new coding Session receives its task through Session
creation; spoken Brief requests use the Inbox Action rather than shell discovery.

The Voice settings schema owns the idle lifetime default for both clients and
the CLI. A confirmed primary Run Stop remains successful if the optional sweep
for other matching Runs cannot load its inventory; that failure emits a cleanup
warning. A refused or unreachable primary Stop still reconciles against the
execution owner's exact Run state. Continuation on another client retires only
the departing client's local custody.

Session-owned child Runs retain their own transcript sidechain and interaction scope. They cannot publish the parent Session's work-state or active-input readiness; those projections belong to the main Session context. Finite and retained child contexts use the same Run-scoped work-state service, which reports Session projection as unavailable.

In 0.3 development source, child contexts compose the same ordered transcript
follow service and source projector as the main native Session. The retained
external-session source feeds the child's own native observer; display and user
source facts use the Run's sidechain writer and its current controller custody.
The parent supplies the committed-id baseline, not its active follow binding.
Run disposal releases only that child's source-follow resources.

In 0.3 development source, the host hook service admits the child's exact native
transcript location before forwarding an authenticated SessionStart or statusline
observation. Statusline can arrive first. Admission settles once per native
binding in that runtime's scoped file-follow registry; it does not grant a
directory or authorize a different Run's transcript. Transcript rows and readiness
wakes do not re-admit that binding. A refused Claude terminal source-follow
acquisition retains its typed failure, keeps observation unknown, and stops
automatic readiness wakes. An explicit new native binding can acquire its own
source; the failed binding is not automatically retried.

In 0.3 development source, required terminal transcript follow binds before
launch when the native Session identity is already known. A fresh terminal
launches without a fabricated identity; the host observes the provider's existing
identity publication and binds required follow once that evidence arrives.
Terminal completion or Session retirement before publication fails admission
closed. A refused follow binding stops the launched terminal through its existing
cancellation signal; waiting for identity adds no timer.

Claude terminal replies enter the same correlated committed-text channel as SDK
replies before the host settles a child turn. The codec publishes only current
primary reply facts admitted by ordered source follow, with their native fact
identity. If a Stop hook names a reply not yet observed there, its completion
evidence waits for that reply; it does not start structured-output repair with an
empty Run buffer. Historical replay and native sidechains do not close that turn.

For main Sessions and Session-owned Runs, the canonical ordered transcript writer
uses that shared durable baseline for historical replay and fresh initial
admission. The follow producer does not filter display rows or own another
deduplication decision. Actual Home acknowledgements update the same Session
identity set, including direct SDK commits. Native display facts already committed
through the SDK are not rewritten with a different native-source timestamp.
Source-observation receipts still reach the current native observer, new display
facts are published, and later live updates retain their normal publication path.
Semantic custody does not prove media custody: a failed media publication is
retried through its existing owner before the source frontier is acknowledged.
Home's same-identity timestamp and provenance checks are unchanged.
The committed local-ID reader pages all Session scopes to completion under the
containing follow admission's cancellation and deadline, retaining identities
rather than message bodies. Total committed-history length does not make a
baseline incomplete; failed reads or a non-progressing cursor still refuse follow.

In 0.3 development source, both Session-derived Run adapters bind hook-server
and hook-plugin-directory creation to the child invocation lifetime. The child
retains its genuine parent Session identity but cannot reclaim that Session's
persisted hook port or overwrite its retained hook files. The existing hook
resource owner allocates and disposes the invocation resources. This correction
requires a fresh runner after the CLI reload for loaded-runtime validation.

In 0.3 development source, Session-owned Runs execute in the Session runner.
The runner-local registrar retains Session controls, sidechain/transcript delivery,
Pending and WorkerUpdate. Before admission it acquires a pinned executable snapshot
over the existing tracked-runner daemon service at
`/agent-runtime/session/services/v1`. The daemon's
[`snapshot producer`](../apps/cli/src/rpc/handlers/executionRuns/acquireExecutionRunRuntimeSnapshot.ts)
leases its canonical executable registry and derives admitted profiles and the
selected child Agent's retained source binding from that same lease. The runner
loads the child factory through the existing retained-source loader; it does not
discover another catalog or populate a daemon singleton. Native child tool services
resolve the verified child's CLI metadata through the canonical Agent CLI resolver;
they do not inherit a different Agent's captured launcher. An exact captured launch
keeps its existing binding. Native offered-model evidence is read through that
snapshot's daemon service, using its admitted Agent catalog and the owning
Session's Account context. Unknown models still refuse structured-output admission;
Provider and Team selections cannot borrow a native model's capabilities.
Continued Review narration uses the controller's retained reader and Agent
projection; recovered Runs reacquire them through the same snapshot owner.
Admission prepares profile
prompt text through the existing daemon contribution service using that lease;
the Run retains the prepared instructions. Ordinary later resource reads still
obey publication fences. The existing controller occurrence retains its admitted
profile catalog for Pending, send, Actions, public projection and terminal hooks,
so another acquisition cannot replace a live Run's profile decisions.
Review scope, commit-message repository evidence and the fresh working-tree
comparison's commit-target witness are prepared over the same
runner-to-daemon services channel with the retained Run snapshot. The daemon
selects SCM through that snapshot's executable registry; the runner retains
profile lifecycle and does not construct an SCM registry. Commit-message
preparation preserves the requested path scope and the profile's existing
evidence budgets. The witness uses the existing SCM capture owner rather than
falling back to an absent runner-local registry. Missing, retired or foreign snapshot custody refuses
preparation before Run creation.
Inherited Provider admission and personal-Provider launch preparation also use
that retained executable registry over the same service. The tracked Session's
Account reader supplies settings and source currentness; the runner receives the
existing scoped environment, binding and exact redaction values. The retained
snapshot owns in-flight preparation and cleanup, including abandoned runner
exit. Typed incompatible/unverified child-choice details survive the service
boundary. Existing Team credential preparation keeps its separate authority.
In development, an attached managed Run binding admits its exact occurrence,
Agent, model and Provider selection once when opened. Later sends and private
binding reads consume that proof and the existing binding cancellation, tracked
PID ownership and Account-scope lifetime; they do not repeat the Run-authority
RPC. End/close releases the binding. Recovering a released binding is a new
admission and never replays a model request.
Review host Action admission and new grant caller references read the daemon's
current registry through the authenticated tracked-runner service. Once approved,
review comments retain that admitted subject and its exact prepared operands;
signing and sending preserve the Account, body and machine-installation proof
checks without comparing plugin source or policy again.
Session and Run bridge lifecycle notifications likewise dispatch through the
existing daemon contribution service, selecting the current registry for each
event. Child-event metadata does not replace the issuing parent Session's
transport authority; no runner-local catalog is populated.
These service consumers require the runner's canonical authority-file
environment. The daemon launch producer supplies it for daemon children;
the foreground CLI owns it for its Session lifetime and restores the previous
values at cleanup. Accepted Profile-secret re-admission refreshes both paths.
Deferred native preparation reads the accepted claim's current authority path
while retaining the original bootstrap identity and exact-source checks.
Loaded-runtime validation still requires a fresh runner after the CLI reload.
Runner-to-daemon service preparation belongs to the containing invocation,
including native launch preparation and Project setup or approval. The pending
working-tree correction binds its service proxy to that invocation's cancellation
and removes the implicit five-minute transport deadline. This correction is not
yet committed: the committed service client still defaults to 300,000 ms when no
timeout is supplied. Do not infer the correction from a fresh runner alone; it
requires the changed client and invocation binding to land and be loaded together.
Explicit caller deadlines remain effective. Response loss after dispatch retains
its unknown effect outcome rather than authorizing replay.
The bridge binds snapshot release to Run runtime
cleanup, and the daemon's existing tracked-runner exit cleanup releases abandoned
leases. New acquisition refuses unavailable or replaced authority with a typed
result; unknown operations on an older daemon cannot become an empty snapshot.
Omitted child selection consumes the parent's applied model/auth reader, while
explicit `agentDefault` and incompatible-Agent choice retain the canonical
child-selection rules. Inheritance joins the Session's internal controls-installation
notification, then the existing applied-selection registration promise. Complete
explicit selections for every requested role do not read or wait for the parent.
In 0.3 development source, ordinary Review Start with no model, credential route,
role or profile choice requests that existing `agentDefault` selection: the Account's per-Agent target
model takes precedence, then the Agent's own default. Explicit Review choices
retain their normal custody. `resolveExecutionRunAgentDefaultSelection` owns the
Account lookup for launch and for the daemon's `review.engines.list` inventory.
The inventory's optional `launchModelId` reports a concrete Account-configured
model; omission leaves the Start engine subline empty for the bare Agent default.
An explicit Team model suppresses that reviewer's default subline; the existing
Team picker names the chosen model.
The UI reads these daemon facts rather than choosing a model itself. This source
change still needs the composed live Review replay after the updated runtime loads.
Cancellation, controls withdrawal or replacement,
and fenced applied authority still refuse with
`execution_run_parent_selection_unavailable` and `noRunCreated`. Local file
diagnostics identify the unavailable reader or authority predicate. There is no
separate public readiness probe or startup deadline; each attempt rechecks applied
custody. A first parent turn alone does not certify the parallel daemon registration.
The daemon's applied-parent reader and Run credential
materialization resolve the accepted runner through canonical tracked Session
identity, including wrapper launchers. The reader uses that Session's existing
runtime-registry target; Session exit retires Run credential authority using its
tracked runner PID.
Attached SCM summary Runs inherit the applied parent when available; otherwise
they use the configured summary model with the child Account's default route.
If that default belongs to another Agent, SCM submits it through canonical
Action admission only after the parent attempt proves that no Run was created;
profile input never changes an already admitted Agent target.
The bridge resolves this selection before preparing the summary profile so its
saved generator describes the admitted model. These are development-source
contracts pending loaded daemon/runner validation.
The generated RPC adapter retains schema-approved
`childChoice` details and discards unknown data. Target equality compares complete
Protocol Agent keys without treating the runner's global catalog as executable
admission; the daemon snapshot producer still proves the selected factory.
These source contracts require daemon and runner reload
together for loaded-runtime verification; they do not certify an already-running
Session or a released artifact.

In 0.3 development source, the daemon owns diagnostic refusal of runner
`plugin_services.prepare_v1`. Its preparation owner stamps the failing stage;
the control response carries a closed, bounded `{ code, stage }` cause and the
runner preserves it in `PluginError.details.cause`. The daemon writes the same
cause in one `runner_plugin_services_prepare_refused` local file-log line.
Raw exception messages, stacks, paths, credentials and arbitrary error details
are excluded. Refusals without a cause remain readable. This diagnostic changes
neither authority nor retry behavior; loaded QA replay remains a separate check.

The daemon starter's readiness timeout bounds the starter's observation, not
plugin execution. The existing daemon plugin runtime owner awaits source
preparation, module loading, required startup activation and initial Resource
admission before publishing the serving registry. Reload uses the same startup
activation predicate as cold start; demand-only Agents stay dormant. Primary
Agent runtimes are constructed on demand, not as a publication readiness probe.
A valid update adopts the new version; if its Agent constructor fails on first
use, that request reports the new version's error without restoring the prior
version. Slow work remains
pending under its real occurrence lifetime and can settle without restarting
the daemon. Elapsed startup time is not a participant failure; real failures
retain their diagnosed unavailable result.
In 0.3 development source, the daemon's existing cancellation signal also owns
pending source preparation during initial and later registry resolution. Abort
joins the preparation process tree's retirement, prevents targeted fallback and
initial serving publication, and follows the existing startup cleanup path.
It does not add a startup deadline or shorten the helper's existing budgets.
Required synchronous consumers do not receive an incomplete registry merely
because the starter stopped waiting. See [plugin preparation](plugin-platform.md#generated-ownership).

Session MCP bootstrap reads the same daemon plugin catalog through the existing
control client. `/plugins/catalog/read` has no implicit generic control timeout:
a loaded daemon's delayed response is not a catalog-unavailable fact. An explicit
caller deadline or cancellation still ends that caller's wait; actual transport
or catalog failures retain their existing unavailable result. This changes no
catalog authority, retry loop or Session lifecycle owner.

Applied Connected Account parent selection and Execution Run generation
currentness reads likewise follow their containing Session or Run operation,
without the generic control HTTP cutoff. Explicit caller deadlines and
cancellation remain effective; delayed reads do not prove retired authority.

Execution Run Connected Account materialization also waits for the canonical
root writer and credential preparation without a default HTTP deadline.
`HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS`, when explicitly configured,
sets the caller's deadline; the control client does not clamp it to ten minutes.
Elapsed queue or preparation time alone does not establish a failed child Run.

The lazy Run runtime supplies its existing disposal signal to Connected Account
materialization. The runner control client and daemon HTTP request lifetime carry
that cancellation into the canonical spawn-auth resolver. The daemon retains
this request lifetime through response delivery, and the materialization owner
keeps cancellation bound to the exact returned activation. Cancellation after
target registration or during delivery releases that activation through the
existing retained cleanup owner; a queued cancellation cannot release its
successor. HTTP write completion ends this connection observation; it does not
prove that the runner received the activation. The runner allocates the existing
activation identity before dispatch and retains the issuing daemon target. A
lost, invalid, mismatched or locally cancelled response releases that exact
activation on that daemon before it can become launch input. Release distinguishes
an already absent activation from retained cleanup failure; failure is not
reported as completed cleanup. This describes the 0.3 development-source
contract, not availability in an already loaded daemon or runner.

The established Connected Account owner admits one materialization snapshot
under a requester verification at entry and verifies the requester again before
returning the result. Nested field reads share only that invocation's custody;
they do not perform another Home/Machine/Session admission. Credential and
configuration revisions remain checked around the runtime callback, and field
reads retain cancellation, occurrence and observed configuration-revocation
checks. Completed materializations cannot lend authority to retained readers.
Refresh, revoke and other established operations keep their existing fences.

Executable Connected Account launch snapshots use the Agent catalog acquired
from their existing runtime-registry lease. Cold contribution declarations do
not contain every request-auth, file or environment launch fact. Reading them
alone can suppress capability production before the plugin opens; acquiring the
catalog later in materialization cannot repair that earlier snapshot. The
daemon's explicit spawn-environment handoff carries the materialized capability
into native launch without inheriting ambient host authority.
Retained runners reconstruct those static launch facts from their attested
source, not the daemon's newer global Agent, and release the activation with the
retained catalog lease. Hard revocation still refuses acquisition.

Ordinary Connected Account request-auth lookup and quota reporting inherit the
containing request's cancellation signal in 0.3 development source. Neither the
host service nor the SDK's generated private transport imposes a default phase
deadline: valid requester and credential verification can outlive the former
20-second host and 30-second transport cutoffs. Explicit caller-supplied budgets
still apply. Authentication recovery keeps its separate provider-recovery budget,
and capability, purpose, credential revision and currentness checks still run
before any bearer is disclosed.

Request-auth subjects retain the exact issuing purpose lease's in-memory
binding and materialization ports. Recovering a Session's requester Account
runtime can create another purpose owner; that recovery verifies current
requester custody but cannot replace the issuer's process-local lease map.
Capability authentication preserves these host-only ports without serializing
them. In development source, lookup refusal file logs preserve owner-issued
causes for malformed Home projections, missing or unfenced credential snapshots,
identity/revision mismatches, unavailable content or encryption material, and
purpose authorization failures. Binding and bearer callbacks share the same
cause projection. Unclassified failures add only the canonical content-free
error class and recognized exception code to the existing single lookup refusal
record; exception messages, payloads and arbitrary name/code fields are excluded.
Public request-auth errors retain their existing redacted envelope.

Plugin-declared MCP servers in 0.3 development source enter
[`resolveSessionCapabilitiesV1`](../packages/protocol/src/reach/resolveSessionCapabilitiesV1.ts)
as `plugin:<pluginId>/<localId>` items. Catalog rules and Session selection
decide their inclusion together with Account-managed servers. Rules choose
defaults; an explicit Session include admits an existing item even
with no rules or rules only for another Machine or Agent. Agent support remains
an admission constraint, and the machine materializer retains its typed failures
and notices. Preview and runner preparation realpath both MCP and skill workspace
rule roots through the same machine path owner before Protocol containment;
stored and displayed root spellings remain unchanged.
The existing hosted loopback attaches selected dynamic registrations; it does not choose
servers independently. Forwarded MCP peer tools retain their original names
under the MCP SDK tool schema; host-authored hosted tools retain their existing
namespace validation. Static declarations use the existing executable owner
or remote bridge. Wire-name assignment reserves only enabled native servers
whose discovery source declares `loadedInHappierSessions: true`.

Daemon-launched runners request plugin MCP preparation through the existing
authenticated runner service bridge. The daemon retains the executable registry
lease across declaration projection and selected-server attachment; the runner
keeps directory selection, wire-name assignment, private native configuration and
tool-policy projection at their existing owners. Native-server discovery uses
that same lease so the wire-name owner can reserve names already loaded by the
Agent. Recorded Stop refuses new preparations. An applied MCP profile retires
its exact preparation when replaced or stopped. The daemon's tracked-process
cleanup also joins pending attachment work and disposes it on runner exit. HTTP
response completion does not end the Session-owned hosted endpoint. This private
development contract requires the daemon and runner to be reloaded together;
it adds no runner executable registry or public SDK operation.

In 0.3 development source, native Session checkpoint commands use that existing
runner services channel's private `host_scm.run_v1` operation. The daemon invokes
the canonical host SCM runner with the invocation's retained isolation context,
authorization and cancellation lifetime. This context also exists when Machine
isolation is disabled or no Machine isolation port is installed: the Session
invocation owner retains requester custody independently of OS isolation. Git
then runs as the daemon/Session runner OS user through the same Exec owner;
enabled isolation retains its selected execution identity. Isolation is not
projected into the runner, and the Agent plugin's Exec resolver still rejects
undeclared Git.
Ordinary Git commands carry text stdin and the existing output/time budgets.
Checkpoint materialization carries `ls-tree` output into an exclusively created
host-owned file; binary `cat-file --batch` output uses a temporary shared-host
spool, with the byte consumer/parser and cleanup retained in the runner. The
daemon's existing command owner still enforces the batch's output budget.
Interactive stdin and early-settling stream consumers are not supported by this
private checkpoint port; no general plugin process authority is added.

A repository checkpoint phase crosses that channel once: `host_scm.checkpoint_v1`
carries the message-start capture, or the turn-final capture plus its diff against
the turn-start base, and the daemon runs the phase's Git commands locally through
the same per-launch Exec authorization, returning the capture and diff results the
Session's change card is built from. The turn-start alias stays one
`host_scm.run_v1`. A target-placed workspace runs the phase in the Session host
through its workspace source, with no daemon round trip. The turn still completes
after its checkpoint card, and a refused card write still fails the turn.

In 0.3 development source, daemon-started Session runners acquire their own
Home carrier before command startup and retain it until the command ends.
`runWithRunnerHomeTransport` reuses the Account-client carrier acquisition policy
and native Home identity verification; it does not register the daemon's persisted
Machine EndpointId. Spawn passes the configured URL-only route, never the daemon's
process-local listener. Carrier acquisition failures retain their typed cause.
Existing runners launched with an older daemon-local route need replacement
through their normal lifecycle before they consume this correction.

Native Home and Machine tunnel listeners share authenticated connection custody.
After QUIC closes, the next local TCP connection reacquires the same descriptor
EndpointId through that owner and retains the published listener origin. Healthy
connections remain shared across local streams. A failed acquisition ends that
local request and leaves the listener available for the next request; there is
no idle reconnect timer or backoff loop. Normal lease release closes the current
connection and joins its local socket pumps. Native UI adapters project a retained
disconnected lease as `degraded`, continue their existing observation, and report
terminal `closed` only when native status confirms the lease no longer exists.

Session runners can survive daemon restart. The incumbent services proxy may
reprepare an invocation only after a proven pre-effect refusal, and does not
replay an ambiguous in-flight command across authority replacement. Missing
invocation custody context, unsupported daemon operations and unavailable
authority fail as `scm_exec_unavailable`, retained as unavailable checkpoint evidence rather than
`not_repo` or an empty successful comparison. Existing service operations remain
compatible for an older runner on a newer daemon, but an older runner retains
its old checkpoint binding: validating this correction needs both daemon and
Session runner reload, not a UI reload alone. Missing historical checkpoint
objects cannot be reconstructed from the present worktree.

The public `services.mcp.resolveServers` signature is unchanged. Its host
implementation projects the applied runner set and never repeats a catalog or
rules resolution. Session-owned Runs receive their own applied projection;
detached Runs retain execution-run scope and cannot attach a declaration that
requires a Session. These source paths are not a claim of completed live QA.

The shared ACP cancellation owner releases the cancelled prompt's raw request
custody before publishing terminal turn state. This includes host-denied MCP
calls: the next admitted input must not race that cancellation and be refused
as a still-settling predecessor. Permission denial continues to cancel the
current prompt through the same owner; plugins do not own host turn state.

In 0.3 development source, known third-party MCP wire names resolve through the
runner's canonical item-identity map and Protocol's tool decision owner. The
launch-name owner assigns portable server keys before handing them to Agents,
reserving both native names and their normalized spellings and suffixing
collisions. Catalog ids remain unchanged in that map. Protocol's
`formatMcpToolWireNameV1` / `parseMcpToolWireNameV1` own wire encoding and
decoding; approvals resolve only against recorded launch keys, never by guessing
which catalog name a native Agent normalized. Existing Sessions keep their
captured mapping until a fresh launch. Off
remains denied under full access and existing grants, including when a pending
permission answer is rechecked. Read classification requires both the server's
read-only opt-in and the tool's annotation. The built-in Happier server retains
its Actions policy. For an admitted native Session declaration, MCP entity-row
publication wakes the existing captured Account snapshot subscription and sends
the current projection through the ordinary configuration-update carrier;
Settings need not change. Invocation-only foreign-Account reads retain the
existing Saved Secret operation holder: MCP admission publishes the row into
that captured holder, and the owning Session or Machine's existing AccountChange
and reconnect wakes re-read demanded rows through it. A captured catalog failure
withdraws that holder's tool authority; credential retirement clears its readers
and subscriptions. A failed demanded MCP read does not prevent the Machine's
unrelated notification, Pending, or cursor convergence; cancellation or captured
Account retirement encountered during that demanded read still refuses the
catch-up. An already-retired holder has no catalog demand. These reads never
retarget the process's Active Account.
Ordinary foreground Sessions retain their captured Active Account scope and
lifetime; Session-derived Runs reuse the existing Session configuration carrier,
not a new detached-Run control method.

The 0.3 development approval logic preserves the host's validated `mcpTool`
identity through Session-core's stored request, transcript and pending-request
projections. Its Always-allow controller answers through the existing Session
permission owner, then writes `mcp.servers.tools.set` as the present user. A
failed catalog save retries that write only. Capability enablement uses the
existing `session.capabilities.set` approval and its review-only `reason`;
Always retains the deciding rule's Agent qualifier and writes through the rules
Action. The shared apply-notice producer reads the current desired/applied
metadata, so a stale preview cannot retain a cleared notice or claim a live
reload was acknowledged. Card rendering and composer placement remain separate
capabilities-program integration work.

MCP Action observations and public approval reads retain the validated tool
default/overrides and non-content operation controls (reach, removal, step-up and
preview choices). Private replay operands and executable or credential values
remain separate; a public approval read is not replay authority. This is current
0.3 development behavior.

In 0.3 development source, the shared runner MCP resolver publishes skipped
non-strict servers in one committed Session `message` when their failure facts
change. It retains the last set in private Session runtime metadata
(`mcpCapabilityNoticeV1`), so unchanged turns and resumed preparations add no
notice. Server ordering does not count as a change. Successful preparation
clears the failure set silently; a later failure is a new transcript entry.
The resolver retains its debug diagnostics. The typed
[`capabilityNoticeV1` sidecar](../packages/protocol/src/sessions/messages/sessionCapabilityNoticeV1.ts)
contains the server name, reason and optional library item id. Its canonical
reader validates the notice independently of the message; malformed or future
sidecars leave the fallback text readable. Explicit Saved Secret catalog failures
retain their existing fail-closed error path.

The Host's selected-server MCP notice publisher, shared Skill-failure publisher
and optional prompt-library warning await the transcript journal's local admission, not the Home
delivery ACK. Successful admission persists the stable notice identity before
preparation returns; the same journal retries delivery and Home deduplicates it.
MCP journal-admission failure still throws to startup; Skill and prompt-library
notice failures retain their existing logged best-effort handling. Required
context, credential and post-admission currentness checks are unchanged.

Pi's development MCP extension discovers optional servers independently of native
Session readiness and one another. A peer that has not answered initialize or
tool-list does not hold Pi's RPC reader or ordinary turns. Completed catalogs
register through Pi's native tool refresh and become available to subsequent
model requests. Session shutdown closes pending peers and joins their discovery;
it cannot register late tools. Spawn, initialize and tool-list failures close
only that optional connection and keep healthy tools callable. The existing JSON
stream carries the canonical notice through the public transcript publisher,
without raw peer error text that could
contain secrets. The runner's existing strict-mode fact travels with
`mcpServers` as `mcpServersStrictMode` on Session and Run requests; strict startup
failure closes all connections and refuses startup instead of continuing.

Pi's development input observer also uses the existing Happier tools extension.
Every conversation launch prepares that extension, including Sessions and Runs
without configured tools. The extension observes extension-origin text at Pi's
public `input` hook and sends it through the native RPC notification stream. The
Pi runtime consumes that observation before diagnostic logging and publishes one
session-scoped user transcript fact per submission through the existing host
projection. Host input keeps its existing recording owner; raw user-message
echoes do not create additional rows. A recorded submission may be transformed,
handled or cancelled later and does not prove final model delivery. Provider-started
turns continue through the existing Pi runtime and host turn invariant.
The same event-publication owner retains startup events until the first host
consumer attaches, then delivers them in order. Internal observers do not consume
that startup history; later observers retain the existing metadata catch-up.

In 0.3 development source, the shared Session loop captures a completed host
turn's nullable assistant preview in the ordered terminal transcript projection.
Ready notification dispatch consumes that captured result, preserving an empty
answer even if a provider successor has already produced text. Working state
continues to follow the canonical Session turn lifecycle, so host-loop cleanup
cannot mark an active provider successor idle.

In 0.3 development source, the [Session lifecycle](../apps/cli/src/agent/runtime/session/loop/lifecycle.ts)
activates the decorated runtime event stream for transcript projection. Delivery
outcome and typed identity registration are passive. The same lifecycle event
fanout supplies Runtime Activity and provider-session identity metadata, preserving
provider startup output until the transcript reader attaches. Native runtime
hooks continue to own prompt delivery, cancellation and turn completion.

In 0.3 development source, prompt Artifact preparation uses the admitted Session
HTTP route for the active Home; a saved descriptor supplies Home identity rather
than overriding that route with its HTTPS endpoint. An unavailable prompt-entry
transport keeps preparation pending, including for optional entries; definitive
absence can omit an optional entry with typed unavailable admission facts.
Optional plugin augmentation can report `prompt_library_unavailable` through
the committed capability notice, with no document or Account identifiers.
Required inputs, invalid or locked content, and cancellation retain their
fail-closed preparation path. Recovery is checked on the next preparation.

Independent daemon prompt augmentation and Account/Project source preparation
overlap before composition. The shared Protocol prompt-stack owner likewise
reads selected document addresses concurrently, then interprets their results
and failures in authored Account → Profile → Project → Session order. Duplicate
addresses share reads only within that preparation. Memory-off still admits
headers before deciding whether to read bodies; it never opens omitted Memory
bodies. Every document read settles before the stack returns or refuses, and
the Session plan's final Account and Profile fences still run before publication.

The Session host also prepares skills and MCP concurrently, joining both before
native open and retaining each owner's captured Account checks and cleanup.
Each selected OAuth MCP server opens its own capability concurrently; a strict
refusal waits for all issued siblings before retiring their capabilities.
Startup phase durations for skills and MCP therefore overlap and are not additive.

An explicit native refusal of startup instructions withdraws that capability for
the opened runtime incarnation. The replaceable host runtime forwards this fact
to the prompt loop, which uses its existing complete-plan prefix delivery instead
of reopening the same unsupported native path. A genuine runtime replacement
observes support again; no installed-binary capability cache or plugin-id special
case is involved.

An admitted prompt plan retains its prompt-library snapshot for the current
dispatch. A same-Account catalog refresh or row revision during preparation
does not withdraw that plan or prevent startup; the next preparation reads the
new snapshot, and skill changes use the existing synchronizer at settlement.
Account lifetime retirement, Settings changes and Profile authority changes
still withdraw prepared instructions and policy. Currentness compares those
authority facts and Account decryption material; independent MCP/catalog
maintenance, observation timestamps and equal-content Settings refreshes do
not withdraw a prepared prompt. The Account snapshot owner retains unchanged
preference and key identities when accepting a newer revision. Withdrawal
errors retain `context_source_unavailable` and identify the failed active or
captured Account, Settings, lifetime or Profile check in their typed `reason`.
Optional plugin augmentation retains the notice above; an unavailable selected
document remains pending. These source contracts require a rebuilt CLI
closure and fresh runner for loaded-runtime verification.

In current 0.3 development source, `template.instantiate` has Account placement:
the requester's host runs one admitted parent Action and can commit birth while
the selected Machine's daemon is asleep. Ordinary Session creation commits or
rejoins the creation key before its host-local `beforeLaunch` continuation
composes the recipient's instructions, Memory, Session-only skills and private
template instance. The continuation remains invocation-local and never crosses
the UI-to-daemon transport; the signed immutable recipe carries deferred setup.
Only after it settles does the ordinary Session launcher admit the first input.
That input has the strict host-owned `hostOnboarding` producer: the transcript
renders a Happier event, and the first turn uses read-only permission without
changing the Session's chosen permission mode. Its prompt introduces the Bot
and offers the optional first task; it does not execute that task. A content
failure retains the committed Session and known resource IDs and prevents launch.
The browser birth adapter retains ordinary initial access, manager, primary Team,
Team credential bindings and organization placement. Browser birth uses the same
projection and merge as CLI creation to send the reviewed Team model as a Session
binding intent. Home checks the recipient's entitlement and the reviewed resource
revision at creation. The runner uses the binding accepted by Home. Direct-recipient E2EE
envelopes use the actual new Session key during creation; collective envelope
preparation uses the existing served Session key before the content continuation
and first Pending input.

Full-credential template Actions admit the review once, then use the host's
ordinary Account credential. Approved agent Copy/Apply runs on the person's own
daemon using generic original-Session approval custody. The same executor runs
reviewed children; Artifact grants, Session ownership, envelope audiences and
MCP envelopes retain their domain owners. The template format, preview and consent
confine foreign content. Restricted PATs retain their token-only template-purpose
grammar; requester authorship is not an authority input.

Recipient setup is prepared by the shared template operation before birth:
software selections become one ordinary Machine setup input, Connected Account
choices remain recipient references, and MCP entries use the existing catalog
and Session-capability owners. The private template instance carries lineage and
local item mappings, not setup jobs or credentials. A Pending input acceptance is a birth/admission result,
not proof that setup or the runner has completed.

Copy invokes ordinary setup Apply and terminal observation from the existing
`beforeLaunch` creation continuation, after Session birth/content and before
accepted-instance settlement or Agent launch. Updates use the same ordinary
`machines.setup.plan` / `machines.setup.apply` Actions through the host's private
reviewed-child port. The Machine owner decides Manage and the exact target.
The UI binds its reviewed child through the existing present-user confirmation
owner; the daemon executes the child on the originating host with the person's
ordinary credential. The UI's exact reviewed child reuses the
person's consent rather than creating another setup card. Standalone UI Machine
approvals retain the existing mounted top-level continuation owner.

Scoped tokens use their own credential throughout. Template software uses the
ordinary setup Action approval path and requires the token's own setup grants;
template grants alone do not install software. No-software Copy and Update remain
available through their token-only transport. Template setup does not define a
separate credential or approval transport. A failed
installer preserves its typed cause and leaves the accepted base unchanged; a
fresh reviewed retry can reuse a born Session without starting its Agent early.

Software-only setup Runs retain Session scope and Account work-depth policy
without requiring an applied Agent launch baseline. Concrete Agent steps still
consume full launch admission and the same ambient Role/inventory observation.
The native operation waits for its child through the combined Run owner, bound
to the accepted operation's exact parent. This uses the existing change feed,
cancellation and Session self-dependency checks; public unbounded Agent waits
retain their existing restriction.

Updates use the same Action-operation and resource owners. The demanded review
loads the accepted upstream base and bound local content; the shared three-way
comparison supplies text/file choices. Selected writes settle before the private
instance CAS advances the accepted base/version. Partial results retain their
applied and remaining resources for deliberate recovery. They do not perform
Memory merges or implicit Agent restarts. Direct-source accepted-version reports
are best effort after settlement. Deferred starts use the already loaded private
instance and admitted requester credentials only after runner success, without
another Session read, background retry or polling loop.

In current 0.3 development source, the daemon's [admission drain](../apps/cli/src/daemon/lifecycle/admissionDrain.ts) owns fresh-work quiescence. Temporary drain preserves accepted custody, native request-auth and daemon publications; reopening wakes the incumbent Automation claim loop and parked Workflow admission. Fresh turn and managed-process authorization remain closed during drain. An authorized opening or opened Session's fresh-work daemon-service request waits on that same drain under its request cancellation lifetime, then rechecks runner authority before dispatch. A reversible managed activity probe therefore cannot turn its overlap with a first turn into a terminal input refusal. No service effect enters before admission reopens. Plugin handoff retains its own exclusion and publication custody: fresh-work service requests wait for reopening, while refused publication ingress reports `daemon_draining`. Final shutdown uses `daemon_shutting_down`, including for a parked request. Final shutdown closes admission irreversibly and awaits the existing finite-operation owner's actual settlement before disposing native plugin leases, terminals or roots. Unconfirmed Stop retains that custody and keeps observation and explicit repeated Stop reachable; it does not prove settlement. Session-hosted Execution Runs ask that current daemon owner over the scoped control transport before creating a Run; an unavailable admission reply refuses the new start. Retained Run state stays with the [execution registry](../apps/cli/src/daemon/executionRunRegistry.ts), rather than becoming another drain decision or start registry. These source contracts are distinct from loaded-daemon certification.

Each temporary drain returns its own idempotent release function. An incomplete
daemon Stop releases only that Stop's contribution; another temporary drain,
unused-Stop probe, plugin handoff or final shutdown continues to close admission.

In 0.3 development source, authenticated local daemon `/stop` with
`stopSessions: true` returns `sessionResults`, one `{ sessionId, result }` per
attempted Session. Each result uses the existing Session Stop contract, including
`incomplete` with `runner_exit_timeout`. Both the `stopping` and
`session_cleanup_incomplete` acknowledgements retain these outcomes so Stack can
report the blocking Session without reconstructing a reason. Daemon-only Stop
keeps its status-only reply; older daemons may omit `sessionResults`.

The private Session-service request lifetime begins before its initial authority lookup and remains active through drain waiting, authority revalidation, dispatch and durable admission. Cancellation retires the waiter, withholds any unaccepted admission and clears its exact marker when cancellation occurs before acceptance is confirmed. The existing request-lifetime and admission owners retain that custody; no separate cancellation timer is added.

New Session spawn and replay wait for reversible drains at the daemon admission owner. A read-only unused-Stop probe releases only its own drain. A successful native-effect idle confirmation retains the Stop gate and refuses new spawns with `daemon_draining` until the current Stop owner reopens it or the daemon shuts down. Final shutdown reports `daemon_shutting_down`, including to parked spawns. Foreground admission/claim/options/release, runner restart, Connected Account switching and local-service actions keep their immediate-refusal policy and existing typed codes.

The plugin-change service retains its own handoff exclusion custody and uses the same refusal codes in its existing `{ kind: 'unavailable', code }` envelope. Requests refused before preparation or after prepared-candidate cleanup report `daemon_draining` while reversible handoff holders remain; only the service's final stopped state reports `daemon_shutting_down`. Resuming every handoff holder reopens change admission unless the service has stopped. The authenticated change route, CLI diagnostic and development Actions preserve that cause.

Finite Windows PTY work now consumes the existing [native process-custody owner](../apps/cli/src/subprocess/supervision/processCustody.ts), not ConPTY's root-exit notification as a descendant-settlement fact. Its finite helper mode assigns the actual target to the same Job before execution, retains the Job until positive kernel membership absence, and returns the recorded root exit code. Ordinary managed-service helper semantics remain separate and unchanged. Completion-port notifications may be lost; explicit Stop queries/terminates that same established Job and a positive zero-membership result wakes the retained helper. A Get/Wait or output EOF alone is not this recovery. Consumer, native-platform and loaded-runtime validation remain open in development source.

POSIX natural-root uncertainty preserves the original exit waiter, cancellation subscription, output custody and finite reservation until a positive owned-group settlement or explicit recovery. That group witness does not itself prove that a non-disowned descendant in another process group exited; the job-control process-tree validation remains open. Native preparation's host-private Exec custody similarly must retain its actual supervisor resource through unconfirmed cleanup, rather than treating callback completion as process settlement.

### Session process custody (0.3 development)

The Exec supervisor exposes two native facts on one `PluginProcessHandle`:
`waitForExit()` returns root termination at Node's `exit` (or spawn failure),
while `wait()` returns captured stdout and stderr only after Node's `close`.
Finite commands, SCM comparisons and feature probes consume completed output;
native startup and disconnect detection consume root exit even when inherited
pipes remain open. Neither fact substitutes for the existing custody owner's
descendant-settlement proof. Exit observation does not seal output or request
cleanup of an otherwise completed finite command.

The existing owner-metadata `lifecycleState: 'stopped'` and
`lifecycleStateSince` record a confirmed clean process end. The host Session loop
publishes them after native disposal for a clean Stop, graceful termination or
observed terminal exit with code zero, before semantic Session end. The daemon's
confirmed physical Stop publishes the same fact through its authenticated,
runner/attachment-fenced metadata retirement path. Startup and Resume restore
`running`. This is a process fact, separate from archive intent and the durable
explicit-Stop hold.

Heartbeat expiry, native crashes and lost observation do not publish `stopped`.
A confirmed unexpected runner exit clears that runner's `hostPid` and birth
witness, and removes its stale `running` lifecycle through daemon child-exit
tracking, before releasing the requester. The metadata CAS compares both PID
and birth time; an older exit cannot retire a replacement. A failed readiness
report may not have given the daemon a Session id, so startup retains its
failure-path CAS using the same tuple-guarded projection. Explicit Stop keeps its attachment-fenced
retirement and `stopped` publication described above.
For a confirmed absent plain runner with no terminal-host descriptor, daemon
exit tracking retains the existing plain `controlServiceabilityV1.retired`
projection while removing the PID tuple. A later Stop consumes that proof through
the same recovery and retirement writer, rechecking its observation, absent
runner tuple and descriptor before publishing `stopped`. Startup clears the old
plain-retirement projection when it publishes a new runner. A readiness failure
before physical exit, an unreadable descriptor, or historical metadata with no
PID and no retirement proof cannot supply this fact; Stop continues to refuse
unproven topology. This does not classify an unexpected exit as a clean Stop.
A generic `runtime-ended` event is insufficient: it can report unexpected native
exit even when host cleanup exits zero. Disconnected status wording uses Stopped
only when the viewer can read the exact terminal lifecycle value; absent,
unrecognized or unreadable owner metadata stays Offline (list surfaces may keep
their Last seen wording). The string field remains tolerant of unknown values;
historical inactive Sessions are not backfilled from presence.

Several tracked runner generations can coexist while predecessor cleanup settles.
Private daemon-service ingress selects the generation matching both presented
capabilities, then performs the existing exact authority and currentness checks.
A mismatched predecessor is not a veto on its authorized successor and does not
lend that successor its authority.

The daemon's confirmed runner-exit path, both requested Stop and unexpected exit,
consumes [`endOwnerRemainder`](../apps/cli/src/daemon/processes/endOwnerRemainder.ts):
fresh census and the one ownership owner identify the Session's remaining proven
members for the one tree terminator. Unreadable evidence, replaced generations
and a resumed owner cannot authorize an older exit's sweep. Likely survivors feed
the same two-pass Left-behind owner; daemon startup also observes ended-owner
leftovers. These physical observations use retained requester attribution: they
never recover unrelated Account contexts or await Home admission/settings reads.
Native evidence stays fresh, including the final signal authorization; missing
attribution is not replaced with the custodian's identity. Interactive process
reads retain the existing requester-recovery path.
Tree capture retains observed identities, including UID/SID-isolated descendants;
it grants no permission to signal them. An unavailable capture does not veto the
exact tracked runner's existing graceful Stop authority. Capture and ownership
observation failures retain their native code and phase in `processFailure` on
the incomplete Stop result. Confirmed runner exit still releases its tracked
Session after the normal exit settlement; uncertain remainder cleanup is reported
as `process_owner_observation_unavailable`, never as confirmed cleanup. Retry the
archive after exit settlement; remaining processes use the existing Left-behind
inspection and termination flow.
A deliberate process Action stamps the existing Session stop intent
before the first signal, so exit retirement records a person's kill rather than
restarting it as a crash. Explicit Stop of an already-dead tracked runner records
the same intent and awaits the existing exit lifecycle, final presence and inventory
settlement; physical absence alone is not a successful Stop receipt. An incomplete
settlement retains custody for an explicit retry. Once the terminal-host descriptor
is positively absent, historical launch metadata does not retain host custody or
block final-exit inventory retirement. Unreadable or replaced attachment evidence
still refuses retirement; Home finality, control-serviceability publication and
Session remainder cleanup retain their existing obligations.

In development source, authenticated Machine terminal capture treats an archived
Session as `already_inactive`, without changing its archive or activity state.
Final runner-exit and startup-orphan settlement share the classification of
`archived`, `not_found` and a peer's explicit `unsupported` refusal as permanent
terminal unavailability. They release dead-runner custody without claiming
terminal authority or repeatedly requesting it; independent terminal-host custody
still follows its physical evidence. Missing Machine transport, internal errors
and inconclusive authorization refusals retain recovery evidence. In particular,
a disconnected socket is a transport failure, not proof of an unsupported peer.

Development-source durable resume admission has a separate
[Protocol-owned Stop record](../packages/protocol/src/sessions/metadata/sessionExplicitStopV1.ts).
Its shared reader distinguishes an absent record from malformed authority and
returns `eligible`, `held_by_person`, `archived`, `machine_unavailable` or
`authority_unavailable`; archive takes precedence over a hold. The hold includes
an admitted lead stopping a Session in its led subtree, with `managerSessionId`
recording that Stop's admitted creator. A person may resume either kind of hold.
The Session Action boundary admits led-subtree lifecycle targets for exactly
`session.stop`, `session.archive` and `session.unarchive`. Headless `session.open`
Resume of another Session is admitted only for the caller's direct managed child
(the led-subtree row's manager is the caller); `session.open` otherwise remains
current-Session-only. The existing `requestInactiveSessionResume` owner retains
its separate current-manager check and person-only handling of older holds
without creator evidence; it cannot widen that Action boundary.
Native launch rechecks the current manager, requester, Home and Machine; Action
enablement and approval policy still apply. Only successful exact native Resume
clears the observed hold; a transport acknowledgement cannot clear it.
Signed Stop metadata phases retain their original Action root for the exact
Session read and owner tuple. Home admits a Session caller's Stop through the
same current, readable recursive led-subtree owner used by Session listing.
Signed Open metadata phases remain bound to the original caller's own Session.
Ordinary Account access and current publisher admission still apply.
Clearing compares the observed request identity, so completing an older Resume
cannot erase a newer Stop. This metadata
contract does not replace physical Stop settlement or authorize a launch from
`active: false` alone.

In development source, automatic launch refusal retains that same closed reason
through the private launch-admission hook and the existing `launch_error` detail
on `SPAWN_VALIDATION_FAILED`. It is not a daemon-connectivity failure. Pending
activation preserves its retryable disposition and leaves the message queued
(the composer never marks it Blocked); the client submit result retains the detail.
The daemon's automatic respawn treats a `held_by_person` or `archived` refusal as
terminal: it logs one "Respawn suppressed" warning and stops, since only a
person's Resume, a new message send, or unarchive can change that admission. The composer reads the canonical
persisted admission to show “Stopped by you” with the existing Resume action when a stopped Session
still has queued input, instead of a generic queued message or a retained Guard wake promise. None of
these presentation facts can clear a hold or admit a launch. A loaded-daemon
replay remains separate from source validation.

Any explicit message send into a held Session resumes it, whoever sends it: the
app composer, phone, queued-message send-now, review and plan surfaces, the
terminal CLI, an agent or manager Session, Actions and automation or workflow
sends. The two send owners, `submitSessionUserMessage` and `sendSessionMessage`
(with `explicitMessageSend`), apply that one rule from the Protocol admission
reader and attach the existing `user_request` Resume authority for that send only.
A consequence: an agent or automation that keeps sending to a Session can resume
it after a person stopped it. Everything that is not a new send stays held:
daemon restart and respawn, machine reconnect, unattended pending activation,
connected-service continuations, Session Follow occurrences, returned answers and
Runs started by automation. The memory worker's hint Runs never target a Session
at all: `runMemoryHintsExecutionRun` starts them in the daemon-owned detached
scope (`execution.run.start` with `sessionId: null`), so a hint never resumes an
inactive Session or spawns its runner. The prompt carries the transcript text and
`commitHint` writes the result to the Session; the hint cursor advances only on a
committed shard, and a failed Run uses the per-Session hint failure backoff. The
runner comes from `hints.summarizerRunner` through the background task runner
owner (below): Auto or the person's explicit runner. Nothing ready throws
`LlmTaskRunnerUnavailableError` before any Run starts, and the hint pass backs off
as for any failed Run. The indexer reads the Session's own Agent from the same
Session fetch that opens its transcript and passes it with the hint; that Agent
wins Auto's cost ties. The Resume owner
treats a request that names no authority as automatic, so only a named person's
Resume, or a new send, crosses a hold. Stop keeps the opposite default on purpose:
a Stop with no authority still records the hold.
Sends do not delegate to unattended daemon activation, which stays automatic. The
daemon's fresh explicit launch admission waits for the physical Stop and clears
the observed hold only after an exact successful launch; an archive still refuses.
A failed resume (machine unreachable, spawn failure) leaves the row queued and the
hold in place and shows the true reason, not a raw code; the next send or Resume delivers
queued input in its existing order.

Processes and widget Session Stop use the existing `lifecycle_control` intent
through the same exact-runner Stop owner as Guard: they free resources and let
the next ordinary message request wake. `recordSessionStopIntent` owns whether
an admitted Stop writes the durable hold. These resource controls neither write
nor clear a person/manager hold; Info → Stop session retains its `explicit_stop`
hold and still requires an admitted Resume or a new message send. A Session's Start again/Undo result
remains `already_wakes_on_next_message`, without changing Stop metadata.
The physical Stop barrier, requester custody and later-Stop launch fencing
apply to both intents. This describes development source; loaded-daemon replay
is a separate validation step.

In development source, the hosting daemon can observe pending Session follows
without a receiver host. The existing exact-Session Account-change callback and
startup/reconnect visitor pass the strict inactive observation to
`sessionFollowOccurrenceDispatcher`. Original-backed events enter Pending there;
an unavailable dispatcher or source range cannot fall through to another wake.
Only a fully traversed source may offer a manager's waiting Turn or an
ordinary/manager/rule route's selected stalled Turn without an original input,
using the same `shouldWakeForSessionFollowWorkerUpdate` selector as live intake.
Transcript Goal changes and human messages cannot select that Turn-only wake.
The probe checks
the committed Home, Account, Machine and installation, opens the source under
the captured requester's Home, and delegates eligible launches to
`requestInactiveSessionResume`. An unrelated Session change does not start an
Account rescan. Selection and launch neither clear a Stop hold nor advance source
progress; the resumed host retains native admission and acceptance ACK ownership.
Private rule selection and Turn-only accepted progress retain the
[Follow boundary](session-collaboration.md#read-state-follow-and-awareness);
neither the source hydrator nor the receiving Session runner becomes another
private-rule reader.
Loaded-runtime validation remains separate from these source mechanics.

Fresh positive zombie observations count as exited even if native ownership
enrichment has disappeared before reaping. Live and unknown members still require
the same current ownership proof before any signal.
Runner-bound control retirement may clear that runner's historical hosted
projection only while the descriptor remains absent and Home metadata still
matches the departed runner; a retained host or replacement runner refuses it.
Windows runner-held Jobs survive daemon restart without
kill-on-close; after holder death, the owner tag and captured tree supply fallback
evidence. See [machine processes](cli-architecture.md#machine-processes-03-development).

The daemon stages a confirmed unexpected host loss as an exact Turn failure with
the `session_host_lost` runtime issue. Follow can deliver that failed outcome from
the retained Turn. A deliberate Stop settles an active Turn as cancelled through
the existing Stop path. Outstanding questions retain their own lifecycle.

Startup reattaches live runners through the existing Session markers. Dead-runner
markers instead enter [orphan settlement](../apps/cli/src/daemon/sessions/publishOrphanedStartupSessionEnds.ts)
on the machine transport's connected edge, not when asynchronous connection is
requested. The same serialized publication path retries retained evidence on
reconnect or publication resume. Marker cleanup follows durable exact-turn staging
and authoritative terminal capture/finalization. Obsolete evidence for a recovered
live Session is staged without ending that successor. Every retry also checks the
existing live-runner owner before capture and again before finalization, since a
Session can resume after the startup scan or while capture/staging is in flight.
Failed or quiesced settlement retains the evidence. This recovery does not signal
a surviving runner.

Generic native-IO roots without Run/service identity belong to Happier itself;
their spawner's existing abort/timeout owns cleanup, not a shared-tag sweep. An
instant-exit bare Exec with no observed native subtree settles its lease as
`ended` with `remainder: 'unobserved'`: nothing known to clean, not proof that no
descendant exists. A detached daemon-tagged child whose spawner's end is unproven
remains Proven Happier's, not Left behind. Captured subtrees and explicit Run or
service custody retain their existing confirmed-settlement requirements.

In development source, long-lived Agent processes run under the per-Session
holder ([CLI architecture](cli-architecture.md#per-session-agent-holder-03-development-source)).
A placed Session also routes managed services, MCP subprocesses, readiness probes
and native terminal Agents through that placement owner. Host process custody
and output wrappers cannot override the target. The target launch mapping owns
executable paths, workspace paths and delivered credentials; an unmapped executable
refuses with `agent_cli_target_unavailable`, without falling back to this Machine.
Workspace commands (including Git, language servers and terminal shells) use the
same target holder through the admitted workspace source. Machine control-plane
processes and the provider's transport carrier remain on their owning Machine.
Unplaced Session helpers retain their local launch behavior.
A runner crash therefore leaves the Agent and its in-flight turn running; the
holder keeps unacknowledged output for the next runner that attaches. Stop is
unchanged: the supervisor ends the Agent's process group through the canonical
tree terminator, and the holder reports the exit and leaves once that exit is
acknowledged. The daemon's runner-exit path (`onChildExited` → `endOwnerRemainder`)
still ends a dead runner's remaining Session members, including a held Agent, until
respawn adopts holders.

### Project finite worker execution (0.3 development)

The existing [worker admission owner](../apps/cli/src/workspaces/execution/projectWorkerAdmission.ts)
owns process-local FIFO admission and finite reservations, not a second Session
queue. The [finite Project Action owner](../apps/cli/src/workspaces/projectSetup/projectFiniteAction.ts)
captures the SOURCE declaration and exact target, reserves before clean Workspace
Sync preparation, then reviews copied TARGET definitions, setup and environment
before final PTY admission. Queue acceptance is not execution or setup completion;
copying, setup and running are observations of the same retained Action operation.
Cancellation while queued can prove no launch. After preparation/process custody
begins, uncertain cleanup retains that operation, output and reservation until the
canonical owner proves settlement. Inspect and explicit Stop observe/control the
same occurrence rather than replaying it or releasing capacity from elapsed time.

Native Project preparation's existing failed-phase diagnostic includes the
pending sub-operation and, on cancellation, the aborted launch, ingress or
operation signals plus a fixed abort-reason category. Runner-authority refusals
name the failed snapshot, Session, source-custody, process or turn-witness
predicate. These diagnostics contain no exception text, paths or credential
values and do not change cancellation, retries or preparation deadlines.

Worker-copy retirement uses the existing [Project worker Action](../apps/cli/src/workspaces/execution/projectWorkerAction.ts)
and Workspace Sync relationship owner. Active queue/preparation/process/Service/Sync
dependencies can refuse retirement. Removing a relationship definition and removing
copy bytes are distinct outcomes: confirmed definition retirement followed by
uncertain byte removal remains `outcomeUnknown`, requiring inspection, not automatic
retry. Long-lived Services use their managed-process/native custody owner and do
not consume the finite FIFO lifetime reservation. A confirmed Stop during Service
Move is retained before cancellable copying; unconfirmed Stop is not settlement.

These are development-source ownership contracts. New-machine acquisition, cold
wake, foreign-requester Source/Sync authority, compound placement-save + Move and
their composed live journeys remain separate integration obligations; this page
does not claim those paths are available or release-certified.

### Managed activity inventory

The daemon's [managed activity inventory](../apps/cli/src/daemon/lifecycle/managedActivity.ts) reads the incumbent Session/input, execution budget and marker, Action operation, PTY, Workflow, Service, transfer, Sync and installation owners. It is a private projection, not another work registry. Missing or failed applicable coverage remains unknown. The transfer bootstrap can prove absence when its canonical configuration explicitly disables direct transfer; an unavailable enabled owner cannot make that claim. The requester summary projector takes this same inventory input; its authenticated reader and authorized requester identities remain a separate Machine-access seam. Retention-only custody is not reduced to the summary's three public count columns.

In 0.3 development source, passive publications refresh only the owner that
invalidated its facts, retaining the other owners' latest projections within the
inventory lifetime. An Automation claim observation therefore does not demand a
fresh read of every settled Session. Within the Session owner the same rule is
row-level: a runner's `/session-activity-changed` names its Session, so the
passive refresh rereads only that runner's live work and keeps the others'
latest successful observations; unattributed edges (process set, transport,
startup webhook, exit) reread every runner. Explicit inventory and decision reads still
query every live owner; concurrent full reads share only an in-flight observation
at the same invalidation edge, never a completed or partial passive result.
New owner edges capture immediately, and superseded observations cannot publish
late or confirm idle. Disposal releases the retained projections.

In 0.3 development source, the daemon's Workspace Sync runtime compares Project
scope, WorkspaceRefs and relationships with its successful reconciliation input.
When no relationship belongs to the local controller and its activity coverage
is complete and empty, equal refreshes advance Project graph settlement without
enqueueing material Sync work or resetting the Machine's idle interval. Installed
local relationships retain native bootstrap and custody reconciliation, including
while their desired inputs are unchanged. Changed inputs retain normal busy
admission. Project withdrawal, failed or partial recovery, and supervised sidecar
replacement require reconciliation even when desired inputs are equal.

Publisher reconnect reads this same inventory through the reserved server-origin
Machine access-loss receiver. Only attribution matching the current Home, Machine
and installation supplies requester subjects. The Home combines them with
Session AccessKey subjects and revalidates current effective access. In current
0.3 development source, withdrawal refuses the next admission and closes
open-ended interactive access, including terminals and preview streams. It does
not stop already-admitted finite Session, Action or Service work. Those owners
retain settlement and explicit Stop; a surviving grant preserves access. Missing
attribution or coverage remains incomplete rather than a claim that all requester
work was recovered.

Session absence requires exact committed runtime activity and a current Pending projection: the runner reads the authoritative Session snapshot once per Session socket connection (and whenever its projection is unknown), after which live `pending-changed` updates keep it current, so idle activity reads issue no Session read. Absence also requires no accepted, returned-batch, preparing or dispatched input custody. Content-free host notifications invalidate observations; they do not authorize idle. A foreign requester's unavailable Session transport remains unknown. External execution markers are observed on demand through the existing registry's native directory watcher; uncovered or failed observation cannot prove idle.

In 0.3 development source, that same Session live-work read also includes live
host subagents, Agent activity headlines, and pending permission/question requests.
A settled turn cannot prove absence while any of those remain active or unknown.
The runner retains the per-Session `settledAt` anchor; reconstructing the daemon
inventory does not restart it. Retained PTYs expose their own last-activity time.
Inventory subscribers receive owner invalidations even when another owner keeps
the aggregate busy, through the existing change-or-deadline wait primitive.
Healthy-process heartbeat checks retain process and terminal supervision, but
do not invalidate Session work: process presence proves no work-state change.
Actual host activity and lifecycle notifications still invalidate the inventory;
explicit reads, including final eligibility checks, query fresh live Session
work. Unavailable coverage remains unknown until a real notification or read
recovers it; a healthy process alone cannot authorize idle. Passive daemon-state
publication is not fresh decision authority: Guard, idle confirmation and storage
eligibility retain their explicit live reads.

Guard eligibility reads drafts through the Session's current requester-qualified
Home credentials, scanning the canonical V2 Account draft listing for all of that
Session's address kinds without decrypting draft content. Unavailable or expired
authority, unsupported listings and incomplete reads cannot prove draft absence.
Eligibility also uses the canonical inactive-Session resume builder with fresh
owner metadata from that admitted transport; this read alone does not stop,
resume or discard a Session. The daemon's development-source memory ladder
consumes this predicate and the process-ownership owner's verdicts. The same
planner supplies its preview and execution choice; unknown ownership, activity,
visitor counts or recovery support cannot authorize a stop. Only a later minute
after exact process absence and the cooldown can establish measured relief.
The service rung targets only Project services with their captured Stop and
existing Start again. Every listener must have a known connection-free sustain
window, and the same live-work inventory must prove no working Session in that
Project workspace. Active subagents and waiting questions count as work; unknown
workspace or listener facts remain busy. Session-linked plugin services are not
service-rung targets: their Session is the stop and next-message wake unit.
Guard reads the existing LocalServices refresh's native observation before HTTP
presentation enrichment. The same single flight still owns the full published
inventory; a later Guard reader waits for its fresh successor rather than treating
an earlier completed socket observation as current.
Guard lifetime and watch cancellation retire only their awaiting reader, including
pending ownership and Session activity reads; the shared native/inventory producer
and its normal publisher remain live. This reuses the existing change-or-deadline
primitive without adding a timer or cancelling another consumer's work.
The Guard's planning tick reads the live-work inventory with the `changed` scope:
runners push an invalidation after every live-work change, so each owner rereads
only what its pushes changed and an idle tick makes no runner RPC. That read is
never an action confirmation: a Session stop's SessionStop admission and a
browser or service fire still read fresh facts.
This does not certify the composed loaded daemon or the visual Guard tab.

The development CLI's [process census](../apps/cli/src/processes/census/processCensus.ts)
owns native observations for Guard, Processes, inventory and custody. Linux
consumers request their needed fields; inventory retains machine-wide ownership
evidence and enriches listener command ancestry. Its procfs adapter reads to EOF
without a 64 KiB allocation for each small file. Only successful process-local
page-size evidence is reused across captures; mutable ownership/command evidence
stays fresh. The census has no timer. Inventory ticks follow its existing watch
or summary demand, and Processes releases sampling when its last viewer leaves.

The current Session input-admission owner also receives `session.guard.notice`.
Its exact-current publisher writes the content-free shared `sessionGuardStateV1`
countdown or clears it, and a new runner clears the previous presentation on
startup while retaining the optional Session ceiling override. An explicit
`ceilingBytes: null` disables that Session's cap; absence inherits Machine policy.
The live publisher and authenticated inactive-Session metadata CAS share the
same override mutation. A stop receipt first records requested intent at
`activity/session_stop.v1` and commits that reference on the existing informational
transcript message. The exact runner's exit owner settles the same record to
stopped before retiring its requester resources; rejected eligibility and native
stop failures settle it to cancelled or failed. Publication uses that runner's
admitted requester Session record port, bound to its Home and current authority.
Failed exit publication retains the existing exit custody for retry. The mounted
transcript marker observes the current record through the Session record repository;
pre-stop intent never proves exit or freed memory. Stored record reads tolerate
unknown fields. The daemon remains the guard policy and stop owner and must not
stop on a failed receipt. Warning
delivery uses the existing Activity dispatcher, the current requester Account's
catalog and the shared Machines channel. These development-source seams do not
certify loaded-daemon behavior or the visual countdown/action consumers.

Linux scoped Session launches use the existing native support helper's
`scope-exec` operation to retain scope membership until the runner exits. It
reads that scope's `memory.events` OOM counters once before returning, including
when no Session soft ceiling is configured. The exact launch unit qualifies its
private exit capture; the existing ceiling/Activity owner consumes it before
remainder retirement and records positively witnessed kernel OOM kills. A signal
alone supplies no OOM attribution. The existing accepted-runner marker retains
the launch unit across daemon reattachment. This adds one small native wrapper
per scoped Session and no polling, OOM policy or collection change. macOS and
Windows retain their existing behavior without Linux OOM attribution. These are
development-source contracts, not certification of the composed loaded daemon.

Retained terminal warnings project `terminalGuardStateV1` through the existing
terminal list owner, without manufacturing a Session id. Machines warning data
carries the exact Session or terminal Action targets and a stable occurrence id.
Notification consumers bind its URL routing to an admitted Home before producing
complete Action inputs, rather than substituting the active Home.
The shared current-state predicate lets notification consumers dismiss a cleared,
replaced or completed warning. Session-custodied terminal warnings and ceiling
attention use the same requester runner's notice/dispatcher path without replacing
Session presentation. The terminal and guard owners retain cancellation and stop
authority; this data seam adds neither a clock nor a second notifier.

Memory-guard episodes use that same Machines notification channel once the
daemon reports calm or no remaining steps. The episode projection carries only
the Machine/episode identifiers, action counts, freed bytes and whether a look
is needed; private activity subjects, notes and requester attribution stay in
the activity owner. Session stop warnings remain separate occurrences in the
same channel, not a notification for every completed step.

In 0.3 development source, semantic withdrawal uses the existing [Pending mutation owner](../apps/server/sources/app/session/pending/pendingMessageService.ts) through `POST /v2/sessions/:sessionId/pending/:localId/withdraw` and its Run-scoped sibling. Its result distinguishes confirmed removal from consumed custody or uncertainty. Only confirmed removal can restore the captured structured composer document, and only while its Account/Home and document revision remain current. Legacy Pending `DELETE` remains a separate primitive: predecessor success without that semantic result is not proof that input was withdrawn. An older server's unsupported semantic POST must not fall back to a mutating DELETE. These wire semantics do not certify the still-unverified composed cold-wake or UI integration paths.

Aggregate idle begins only after all applicable owners prove settlement. Real owner invalidations reset that interval, and an asynchronous snapshot invalidated during its read cannot confirm idle. The authenticated guest bridge rechecks the exact retained row, revision and controller around a fresh closed-admission read. Its unused-stop cause can reopen independently of temporary drain, plugin handoff and irreversible shutdown. Only the safe activity decision is published through existing Machine daemon-state updates; references, attribution and content stay private. A committed idle bridge reply can additionally carry the current guest installation's signed evidence, binding that exact row and guest-measured interval. These are development-source contracts, not loaded-runtime certification.

Activity reads own short guest-local probes: the guest releases the probe before
replying with signed idle evidence, including when delivery or the controller's
operation later fails. The selected unused interval and approval wait retain no
probe drain and do not depend on a second resume RPC. The native-effect guard
confirms idle again and retains admission closure immediately before Stop/Delete;
once native IO may have started, an uncertain result does not reopen admission.

An external after-idle Stop/Suspend/Delete uses the original accepted Action root and
controller installation signature through the existing Machine transport. Home
derives the private activity/drain destination from that same current control
request's admitted intent and exact retained guest, while rechecking the original requester's
Manage admission. Only this proved controller receives its custodian guest key
envelope for the transport codec; requester Account key material is not borrowed.
The requester needs Manage on the controller, without a separate guest grant.
This narrow retained-control bridge does not grant ordinary guest access; loss of
controller Manage or retirement of the retained control closes it.
Reopening releases only an actually retained drain target and does not authorize
fresh activity reads or drain admission after retirement.

For controller-free Account rows, the same root issuer qualifies the signed
guest or private Account daemon through
`resolveSignedManagedAccountExecutorInTx`. Its existing signed binding carries
the exact power/delete input in `managedAdmission` and the retained guest in
`managedAccountExecutor`. Activity/drain spends that owner fact against the
active row, control request and intent; it does not repeat executor eligibility.
Plain and encrypted HTTP roots carry the same control projection. Native
controller roots retain their existing Manage admission and guest transport.
This is an unreleased 0.3 contract; it adds no signer or stored authority.

The daemon's managed-policy runtime rereads the exact installation-signed managed row and its current wake targets when a controller-specific Account hint names a known managed Machine. Its own Machine changes, reconnect/recovery edges and hints without a known managed identity reread the complete controller census. Targeted accepted Pending/Run work and Team admission changes use the same invalidation owner. The existing Account-feed reader classifies these wakes; unrelated Account, Pending and Run traffic does not schedule a census. Changes to an origin already held by a driver still reconcile that work. Managed controller replacement also invalidates the former Machine, so coalescing the managed Account row cannot hide retirement from its old controller. Daemon startup mounts that single subscription owner with the current Machine transport and retires it on replacement or shutdown. Replacing the retained native resource or enrollment retires the old held policy lifetime; the driver's own intent/submission progress does not. Selected idle/deadline waits remain with the native driver, not a polling loop. Automatic policy effects still pass through current Actions policy and its existing approval Artifact lifetime; installation signatures do not substitute for human Ask approval. Approval retains the same host operation and approved execution context. These development-source paths still require composed and loaded-runtime validation.

Policy preparation reviews the native effect without admitting a new desired
intent. The approved callback rechecks the retained row and then commits that
intent before native submission. A finite external Action also rechecks its
original Session publisher through the final guarded wake transport boundary;
retiring that publisher cannot leave a valid wake authority behind.

The installation-signed census also rediscovers canceled creations awaiting
immediate cleanup before resource/Machine binding. The same policy driver can
delete a declared, retained native-operation handle; unknown handles remain
recovery work and cannot supply a native target. No new cleanup queue is added.

## Background-service process custody (unreleased 0.3)

The plugin background-service lifecycle owner also runs host-owned background
services. It owns demand, coalesced follow-up runs, settlement and retirement;
`placement: 'process'` selects its child-process adapter rather than a second
runtime or managed-service registry. Launch uses the binary-safe Happier CLI
launcher and the shared
[`process custody`](../apps/cli/src/subprocess/supervision/processCustody.ts)
and supervision owners, including process-tree termination and Windows Job
custody. The ordinary process census observes that child independently of the
daemon.

The daemon retains admitted source custody, currentness and invocation authority.
The child runs the selected runner and consumed reader surfaces from that admitted
source. It cannot publish a catalog, admit Actions, start sibling contributions or
migrate public daemon databases independently. Its service bridge delegates those
operations to the existing bound daemon owners; public database callbacks and
transaction handles retain their original ownership.

A finite demand runner returns when its work is complete. The lifecycle joins
child termination before reporting successful demand settlement; the next demand creates a
new child.
Plugin retirement and daemon shutdown send abort and join that same path. A crash
is a visible background-service failure, not successful completion. Host placement
adds no idle timer: work settlement decides when a demand child ends. The
[plugin platform contract](plugin-platform.md#background-service-placement-unreleased-03)
owns declaration defaults, caller cancellation and process-service availability.

## Managed service custody (0.3 development)

The daemon's existing heartbeat recovery also discovers Linux service scopes
from the native process census when their endpoint projections are gone. Scope
names must identify the current Happier home, and every surviving member must
have the existing ownership resolver's ended-service proof before the process-tree
terminator acts. Live and unknown owners remain untouched. This adds no recovery
timer or store; Windows and macOS retain their existing projection-based recovery.

Non-Session ACP readiness probes use the host's existing process-tree terminator
on every platform. Cleanup retains launcher ancestry until that owner captures
and settles the tree, then closes the ACP connection and pipes. A launcher exit
alone cannot prove descendant cleanup. This is development-source behavior;
source, compiled-module and loaded-daemon validation remain distinct evidence.

Declared Agent catalog preflight combines the daemon lifetime with the exact
plugin consumer and runtime retirement signals at the host catalog projection.
Daemon shutdown therefore cancels native preflight execution before RPC draining
can postpone registry disposal. The existing Exec and managed-service owners join
process cleanup; admitted mutations retain their own drain lifetime.

The incumbent [managed-services owner](../apps/cli/src/plugins/runtime/invocation/services/managedServicesOwner.ts)
and [process supervisor](../apps/cli/src/plugins/runtime/invocation/services/managedProcessSupervisor.ts)
own both plugin-scoped services and host-admitted Project services. Project
admission carries the accepted Workspace, source-qualified declaration, cwd,
reviewed effect and authenticated requester attribution into the same semantic
entries. Built-in Project services do not fabricate plugin identities. Their
actual supervisor-issued instance id, not the stable declaration id, identifies
current controls; feed and preview consumers project the same handle and snapshot.

Workload-consuming Domain reads join the installed Machine's existing
Environment-service recovery before selecting the managed Compose service.
Domain verification and removal do not require workload recovery. An unavailable
service retains its typed failure step, cause and recovery remedy.

Machine Service catalogs and reboot facts share one disclosure selector. A
Workspace Service remains visible to its requester or to the Machine custodian
through the receiver's admitted Account custody, including after the requester's
grant is removed. A Manage grant alone does not disclose another Account's
Workspace Services. Environment Services retain their Environment read policy.

In 0.3 development source, `services.managedServices.observeWorkload({ serviceId })`
exposes a host-admitted retained generation through that same disclosure selector.
The opaque handle reads and subscribes to the incumbent Machine Service row
(health, endpoint and projected ports), and delegates native controls and logs
to the existing Project handle. The host captures the admitted resource, Machine,
control operation and invocation lifetime; plugin code cannot supply authority
or source custody. Disposal removes this observation and log subscriptions without
stopping the native workload. Missing admission and recovery failures settle as
typed unavailable results. Deployment-role invocations join the Machine's existing
Environment recovery before attachment; there is no additional native inventory,
supervisor, persistent handle or recovery loop. Observe/link roles do not acquire
native mutation authority.

Environment deployments extend that same Project-service witness with an
`environment` arm. It carries the admitted source-materialization custody handle,
Environment instance, Deployment evidence and Compose service, with no Workspace
or requester. P41 activates the Compose project once; per-service observations
attach to that existing generation with stable ids
`<environmentInstanceId>/<composeService>`. The strict Local Services projection
retains those ids and deployment purpose. Requester access-loss reconciliation
selects only Workspace services. Environment retirement detaches observation;
explicit native controls and deployment teardown own stopping effects. Start and
Restart address the admitted existing generation rather than running Workspace
preparation or Compose `up`. These are 0.3 development-source contracts; composed
and loaded-runtime validation are separate evidence.

An adopted Compose project's protected Target link origin supplies its existing
physical project and Docker engine identity to the same P41 executor. The link's
installation membership selects the imported member; additional members use
their ordinary Environment project identity. Deployment review captures the
current native container generation in its existing input basis. Execution
compares that reviewed basis, then checks the same generation under the existing
native-effect admission before any native effect. This is a fresh review of the
current generation, not a permanent pin to the containers observed at import.
The retained receipt preserves the physical identity for ordinary recovery.

The existing Machine Service list/detail row projects retained native
`configuration.ports` alongside the canonical health freshness. It derives the
port shape from the native facts schema and excludes mount paths; detail reads
retain the complete native facts under their existing disclosure policy.
The own-server launch host resolves declared private service references through
this projection and P21's ready private-network observations. It selects the
active Deployment and exact installation, declared container port, TCP mapping
and bind address on the declared shared network. Missing, stale, stopped or
ambiguous facts refuse with `reference_unavailable`. Same-Environment automatic
references use Compose service DNS and the container port. Cross-Environment
reads retain the original requester; an access refusal never borrows the
installed daemon's Account authority. These are development-source contracts;
loaded-runtime and physical-platform verification remain separate.

After a daemon restart, the managed-services owner joins retained Environment
recovery on the first Services or deployment health/drift read. The installed
Account's existing receipt history and member-version projection select the
deployed version; retained source custody supplies its definition authority.
The cold native discovery shared with logs supplies surviving container IDs
and effective published port bindings from the same native inspection. Recovery
passes that structural configuration through the existing native facts and
Machine Service projection, including an empty ports list for an unpublished
service. It does not reopen runtime secrets or retain raw container environment,
commands or mount paths. The existing per-service observation producer adopts
that generation and owns observation freshness.
The native working directory identifies the retained source receipt; the
serving receipt identifies the active deployment. Those receipts can differ
when Compose reuses a container, so recovery resolves the native source's exact
custody instead of requiring its receipt to equal the serving receipt.
A stopped container remains observable; a removed generation remains absent.
Startup does not scan or restore services, and recovery adds no persisted
inventory or native activation.

Native control settlement is separate from current observation authority. The
supervisor preserves Stop's stopped, accepted, unsupported and
termination-incomplete results. If read authority retires after an admitted
effect, its Action retains the operation receipt but discloses no old service
state or generation. Accepted dispatch is not an observation that the service
stopped; unconfirmed settlement keeps the existing operation uncertain.

In 0.3 development, an adopted Compose watch controls its existing containers
through the same admitted service control and Exec custody as other native
services. Stop, Start and Restart use the watched resource's discovered container
IDs and observe the resulting native state; they never launch or recreate a
Compose project. The Machine row consumes the supervisor's control support
facts, independently of the resource's current running or stopped phase.

The same admitted built-in Compose lifecycle exposes its already-observed native
container identities and PIDs to the daemon's canonical process-root projector.
Only a matching full-ID Linux cgroup-v2 fence in that same census establishes host
process attribution; remote/Desktop PIDs and missing or unsupported containment do
not. The resulting strict `container` Process owner retains the actual Home,
Machine and service, without manufacturing an Environment requester. Processes
requires current Machine admission and current Account read of the exact
Home/Environment before disclosure, including for the custodian. Native ancestry
stays inside the proven fence. This projection adds no engine read or second census
and does not establish activated-resolved-configuration attribution/freshness.

Host health consumers subscribe through the Project handle's `observeHealth`
projection, produced by the same supervisor snapshot writer. It emits state,
native phase and readiness only when those facts change. A separately retained
failure diagnostic still updates full snapshot readers without publishing a
second unhealthy transition. Service identity and C1 tuple encoding live at
Protocol's Local Services owner; receipt and actor changes are evidence rather
than new service identities.

The target daemon's `machineNativeEffectAdmission.ts` owns finite native-effect
exclusion. Callers admit the complete rendered project, native-volume, host-bind,
engine and setup key set once, then retain the same host-only context through
nested stages and native settlement. Equal canonical bind sources conflict even
across engine endpoints; ancestry alone does not. Engine effects exclude all
workloads on that engine, while unrelated projects remain concurrent. Receipt
publication does not release this custody. Unconfirmed native termination keeps
the keys unknown until their provenance owner re-observes settlement; old,
foreign and retired contexts cannot dispatch or replay work.

In 0.3 development, setup consumes `resolveMachineSetupNativeEffects` before
admission or credential delivery. The existing setup impact classifier distinguishes
local Docker/containerd service or Docker-configuration effects from authored
scripts targeting their execution environment's selected engine. Local effects
use exact engine keys when native-service/process/socket evidence proves the
binding; an ambient Docker context ID or caller-provided configuration path is
not that authority. Without exact binding, local system Docker/containerd and
configuration effects conservatively cover the union of observed Docker engines
on this Machine. The inventory comes from the existing engine observation and
native-effect custody owners, including unsettled effects. If neither retains
an identity, the existing native engine reader must obtain one; this is an
observation, not physical-binding or complete-inventory authority. Unobservable
inventory uses the [Machine-wide admission scope](#machine-native-effect-admission).

The same admission owner holds that Docker-only union as one static scope: it
checks incumbent effects and any later effect carrying actual observed Docker
coordinates, so an engine first observed during setup cannot escape exclusion.
There is
no new registry, guessed socket or second selector. Exact bindings remain exact
and unrelated engines remain concurrent with those exact effects. The producer
rechecks recipe coverage before the root setup stage; a change outside the
retained scope returns `plan_changed`, never expands custody. Script effects
retain their actual execution-environment check and conservative engine-wide
default when `setupScriptAffects` is omitted.

The setup interpreter owns which steps can still have effects. Admission uses
that same decision: an already-satisfied prefix before the first effect requires
no native effect keys, while later steps and programs remain covered because
earlier work can invalidate their original observations. Setup callers do not
independently filter satisfied steps or weaken the full-set admission.

Native process metadata may be unavailable to the non-root daemon even when it
can use a Docker socket: Linux separately applies
[ptrace access checks to process descriptor links](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html).
This uses the conservative union rather than excluding ordinary non-root
rootful-Docker setup or requesting elevation. Configured systemd `Listen` or
`ExecStart` values are not substituted for live physical evidence: systemd can
retain a running socket state after a configuration reload without matching
open descriptors ([systemd v255 socket coldplug](https://github.com/systemd/systemd/blob/v255/src/core/socket.c#L1733)).
The current strict recipe `serviceUnit` contract addresses the system manager;
it does not infer authority over another user's rootless unit.

Native liveness inspection continues under the service watchdog. The supervisor
publishes lifecycle observations only when state, native phase, readiness or the
admitted endpoint changes. Successful ready samples still refresh
`lastHealthyAtMs` for direct snapshot reads; timestamp-only samples do not wake
lifecycle subscribers. Inspection failure withdraws running evidence once, and
recovery publishes the newly observed facts through the same owner.

Managed-spawn and attached services retain successful HTTP/command probe freshness
the same way. An already healthy watchdog sample or repeated readiness request
updates `lastHealthyAtMs` for direct reads without notifying snapshot observers;
a health-state transition still publishes through the supervisor. Probe cadence,
failure thresholds and endpoint-change publication remain unchanged.

Native output is collected only for a failure transition or one explicit failed
health inspection. Healthy and unchanged watchdog observations perform no log IO.
The optional public `ManagedServiceNativeLifecycleV1.logs` callback receives the
existing diagnostic byte budget and admitted invocation context; an adapter
without it retains the failure diagnostic without output. Built-in Compose
uses its already-admitted container IDs and a bounded Docker tail. The supervisor
sanitizes and retains this output as `native_service_output`; it is a bounded
failure diagnostic, not a long-lived Service output reader. Observed resource
death withdraws its endpoint before awaiting output, then publishes terminal
custody after collection so automatic cleanup cannot retire the output read.
The optional `serviceExec` callback is the same kind of additive role for an
adopted Machine watch. It validates an optional Compose-member selection against
the exact retained resource and returns a literal launch. The host authorizes
that launch through the invocation's Exec and runs it through the existing
admitted service command/shell owners. Built-in Compose execs into the selected
running member's container. The Machine row consumes the admitted handle's
optional `capabilities.exec`; it never infers exec support from an adapter id.
Compose publishes sorted, unique `composeServices` in project-level native
observations using the same member-list owner as `serviceExec`. The supervisor
retains it as `nativeComposeServices`, and the row presents it under `native`.

The development Local Services launcher feed carries only diagnostic code,
severity and sanitized message while a managed lifetime is failed or unhealthy.
The strict launcher target schema and existing Services row target carry those
facts to the client; recovery omits them even if the supervisor retains earlier
diagnostics. Private diagnostic details and remediation never enter this projection.

An unexpected Project Service process exit is a failed lifetime, including an
endpoint-free command that exits immediately. The supervisor projects sanitized
output from that process's existing bounded terminal result; it adds no output
subscription or retention policy. After confirmed cleanup, the same semantic
entry retains the failed attempt and its supervisor-issued occurrence for review.
Failed native starters and native resources already stopped at initial inspection
use this same failure presentation. Explicit Stop clears the attempt; a freshly
reviewed retry replaces it through the incumbent owner, and a recovered running
target omits failure diagnostics. Unconfirmed cleanup retains actual custody and
cannot become a settled failed attempt or permission to start a replacement.

Complete Project binding reads join an in-flight establishment at this owner and
re-read its published handle before returning. A pending Start or Move therefore
keeps its native read pending rather than publishing a Machine-unavailable
failure. A failed establishment with confirmed cleanup returns its retained failed
attempt in complete reads, while its Start operation still rejects. Unsettled
establishment, retired custody and lost currentness refuse the complete read;
an incomplete snapshot never establishes absence or Start
permission. Ordinary diagnostic lists remain synchronous views of published
handles. The existing native establishment lifetime governs the wait.

The reload controller retains that one Project custody owner across registry
replacement. Generation-scoped plugin bindings still retire normally. A native
adapter lifecycle is captured for one exact instance while its selected
occurrence is current. Inspection and new effects require current authority,
but retained Stop remains callable after definition or serving retirement.
Starter exit is not proof that the native resource stopped. Endpoint-free
processes report `running` without a URL; HTTP capability and native readiness
are observed separately from process lifetime.

For host-admitted Project services, the same supervisor retains the authorized
launch's selected native invocation capture after successful spawn. Launcher-root
exit or output closure cannot release it while an owned descendant may remain.
The existing cleanup owner releases it only after process-tree disposal and
observed terminal settlement succeed; an unconfirmed Stop retains the same
capture and cleanup for an exact retry. A native resource may truthfully report
its phase as stopped while its owned starter tree remains unproved: whole-service
custody stays unhealthy, not stopped, so the existing Stop policy keeps that retry
reachable. No-launch failures release normally, and ordinary Exec keeps its
existing output/root-wait lifetime. These are source-level contracts, not loaded
daemon or physical-device certification.

The authenticated final-effective Machine-access-loss receiver cancels preparing
Project services and stops entries matching the exact Home, requester Account,
Machine and installation. It rechecks the bound signed Home proof around awaited
cleanup. Serving authority retires immediately; unsupported or incomplete Stop
retains actual custody without retaining preview access. `cancelled_preparation`
requires definitively settled cleanup with no acquired instance, and `stopped`
requires definitive process/native termination. Ordinary shutdown retires this
same owner; no separate service census or registry supplies lifetime authority.

Shared subscription-backed Provider gateways use these same semantic entries in
unreleased 0.3 source. The admitted Home/Account, connection and execution
machine identify physical custody. Separate consumer claims retain exact
request-auth authority; final release joins that consumer's in-flight request
settlement before the owner can stop an idle process. An explicit Start retains
its own claim, with no invented idle timer. The Session runner retains its Agent
and a stable local delivery endpoint, not gateway process custody. New requests
re-admit private daemon access after replacement without replaying transport
failures. A saved remote placement reaches the same custody owner through the
existing machine broker/carrier; it cannot select another hub or local fallback.
See [Providers](providers.md#managed-subscription-backed-gateways) for source
authority and the remaining composed-validation boundary.

## Session path and owners

In 0.3 development source, Session awareness carries task progress from the
compact work-state display. The work-state owner counts completed task and
todo items against the total task and todo items. The count is private Session
content and is omitted for locked or unavailable work state. Awareness also
projects the running work count from fresh Runtime Activity and authorized
managed Sessions. A foreground turn in the Session does not count as one of
its running work items.

In 0.3 development source, `session.status.set_reason {reason}` edits the current
Session's explanatory annotation through the registered `display.statusReason`
field. Its binding writes `work.statusReason` and records when the note changes
through the metadata CAS. Passing `null` clears the note and its timestamp.
Host-stamped Session caller context fixes the source Session for this Action.
`session.status.set_progress` writes an authored `{done,total,label?}` count to
the same owner. `session.status.clear` clears both the note and authored count
in one metadata update. Both Actions take an exact `sessionId` from a user or
plugin, or use the host's current Session for an Agent.

Readable awareness chooses the now line from the note, active task, or current
goal, in that order. Progress comes from the authored count, task list, or
managed Sessions, in that order. It retains a completed count while the viewer
has unread Session activity. The note persists through turn end and projects
its own timestamp when it predates that turn end. Archived rows and rows whose
content cannot be opened omit these status details.

In 0.3 development source, an acknowledged Session birth can survive a failed
first native open without a published Agent runtime identity. Inactive recovery
uses the canonical qualified-target reader to recover that birth's admitted
creation target, keeping its existing Session, workspace and Pending custody.
Initial model and permission choices feed the ordinary snapshot arbitration;
newer saved intent still wins. An existing Agent identity takes precedence over
the birth recipe after a cutover. Explicit `session.open` resume and a newly
authorized Pending activation share this recovery owner.

In 0.3 development source, the Session host's open context retains the admitted
Session transport's Home id and HTTP endpoint, Account credentials and Account
lifetime. Prompt, skills, MCP and role preparation consume that context rather
than selecting a saved Home profile or another endpoint. Each finite read may
capture newer material from the same Account lifetime; retirement still refuses
private reads and provider effects. Manual startup reads Machine policy after
the real Session supplies its binding, including deferred attachment. This
does not add another credential or routing authority.

The shared MCP startup reader admits an unavailable non-strict catalog as a
typed capability notice without removing the built-in Happier tools. Strict
MCP policy and Account custody/encryption failures retain their typed refusals.
Selected-server operations and execution-only detached Run admission continue
to require their catalog; detached Runs have a different output contract from
Session capability notices. Optional daemon plugin-tool catalog loss likewise
publishes a startup notice and permits bridge construction; it does not admit
an empty executable catalog. HTTP POST and native tool execution still demand
fresh daemon authority and refuse until recovery, through the existing inventory
owner. Required prompt, Role and admitted-context failures use the host's typed
`preparation_pending` publication before construction cleanup, without exposing
private Account or document facts. Loaded-runtime verification remains a
separate boundary from these source contracts.

OAuth capability issuance refuses an unavailable Connected Account credential
snapshot without fabricating material or borrowing another Account or Home.
That per-server `initial_admission` failure is not itself a Session startup
failure. `materializeMcpServerConfigRecord` owns strict refusal versus optional
server omission for ordinary, Agent-spawned and recovered Session startup;
the runner passes safe request-auth failure codes to that owner. Non-strict
startup skips the server and publishes the existing capability notice. Strict
MCP policy still refuses startup, and explicitly selected Saved Secrets retain
their typed refusal even under non-strict policy.

In 0.3 development, these selected-server startup notices await durable local
transcript admission, not the Home delivery ACK. The existing mutation journal
retains and retries the same notice; captured Account scope is still rechecked
before prepared MCP configuration returns. Other Session events keep their
existing delivery waits, and an explicit required-delivery admission cannot be
overridden by an optional diagnostic wait preference.

Coding prompt preparation may omit unavailable optional Account library,
Artifact and automatic plugin-asset augmentation, publishing one private-safe
Prompt Library notice from the full-plan producer. A remembered required
selection prevents silent omission until a ready selection confirms deletion;
its old body is never read as a fallback. Selected Profile, Project and required
attachment admission remain strict. Ready captured coding records avoid repeating
catalog reads through the same hydration owner. The memory corpus rejects an
incomplete inventory before replacement or pruning; confirmed absence still
withdraws the corresponding indexed document.

Notes and live worker boundaries without a selected or inherited Role do not
demand unused Account Role inventory. Selected Role policy retains its own
required source admission. Prepared-plan freshness likewise belongs to the
full-plan producer: its currentness assertion is consumed again at native open
and provider dispatch after asynchronous preparation. Withdrawn facts cannot be
reconstructed from earlier returned text. A valid empty plan remains distinct
from withdrawal; string-only callers without that producer authority retain
their existing fallback contract.

In 0.3 development source, skill delivery consumes the canonical reach and
Session selection owners before the runner opens an Agent. The daemon alone
writes `<happierHome>/skills`: immutable digest-addressed bundles feed absolute
POSIX session links or Windows copies, with `session.json` retaining the digest
roots for both Sessions and their Runs. Runner exit releases the folder after
the existing replacement check; daemon re-adoption removes abandoned folders
only with a reliable live inventory. GC runs at those lifecycle boundaries,
marking the complete Artifact-library inventory, first-party content and every
live Session/Run digest. Unknown Artifact-library inventory or an unreadable
session manifest blocks sweeping. Unpinned plugin delivery caches are evictable
without complete plugin-skill coverage from every Account Machine: each new
delivery rereads the plugin's canonical content before materialization.
Supporting files retain executable bits; native skill roots remain read-only inputs.
Remote library marks are read before entering the store mutation queue; the
current Session/Run roots and sweep remain serialized, so a slow GC read does
not prevent another Session's content from being materialized.
Foreground identity registration and marker persistence reuse the ordinary
daemon report owner before materialization, without admitting runtime readiness.
The existing heartbeat and exit owner retire those folders after a crash; a
Session-owned Run carries that parent's captured metadata/PID, not the resolver
process. Native registration enters the existing exit custody before awaiting
OS evidence; an unavailable, departed or mismatched recorded process cannot
republish a folder after retirement. A live foreground parent is registered
even when its own skill delivery uses only an index.

One pure skill-plan owner decides native masking, duplicate names and the
index fallback. An unreadable native root withholds every otherwise unmasked
selected skill, while keeping known masking evidence visible. Failure to read
content or reach the daemon never prevents the Session from starting; the host
publishes its existing capability notice. A Run uses its own Agent, cwd and
folder through the same resolver and SDK carrier.

In current development source, stack skill migration is additive. The Prompt
Library load owner adds deterministic Everywhere rules, the Profile owner adds
seeds, and the Project owner adds rules in each viewer's Account. Shared Project
attachments remain intact. Session startup classifies its own and inherited
bundle references through the Artifact reader before its metadata CAS: enabled
own entries become includes, and disabled inherited entry ids become excludes.
Profile seed and Session include migration mark consumed enabled entries with
`skillMigrationV1: true` on their existing stack entries in the same row CAS.
Subsequent loads skip those positive projections, so removing a seed or include
without Off remains effective. The retained marker never suppresses inherited
exclusion identity.
Account and Project migration use `consumedLegacyEntryIds` on the viewer's
existing `skill-rules` row instead: the scoped deterministic entry ids and rules
are written in one destination CAS. Rules Actions preserve consumption when a
rule is removed, and the migration skips consumed positives before reading
Artifacts. Shared Source attachments remain unchanged, with independent
consumption in each viewer's Account. The strict server row schema and tolerant
stored reader share the Protocol schema owner for this optional field.
The kept Account, Profile and Project rows retain entry-to-skill identity even
after a rule is removed or recreated. Disabled Profiles remain readable for this
retained identity purpose without becoming active context or adding new Session
seeds. Deferred native attach forwards its existing credentials to that same
preparation owner. Required inherited exclusions are classified independently
of positive Session attachments: an unreadable own bundle cannot erase a proven
exclude. If required inherited custody cannot be read or classified, the runner
uses its existing skill-unavailable result without preventing Session startup.
Privately captured Runs reuse the same row reader and selection calculation,
without publishing their Account snapshot into active process state.
Coding entries remain inert stored data; the stack resolver never pastes
skill-schema content. Generic bundles continue
to contribute their existing text. The same Prompt Library load owner drops
Voice skill entries through its existing row CAS (D32), without enabling them.
Malformed or unavailable source/target data cannot authorize migration writes.
The program's composed live journey remains a separate verification boundary.

Before capturing skill rules, the runner prepares the Session's selected Project
through that same context owner, including when no project rule exists yet.
It re-reads the captured Account's rules after migration. A failed Project
migration uses the existing skill-unavailable result and capability notice;
it does not refuse Session startup. Private invocation contexts keep their
captured Account/Home and never publish into the daemon's active Account.
The shared Artifact reader binds both ordinary Account credentials and
requester-scoped credentials to that invocation's captured Home transport.
Qualified references must resolve to the same bound Home through the existing
profile identity owner; saved profiles never supply another Account's material.
Invocation currentness is checked even when the reader reuses a cached store.

Memory-write and approval-request exposure admission uses the Account Artifact
store's read-only grants and public-share census, without opening Doc content or
preparing recipient keys. Both requests retain the original requester's signed
authority at the captured Home. Home admits only these exact reads under that
root; exposure inspection grants no content, key-repair or sharing mutation
authority.

The host's [skills reapply operation](../apps/cli/src/prompts/skills/runtime/reapplySessionSkills.ts)
reuses that resolver and folder owner. A declared live-reload Agent acknowledges
the new delivery before the host publishes its applied plan; a native-root scan
or library inventory/content failure preserves the retained folder. Account
currentness is checked again after native acknowledgment before publication.
Unsupported launch
paths return a next-turn result, and reload errors return a failed result for
the capability-selection synchronizer's restart-with-resume path. Native-skill
disables remain launch-owned and require that restart rather than library reload.
The synchronizer and its composed Session journey are a separate integration
boundary from this operation's source contract.

The development Session Skills pane, Info Skills row and saved-skill result
consume these same capability-selection and application owners. The pane is one
builtin rail destination, defaulting to More. A successful `skills.create`
returns its acknowledged identity and bounded name/description/creator summary;
the saved card renders that result without reopening the bundle. Inclusion
failure retains the saved identity for an explicit attach retry. Desired
selection never establishes Live now: the shared apply-notice presenter consumes
the runtime acknowledgment and keeps pending, restart, offline and unsupported
launch explanations.

UI Settings, skill detail and Reach navigation still bind to the active Home.
For a Session on another Home, the shared availability result presents
Unavailable in the pane and disables saved-card View and All skills navigation.
It does not substitute an active-Home route for the Session's captured Home.
The complete cross-Home workflow remains blocked pending an owner-approved
navigation amendment; this unavailable state is a mitigation, not completion.

The skills library's content-derived `SkillListSummaryV1` is rebuilt by the
existing Artifact header preparation on writes and restores. `skills.list`
projects summarized rows from headers and optional selected `skillIds` through
the existing selected-header reader. Only legacy rows without summaries need
the same owner's body fallback. Creator facts remain in private provenance,
outside the content summary. Runtime eligibility/materialization still reads
content through its existing planner; metadata availability is not executable
readiness. The pane reuses that demanded preview rather than preparing another
plan. Maker filters operate on the held list and accessible Session identities,
with no per-row Session fetch or persisted filter preference.

The Session skill catalog reads the current acknowledged delivery at demand.
The host's [delivered-skill identity owner](../apps/cli/src/prompts/skills/runtime/resolveHappierSkillIdentity.ts)
recognizes both session paths and the immutable digest-cache paths Agents may
report, then publishes `origin: 'happier'` with the library `projectionRef`.
Containment and home-prefix spellings use the existing CLI path owner.
A reported native path retains its native identity even when its name matches.
A per-open refusal hides only that refused delivery; a later acknowledged reload
can publish its fresh delivery without restarting the host catalog reader.

Skill use in 0.3 development source is an Account fact separate from the skill's
Artifact revision. Declaring native plugins emit the strict `skill-usage` event;
the transcript projection resolves it through that same delivered-skill identity
owner and posts `/skills/usage` without committing a transcript message. A
successful `skills.read` inside a current Session plan uses the same daemon
recorder; reads without a Session do not record use. Native-only paths, stale
plans and failed content reads cannot authorize a usage write.
The request retains its source Account id and captured Home endpoint; the daemon
refuses observations for another Account or Home before reading its catalog.
Session-owned finite and retained Runs forward the native evidence through their
own resolved delivery and captured Account binding, without adding a Run event
or a second token-usage observation.

The daemon's `createSkillUsageRecorder` reads the captured Account's hydrated
`skill-usage` catalog and writes through the existing Prompt Library row CAS.
`planSkillUsageWriteV1` updates a skill only when its timestamp is absent or at
least one day old. The recorder reserves only concurrent in-flight attempts and
releases that reservation when the attempt ends. A refused write consumes no
daily interval; a later genuine use may re-plan from the stored timestamp.
Unavailable rows and conflicts drop the observation without replay; the existing
catalog refresh withdraws stale rows after a mutation receipt. A lost receipt
cannot bypass the same expected-revision CAS on a later use. This
network work stays outside the filesystem store queue. The row retains one
timestamp per skill, including historical ids, for the Skills read/list consumers.
`skills.list` and Session-less library `skills.read` join this row without
recording a use.
The list also projects its oldest timestamp as `usageObservedSince`; deleted
skill ids remain part of that observation bound. An empty or unreadable row
leaves the bound unknown, and an unreadable row supplies no last-used facts.
The shared `deriveSkillAccountStatusesV1` owner marks a skill unused only after
more than 30 days since its recorded use. Without a recorded use, both the
observation bound and the skill's creation must predate that boundary. UI
consumers suppress this status while the usage row is unavailable, including
when other library facts are retained for continuity. These are development
source contracts and do not claim complete native Agent observation.
Source tests do not certify the program's loaded vendor/daemon journey.

Machine skill installation in 0.3 development source is a separate, opt-in
custodian operation. The existing daemon Action executor copies a library bundle
to the selected Agents' declared user roots and preserves supporting-file modes.
It does not write plugin caches or overwrite an unmanaged skill. The existing
Account `external-links` CAS row retains machine/Home-scoped receipts with the
library digest and actual installed digest; new receipt writes omit the retired
sync-mode field, and the canonical reader folds legacy modes to manual. Account
artifact changes
and reconnect demand use those receipts to refresh matching unchanged copies.
Locally edited copies are refused; uninstall removes only a receipted matching
copy unless the custodian explicitly forces it. Account or Home retirement
refuses further effects, and receipt-write failures preserve the reported native
outcome without a retry queue.

Found in 0.3 development source uses the same declared-root scanner as masking,
including plugin roots for discovery only. `skills.found.list` reports directory
paths and plugin provenance. The existing download transfer accepts one of those
paths, re-scans it, and reads the bundle with its actual file modes; it does not
resolve prompt-asset adapter ids. Both hosts supply that reader to the single
`skills.found.read` / `skills.found.adopt` operation. Adoption creates library
content, then acknowledges its reach rules and optional Session include in order;
it keeps any acknowledged identity when a later step fails. A plugin-owned skill
is copied into the library without writing its plugin cache. UI reads retain the
exact selected Machine Home independently of the captured library Account.
Loaded daemon and browser verification is separate from these source contracts.

| Responsibility | Canonical host owner |
| --- | --- |
| Session construction, runtime/context binding and startup | [`runHostSessionRuntime.ts`](../apps/cli/src/agent/runtime/session/loop/runHostSessionRuntime.ts) |
| Runtime event subscription, effective thinking, keepalive, mode orchestration and cleanup | [`session/loop/lifecycle.ts`](../apps/cli/src/agent/runtime/session/loop/lifecycle.ts) |
| Input pumping, permission-mode application, prompt admission and turn execution | [`runPermissionModePromptLoop.ts`](../apps/cli/src/agent/runtime/runPermissionModePromptLoop.ts) |
| Accepted turn facts and lifecycle publication | [`session/turn/lifecycle.ts`](../apps/cli/src/agent/runtime/session/turn/lifecycle.ts) |
| Runtime event validation and stream publication | [`agentSessionRuntimeEventStream.ts`](../apps/cli/src/agent/runtime/session/events/agentSessionRuntimeEventStream.ts) |
| Transcript event projection | [`projectRuntimeTranscriptEvent.ts`](../apps/cli/src/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent.ts) |

Transport liveness, Machine reachability, host-owned Session work and viewer demand
are separate facts. In 0.3 development source, `machine-alive` renews the Machine
reachability lease without rereading or publishing peer endpoint content. The
loopback endpoint owner publishes listener changes and renews its advert at the
existing half-life deadline; startup, reconnect and publication resume reconcile
through the same Machine publisher. Session keepalive schedules the next configured
idle or thinking renewal, while host thinking and mode changes publish immediately.
Neither a live socket nor a renewed lease proves active work or service health.

In 0.3 development source, a confirmed managed guest Stop withdraws Machine
reachability and closes Session publishers placed on that exact installation in
one Home commit. The Session publisher owner preserves the Session and its
placement for an ordinary Send to resume after wake. The person-issued Session
Stop owns the explicit Session hold.

Pure Machine heartbeat persistence uses the shared
[`persistMachinePresence`](../apps/server/sources/app/presence/persistMachinePresence.ts)
writer. Its atomic update advances the admitted observation without touching
the content `updatedAt` clock or creating Account changes; it never reads and
restores a content timestamp across a concurrent writer. PostgreSQL-compatible
backends explicitly bind the UTC observation as a timezone-free timestamp for both
assignment and the monotonic fence, preserving its epoch in non-UTC database
sessions. MySQL and SQLite retain their native Date bindings. Machine observations
persist synchronously under the existing Machine row lock in all server modes.
Current authenticated socket beats use server receipt time independently of the
daemon clock. Delayed Redis observations retain their original observation time.
The API/Redis enqueue throttle and local database batch have been removed. The
retained Redis reader admits observations from supported released API producers
through that same writer. Its pending flush parks when drained and acknowledges
only the captured, successfully applied batch. Released API batching can produce
40-second observation spacing; the remaining Machine deadline budget is divided
between pending idle age, reclaim sweep, blocking read and SQL completion (five
seconds each at the default 60-second deadline). Flush, block and reclaim tuning
cannot exceed that derived slice, and reclaimed batches flush immediately instead
of waiting for another batch interval. Delayed observations
cannot reactivate expired presence. Machine validity caching remains separate.
Machine timeout persistence uses the same presence owner for an exact-observation
inactive compare-and-set, also preserving the content clock. Its recipients are
resolved from current Machine access in that transaction. The existing deadline
owner now serves every server role, restores active observations on startup and
rechecks the current locked row at expiry; an old timer or delayed startup census
cannot replace that authority. The competing Machine timeout scan is removed.
Protocol's server configuration registry supplies the default 60-second Machine
and 120-second Session deadlines. Session expiry keeps its exact-publisher fence,
broker, Follow, Pending and badge effects, with one next-due wake instead of a
periodic scan. Pure Session touches and expiry retain the content `updatedAt`.
Recovery enrolls peer deadlines through the existing Socket.IO adapter and Redis
presence stream. Every headless worker follows that stream with its own broadcast
cursor, independently of the consumer group distributing legacy SQL writes;
another consumer's acknowledgement cannot remove its enrollment. The cursor is
captured before the startup census, so activations on either side are covered
without making a worker a Socket.IO peer. Renewals extend the persisted observation
without broadcasting another enrollment. Peers reread that current observation at their next deadline,
and restarted owners seed from persisted active rows. Startup seeds only after
the realtime publication transport is ready. The timeout-tick setting remains
the existing database-failure retry cadence, not an extra grace interval.
Machine activity delivery is ephemeral: process loss after an inactive commit can
lose its push. Reconnecting readers obtain current committed presence; connected
peer-node viewers can remain stale until their next Machine event or reconnect.
These development-source changes do not certify the loaded 60/120-second replay.
Incumbent heartbeat fanout and client grace clocks remain until their separate
transition-recovery gates pass; a client's own transport loss still withdraws
retained presence to unknown.

AppShell plugin membership consumes the existing semantic Machine presence owner
and its next grace-expiry wake. Heartbeats can extend that deadline without
republishing unchanged membership; expiry and fresh-heartbeat recovery change
the physical lease. UI request admission uses
[`isMachineReachable`](../apps/ui/sources/sync/domains/machines/reachability/machineReachability.ts)
under the authenticated Home and Account. A reachability failure remains recorded
across heartbeats until a later successful request or an authenticated socket
reconnect clears that exact scope. An admitted Machine reconnect clears only that
Machine; re-establishing an Account socket clears only its captured Home and
Account. Missing optional RPC methods remain capability gaps, and a timeout is
not Machine-offline evidence; only an explicit target-unavailable response
records that failure. If this client's Account transport drops, retained Machine
presence becomes unknown until an authenticated presence update or admitted
Machine-presence census re-observes that Machine in the same Home and Account. Reconnecting
alone does not renew a retained heartbeat. The shared presence projection keeps
the Machine's identity, while execution admission remains closed for unknown
presence. A fresh observation restores the ordinary verdict, including offline;
the heartbeat grace is unchanged. Explicit Retry and refresh still issue the request that can establish
recovery, while retaining identity, credential-currentness and content-access
guards. Registry changes retain their existing currentness notifications.
These development-source contracts do not certify loaded-runtime performance.

File-backed JSONL observation retains the existing follower/controller and native
file-watcher owners. Healthy native observation wakes the follower on change;
bounded backlog and failed delivery still use its existing drain/recovery policy.
Watcher loss or unavailable parent directories enable fallback reads until native
observation recovers. File replacement, directory consumers and symlink targets
remain part of that same watcher lifecycle, rather than separate polling owners.

The lifecycle owner consumes validated `AgentSessionRuntimeEvent` evidence, projects turn/transcript facts and supplies the prompt loop's thinking setter. The strict event union is owned by [`runtime/agentSessionV1.ts`](../packages/protocol/src/runtime/agentSessionV1.ts); [`plugins/events/hostV1.ts`](../packages/protocol/src/plugins/events/hostV1.ts) validates Host Event payloads through that same schema. Native callbacks do not become a second host state machine. Historical replay/follow and external-session discovery remain distinct from live input and transcript publication; they must not start another prompt loop or durable transcript writer.

In 0.3 development source, a runtime with a live continuation observer publishes
`runtimeCapabilities.providerContinuations: { supported: true }`. The existing
turn invariant retains the host context of admitted main-agent tool calls.
`provider-continuation-registered` associates a continuation id with that
parent turn and tool; it carries correlation facts, never permission authority.
A provider-started turn consumes that registration using `continuationId` and
the original `causedByTurnId`. Its operations use the retained original input
context, even after another foreground input has completed. Unknown, released,
sidechain, and unadvertised origins cannot acquire that context. Ordinary
provider starts keep their existing admission path.

`provider-continuation-released` retires a registration;
`provider-tool-contexts-released` retires parent tool contexts after the native
observer has crossed their registration boundary. Session disposal retires
both. Historical replay never creates continuation authority. The shared ACP
composer translates provider-owned evidence into this same host lifecycle;
transcript, plan, activity, approval, and terminal publication keep their
existing owners. The source callback receives a frozen copy of the composed launch
settings before runner-private credential substitution. It retains the selected
home, explicit overrides and removals; a host-finalized launch does not inherit
ambient environment values. Managed credential slots remain markers in that
copy, while only the native child receives their substituted values. The ACP
launch owner clears the retained source settings when its connection retires.
See the [compatibility ruling](compatibility.md#provider-continuation-authority-03-development-source)
for the coordinated host/SDK update.

In 0.3 development source, assistant deltas and authoritative committed snapshots
share an exact message identity and host turn. The Session-owned Run adapter
projects those snapshots into the strict Run event union; foreground Run results
exclude history and child-sidechain commits. The execution controller replaces
the current message's draft, including an empty final snapshot, while retaining
earlier assistant messages. Its streamed transcript uses the existing writer's
replacement operation on that same active row. Agent producers publish a final
correction before beginning a later assistant message.

A settled cancelled turn can publish its real native rollback checkpoint through
the same host boundary as a completed turn. Exact provider identity and duplicate
checks remain enforced. A delayed committed user-message sequence can join that
retained checkpoint after cancellation; reset or disposal retires the join. A
turn without native checkpoint evidence remains unavailable for rollback.

Repository code rollback has a separate host owner in 0.3 development source.
The Session runner binds `session.checkpoint_code_rollback` beside the repository
checkpoint lifecycle, using its Git context and the existing SCM rollback
executor. The host checks the Session, worktree and checkpoint scope before
applying the reverse patch and retains a backup checkpoint. Agent runtime facets
continue to supply native conversation rollback; they do not supply this Git
effect. The composed source test covers Action execution through the registered
Session RPC and real Git. Loaded-runner approval and file-state verification
remain separate evidence.

Claude native task completions use the plugin's existing task-notification
projector across SDK, terminal and transcript readers. Historical 0.2 metadata
results are accepted only as one tool result matching the origin's tool-use id;
their recorded failed/stopped status corrects the released false error bit.
Ordinary metadata retains its visibility filtering. These are development-source
contracts, not claims of released availability or loaded-provider validation.

The [input consumer](../apps/cli/src/agent/runtime/session/input/sessionProviderInputConsumer.ts) owns provider-input dispatch custody and admission quiescence. Ordinary dispatch and model-transition admission transfer use the same async custody scope. A runtime replacement initiated within an active dispatch retains that custody and drains other dispatches plus pending materialization; it does not wait for itself. External replacements drain all dispatches. Settled dispatch scopes cannot lend custody to later asynchronous continuations. This is a 0.3 development-source contract; native reply verification is separate evidence.

For unified Claude, the lifecycle subscribes before native presentation can start a resumed turn. The prompt loop consumes the ordered follow's terminal event, settles the lifecycle boundary and wakes that same input consumer. Home selects the eligible Pending row and its requested action, including Send now; a model-transition admission fence still blocks materialization. Claude's statusline applier owns current-model evidence: once a native statusline model is observed, assistant inference ids are usage evidence rather than selection changes. Transcript model evidence remains the fallback before statusline arrives, and verified native controls can still change the observed selection. This avoids false drift between a native selector and its resolved inference id without guessing alias equivalence or weakening provider admission. Loaded replay of this development-source behavior requires the updated runner.

In 0.3 development source, OpenCode V1 input acceptance consumes its unique committed
native user message independently of the long V1 message HTTP response. Live
message/status events wake an authoritative inventory read; the native Session,
nonblank user identity, submitted prompt and creation time must bind to the current
host turn. Missing, foreign or ambiguous native identity leaves delivery unproven.
A later HTTP response failure cannot erase proven native acceptance or establish
native finality. Busy, compaction, tools and permissions retain their existing
native lifecycle; an assistant `finish:stop` alone does not settle the turn while
the native operation remains active. The plugin supplies this evidence through
the existing Session SDK input receipt; the host retains custody and turn ownership.

In 0.3 development source, OpenCode idle reconciliation carries a completed
assistant error tied to the current native prompt through the existing Session
and Execution Run failure projection. OpenCode V2 places its HTTP response
body under `error.response.body`. The plugin extracts the provider code and HTTP
status and excludes the response body from the published diagnostic.

In 0.3 development, a missing launchable Agent CLI carries `agent_cli_missing` from both the command/terminal launch owner and the native plugin system-tool binding. Startup sanitization preserves that code; the primary Session issue classifier projects `dependency_failure` with static installation/path remediation. It does not expose raw startup error text or infer acceptance from a failed prerequisite.

The same closed startup-diagnostic owner preserves
`plugin_services_managed_provider_authority_unavailable` in the existing primary
Session issue and public status. Its fixed preview directs the reader to check
the Gateway and its Machine connection before retrying; private authority or
lease details never become the public error message.

In 0.3 development source, a rejected native Session construction before its
factory returns records its classified failure code, construction phase and optional existing
`failureCause` through the runner-open attestation. The original startup operation
settles as failed even while its controller stays available for recovery. Generic
construction errors remain `agent_session_error`; this evidence does not establish
a quota or authentication cause. Native error bodies are excluded. Generation
cancellation, an unknown effect outcome and a failed diagnostic acknowledgement
retain their existing uncertain/recovery behavior. A successful native factory return is
not replaced by a later generic host setup or commit-acknowledgement failure.

In 0.3 development source, the runner diagnostic and primary Session issue also
retain the host's closed MCP preparation, runner-generation, daemon-authority,
unknown-outcome and shared skill-delivery refusal codes. Arbitrary plugin codes,
messages and details remain excluded. If the runner exits before native open,
the exit owner retains its validated stderr failure cause in the tracked
runner's existing startup-failure envelope, including after webhook acceptance.
The original launch operation carries that cause and its code into the Workflow
result even when Home diagnostics are unavailable. Without a local cause, the
same requester-aware Home failure reader as startup recovery supplies only a
known primary Session failure observed at or after that runner's birth; stale,
unknown or unreadable evidence retains `SPAWN_FAILED`. This diagnostic projection
does not change admission, Stop, retry policy or native-open authority.

The same mapping retains `team_credential_provider_selection_not_current` from
Team binding preparation through runner exit, the primary Session issue and
the original launch result. Its fixed preview asks the requester to review the
Team model selection before retrying; raw Home responses remain private.

System-tool grants pin the selected absolute executable and captured arguments;
they do not clear the inherited host `PATH` used by an Agent's descendants.
The Agent binding's empty lookup `PATH` prevents a second executable selection,
not descendant command resolution. The grant producer owns that launch contract.

Codex Session and execution-run startup use one sanitizer for closed failure
codes and static messages, retaining bounded authentication and missing-state
facts without copying native error prose, payloads or causes. The host's primary
Session issue projector retains those Protocol-owned codes through publication.
The existing issue's optional `failureCause` retains a cause
code, preparation/turn phase, closed classified reason, recognized native error
code and HTTP status. Correlated Codex JSON-RPC application rejections also
retain `providerErrorMessage`, redacted by the existing bug-report secret
redactor. Native Codex turn error notifications retain the same redacted message
with or without a Provider connection binding, including managed-purpose launches.
Local Voice carries the existing `runtimeIssueV1` through its Account-carried turn
error stream and into the client runtime failure; HTTP status and vendor message
remain diagnostic evidence. Generic Home launch-error prose is still excluded.
This is diagnostic presentation, not classification or retry
authority; response data and generic native error messages stay excluded.
The redactor deliberately preserves filesystem paths in provider prose, so
redaction does not make that prose safe for server-readable Session state.
For E2EE Accounts, the client-side `deliverSessionTurnMutation` owner consults the
Account encryption-mode owner before sending the mutation, including durable
replay and socket-to-HTTP fallback. Its
server-readable issue and resulting `Session.lastRuntimeIssue` omit
`failureCause.providerErrorMessage` and replace native `sanitizedPreview` with
a static preview for the closed code, localized by the client's existing code
presentation. The original diagnostic remains available to the person through
an E2EE-carried projection; an encrypted Session transcript already carries its
full text and `runtimeIssueV1`. Transcript rendering, Find and copy retain that carried native detail
alongside the localized startup cause. Account mode is the authority for this policy,
not key presence or Session transcript mode. A retained Plain Session transcript
is not a private channel merely because its Account now uses E2EE; private
detail there requires an Account-encrypted projection. Plain Accounts retain
their existing diagnostic publication behavior. The server must never receive
E2EE Account native prose in the runtime-issue mutation; server filtering is
not the privacy boundary.
The native adapter and public Run projection carry the original diagnostic evidence. A recognized
native OS error retains its closed errno in `failureCause.code` beneath the
public startup category, including after repeated sanitization. That closed
OS cause excludes paths and native output; diagnostic prose follows the Account
privacy policy above. Version and feature discovery preserve typed
failures independently of SDK class identity. Realtime launch diagnostics keep
their initiating exception internally, so startup sanitization can retain its
typed cause while Voice retains its existing unavailable result. Failed startup
cleanup cannot replace the initiating rejection. Preparation
failures proven to precede `turn/start` reject the input without publishing an
accepted turn; a lost response after dispatch remains outcome-unknown. The
failure owner logs one redacted cause record for each settlement or refused
preparation. These facts describe 0.3 development source; they do not establish
the cause of a historical failure whose underlying evidence was not recorded.
Live ACP configuration refusals retain their request diagnostic at the native
adapter. The model transition coordinator uses the primary Session issue
projector to carry its closed `failureCause`, with `turn_start` as the fallback
phase, through failed or reconciliation-required results. Prompt errors,
metadata overrides, and public Action failure details preserve this same cause;
they do not infer HTTP errors from ordinary assistant text or introduce retry
decisions. A native JSON-RPC integer request code stays a `providerErrorCode`.
An unavailable model-transition RPC owner retains the known `turn_start` phase
with an unknown cause; absence of an owner does not establish a native refusal.
Shared Codex control obtains its per-Session socket directory from the host
Exec owner using the held native launch identity. Cross-UID Linux placement
reuses the Session MCP directory/verified exact-UID ACL owner under `/tmp`;
daemon-private ancestors stay private. The existing first-party native-launch
shim creates the native-owned alias child and grants the daemon UID traversal
only. Readiness observes alias publication without following the private socket.
Codex 0.162.1 keeps its physical socket under its own UID-only daemon directory.
For a separated executing UID, SQLite defaults to the shim-selected native
`CODEX_HOME`; startup argument construction omits the custodian's
`CODEX_SQLITE_HOME` override. The existing OS-user startup lock covers this
unresolved native root without opening the member's home from the custodian.
Happier connects through Codex's existing
`app-server proxy --sock <Session alias>` under that same executing UID,
so it preserves Codex's native directory/socket permissions and targets the exact
Session server. The existing supervisor owns readiness and cancellation; the
plugin supplies no UID and has no owner-identity fallback. Session MCP retains
its separate per-Session bearer authentication. The short Unix runtime root is
independent of an overlong `TMPDIR`, including same-UID launches. For a Session
placed in another execution target, Exec reports `plugin_exec_native_socket_unavailable`
instead of allocating a host-only endpoint. Codex then uses its existing stdio
transport through the Session target relay. Windows stdio retains its existing
contract. These are development-source contracts, not
certification of a loaded runner.

In 0.3 development source, a placed managed-purpose Provider consumer uses the
existing workspace holder channel's `loopback-listen` operation. Its OS-assigned
listener binds only `127.0.0.1`; accepted sockets reuse numbered `O/I/C/X`
streams. The host connects those bytes only to the canonical consumer endpoint
selected at launch, and the admitted Session/target lifetime closes both sides.
There is no guest Machine enrollment or additional Provider authority. An older
holder refuses the unknown operation; the canonical native supplier rebuilds the
holder from current Rust and target bootstrap replaces mismatched digests before
launch. Source tests do not certify a loaded guest helper or successful Agent turn.

In 0.3 development source, `codex_refresh_free_auth_unsupported` retains its
closed `details.reason` through the plugin error boundary and the host failure
publication into `Session.lastRuntimeIssue.failureCause.reason`. Runner file
diagnostics retain that same closed reason without upstream text. Identity,
workspace, credential-family and native auth-apply refusals use Agent sign-in
or account selection recovery; a missing refresh bridge asks for Machine
reconnection or a Happier update, while an unavailable native sign-in API asks
for an Agent update. These permanent refusals do not offer Retry. Existing
transient startup failures retain their normal Retry action. UI presentation
consumes the existing runtime-issue and Agent sign-in owners.

Codex app-server transcript projection also has one owner for native tool
identity. Typed commands and their raw echoes share that identity; code-mode
`exec` envelopes are suppressed only when a newly observed native tool has one
eligible same-turn invocation. Yielded cells remain eligible after returning their
initial result. When several invocations could own the tool, their envelopes stay
visible, preserving independent failure evidence. A raw or typed echo of an
already observed native call cannot be attributed to another invocation.
Native approval subjects carry the tool call identity to the host permission
owner, while transient interaction custody remains host-stamped. Plain native
Sessions bind app-server model discovery to the host model publication service;
the host remains the writer of `sessionModelsV1`. External Provider catalogs
retain their authorized publication path. Native model display names pass through
the shared display-name resolver, and unobserved discovery preserves retained
facts rather than inventing a catalog or a friendly name.

Session-native catalog controls also accept a `models` request through
`AgentSessionCatalogControl.list`. Successful replies carry the existing
`AgentSessionModel` rows and optional current/default model identities;
unsupported catalogs retain the shared typed control failure. Before a Session
exists, model discovery uses the declared `probeModels` preflight callback and
its host-scoped JSON-RPC client, with the already-prepared account environment,
working directory, cancellation and process cleanup.

In 0.3 development, declared JSON-RPC probes close stdin and await process exit
within the supervisor's existing grace period. The process owner reports
incomplete termination, including observed survivors. A completed model catalog
remains available to the picker and execution admission, with a separate local
cleanup diagnostic. Failed model reads follow the existing refresh failure path.

Current development source retains content-free failure diagnostics at the
existing owners. External Session follow identity admission returns a private
typed sub-reason and logs one local file record, including closed provider
failure codes and source-refusal codes where available. It never records source
paths, transcript rows or credentials. Outer source materialization failures
retain their closed registry/materialization cause before the bounded operation
owner discards the thrown error; retained-source validation failures keep their
own sub-reason even when the provider throws. Codex's terminal turn-failure owner logs
the classified failure reason, an admitted native error code when recognized,
and whether provider start was acknowledged. Unclassified failures remain
explicitly unclassified; these observations do not authorize input replay or
change Activity from unknown to idle.

In 0.3 development source, the host's ordered terminal transcript importer waits
for durable Home publication under the containing follow lifetime. Author listeners
and physical cleanup have no separate phase deadline; cancellation and source
retirement still release delivery waiters, while cleanup settles only when the
owned resource has actually closed. Post-admission loss travels through the
existing source-follow handle's failure observation to the Agent's evidence
ledger. Claude terminal and SDK paths retain unknown observation while the host
keeps its Activity publisher and Session or Run controls alive. A source failure
alone neither proves native process exit nor retires Home publisher authority.
These source contracts require a fresh runner after reload for live validation.

Fresh Claude SDK SessionStart hooks can precede creation of the native transcript.
In 0.3 development source, ordered history acquisition waits for the existing
authenticated accepted-prompt transcript proof; its pending observation scope
keeps Activity unknown. Successful source admission retires only that pending
scope, preserving real observation loss and outstanding native tasks. Refused
acquisition leaves the baseline pending rather than marking the native stream
lost, so later admission of the same binding can settle it. SDK history acquisition
failure settles at that observation owner: it does not invalidate accepted-prompt
resume proof or change a successful live SDK result into a failed turn. A later
authenticated SessionStart can retry the pending binding. Physical terminal
launch retains its separate required-follow admission barrier. Authenticated native
restart receipts remain pending for the existing identity-filtered reconciliation
after actual history admission. Resumed
histories still acquire their historical baseline at SessionStart. This source
correction requires a fresh loaded-runtime replay; it does not clear a running
Session's retained observation loss.

The host follow owner classifies admission refusals as deterministic or retryable,
carrying that fact through the private daemon/runner result and terminal bind error.
Claude's SDK history binding settles either refusal class without invalidating
accepted-prompt proof. Actual transcript-proof read failures retain their existing
error handling and JSONL redelivery. The follow lease owner deduplicates only acknowledged
metadata writes, retaining failed updates for retry at the existing source recovery
boundary without a new timer.
Private replay diagnostics distinguish page reads from listener delivery and
initial from continuation cursors without recording cursor bytes or content.

Hosted `SessionStart` and `UserPromptSubmit` forwarders wait for the host hook
handler's acknowledgement under the native synchronous hook's timeout and process
lifetime, without a shorter local delivery deadline. Normal native progression
therefore waits for authenticated transcript grant and follower acquisition.
Other observational hooks, including qualified external Session hooks, retain
their non-controlling 500ms attempt. Failed HTTP delivery, transport error codes,
and unreadable secret-file error codes are reported on stderr without secrets, paths,
hook payloads, or response bodies. Transport rejection or disconnection still exits
without a native policy decision; missing transcript proof keeps Activity unknown.
The [native hook owner](https://code.claude.com/docs/en/hooks#timeouts) retains
cancellation and timeout behavior. This is a 0.3 development-source contract.

A final successful Claude SDK result retires its still-observed query inventory
when no background task remains. Intentional query disposal then cannot turn
that completed observation into unknown Activity. Lost observations, pending
source baselines and unfinished native tasks retain their existing conservative
state. This is a development-source correction pending fresh loaded replay.

Machine and Session RPC dispatch in 0.3 development source uses the existing
[`RpcHandlerManager`](../apps/cli/src/api/rpc/RpcHandlerManager.ts) for one
content-free completion record. It measures dispatch through reply encoding and
cleanup with a monotonic clock, reuses the relay correlation or the encrypted
codec's existing call id, and generates a local id when neither exists. Opaque
transport ids are logged as digests; registered method names omit Machine/Session
scope. Known RPC error codes, admitted caller classes and private failed-admission
predicate labels replace raw error prose and stacks. Unclassified errors stay
explicitly unclassified. Completion uses the existing file info level, so ordinary
Session logging retains it; acknowledgement-projection failures join that same
record without changing the response. Resource handlers report predicates from their existing
admission checks; the diagnostic callback grants no authority and adds no wire field.
The existing daemon control timing owner suppresses successful `/ping` records,
keeps unmatched probes at debug and sends actual route failures to the file warning
logger. These source diagnostics require the next authorized loaded-runtime replay.

Signed direct Machine RPC in 0.3 development source reaches the same
`authorizeMachineRpcRequest` boundary as socket RPC. The peer adapter combines
the verified Home-signed Account with its installed Machine identity and content
mode, then supplies live admission checks to the handler. Public RPC parameters
cannot supply that authority. Handler exceptions remain typed RPC results in the
existing direct response envelope; `handler_unavailable` identifies a missing
handler. The client retains its conservative outcome disposition for that reply.
Loaded-daemon validation remains a separate check.

Prompt preparation failures during construction use the same canonical turn
lifecycle before Session cleanup releases durable delivery. The issue classifier
preserves `preparation_pending` or `attachment_unavailable` as `dependency_failure`.
Typed attachment refusals retain their code-only preparation cause through the
daemon boundary, loop diagnostic and Session failure presentation. A definitive
Plugin refusal retains its retryability instead of becoming a transient failure.
Typed Home-resolution failures retain their specific code (such as `profile_missing`)
through preparation and lifecycle publication. All use
static document/Home remediation, without publishing private references or
raw error text. Required context remains fail-closed; the issue does not imply
that an Agent accepted the initial input. This is a development-source contract;
loaded-runtime failure visibility and explicit recovery need separate validation.

After the live prompt loop has taken input custody, retryable
`preparation_pending` failures retain that exact input before native dispatch.
They do not publish a failed Turn or write a provider-rejection block. The existing
recovery wait observes Session metadata/reconnect or new queue growth. Retained
preparation also retries using the offline reconnection owner's jittered backoff,
without an attempt cap, so silent Home recovery can resume the original input.
Event wakes can retry sooner; each attempt re-runs full preparation and its
currentness checks. Replay-seed retirement keeps its event-driven wait.
Required Follow originals preserve classified Home source-read failures through
the hydrator and reconciler into this same recovery wait. Definitive refusals
still block the input; optional Follow context retains its omission behavior.
This recovery adds no Pending row or provider acceptance and changes no HTTP
timeout.
Cancellation ends the wait without native delivery, leaving
durable input recovery with the existing Pending owner. Required context is
never omitted to make the retry succeed. Permanent preparation refusals retain
their existing typed rejection and failed-Turn path. This is 0.3 development
source; the loaded-daemon outage/recovery journey remains a separate check.

The daemon's existing runner-respawn owner reads this retained failed-turn issue
before automatic recovery. A deterministic primary Session dependency failure
observed after the exited runner's process start stops that
respawn cycle; the host's issue remains the user-visible authority. An issue from
an earlier runner cannot veto a fresh explicit Resume. This uses the existing
exit-custody process witness and restart scheduler, not another retry policy.
Transient `preparation_pending` and `daemon_plugin_catalog_unavailable` failures
keep the existing automatic recovery path. Fixing configuration followed by
explicit Resume admits a new runner; it does not silently resubmit uncertain input.

The Session MCP owner refuses an unavailable daemon plugin catalog with
`daemon_plugin_catalog_unavailable`, rather than interpreting it as an empty
catalog. Before the live loop takes ownership, the construction owner projects
this prerequisite failure through the canonical turn lifecycle and drains its
durable mutation admission before releasing Session custody. The issue uses
`dependency_failure` and static daemon-connection remediation; it does not imply
missing Agent credentials. Once startup is admitted, the standalone GET
notification stream uses the startup registrations without a fresh catalog read:
the MCP transport cannot dispatch tools from GET. POST requests and native tool
RPCs reuse the admitted inventory's catalog while the daemon projection fact and
Session connection epoch are unchanged. The [plugin projection signal](plugin-platform.md)
invalidates it; the next request reads once and an unavailable refresh fails
closed, rather than dispatching stale tools. Replies without that signal contract
retain per-request reads. Daemonless runtimes retain their explicitly supplied
registry lease; effect-time contributor occurrence admission is unchanged.
These are development-source contracts, not completed live proof.

Accepted spawn nonce observation uses the daemon Session startup budget by default. Explicit finite observation durations are not reduced by phase-local caps; detached abandoned-spawn stop/archive observation retains its separate ten-minute default. The CLI nonce observer, daemon nonce endpoint, target RPC handler and shared acknowledgement race re-arm long deadlines in Node-supported timer chunks. Relay forwarding retains Socket.IO's native signed-timer boundary (about 24.8 days), so these local owners do not establish unbounded end-to-end relay observation.

Creation, inactive resume, tracked handoff and detached cleanup reattach the same accepted spawn nonce through the existing RPC connection supervisor after transport loss. Reconnection resubmits the remaining observation budget; it never sends another spawn. The original deadline and cancellation span reconnect, and settlement retires the underlying observation. Late acknowledgements from a disconnected connection cannot settle the resumed waiter. This describes current development source, not loaded-daemon certification.

In 0.3 development source, Session socket ACK writes wait under the existing
connection supervisor while startup is offline. The transport's connect timeout
bounds an individual attempt; it does not also terminate the waiting Activity
publication or publisher claim. Online connection resumes the write, while
authentication failure or Session disposal rejects it. Session close starts the
existing write cancellation before draining pending lifecycle writes, so offline
Activity delivery cannot hold close open; the undelivered snapshot retains its
durable outbox custody for recovery. Connected shutdown still drains writes and
closes the Activity publisher before disconnecting. The transport retains its
per-attempt timeout and reconnect policy. This source recovery contract is
distinct from a successfully loaded native Agent turn.

Accepted Pending settlement and exact publisher-authority reads also follow
the containing server operation's lifetime in 0.3 development source. The
server's receive/publisher admission queues and transaction retries can outlast
the generic control ACK deadline, so these waits use transport failure or
Session disposal rather than that shorter timer. The existing Session client
retains witnessed acceptance by local input identity and reoffers the same
idempotent settlement on reconnect and before its queue's next materialization
round. Main and Execution Run custody remain separate; reconciliation never
redelivers an accepted input to the Agent or treats Pending absence as proof of
acceptance. Exact server acknowledgement and current publisher/binding checks
still govern retirement. Loaded-runtime recovery requires separate validation.

The same operation-owned ACK lifetime now covers ordinary Session metadata,
Agent-state and Activity writes, transcript/message commits, Pending
materialization/admission and Follow/Discussion publication in development
source. Socket connect convergence and credential admission occur before a
handler's own deadline, so a bounded transaction phase does not bound the full
ACK wait. The trusted Discussion post/create handler likewise does not impose
a shorter timer on the publisher's serialized admission queue; current-publisher
checks and the transaction owner's resource budgets still apply after admission.
Connected shutdown retains the ordinary write lifetime while draining;
offline shutdown cancels it, and accepted-input settlement keeps its separate
early retirement. Durable transcript delivery follows the selected Session
handle and its existing outbox custody. Released `session-end` handlers that
never acknowledge retain their bounded advisory probe and authoritative inactive
read rather than an indefinite ACK wait. This describes partial development-source
ownership, not completed certification: terminal credential-admission failure
currently can omit an ACK without retiring the Session transport, and retrying
metadata/state after supervisor socket replacement still needs current-transport
reacquisition. Integrated package and loaded-runtime validation remain separate
evidence. The outstanding correction and evidence are recorded in the
[ACK deadline audit](../.project/plans/2026-10-03-find-search-prompts/lanes/audit-r30-ack-deadlines.md).

In 0.3 development source, the shared Session mutation outbox preserves its
captured server destination through delivery composition. Non-lossy turn
mutations refused with HTTP 400 or 422 settle as
`session_turn_mutation_rejected` in the existing durable dead-letter journal;
an exact turn end with a matching, committed non-positive receipt settles through
that same rejection path, preserving its decision and original mutation. Home
replays that decision by mutation id, so timer, reconnect and restart recovery
do not redeliver the deterministic refusal or report positive delivery. Unrelated queued
mutations can continue, while explicit failed prerequisites retain the existing
dependency-failure behavior. Authentication recovery, transient transport
failures and unmatched receipts keep their existing custody. This does not
relax the server's completion-anchor validation: the ordered host lifecycle
publishes acknowledged user, range and final assistant anchors together.
Loaded native completion and next-prompt recovery require a separate replay.

An exact daemon turn marker is local runner/admission authority, not proof that
Home has a `SessionTurn`. Input admission can record its host turn id before the
native Agent starts. For an accepted native start, the daemon captures the exact
turn in its existing tracked runner before awaiting marker persistence. The
shared atomic writer owns transient filesystem recovery. A persistent write
failure is logged while the live daemon retains that turn for its existing exit
outbox; it does not trigger a host retry timer. The host then admits `begin` to
runtime custody; a runner can exit between those operations
with no start row to deliver. Observed exit uses that same host id,
not the separate provider `agentTurnId`. A matching committed `missing-turn`
receipt is therefore a legitimate final refusal for conservative exit evidence.
It must settle through the rejection path above. Marker presence alone cannot
justify synthesizing a begin for an Agent turn that never started, and moving
marker publication after delivery would leave admitted local work without its
existing runner authority. This describes the 0.3 development lifecycle, not
historical attribution of every retained exit journal.

Tracked handoff accepts cancellation during preparation, then closes cancellation immediately before target launch begins publishing canonical Session metadata. Confirmation, commit and source cleanup use the completion signal after that point; a late cancel request cannot abandon the accepted target launch.

`SessionHandle.watch` follows committed retained transcript rows through the shared socket source and delivers complete text before advancing its reconnect frontier. Provisional stream deltas do not become retained message events. Cancellation ends the watcher; credential and plugin-occurrence checks prevent further delivery after retirement.

In 0.3 development, bounded server transcript pages, exact-message/action-reference
lookups and reply projections use the existing `captureReadSnapshot` owner: admit
the request once, capture publication and content facts in that snapshot, then
finish from the captured result. They do not repeat permission evaluation after
capture or re-read a reply in a second snapshot. Revocation applies to the next
request. Each live socket recipient disclosure remains its own current read
admission, independent of the original writer's retained custody.

For cold native history catch-up, a Session factory may declare `transcriptIdentity`, its pure provider-owned identity codec. The bound `transcripts.reconcileSourceIdentities` operation uses the canonical paginated transcript reader and encryption/semantic decoder, filters conversation rows to the selected Agent, and supplies only the codec's declared correlation fields. It checks the current Session, plugin occurrence and native Session identity before and after the read. Unsupported, failed or malformed reads reject rather than becoming empty coverage. OpenCode hydrates its existing authored-ID tracker from exact committed identities, including witnessed 0.2 predecessor mappings and import IDs. Its current percent-encoded import IDs preserve opaque identity tuples; the predecessor codec compares complete constructed legacy or JSON-tuple IDs only after checking a separate exact native-session witness, never by splitting opaque IDs. Unprovable legacy coverage is reported through the existing informational Session-event and default log owners; only that historical snapshot is suppressed, so subsequent settled native turns can still sync. No new identity registry or transcript writer is introduced. These current-source contracts are distinct from full authenticated live validation of the composed 0.3 runtime.

Normal input and in-flight steer use the shared [host dispatch preparation](../apps/cli/src/agent/runtime/turns/prepareSessionInputForProviderDispatch.ts). It delegates selected skills, plugin references, attachments and media to the canonical structured-input resolver immediately before provider effect. The resolved envelope reaches the Agent through the same typed turn metadata, and its JSON projection counts toward required context before optional Follow context is fitted. Native slash commands retain their leading grammar with resolved context after it. Resolution failure is rejected before provider effect with its existing diagnostic and retryability; an undispatched replay-seed association is released. Steering rechecks Session binding, turn availability and admission after asynchronous preparation. This describes 0.3 development source, not completed loaded-runtime validation.

The [Session prompt-plan producer](../apps/cli/src/agent/prompting/coding/sessionPromptPlan.ts) prepares coding policy through the canonical Launch Profile reader, including authorized published-profile Artifacts. Prompt rendering, title-tool advertisement and permission admission consume that same prepared fact. Session-owned retained Runs read it through the existing internal runtime-control binding; their Run intent id is not a Launch Profile id. A missing or retired producer, or failed preparation, withholds title-tool advertisement and admission until the policy is available again. An unresolved profile retains the canonical Account-default policy. No new policy wire field or persisted policy copy is introduced.

The host fits retained WorkerUpdates against the current optional context allowance before dispatch. A still-deliverable wake that cannot fit stays with the input consumer until context/source, metadata, admission or user input changes; parking neither commits a transcript event nor acknowledges provider acceptance. Source admission is rechecked before parking, so a withdrawn wake releases custody even if it still cannot fit. User input keeps priority, and the retained wake is reconsidered afterward without selecting its producer again.

In 0.3 development source, every represented WorkerUpdate enters durable transcript custody under its completion identity before provider dispatch, including updates attached to ordinary input or in-flight steering. Context-only wakes use the same event publisher. Failed transcript admission withholds provider dispatch and leaves the producer's existing custody pending; exact provider acceptance retires that custody only after successful admission. Several worker cards may share one native input.

### Usage-limit reset continuation (0.3 development)

The shared Session usage-limit controller owns ordinary waits, including
foreground CLI sessions without a daemon. It uses the common recovery scheduler
and control router. At a scheduled reset the router uses a native quota probe
when available. A reported reset can drive continuation for a provider without
a probe. Codex readiness and Claude wait timing use the latest reset across
exhausted windows. If an exhausted window has no known reset, the wait uses
the existing recovery backoff. Transient probe failures retain the authorized wait. Inactive waits are
restored after machine-control registration and wake through fresh session
resolution. Native quota and credential failures without a Connected Account selection do not enter
Connected Account authentication recovery.

The daemon's [runtime-auth recovery scheduler](../apps/cli/src/daemon/connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler.ts)
owns a wait for the exact failed turn and selected Connected Account. When a
directly selected account reaches its reported reset time, recovery admits the
configured continuation through the existing [continuation dispatcher](../apps/cli/src/daemon/connectedServices/continuation/createConnectedServiceContinuationMessageDispatcher.ts)
and [Pending delivery owner](pending-delivery.md). Pending activation owns any
required runtime attachment; restarting an idle runner alone is not continuation.
Queue admission and Agent acceptance are intermediate outcomes, not recovery
proof. The existing credential-qualified outcome owner must observe successful
execution.

Claude's native account-usage delivery does not hold primary failure reporting or
terminal readiness behind a quota transport acknowledgement. A primary failure
records its quota snapshot with the existing evidence-only disposition; its
runtime-auth recovery remains the switch owner. Sidechain and passive quota
observations retain their normal quota policy and do not fail the parent turn.
Delivery failures remain visible through the existing host logger and retry owner.

The runtime-auth scheduler treats typed pool-switch lease contention as a local
retry without spending normal provider attempts. Runtime-auth and usage-limit
recovery have no attempt ceiling or age-based terminal-record expiry. Real
provider reset and Retry-After timing still govern when work can resume, and
temporary capacity failures reuse the shared recovery scheduler's backoff rather
than a separate capacity ladder. After a local switch or credential repair,
recovery waits passively for credential-qualified provider evidence; it does not
schedule repeated repair attempts to seek proof. Explicit checks and user Stop
remain available. A newly failing token starts with its own source evidence
rather than inheriting another token's pending proof target.

Coalesced switches share their committed account and
credential generation while preserving each waiting Session's own trigger reason.
Claude's existing shared-generation application path applies credential revisions
through its native auth surface, including when the selected member is unchanged;
it retains the existing currentness and credential-qualified outcome checks.

Active Session RPC checks and CLI/MCP checks use the same exact daemon-owned
attempt and resume-prompt mode. A failed daemon check cannot fall through to a
competing provider-local recovery path; ordinary live attempts use the shared
Session controller. Explicit ordinary user input goes through Pending
rather than waking an automatic continuation during pre-admission revalidation;
the dispatcher suppresses obsolete continuation when newer input is queued.
Automatic continuation revalidates the current issue and recovery intent before
admission. Cancellation, a replaced issue, newer user input
and disabled automatic resume take precedence; the original interrupted input is
never replayed. Readiness, account-switch and runtime-launch acknowledgements
alone do not dismiss a usage-limit warning. Accepted Pending admission hands
continuation custody to the existing queue and activation presentation; it does
not prove provider quota recovery. Explicit cancellation or subsequent Agent
activity can also end the wait presentation. A failed reset request releases its
checking state for retry. This development-source integration
still requires composed loaded-runtime validation.

Protocol's `buildUsageLimitIssueFingerprint` owns issue identity across reporting,
controls, and presentation. Runtime-auth classification captures the accepted
failure's identity and projects it separately from `runtimeAuthRecoveryAttemptId`.
Recovery timing, cancellation, and action targets apply to the current issue only
when their fingerprints match. Older opaque attempt fingerprints remain readable
but cannot establish that association. Live Check Now reads the public issue
through the Session's existing authenticated Home transport when needed; an
unavailable read returns an error, while a different issue uses its current local
controls. Explicit new input still supersedes prior automatic waits independently
of their issue identity.

### Goals without native controls (0.3 development source)

The Session Goal router retains native Goal controls when available. When no
native Goal adapter exists, `happierSessionGoalControlAdapter` stores the
objective as a Happier-origin item in the existing Session work-state field.
Writes use the target daemon's durable work-state custody; a missing writer
cannot acknowledge success. Other work-state sources retain their items.
The Goal control uses that daemon capability for Agents without a native Goal
declaration, including configured ACP and installed plugin Agents. Keep going
owns continuation for those Sessions; the host objective adds no native Goal
capability or second continuation loop.

The Session-bound `session.tasks.set` Action and its `session_tasks_set` MCP
tool publish a complete ordered Happier checklist through the same work-state
owner. An empty list clears that checklist. Provider task and plan sources keep
their own published items in the Session list.

`session.goal.clear` owns clearing the Goal and removing its Session-scoped
Keep going triggers through the existing trigger owner. UI and agent callers
consume that same Action result; the Goal control has no separate removal step.
After confirmation, the UI lets this finite Action finish independently of
Goal-panel or Session-view dismissal. Native Goal removal can retire that panel
before trigger removal completes; presentation cancellation must not interrupt
the compound mutation. Account authority remains owned by the Action front door.
Other Session Habits remain attached. Native Goal adapters continue to own only
the native Goal mutation. A prerequisite-read or native-clear refusal retains
the attachment; a detach refusal is returned after the Goal clear, and an
explicit Clear retry can finish detaching it. The open Goal control reads Keep going from the
Automation trigger projection and refreshes through its existing change signal;
only unsaved field edits and pending writes belong to the control.

Within one Workflow condition or stop evaluation, the existing Session value
resolver lazily reads each demanded source (Session and usage) once. Short-circuited
fields do not read their sources. The scope ends with that evaluation; the next
evaluation reads new Goal and usage facts, without a TTL or shared cache.

In unreleased 0.3 source, attaching Keep going to an opened Session checks its
native Goal owner through the existing Goal Action. A native owner refuses the
attachment with `native_goal_owner`; unavailable ownership returns
`target_unavailable` rather than starting a competing continuation. Claude's
native runtime wires `createClaudeNativeGoalWorkStatePublisher` to the host's
`goals` work-state publisher. Native Goal snapshots therefore reach the same
Session projection; Keep going does not manufacture those native items.

Inactive Goal Set, Get and Clear from an Action host without work-state custody
route to the target Machine's registered daemon Goal handler, including when the
caller runs on that same Machine. Native Get can refresh the persisted work-state
projection, so it uses that custody too. The daemon invokes the declared inactive
facet and commits its projection through the existing mutation outbox. These
controls do not resume the Session unless the caller requests the existing
Set-with-resume operation.

For an opened native-Goal Agent, the host's native Session input dispatcher
serializes Set and Clear with new prompt dispatch. A mutation received during
an active turn waits for that turn's existing completion and publication boundary;
later queued input follows the mutation. The Goal receipt still waits for the
Agent's native acknowledgement, and Get reads the canonical work-state projection.
If that acknowledgement precedes release of the native transport, ordinary
input remains in the host dispatcher while the Agent's optional passive
`activeInput.waitForInputReady` observation settles. The host then rechecks
input custody and Session retirement before authorization and send; the Agent
does not own another prompt queue.
Queueing does not publish a synthetic Goal. Session retirement refuses queued
mutations before they reach the Agent. Loaded-runtime replay remains required
before this development-source correction is certified.

Native controls demand the existing Session event subscription before reading
the admitted native identity. Get immediately after Resume can therefore use a
replayed startup identity even before a transcript subscriber opens.
The host retains that accepted identity snapshot for the later subscriber;
observing it does not admit another turn or Goal transition.

Codex's App Server path opens and persists its zero-turn native thread during Session startup,
including when no startup instructions are supplied. The existing native
attachment owner makes that thread readable by later attachment and inactive
control clients. Live Goals use the client already holding the thread and
start no additional native process. This does not submit an ordinary prompt.
Pre-input Set and immediate Get use the same native Goal codec and host
work-state publisher as later controls; no pending-objective store is added.
A missing native thread retains the unavailable result and names the
`native_effect` failure phase.

While a native Codex start waits for another start on the same Machine, its
existing Session Agent-state publication carries the optional, content-free
`workStatus: 'waiting_for_startup_lock'`. Protocol's awareness presenter maps it
to working and the Session line explains the wait beside the queued-input count.
Acquiring the lock or failing/cancelling the start clears the detail. Older
Agent-state readers ignore the optional detail and retain their generic status;
the startup lock's scope, cancellation and readiness boundary are unchanged.
This is 0.3 development-source behavior, not loaded-runtime certification.

On native Codex resume, the Goal source reads `thread/goal/get` before accepting
empty-state notifications. The resume response has no Goal field, and initial
absence before that read cannot clear a retained Goal. An explicit `goal: null`
read or a subsequent native clear publishes an empty source snapshot through
the same SDK work-state publisher. Missing or malformed Goal payloads leave the
retained projection intact. This is development-source behavior; the composed
Stop/Resume replay remains required on the loaded runner.

In 0.3 development source, the Session metadata publication owner and the
inactive daemon's work-state delivery compare the effective Goal before and after
the successful work-state commit, including a clear. Both use the same effective-Goal
comparison. A change appends one content-free `goal-changed` transcript original;
equal snapshots, usage/progress-only updates and refused writes append none.
Native reopen/readback compares the final updater's before-and-after Goal, not
the client's possibly stale or independently refreshed metadata snapshot.
Follow hydrates that original as a source-linked notice under the shared event
policy. The daemon uses its existing transcript custody and the same Goal event
local-ID codec. Its Account-authenticated HTTP append does not supply a live
publisher's authority; the current server personal-notification path requires that
authority, so the daemon append alone does not deliver a personal alert. Inactive
Goal changes remain available to Follow/Voice readers on their next read; no
separate off-source personal-alert authority is added (R-ORC-3).
The existing transcript append retries while the process lives. A crash
between the Goal commit and append may lose that follower notice; the committed
Goal remains durable and visible. No separate notice receipt or delivery ledger
is created.

In 0.3 development source, Claude SDK Sessions retain `SessionStart` on the
existing authenticated command hook: native startup precedes SDK initialization
and cannot be observed by callbacks registered in that request. The same host
hook owner grants transcript access and admits the resume candidate used by Goal
following. Later lifecycle hooks use the SDK control channel; `SessionStart` is
not also registered there. Fresh loaded-runtime replay is required for this fix.

Claude can persist an active Goal sentinel before its native command echo. The
Goal source joins that sentinel to the exact SDK command UUID through the echo's
`parentUuid`, then awaits the host publication acknowledgement. Set can settle
while native work continues; it does not wait for another active attachment or
provider completion. An unrelated sentinel or echo cannot acknowledge the command.
When an authenticated SessionStart changes the native Session id, the source
discards the preceding transcript's learned id before processing the new file.
The new sentinel can then join its exact command echo even when that idle query
starts a fresh native conversation.
Native settlement failures may carry the closed, content-free
`goalControlFailure.phase` receipt through the SDK, host router, Action result
and UI Goal operation reader. CLI JSON failure envelopes retain the same facet
under `error.goalControlFailure` in generic `actions invoke` and the shared
friendly-command presenter. The standalone CLI's daemon HTTP reader uses the
canonical Action failure projection to preserve the same strict facets while
excluding daemon-private top-level fields. The daemon's inactive native-control
adapter retains the same receipt when a live Session method is unavailable,
including before a native thread exists. Each projection validates the same closed facet
and drops malformed diagnostics without discarding the refusal. The runner's
existing RPC completion record logs that phase once; vendor error text, objective
content and local paths are excluded from this diagnostic facet.

In 0.3 development source, Codex Goal Get/Set/Clear failures also retain a
content-free stage, exception class and recognized error code in the existing
diagnostic/result `details`. This distinguishes client creation, initialization,
the exact native Goal RPC and host publication. Active and inactive adapters and
Session RPC projection share the Action-result diagnostic projector; arbitrary
plugin details, vendor messages, Goal text and paths are dropped. Unknown error
codes remain null. These fields diagnose a refusal without adding a retry or
changing its settlement phase.

The Codex control owner also records a closed local refusal condition rather than
native error prose. Codex 0.162.1 uses `-32600` for several distinct refusals;
that code alone does not prove disabled Goals or a missing thread. Only its exact
disabled-Goals refusal from a Goal RPC returns `unsupported` with
`codex_goals_disabled`. It does not override native configuration or resume a
thread. Missing-thread, ephemeral-thread and identity-mismatch conditions remain
content-free diagnostics under the existing unavailable result. Bundled and
installed Codex plugins share this control owner. Loaded QA acceptance remains
separate from the isolated native contract test.

An active origin Session receives Workflow continuation through its existing
context-only `workflow_step` queue. Preparing that input authorizes the exact
Session and workspace but does not resume or reconfigure a live runner.
Inactive origins still use canonical Session resume before the offer.

### Roles and managed work (0.3 development source)

Protocol's [role resolver](../packages/protocol/src/prompts/roles/resolveRoleSelectionV1.ts)
owns effective role fields; its
[renderer](../packages/protocol/src/prompts/roles/renderSessionRoleBlockV1.ts)
supplies the host prompt-plan role block. Plugins contribute source instructions
and preferences through the declarative catalog, not another prompt or Session
lifecycle owner. A Session's complete role snapshot and notes are owned by
`work.sessionRolesV1`. Worker starts copy the effective set; explicit same-Account
bulk application is separate from selecting a role or editing the lead later.
Context documents remain in the Session Context stack, not a role-memory field.
Native delegation remains the default where it satisfies the request; explicit
Happier-managed delegation uses the existing Session/Run start owners.

An authored `configuration.workspaceWrites` ceiling is committed before native
Session admission in the existing owner metadata's `runtime.workspaceWrites`
field. Attach retains it. The same Protocol workspace-policy reader combines
it with the selected Role: either denial wins, and removing or relaxing a Role
cannot relax an authored denial. An authored `allow` adds no ceiling. Native
admission refuses an Agent that does not declare enforcement of denial. Claude
enforces denial through its native launch
settings; an unchanged ceiling is not a live TUI directive. Happier Actions
that do not write the workspace keep their ordinary Action approval policy.

Finite Run admission consumes the existing adapter selection: Session-derived
Runs use `capabilities.sessions.workspaceWrites`, and native execution-only Runs
use `capabilities.executionRuns.workspaceWrites`. Either surface declares `deny`
only when its native runtime enforces `configuration.workspaceWrites: 'deny'`.
An undeclared surface retains `role_policy_unenforceable`; an admitted ceiling
reaches the selected native factory in its existing open configuration.

OpenCode server mode applies the same ceiling through its native permission
config and Session rules, denying file-modification tools, Bash and native
child Agents while retaining read tools. Session rules also apply on resume
and external attach. A live ceiling change requires provider restart; ACP
keeps the typed `role_policy_unenforceable` refusal. This is 0.3 development
source behavior; an already-running daemon needs its owner to reload it.

Session Role Actions read Account overrides and retained role sources through
the Session runtime's existing private owner-Account context. The shared prompt
library loader and Protocol parser serve that context and ordinary CLI Account
reads; private catalog preparation never publishes Settings or catalogs into the
focused Account. Credential retirement withdraws the private context rather than
borrowing the focused Account's Role policy. This is a development-source contract,
not certification of an already-loaded daemon or exported UI.

Public Session-owned Run starts with an explicit role, including Second opinion,
prepare that same private Account context before the shared agent-start policy
resolves and stamps the role. The request carries role identity only; installed
Agents use the same host preparation. A live Session supplies freshly resolved
roles from its retained role owner; its runner's cold built-in Agent inventory
cannot replace that installed-source observation. Standalone callers retain
their Account-backed inventory and the same Protocol role resolver. A detached
host start does not invent a Session or Workflow caller: Machine admission
resolves its selected Role from the admitted requester's private Account context.
The existing policy owner assigns present-user starts depth zero and applies
ordinary depth, permission and allow-list restrictions to Account automation.
A matching explicit Team model retains its resource identity when the Role is
stamped; a Role selecting a different model follows the existing model override
rule. An unavailable
context returns `target_unavailable`; typed role-owner refusals retain their
error code. Both carry `details.executionRunStart.runCreation: 'noRunCreated'`
and a closed `refusal: { code, phase: 'agent_start_context' }`. The refusal code reuses
the existing availability reasons, including `role_overrides_unavailable` and
`role_source_incomplete`; role text, credentials and source payloads never enter
that evidence. The existing start-failure projection retains it through RPC
normalization. Loaded-runtime verification remains separate from this source
contract.

Creation origin, current turn initiator and causal work depth are separate host
facts. The [turn stamper](../apps/cli/src/agent/runtime/session/turn/stampTurnFacts.ts)
distinguishes user, agent-session, workflow and host input; a user turn has depth
zero, while the start-policy witness retains the Session's starter depth as well.

For accepted protected originals, root ownership comes from the admission receipt:
an Account receipt must name that Account; a Machine receipt must bind the exact
Account and source Session in `admittedTarget`. Follow and Discussion carriers
do not become direct originals merely because they have a user role. Inherited
roots retain their existing lineage, and exact Execution Run inputs remain outside
this Session-root selection. Reporting membership can change without rewriting
these facts. The shared start
policy enforces role engines, permission ceilings and the Account work-depth
limit; consumers do not infer authority from a tree row or worker result.

Autonomous conversation check-in is separate from that structural start policy.
The [exchange reducer](../packages/protocol/src/sessions/messages/autonomousExchangeV1.ts)
counts actual agent-caused new turns, including a `followUp` that starts a turn,
through the original input's host admission and accepted-turn facts. Selection,
enqueue, true same-turn steering, quiet context and returned answers do not count.
The Account setting `coordination.autonomousCheckIn` defaults to five starts;
`afterTurns: null` means Never pause. Continue, ten more and Stop control held
continuation through the same original-input owner. They do not reset causal
work depth, raise a permission ceiling or change an individual Run's turn budget.
Unavailable authority holds unstarted work; it does not create a host-local
counter. Cross-Account and exact-Run start integration remain separate validation
obligations, not guarantees supplied by this reducer.

The [Session reply path](pending-delivery.md#correlated-session-answers-03-development)
uses that original input's custody for one exact answer or typed terminal outcome.
An informational return adds no check-in count even when admitted to wake an idle
asker. The shared
[receiver decision](../packages/protocol/src/sessions/follow/sessionReceiverDeliveryV1.ts)
distinguishes wake intent, next-turn context, hold and drop; enqueue or resume
success alone is not proof of an accepted new turn. Follow and Discussion delivery
consume these owners rather than maintaining their own conversation caps.

In 0.3 development, the shared Role block describes send, inline/later ask,
exact answer/pass and selector inspection through the existing Actions. It is
guidance, not a second admission owner. The input prompt context supplies an
actual request's reply identity; the host result owner still arbitrates explicit
fulfillment against turn-final fallback. Voice Role blocks retain their existing
conversational projection, and frozen Workflow steps retain their own Role
delivery boundary.

In unreleased 0.3 source, successful file-review Discard and Restore Actions
emit one `file_review_note.v1` transcript item per receiving Session, covering
all affected paths; successful Undo emits the same item kind after its guarded
write. Keep emits none. Delivery uses the existing receiver's `next_turn`
intent and never resumes or steers the Agent. Authenticated Pending admission
stamps the closed, content-free `nextTurnNote: 'file_review_note.v1'` operand
into its existing receipt. The runtime validates the note and receipt, retains
it as structured facts in the existing mode queue, and renders an agent-facing
`<happier_review_note>` block at final provider preparation for the next actual
input. The shared Protocol formatter preserves person-facing transcript copy
while attributing Discard, Restore and Undo to the person for the Agent and
explaining how to respect the resulting file state. Blocks use JSON text with
escaped angle brackets, like Run Follow notices. This leaves primary command grammar untouched,
without adopting the note's permission or primary-input identity.
Host-local and provider-native control commands leave notes retained; native
command bytes and represented input identities exclude them. The next ordinary
provider prompt carries and settles the retained facts. The same
receipt authorizes retained-context materialization; ordinary inputs cannot
claim that status through display metadata. Provider dispatch settles the
represented note through existing Pending custody. A note-delivery failure
remains separate from a successful file mutation and must not replay that
mutation. Publication requires advertised Pending revision 5 at the existing
sender/wire negotiation owners; unsupported or unknown Homes receive no note POST.
HEAD discard uses the existing backend's pre-mutation status inventory
to omit unchanged paths; unavailable status evidence reports note failure without
blocking the discard itself. Requeued inputs retain note identities without
rendering already-represented note text again. Composed runtime and presentation
validation remain program gates.

In 0.3 development, the content-free
[request attribution projection](../packages/protocol/src/actions/actionRequestAttributionV1.ts)
also remains separate from Session/process ownership and execution credentials.
Human input derives its requester from the authenticated Session admission receipt,
not authored labels. Protected machine input can retain that original admitted
cause; its immediate sender remains the separate protected source Session.
Queue batches and private native-turn/Action custody retain a copied cause rather
than a Session-global latest requester. Accepted Workflows retain it inside their
existing accepted origin. This observational value grants neither execution nor
approval authority; missing human identity never becomes the Bot owner's identity.
Deferred approval-result inputs retain the originating approval's admitted cause
through protected host input admission, so a resumed Agent turn keeps its original
requester. The deciding person's current input, focus and permission level do not
replace that cause or grant permission to the resumed turn.
Spawn first-input handoffs preserve the invoking Action's admitted cause, including
for plugin and automation callers. Original UI, voice and CLI inputs requiring
Machine admission retain the authenticated Account requester before content
sealing, including Session-creation first input and paired-terminal bindings. An
API-token root does not establish a human requester; terminal attribution does
not elevate its automation authority to present-person approval authority.
Raw-RPC Session creation retains authenticated present-person host authority
through its first-input handoff to the same sender; automatic host creation
does not infer a human requester from the host credential.
Local Agent/MCP tool execution copies the cause
from the same active-turn witness as its permission and input facts; the daemon
Action channel carries that witness through its existing projection. Neither path
derives the requester from the executing Account or the child Session's ownership.
Signed Session Action origins retain the same protected cause through both socket
RPC and external Action receivers. A receiver uses that admitted value when it
creates an approval and its continuation; transport authentication identifies the
immediate sender and does not replace the original requester.
The private Account invocation carrier retains a host/MCP cause only when its
qualified requester matches the genuine admitted Account and Home. Unknown
requesters stay null; mismatching people or Homes and terminal, API-token,
Session, Workflow or Plugin callers are refused by the shared invocation
classifier. This preserves an own-Account approval continuation without letting
its sender name another person. Mixed-person requester approvals keep their
existing original-Session decision route and signed cause.
Credentialed CLI hosts stamp the separate execution Account in their shared Action
context; Session-only transport credentials do not supply Account authority.

The strict [WorkerUpdate](../packages/protocol/src/sessions/relations/workerUpdateV1.ts)
envelope carries actual engine facts when available, owner outcome, source
pointer and optional deliverables. Truncated results require a source pointer.
In 0.3 development, source hydration preserves the complete original result.
The shared worker-context fitter applies the receiving runtime's allowance from
matching Provider context evidence, including to an admitted Follow original; an unknown model window
adds no local trim. Prior sends containing the same text do not suppress a
distinct source outcome. Fitted output retains its source pointer and settles
only the exact admitted original after native acceptance.
It is host context, never a fabricated user message. A Session worker's pending
turn-end review postpones settled delivery. Follow policy selects quiet context
or a wake from the source outcome. The receiving machine's daemon can request
Resume for an eligible inactive lead through the existing input/resume owner;
an explicit Stop holds automatic delivery, archive drops new delivery, and an
unavailable machine leaves it pending. Busy receivers take context at an input boundary
without steering. In 0.3 development, source, permission and Follow policy are
decided when a new original is admitted. Its bounded Pending materialization
and settlement retain that admission while checking the original's active
custody and exact Account, Session, Home, Machine installation and publisher
identity. Policy withdrawal applies to the next admission; explicit Stop and
replacement of that identity still prevent continuation. An exact settled
original reuses its retained exchange state without requiring a current
check-in preference. Enqueue or Resume alone does not prove native acceptance.
Work/Inbox are projections of these owners, not a second turn scheduler or
permission ledger.

In 0.3 development source, Session Follow progress ACKs use the publisher owner's
Serializable snapshot path. They bind the exact current publisher, accepted
input and existing route frontier without joining the socket's heartbeat queue.
An already accepted original retains its admission: source grants, Follow policy
and mute preferences are not re-evaluated during its ACK. Cursor locking rereads
custody and route state, not permission. Fresh source reads and source-key
acquisitions still admit current access at their own natural boundaries.
Settlement never regresses a Turn frontier. The same Turn follows its typed
lifecycle; a different Turn advances only when it is producer-selected as current
or has strictly later transcript coverage. Unknown historical order preserves
the stored Turn while numeric coverage can advance independently.
Only actual manager or explicit Follow progress publishes the destination's
content-free Account change, as rule progress already does. Repeated settled
ACKs publish no new wake; legacy no-original frontier ACKs allocate no Account
change cursor. An admission
deadline or unavailable transaction returns the typed `retryable` refusal. The
existing reconciler retains the accepted request and retries its ACK at the next
preparation boundary, suppressing another delivery of that accepted context while
the refusal persists. Successful or terminally refused requests retire this local
custody. For admitted originals, the provider-outcome normalizer passes its existing
Pending acceptance promise to the correlated Follow effect. Native replay custody
retires immediately; the reconciler joins that write before ACKing. The
reconciler re-observes the exact admitted receipt for the current publisher
generation after reconnect or Resume; it keeps the accepted original's represented
prefix rather than replacing it with newer source progress. A stale generation,
unverified acceptance or transport loss retains that original's request for the
next preparation boundary, without another native send. No-original context-only
wakes retain their existing at-least-once transport recovery behavior. Typed
semantic refusals and exceptions share the server's structured ACK phase/cause
diagnostic, without input content.
This adds no timer or durable delivery history across a host restart.

In 0.3 development source, content-free Account changes reach context-only input
through the Session client's existing changes-feed recovery owner. It wakes the
consumer for changes to that destination Session or its access, including Follow
destination invalidation and workflow origin delivery. Unrelated Account writes
leave the context consumer parked when the feed identifies the changed entities.
An unavailable feed, pruned cursor, full page or disabled changes sync retains
conservative re-observation. Exact destination broadcasts, reconnects and Execution
Run worker waiters retain their existing wake paths.

Quiet originals represented in a natural input retain their own Pending identities.
The host's exact-input acceptance binding records only the originals selected by
final Follow preparation, plus required returned-answer context. One primary
input remains the native Turn and permission witness. Its actual native acceptance
settles the represented originals through the same Pending writer before the
primary's write; each Follow ACK joins its own settlement. Neither transport
completion nor an omitted original earns acceptance.

Follow intake keeps an ordered prefix per source: a partially represented or
deferred original also defers its later originals, without blocking unrelated
sources. Source notifications reuse the receiver's existing prefix-admission
traversal, so a failed admission cannot be bypassed by a later notification.
After accepted progress, the destination invalidation re-enters that same
ordered range from its acknowledged cursor. The requester Account's own receiver
changes and reconnect/gap observations re-observe all configured sources,
including manager and explicit Follow without private rules. Private-rule
discovery filters unrelated source changes; currentness and binding lifetime
still govern every recovery.
A manager's optional terminal context likewise cannot consume a selected
transcript original that still belongs to admitted-input delivery. Both Account
reads and restricted Runner projections retain the original's stable local id;
an explicitly null id still permits legacy no-original context. Account Voice
keeps its independent original-reader lifetime. These are 0.3 development
contracts, not new queues, cursors or restart-durable delivery history.

In 0.3 development source, daemon-hosted plugins reach the live Session permission
owner through the existing Account-authenticated Session RPC for
`session.permission.remote.pending.list`, `session.permission.remote.respond`
and `session.user_action.remote.answer`. The invoking host copies `pluginId`
and `contributionLocalId` from its admitted invocation into the existing
[targeted Action envelope](../packages/protocol/src/actions/actionRpcTransport.ts),
outside the semantic Action input. Home requires `sessionOwner` admission,
including for pending reads: another Account's collaborator grant is insufficient.
The generic receiving adapter requires Home's `session.write` authorization and
binds the envelope target and Action input to that exact Session.

This route trusts installed code authenticated to the same Account to supply
plugin attribution. It provides no plugin sandbox or independent cryptographic
plugin attestation and adds no credential, signing path or plugin-currentness
service. The Session's existing permission handler remains the settlement owner:
it checks the exact mediator, source revision, turn and request, preserves
first-answer and retry semantics, and records the external human as
`pluginAsserted`. Transport attribution never turns that person into an
authenticated Happier Account user. Unsupported receivers refuse the operation;
the sender does not remove the stamp or use an ordinary Account-user answer.

Channels treats an `ownerMachineUnavailable` pending read as an incomplete
projection, retaining any requests already read. An unavailable owner does not
prove that a pending request is gone: unattempted notifications retain custody,
and incoming approval or question-answer commands remain retryable. Regular
Session observations drive later notification reads without availability polling
or a separate re-admission trigger. Pending state and settlement remain in the
Session.

For chat `/allow` and `/deny` commands, that same Session permission owner
translates the requested decision and scope to a native choice only when the
current offer has exactly one matching choice. Durable local choices and policy
amendments are not inferred. Ambiguous offers remain pending for an explicit
selection. The selected native identity is stored in the existing mediation
record; an exact command retry consumes that record rather than selecting again.
This is unreleased 0.3 behavior; ordinary native responses still require an
explicit current native answer.

The approval reviewer is a request-scoped client of the existing permission
owner. That owner rejects ineligible effects before starting a no-tools review
with a redacted request, then rechecks current request/policy before an allow-once
claim. Human notification and human answers are not held behind review. Escalation
or failure leaves the human request pending; a successful automatic answer records
the reviewer actor and creates no reusable grant or permission-mode change.

In 0.3 development source, Session Run admission prepares that reviewer's Role
from the authenticated Session/Home Account. When terminal policy disallows
present-user authority, it retains `account_automation`, the Session permission
ceiling and normal Agent-start policy/depth checks; it receives no human exemption.
The host captures the causing Turn witness before asynchronous Role preparation
and rechecks that exact witness afterwards. Its depth participates in the normal
causal-depth rule; Session birth depth cannot replace an unavailable or retired
Turn, and a successor Turn cannot supply the earlier review's authority.
The Run Action input preserves `no_tools` rather than expanding it to read-only tools.

Native interaction lifetime is separate from causal turn identity. Ordinary requests default to turn lifetime and retire with the matching terminal turn (including ordinary requests without a turn witness); native Codex asynchronous questions explicitly use occurrence lifetime. Those questions keep their causal turn id after completion and retire when their Session/plugin occurrence retires. The permission coordinator owns this distinction; terminal callbacks do not cancel every request owned by the plugin.

In 0.3 development source, an authored wait-mode question ends its exact host
turn as `waiting`. The host captures that intent before native cancellation or
completion and flushes transcript output without publishing a successful or
cancelled work outcome. Follow consumes the typed waiting turn through its
existing frontier and acceptance ACK, so later state echoes cannot wake the
manager again for that same turn. The answer uses the existing correlated
information-return path and the next admitted turn clears waiting. Explicit
Stop withdraws the question and settles the exact waiting turn; incidental
process exit keeps it available for recovery. Loaded-runtime verification
remains with the coordination program's composed journey.

In 0.3 development source, host-bound occurrence questions can ask for human input
before an admitted turn exists. The host stamps that question origin; it never
converts missing causal authority into permission to execute a tool. Claude's native
terminal dialogs use the existing rich Session permission bridge so their source,
exact choices, cancellation and terminal-application acknowledgement survive.
Workspace trust still needs the configured explicit trust policy or a person's answer.

In 0.3 development source, spawn and recipe `allowedTools` seed the existing
Session permission allowlist. `unlistedTools` defaults to `ask`; `deny` refuses
unlisted tools and ordinary native tool questions without publishing an approval request.
The existing permission matcher owns exact tool names, trailing MCP wildcards
(`mcp__server__*`), shell rules, and absolute scoped Read rules
(`Read(/attachments/**)`). Scoped reads require realpath containment, so a
symlink cannot grant access outside the selected directory. Tool policy travels
with private Session metadata and native configuration, not shared presentation.
The birth seed also preapproves listed external MCP calls for admitted Channels
inputs without producing a reusable remote grant. Later interactive approvals
remain source-bound; causal, workspace-role and Happier Action ceilings still
apply. A listed builtin writer does not bypass a read-only ceiling.

Codex's [permission mapper](../packages/plugins/codex/src/agent/runtime/terminal/permissionPolicy.ts)
resolves the admitted intent before the app-server
[serializer](../packages/plugins/codex/src/agent/runtime/appServer/permissionProfile.ts)
encodes it for thread creation/resume and every turn. Full access (`yolo`) uses
`danger-full-access` on threads and `dangerFullAccess` on turns; workspace-write
uses the corresponding `workspaceWrite` turn policy. A retained thread must receive
the turn override when the intent changes, since omission preserves its earlier
sandbox. A Role's Hands-off ceiling independently forces read-only even under
`yolo`; the Role popover and injected Role notice expose that restriction.
Host-mediated MCP approvals can use Codex's MCP-only granular approval policy
without permitting native sandbox escalation. This is current 0.3 development
behavior, not a claim that an existing runner has loaded the correction.

Agent adapters enforce that same policy at native bypass boundaries. Claude
removes unlisted built-ins and uses the existing fail-closed PreToolUse hook for
every remaining call; native `dontAsk` alone does not confine scoped reads.
Codex's supported native configuration removes shell and other ambient execution
tools, selects only matcher-approved MCP tools from the real server catalog, and
excludes the native `functions` code-mode namespace so MCP resource built-ins
cannot bypass the list. Its own WebSearch stays disabled unless listed.
Unsupported native surfaces refuse a confined launch rather than silently
ignoring policy. These are source contracts, not a claim that an already-running
daemon has loaded them; native runtime/model support must be verified at launch.
For a nonempty exclusive recipe, the shared host reads MCP tool catalogs before
calling the Agent's native open. A failed probe refuses startup with
`mcp_tool_catalog_unavailable` through the runner attestation and `session.spawn_new`
launch error; it does not establish that the Agent runtime lacks confinement support.
The current Codex MCP proof covers native app-server 0.162.1 and a model whose
actual native catalog declares `code_mode_only`. The native catalog probe uses
the Session's launch environment, configuration overrides and `CODEX_HOME`,
including a Connected Account's materialized auth. Before applying external auth,
the adapter requires catalog evidence for that same materialized Account; token
refresh and auth apply retain that Account boundary. Missing or mismatched Account
evidence refuses the operation instead of borrowing a default login's catalog.
Provider bindings without native tool-mode evidence remain unsupported. Direct-tool
models can bypass the namespace exclusion, so MCP-connected launches reject them
before a turn; unknown runtimes are also rejected. ACP, daemon-proxy and direct-terminal
variants without equivalent enforcement do not claim confinement.

An empty tool allowlist with `unlistedTools: 'deny'` suppresses injected MCP
servers through Codex's config owner. Native admission validates that same
effective server set, so an inherited MCP map does not prevent a no-tools Run
from using a Connected Account or Provider binding. Runtime-version and native
configuration checks still apply; an unexpectedly enabled server refuses startup.

The managed Codex installer pins that same qualified release. Its manifest tag,
native admission check and sanitized repair guidance share the plugin's
`agent/cli/supportedRuntime.ts` owner. Unqualified newer system/native installs
remain usable for ordinary sessions, but confined launches refuse them and name
the supported version and `machines.agents.install` reinstall Action. Executable
source preference still applies after installation; verify the selected runtime
rather than assuming a managed reinstall displaced a system override.

Whole-Session permission reset reaches the existing Session request store even when the current coordinator has no local waiters, including after handler replacement. The store cancels pending requests and delivers their response targets. Cancellation waits for in-flight coordinator completion persistence before writing the terminal result; plugin-scoped cancellation retains its owner filter and performs no write when neither local nor persisted requests match. The store returns the exact occurrences selected by its committed write, so the coordinator also rejects matching provider waiters published while an older completion was draining, without retiring a replacement occurrence.

Cancellation removes only the cached decisions it captured before persistence, so a newer decision created while an older scope stops remains available. A cancellation that starts before a queued native decision applies prevents that new application; recovery of an already-applied native choice retains its existing receipt boundary.

ACP Stop cancels the provider independently of permission-state persistence. A failed permission cancellation retains the request for retry and emits the default file-log event `permission_request_cancellation_persistence_failed` with the error type, without request content or the error payload. At the generic Session Stop entry point, `reset({ scope: 'foreground' })` withdraws foreground prompts, including saved prompts without local waiters, while preserving independently scoped execution-Run prompts and cached decisions. Selection uses the canonical Run request identity at the committed store write; the shared permission store and Session/Run allowlists remain alive. A rejected foreground reset leaves native turn cancellation reachable and records `permission_reset_failed`; a rejected native cancellation records `runtime_cancel_failed` in the default file log. Other reset callers retain the acknowledged-write contract.

Session rebinding republishes the coordinator's admitted request context, including its original creation time, source, turn and native MCP identity. An offline client without a readable snapshot keeps that identity. MCP catalog preparation has not yet admitted a permission request and stays unpublished across rebinding until preparation finishes.

The native permission-hook HTTP owner aborts its callback signal before sending its finite timeout response, and also aborts on a disconnected response. Claude's SDK and unified terminal callbacks forward that signal through the existing permission engine. The final unclaimed waiter withdraws response admission synchronously; the existing observed-retirement path then persists the exact cancellation asynchronously. The HTTP deadline does not await an arbitrary callback or journal write. A failed write retains the exact request for lifecycle retry and keeps it unavailable to late answers. The default file log records `permission_request_cancellation_persistence_failed` with the error type, without request content or the error payload.

When a native terminal dialog has already applied a selected choice, the running Session's request store retains that finalized completion if its acknowledged Agent-state write fails. Reconnection or a later Agent-state write reoffers only the same pending identity; a replacement request, newer claim, cancellation or terminal result wins. The original waiter settles after the completion is acknowledged. A repeated matching answer rejoins that completion, and a competing answer cannot apply another native choice. This recovery does not replay the application callback, ordinary automatic policy decisions, or survive process exit.

Metadata and Agent-state retries use the current managed socket on every attempt. Reconnection can therefore finish the same operation within its existing retry budget.

Terminal Agent-state update failures report `session_agent_state_update_failed` in the normal file log, including when a best-effort caller absorbs the error. This record contains operation context only; it excludes request contents and server error payloads. It does not distinguish transport from local preparation failures and does not imply a replay guarantee.

In development source, a `message-delta` can supply the same stable `messageId` as its
`transcript-message-committed` event. The host stream bridge uses that identity for live and
durable rows and separates distinct messages within a turn. When an unnamed foreground
stream receives its native committed fact, the writer finalizes that channel's existing
row under its generated localId, including an already durable checkpoint, with the
authoritative text and `happierStreamSegmentV1.sourceMessageId`. Assistant and reasoning
segments remain independent; later outputs in the turn start new segments. Cancellation
retains the interrupted checkpoint. Named streams use the same finalizer under their
native localId, including Session-scoped and sidechain output. A final snapshot replaces
the text even when empty, publishes terminal segment metadata, drains live publication
before durable admission, and retains unresolved custody for retry. Durable admission
preserves the caller's cancellation and deadline. A matching named writer takes precedence
over the unnamed foreground handoff; Session-scoped output does not acquire that unnamed handoff. Loaded native retry
recovery still requires a fresh runner after the CLI host reload.
Named message identity is shared across foreground and Session-scoped observations of
the same channel and sidechain. An authoritative final therefore uses the existing
writer's source timestamp instead of starting a second write under the same localId.
Live runtime events and terminal file-follow facts enter the same ordered Session
projector and share its active writer and acknowledged native-identity receipts.
If file-follow observes the final first, a delayed delta for that same native
message, channel and sidechain reuses the final receipt instead of reopening a
partial write. Only an explicitly foreground-scoped event can attach that receipt
to a turn.
An already foreground-owned segment retains its acknowledged final receipt until that
turn's next flush consumes it; the Session-scoped observation itself gains no turn scope.
The host's metadata reader recognizes the recorded source identity for both follow/replay
and cold reconciliation. Follow opens metadata through the existing Session-mode decoder
and retains both row and source identities in its paged baseline; plugins receive the
native identity in their existing reconciliation baseline, without a second dedupe owner.
The projector retains completed native source identities for its Session lifetime:
a repeated committed fact cannot finalize a later unnamed segment or duplicate a
Session-scoped row. Stored metadata is read through the canonical tolerant reader.
OpenCode derives its stable ID through the same
provider-session/message helper used by history import, so cold reconciliation recognizes
streamed rows without a second persisted format or native-ID parser.

In current 0.3 development source, transcript output (`message-delta`, tools, file edits and
committed text) may omit the host `turnId`. Such output is Session scoped; output with a
`sidechainId` is also Session scoped, even when it records an originating host turn.
The shared [scope owner](../apps/cli/src/agent/runtime/session/events/runtimeTranscriptScope.ts)
keeps foreground lifecycle, token hooks, change tracking, tool execution and required
foreground transcript custody separate from this output. Foreground output with a turn
and no sidechain still requires the active host turn. All output retains strict schema,
Session identity, sequence and runtime-lifetime admission. Foreground boundaries flush
only foreground streams; a successful authoritative text commit retires only its matching
channel through the named identity or unnamed-segment handoff above. Native child turn identifiers stay
in provider-owned evidence rather than claiming a host foreground turn.

Both the host and public SDK Session-to-Run projections admit assistant/reasoning
deltas and committed text only with proven foreground scope. An omitted turn id
does not authorize Run output. Claude captures the admitted turn with each SDK
query; output arriving after that query is cancelled or its foreground work
completes remains Session scoped even while a newer query runs. OpenCode carries
the provider owner's proven turn and child scope into its detached Run adapter,
preserving committed-message identity rather than relabelling snapshots.

Agent-specific protocol leaves live in `packages/plugins/<agentId>/src/agent/**`. Shared ACP composition, process/terminal transport and host lifecycle stay generic in the CLI. Detection, installation and process launch follow [binary runtime](binary-runtime.md); model-source selection and materialization follow [Providers](providers.md).

### Session Account-action authority (0.3 development)

Daemon-bound Agent tools route Machine-placed contributed Actions through the
existing Session capability. A qualified Action ID and an explicit
`action.invoke` envelope both reach the daemon's contributed Action owner.
The live turn witness supplies the Session caller. Home admits the Session's
installed Machine under the existing `action.invoke` policy, and the daemon
passes that admission to the plugin as the requester Account and chosen Machine.
Plugin input can select a domain resource within that admission.

An Account runtime that holds its own stored credentials and has no local
Machine admission socket relays plugin Session Send through Home's existing
Action ingress to the Session's Machine. The relay preserves the plugin caller,
automation authority and idempotency key. The destination daemon admits the
input through its Machine socket. A refusal before dispatch is a rejected input.
A lost acknowledgement leaves the outcome unknown and a retry retains the same
input id.

Runner admission refusals retain `target_unavailable` and carry the refusing
owner's code-only reason in `details: { code: 'target_unavailable', diagnostic:
{ reason } }`. The Session Account executor distinguishes absent authority path
or turn witness, invalid Run binding or workspace, invalid witness projection,
and refused runner authority; the MCP realtime caller guard uses the same result
owner. These reasons contain no paths, identities, credentials or input content.
The shared constructor and closed reason vocabulary live in Protocol's
`actions/actionRefusalDiagnostic.ts`, re-exported by
`actions/actionExecutionResult.ts`; the Session executor retains its existing
export as an alias. UI Account placement uses the same result for absent own
reachable Machines versus absent eligible plugin Action/options declarations.
The CLI Channels binding distinguishes missing Session transport/Machine,
unsupported caller fallback, malformed results and mismatched Sessions; the SCM
receipt retains that diagnostic alongside its already-committed PR fact.
Session-trigger list availability retains the same diagnostic. Session capability
writes distinguish `session_absent` from `capability_identity_unresolved` under
their existing `not_found` code. Both closed output schemas accept the optional
shared diagnostic under the unpublished 0.3 matching-source reload contract.

Installed Workflow Session leaves continue definition/trigger child Actions through
the existing signed Workflow-origin admission. FIN passes its captured
`InstalledWorkflowSessionLeafAdmission` to
`prepareInstalledWorkflowActionAuthorizationWithEnvelope`, with the original
Session caller and a fresh child request id. The issuer matches the captured
Account, Run and leaf Session, retains accepted authorization and requester
attribution, and signs the exact child envelope with the installed source key.
Home verifies that proof and the admitted Run; later calls read only that Run's
active custody. The receiving daemon restores the Session caller, automation
authority, permission/workspace ceiling and requester attribution. FIN owns
capturing and forwarding these admission facts; ordinary host/plugin requester
invocations cannot manufacture them. This matching-development contract needs
the server, daemon and FIN relay loaded together.

A Workflow definition/trigger child that the App produces while serving a
client Action (for example a mounted draft Save) does not use the App's Account
relay when the parent's caller is a Session. The daemon that admitted that
parent keeps it as the still-active fact for as long as it awaits the App's
answer. The App returns each child to that daemon over
`RPC_METHODS.UI_ACTION_CHILD_EXECUTE`, naming only the parent request id, its
Session and the child operands (`UiActionChildExecuteRequestV1`). The daemon
refuses an unknown or settled parent, a different Session and a server-stamped
actor Account other than the parent's. It then runs the child through ordinary
admission under the parent's own admitted caller, including Session-leaf and Run
facts and requester attribution. It never inherits the parent's approval bypass,
confirmation or request id. `isWorkflowHostAdmittedChildActionIdV1` is the one
predicate for this family. The App never stamps Session provenance.

Experimental native Realtime Start is Session-owner-only in 0.3 development;
it runs on that owner's Agent account. The canonical Protocol RPC classification
requires `sessionOwner`, while shared editors retain ordinary input and question
answers. The server issues `authority: 'sessionOwner'` in the closed,
exact-Session `session.write` context only after verifying owner-classified Start.
The host requires that literal proof plus `present_user` before native Start or
input admission. Ordinary `session.write` and human authentication alone are not
owner proof; older relays without the proof fail only native Start closed.

The host attempt owner creates one private native-input fact, bound to that
Session incarnation and attempt. The native Session projects it into the existing
active-turn witness with the provider's real turn id and a host admission id;
it does not fabricate Pending/Queue records, message sequences, or starting-input
transcript custody. Provider-started lifecycle events alone remain non-authorizing.

The existing daemon Session capability owner retains this fact only in memory,
under the exact runner process and retained Agent source custody. It checks the
fact on native Action currentness rather than retaining a one-time admission
after End. End withdraws the local witness and cancels admitted tool calls before
waiting for native cleanup; disconnect terminal events and Session retirement
withdraw the same fact. Normal Agent/MCP discovery and Session/Account Action
policy still apply. Native origin carries an explicit approval-decision exclusion
through the shared Action authority owner, including nested contributed calls;
waivers and approval bypasses do not grant native decision authority. Run runtime
operations keep their existing closed operation set, not a general nested
approval dispatcher.

This is matching-development daemon/runner behavior. The private IPC operations
and nested admission/witness objects are closed; unsupported readers refuse them
instead of falling back to Queue authority. There is no new public Agent SDK
capability or persisted admission. The server's owner-classified Start proof is
required as well as matching daemon/runner private IPC. Reload Home/server,
daemon and Session runner before validating this source change.

The daemon's existing
[`createDaemonSessionAccountActionExecutor`](../apps/cli/src/daemon/agentRuntime/createDaemonSessionAccountActionExecutor.ts)
does not treat process/Session custody as permission to use its Account
credentials. Once, when it admits an Account Action, it reads the exact Session
through its authenticated Home and requires the canonical owner projection plus
current runtime custody. Later steps of that admitted Action (Home preparation,
the mint, the effect) check only runtime custody and cancellation; a changed
owner or share applies at the next Action admission. Recipient, missing,
malformed or retired callers refuse; they never borrow the Machine custodian's
Account. Shared requester execution uses its own admitted
per-Session requester Home and protected credential custody. This owner-only
guard is not that shared execution channel or loaded-runtime certification.

Native MCP discovery and Account Actions use the admitted operation's existing
Account currentness check. Requester credentials come from protected Session
custody and are not compared with the Machine profile's `access.key`. The
bridge carries this same check into its Account, Follow and plugin Action
owners; retirement still refuses subsequent calls. Callers without captured
Account custody retain the profile credential check. This is development-source
behavior and requires a freshly loaded runner for live validation.

Retained requester Settings use the existing Account/Home user socket for both
Session and finite custody. The Settings publication owner applies envelopes to
the captured snapshot, fetches on version hints or reconnect, and withholds
Action admission while convergence is pending or unavailable. Action cancellation
ends only that reader's wait. Explicit demand rejoins this same owner and can
recover a failed hint. Unchanged policy requires no per-Action Settings,
Profile or Connected Account catalog refresh; explicit catalog demand retains
its existing owner. Custody retirement releases its subscription and private
snapshot. This development-source path still requires loaded-runtime replay.

Explicit requester Settings refresh shares one requester observation across its
Profile and Connected Account catalog readers and private snapshot commits.
It uses the existing preparation checkpoint owner, then checks fresh authority
outside that checkpoint before notifying consumers. A later refresh starts
fresh; revocation during a catalog read prevents successful publication.
Failed Settings observations preserve their transport error rather than becoming
a negative authority decision. Session startup retries these preparation reads
through the existing requester Home backoff under its original accepted startup
operation's cancellation lifetime. It retains the same operation and creation
identity; the retry does not include native launch. A caller without that
operation lifetime receives the existing typed retryable Home failure.

Within one requester credential binding, the first Machine proof discovers the
authenticated Account identity and Machine-access context. The middle read group
and the second Machine proof reuse that exact discovery only for this binding;
both Machine proofs still perform fresh signed Home verification. Discovery is
matched to the exact Home, credential, attribution and Session and ends with the
binding. Later invocations discover again.

Action preparation's Role overrides, built-in Role sources, captured Settings,
Agent inventory, Prompt Library, ACP and Profile readers consume the admitted
requester custody directly. There is no AsyncLocalStorage requester-checkpoint
cache. Custody retirement, encryption-identity changes and cancellation still
withhold prepared context or catalog disclosure. Independent requests and secret
acquisition retain their own admission owners; Home authorizes its own reads,
writes and signed authorization minting.

The established Connected Account owner also admits read-only status through the
same bounded snapshot scope as materialization. Nested field reads share its
Account admission; fresh entry and result-publication checks retain requester
revocation and cancellation. Credential and configuration revision checks remain
at the runtime callback boundaries. Later public operations start fresh, and
refresh, revoke and other effect operations retain their independent admission.

The development requester projection attaches private Account ports to the
existing `ExternalActionExecutionAuthorizationV1` carrier. Its non-enumerable
host-local facet contains the requester Project-row cipher and qualified Artifact
reader, not serialized keys. The strict wire authorization schema is unchanged.
The admitted bootstrap produces this facet; consumers check its currentness at
their Account effect. An arbitrary Machine request without that private producer
cannot select another Session's custody or borrow custodian Account material.
At the signed source installation, approval replay recovers the original
Session's protected custody and retains its private facet when enriching that root.

Same-account Machine starts stamp nonsecret Home, requester Account, Machine and
installation attribution from the verified Machine admission context. The
existing accepted-spawn marker writer and exact-process adoption carry these
facts across recovery; an old marker without them stays unknown. Attribution is
not authorization, and server metadata cannot manufacture it. The transient
admission-currentness callback stays with the live launch and is never persisted
as respawn state. In current 0.3 development, an original Account Action for a
shared Machine start carries installation-sealed requester custody. The existing
daemon `prepareRequesterSessionBootstrap` wrapper accepts that admitted Account
context as well as existing per-Session custody; attribution and currentness come
from the verified binding, never caller-authored spawn fields. Failed launch
cleans the prepared custody through the same owner. UI and CLI requester starts
use this Action path; raw custodian-only spawn methods remain refused. Existing
requester resume restores the original Session's protected custody through
`session.open`, without substituting the Machine custodian's Account. Other
foreign Session/run/workflow starts still refuse until their own requester
bootstrap is available. This is source behavior, not released availability or
loaded-runtime certification.

The admitted requester bootstrap also owns native Account credential eligibility.
Only verified requester and Machine-custodian identity equality permits the
Machine's native Agent login and configuration; UI, CLI and agent origin do not
change that decision. Workflow startup supplies its accepted Machine binding,
and recovery reconstructs the binding through the existing authenticated access
reader and signed Machine verifier. Foreign or missing bindings still require
an isolated requester home and cannot inherit custodian credentials. Spawn and
Connected Account refresh consume the same bootstrap decision.

Cold requester recovery preserves the original private Home/Account/Machine/
installation tuple and verifies it against current authority; attribution alone
grants no custody. A missing protected file can be reconstructed only from
complete matching retained private birth. Foreign, malformed, revoked or
incomplete historical custody remains a refusal, never adoption of today's Home.

A genuinely ordinary owner Session with no requester attribution or private
scope still checks its exact protected custody file through the same owner as
MCP. Only genuine absence or complete original tuple/Home and same-credential
agreement permits independent current Account/Machine/Session qualification;
unreadable, malformed, missing-Home or foreign custody cannot become absence.
A different unrecovered bearer refuses; successful canonical scoped recovery
keeps its existing credential path. Both consumers use the original held profile
and Home and verify ownership of the exact Session. Native invocation demands
this owner-Agent identity lazily after recovery and before preparation effects;
it does not infer person presence or manufacture requester birth. Local
credential/installation withdrawal and tracked-Session/Home currentness are
rechecked at use. These development-source paths do not establish native member
support or loaded replay.

In 0.3 development, retiring a stopped runner's terminal-control metadata uses
the daemon's authenticated Account writer when the retained Account, Home and
Machine all match. Home authorizes the write and the existing metadata tuple
writer checks Account encryption currentness. This retirement does not recreate
the departed runner's Settings, secret or Connected Account execution runtime.
Other requester identities retain their exact requester-custody recovery path.

The durable Session-deletion subscriber calls the existing daemon Stop owner
before removing managed directories, including when no managed directory was
allocated. Home inactivity does not prove a respawned runner has exited. Stop
fences pending automatic launches and retires tracked successors; an incomplete
Stop leaves the deletion change unacknowledged for the existing cursor retry.
These source paths require loaded-daemon replay before live certification.

### Triggers at Session birth (0.3 development)

The strict [`session.spawn_new` input](../packages/protocol/src/sessions/creation/sessionSpawnNewInputV2.ts) accepts `initialTriggers` through the same Session trigger vocabulary as `session.trigger.*`. A birth draft supplies neither a source Session id nor a current-turn identity. The existing [Workflow trigger Action owner](../packages/protocol/src/actions/executor/workflowTriggerActions.ts) validates target and agent-start policy and seals the intent; UI, Agent and MCP callers do not write triggers after spawning.

The [layout-1 Session row writer](../apps/server/sources/app/session/create/layout1SessionRowWrite.ts) binds each intent to the newborn Session and invokes the canonical Automation creation and lifecycle-occurrence owners in the same transaction. Session, triggers and an eligible `sessionStarted` occurrence commit together, or a typed `initial_trigger_admission_failed` refusal rolls back the birth. Ordinary Session trigger CRUD still refuses retrospective `sessionStarted` registration. PR/CI and plugin-event sources cannot be admitted by this birth path until their source prerequisites are available. This describes current source wiring, not completed loaded-runtime validation or released availability.

For signed Session archives, the [archive route](../apps/server/sources/app/api/routes/session/registerSessionArchiveRoutes.ts) authenticates the claimed originating Run against its publisher, Account access and assigned Machine before passing it into the transactional lifecycle occurrence. The [Run cause codec](../apps/server/sources/app/automations/automationRunCauseCodec.ts) retains this optional archive-origin fact in the nullable `AutomationRun.causeOriginRunId` column, separate from private Account evidence and Session creation origin. The existing [trigger cause-chain owner](../apps/server/sources/app/automations/automationTriggerCauseChain.ts) follows that retained ancestry to suppress a trigger already responsible for the archive before admitting another Run. An unsigned archive does not infer archive ancestry from Session birth. This is an unreleased 0.3 source contract.

## Prepared native input budget (0.3 development)

An Agent's preflight contribution owns its runtime input-text limit independently
of model capabilities. Codex app-server supplies its upstream turn-input limit
for native, Provider-bound and Team model routes; Codex ACP does not borrow that
limit. Provider and Team selections still withhold native offered-model evidence.

The native host prepares the Run's actual context once, before sizing the first
input. `prepareInputBudget` subtracts the Unicode-scalar length of the exact
skill-index prefix, including its two newline separators, from the runtime
limit. Preparing this budget does not open the provider or submit input. The
same prepared context supplies the prefix at dispatch and follows the existing
Run disposal lifecycle. A replaced context does not establish that a stored
budget still predicts its prefix.

For retained Session Run input, the Bridge also subtracts the exact first-input
provenance and Session Run context envelope. Reservation and dispatch share the
retained-input renderer. Host-generated analysis parts use the existing trusted
host input admission; ordinary participant input keeps its own admission. The
fixed same-Run multipart plan reserves the first envelope; subsequent parts omit
the first-only Session context rather than adding another allowance.
Review's initial findings input also has profile scaffolding; it is not a
walkthrough part sized by this budget. Later narration parts omit that first-only
scaffolding. Initial findings still rely on native admission for overflow.

Profile `prepareStartParams` retains evidence capture and launch-policy selection.
The optional `finalizeStartParams` input phase receives an asynchronous
`resolveMaxInputUnicodeCharacters` getter for the effective budget. Only demand
prepares the runtime, so cached readings and findings-only reviews can finish
without creating one for sizing. Finalization can update instructions and retained
intent input before initial profile publication and dispatch. It cannot change the
already prepared cwd, permissions or lifecycle. Prompt guidance and rendered
reference/attachment descriptions count when they enter the submitted Text;
separate native skill, mention, image and audio items do not. Separate developer
startup instructions and app-server additional context are outside this Text
limit. The provider's typed `provider_input_too_large` refusal remains the
backstop; the host adds no retry or automatic splitting.

The counting contract comes from Codex
[`rust-v0.163.0` Text counting](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L535-L545)
and its
[turn admission](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/request_processors/turn_processor.rs#L554-L598).

## Execution Run launch selection

In 0.3 development source, Connected Service pool selection for a Run uses the
existing qualified Account-scoped coordinator and shared group lease. The Run
materializes the committed generation into its own activation independently of
the parent Session's native generation application. The parent Session retains
its own turn and application owner. Requester currentness, purpose authority and
Run generation admission continue through their existing checks.

In 0.3 development source, [`ExecutionRunHostBridge`](../apps/cli/src/agent/runtime/bridges/executionRun/ExecutionRunHostBridge.ts)
supplies attachment context to [`startExecutionRun`](../apps/cli/src/agent/runtime/bridges/executionRun/startExecutionRun.ts).
Its [child-selection owner](../apps/cli/src/agent/runtime/bridges/executionRun/runtime/openInputs.ts)
completes omitted model and credential-route choices before materialization.
Explicit native, Provider, role and Workflow choices keep precedence. Detached
work retains its independent Account-default contract.

Session-owned child Runs inherit the original host-private
`AccountSettingsSnapshotResolver`, including its `readAgentExecutionContext`
reader and Account lifetime, through the existing Run controls. SCM and delegate
starts do not reconstruct an execution source from authored Run input or ambient
Account settings. This is a general Account reader: disabling managed MCP does
not disable configured Provider preparation or selected-secret overlays. Only an
explicit MCP-catalog demand acquires MCP source/catalog material; general reads
and secret demands retain the same original Account operation and currentness.
Restricted Session authority still exposes no Account settings.
The Machine reader's `forInvocation` binds the admitted private
requester Account context and its existing Saved Secret operation; a separate
physical-host qualification supplies actual Home/installation custody and the
host's isolation policy. Neither path upgrades an Agent to person authority or
persists execution custody in Account preferences. Cold retained-Run Home/actor
recovery and full composed/live coverage remain unverified.

Detached Project launch separately requires admitted requester custody: a
requester Session bootstrap or signed caller input authorization. A token-only
installed-CLI start supplies neither and refuses with
`project_requester_credentials_unavailable` before creating a Run. Account
defaults select the Agent configuration; they do not supply that launch authority.
Original authenticated CLI Run starts and cold Ensure/Send operations use the
existing Home Action admission even for an own local Machine. They reach the
same captured requester preparation port as app calls; raw token-only RPC stays
unprivileged.

Cold Project preparation carries admitted requester context through the existing
Run backend parameters. In 0.3 development source, nested preparation readers use
that admitted custody without a requester-checkpoint cache or repeated Machine
admission. Local custody retirement and observed Account encryption changes still
refuse reads. Independent requests, credential acquisition and recovery retain
their own authority boundaries; an admitted start is not re-admitted per phase.
The Run controller retains setup review with the shared
Action-operation review continuation; its existing Run id identifies the projected
operation. Review state is controller-lifetime state, not a second Run registry or
a persisted credential source. The Machine Action-operation runtime composes this
domain projection with its incumbent owners, and routes inspection, cancellation
and consent back to the original producer. For a Session-hosted Run, the daemon
projects the existing pending native-launch invocation under that same Run id.
Its lifecycle projection reads the Session Run controller through the existing
requester-scoped Session transport, and operation cancellation calls that
controller's Stop. Denying setup therefore settles the original Run rather than
leaving an independently running daemon projection. Terminal controller facts
cannot carry setup review, and a late Account decision cannot restart a stopped
or refused invocation.
The runner carries the Run's own cwd into snapshot-backed invocation preparation;
the accepted Account workspace rows decide Project membership for that cwd.
The parent Session's cwd cannot substitute, and missing Run cwd refuses preparation.
The Account Action `projects.prepare` with `heldOperationId` authenticates the
approving Account and resumes that retained invocation and reservation. The
runner's controller remains the Run lifecycle owner; native authorization does
not establish Run completion. Run Stop closes the invocation, aborts its review
and withdraws the projection. The Session-write RPC supplies no human setup
decision or Account identity. This development-source path requires daemon and
runner reload for loaded-runtime validation.
See [Project native toolchain preparation](cli-architecture.md#project-native-toolchain-preparation-03-development)
for the development-source launch contract and its remaining qualification limits.

The host-private Session reader combines the model-transition coordinator's
admitted applied target with the scoped daemon's existing applied Connected
Services registry. Pending intent alone neither supplies nor invalidates an
otherwise readable applied choice; an actual unresolved effect or unavailable
owner refuses inheritance. A configured next-prompt route admits its confirming
prompt but remains unavailable to this applied-selection reader until compatible
runtime evidence arrives; it does not lend pending intent to a child Run.
Pool references retain the pool, not its selected member, credential or activation. Cross-Agent Provider choices use the existing
Provider authorization and Agent adapter owners, rather than another selector.

When the accepted native open proves no applied Connected Services, the runner
starts its initial absence registration with that daemon registry in the
background. Ordinary prompt admission does not await it. Child inheritance and
subsequent auth application join the same registration before using or changing
that authority; inheritance still reads the current applied registry and refuses
unavailable facts. Required launch authorization, credential preparation, Session
custody and prompt preparation retain their existing admission owners. These
are 0.3 development-source contracts; the startup phase records in the runner
and daemon support the next loaded-runtime latency probe.

Resolved safe choices stay in the existing retained Run launch record. Resume
does not consult a changed parent or Account default. The additive
`resolvedSelection` summary is a projection of that record, not another persisted
route or an authorization input. Start, activity, finish and host-loss markers
retain this same projection, and Run rows consume it with the Run's exact Home.
Older markers without a summary can use the matching transcript's summary;
absence is not permission to infer a route from current defaults.
Voice chat and commit resolve their choices
separately; unsupported Team custody refuses before a Voice Run is published.
These source contracts do not certify the composed loaded-runtime journey.

Managed Provider preparation for a Run consumes its actual admitted controller
occurrence and cancellation lifetime. The host-private source adapter supplies
the issued Account snapshot and qualified-purpose resolver to the incumbent
Provider catalog/source owners; it does not borrow another active Session's
Account or create a second scheduler. Direct Provider materialization revalidates
that source before commit/backend creation. Attached source operations use the
existing private runner-to-daemon transport and authenticated Session Run RPC;
the actual Run record must attest the accepted Provider connection/model and
Agent target as well as the current occurrence. A cleanup handle never supplies
that authority. After daemon replacement, a fresh read carries the original
proof and re-admits that same target; it does not replay an existing stream.
The composed loaded-runtime journey remains part of unreleased Providers
integration validation.

The Run Provider-preparation owner requires the pinned daemon service for an
Account Provider choice in a Session runner. A missing service refuses with
`execution_run_contribution_snapshot_unavailable` before reading Account state
or attempting a runner-local registry; it is not a request for new experimental
consent. Daemon-owned detached Runs prepare against their applied local registry,
while native selections and Team credentials retain their respective owners.
Native selections with connected Account bindings also prepare through that pinned
daemon service, including `modelId` inputs without a Provider selection. The
host-private request preserves that absence, and the native response can omit a
Provider binding; the existing connected-service materialization owner still
resolves the selected credentials against the daemon's applied runtime.
These placement paths share the existing Provider authorization and materialization
policy; the local adapter is not a fallback for a Session runner's missing service.
Each runtime authorizes its exact inherited or explicit Provider choice once at
launch. There is no separate inherited-choice or reasoning-effort preflight.
Unsupported choices settle the existing Run as failed before endpoint or Agent
creation. The older host-private `execution_run.provider.admit_v1` request remains
an acknowledgement for surviving Session runners; it performs no authorization
or catalog hydration. Their later launch still uses the one preparation owner.

Voice Runs use the same controller-occurrence registry during native MCP
provisioning. The Voice manager supplies custody only after an actual nested
runtime exists and while its lifetime is live; accepted startup alone supplies
no proof. Its ready-state authority remains unpublished until startup settles.
Chat and isolated-commit runtimes share their controller occurrence, while a
resumed controller receives a new identity. Stop, replacement and settlement
retire the proof. OAuth request-auth issuance still requires the exact current
Run occurrence and parent Session through the existing broker check.

### Background task runner selection (0.3 development)

Memory hints, deploy suggestions, the commit message, the diff summary and the replay summary each
store one runner choice: **Auto**, or an explicit runner
(`LlmTaskRunnerChoiceV1` in
[`llmTaskRunnerConfigV1.ts`](../packages/protocol/src/llm/tasks/llmTaskRunnerConfigV1.ts)).
An explicit runner names the Agent and model (`ProviderBoundModelRef`, native or
through a Provider connection), the connected-service route, config options such
as effort, and the permission level.

One owner decides what runs:
[`resolveLlmTaskRunnerV1`](../packages/protocol/src/llm/tasks/llmTaskRunnerSelection.ts).
Tasks only declare their needs in `LLM_TASK_DECLARATIONS_V1`: structured output,
allowed permission levels (the first is the default), whether the prompt carries
Session text, and the cost tiers Auto may use.

- An explicit choice always wins and is never swapped for another Agent. Its
  permission level is kept to the task's allowed levels; the commit message is
  always `no_tools`.
- Auto reads what is ready on the executing machine: enabled Agents that are
  signed in or connected through a service, with their offered models. Task
  runs and the pickers' "Auto — currently" read use the same reader
  ([`llmTaskRunner.ts`](../apps/cli/src/agent/executionRuns/tasks/llmTaskRunner.ts)).
- Auto follows the task's declared cost policy among enabled Agents that are ready:
  deploy suggestions prefer `standard`, then `premium`, then `low`; other tasks take the
  lowest tagged cost tier across all candidates (the diff summary needs `low`),
  skipping models the task can't use. The Session's own Agent wins a tie, then
  catalog order; there is no provider list. An untagged model is never assumed
  cheap: only when no candidate is tagged does Auto take one Agent (the
  Session's, else the first in catalog order) and its catalog `default`, else its
  first model. Auto asks for the picked model's lowest declared effort (the first
  value of its own `reasoning_effort` select) unless the person set an effort for
  that task. Memory hints read the Session's Agent from the same Session fetch
  that opens its transcript. All candidates are the person's own enabled
  accounts.
- Cost tiers are provider facts on the model descriptor (`costTier`). A
  provider's low tier is its cheap, fast tier. Codex tags its live model list by
  model family in its own plugin.
- Nothing fits: a typed `LLM_TASK_RUNNER_UNAVAILABLE` failure with
  `no_ready_agent` or `no_matching_model` and the unavailable Agents. It goes to
  the task's existing failure path; nothing else is tried.

Pickers show what Auto would pick through `agents.models.list` with purpose
`llm_task_runner`, which runs the same owner on the executing machine.
For a `no_tools` task, Auto and the picker require the Agent's positive
`capabilities.tools.noTools` declaration on that Machine. A missing or false
declaration excludes the Agent. Native launch still enforces the chosen policy
for retained explicit choices. Replay reports an unsupported summary runner
through the existing failure result so the person can choose a compatible
runner or replay recent messages. Pi declares no-tools support as false and
refuses an exclusive empty tool allowlist before native launch.

The commit message stores its choice in the Account setting
`scmCommitMessageGeneratorRunnerV1` (null is Auto). The 0.2 Agent id
`scmCommitMessageGeneratorBackendId` is read once at the settings parse boundary
(`backfillLegacyTargetKeyedAccountSettings`): empty or the old `claude` default
stays Auto, any other Agent becomes an explicit runner on its default model.
Writers no longer write the old key. The UI generator
([`commitMessageGenerator.ts`](../apps/ui/sources/scm/operations/commitMessageGenerator.ts))
uses the shared UI lifecycle owner
[`runLlmTaskInWorkspace.ts`](../apps/ui/sources/execution/llmTasks/runLlmTaskInWorkspace.ts).
It resolves Auto on the executing Machine (the workspace's, or the Session's),
then starts the existing `execution.run.start` with that runner.

Deploy suggestions store the same runner choice in `deploySuggestionRunnerV1`
(null is Auto), through the Deployments Settings picker. The suggestion controller
reads one catalog snapshot and runs the existing `task` intent in a Machine
workspace without creating a Session. Its typed result passes through
`validateDeploySuggestionV1`, which checks catalog identities and delegates target
fit to `resolvePublishTargetRecommendation`. Starter and scratch choices create
through `projects.starters.create` on the selected publishing forge and open its
ordinary Session handoff. Scratch creates an empty repository and an unborn
local checkout; the agent builds and commits in that Session. Catalog apps continue to
target selection without opening a Session. The shared task lifecycle reports the
accepted run before waiting, so Stop reaches that run through `execution.run.stop`.

## Execution Run recovery and observation

Execution Run capability preflight in 0.3 development treats
`RPC_METHOD_NOT_AVAILABLE` as target unavailability, whether returned or thrown.
It does not establish that the target lacks the Run protocol. The shared
`readExecutionRunProtocolV2Support` owner reserves protocol-unsupported results
for a positive missing-method response or an incompatible capability descriptor.
Session RPC handlers are republished on the existing socket-connect path; no
additional retry or polling is introduced by this classification.

Session-owned Run RPC handlers live in the invoking SessionClient process; the
daemon separately owns Machine-scoped Runs. Connection retirement clears RPC
registration state synchronously, before compatibility invalidation can yield.
Both disconnect and authentication failure use that same retirement path, so
an older cleanup cannot clear registrations acknowledged by a newer connection.

Run services classify an unavailable or unregistered target as
`execution_run_target_unavailable`. Only affirmative method absence
(`RPC_METHOD_NOT_FOUND`, or its legacy untyped message) means
`execution_run_protocol_unsupported`. Start failures retain their existing
input-delivery certainty; an unavailable response does not authorize automatic
replay or imply that a Run was never created. Controls do not infer Run absence
from local history when their host is unavailable. Transport loss alone does
not prove that a host died or authorize settling its active Runs.

Finite Run startup can recover an explicit Connected Account model rejection
before accepting the initial input. The Agent supplies sanitized rejection
evidence; the native host withholds terminal projection only while opening a
fresh Run with no observed progress or output. The existing lazy Run owner asks
the scoped daemon materialization bridge to validate that exact activation and
member, then disposes/releases it, rematerializes the next eligible pool member,
and replays the same unaccepted input. The pool coordinator owns the model
cooldown and selection. A rejected start is exempt from turn/hour switch limits;
accepted turns, partial output, unknown custody and native resume failures do
not authorize replay. Pool exhaustion names the requested model in a typed
error. The canonical detached Run host supplies descriptor-bounded native-home
reads and Run-scoped authentication refresh. Session and Run adapters share the
host refresh core and daemon refresh authority; the Run control channel retains
the exact runner and materialization activation, without inventing a Session id.
Session-owned Runs keep their genuine parent Session projections while binding
authentication refresh to the Run's own materialized account.
Refresh distribution notifies only current genuine Session targets; a Run's
shared runner PID or retained parent Session id does not authorize a Session update.
Refresh and acknowledgment continuation require exact member/generation and
persisted revision proof. Only the same live occurrence can accept its own
settled credential-revision transition; process replacement or reselection
invalidates that authority.
This is an unreleased source corridor, not a claim of loaded-daemon validation
or released availability. The corridor does not restart the parent Session.

In current 0.3 development source, a failed exact Run input turn retains the
existing `ExecutionRunErrorSchema` as optional `inputTurns.last.error`, including
its sanitized `runtimeIssueV1`. Codex native errors retain the classifier's
retryability, reported reset time and vendor request identity when supplied.
An idle retained Run can remain `running` while its last input failed; Run details
present that turn's issue and recovery through `presentSessionRuntimeIssue`.
The server-readable Session socket carries only the input-turn witness, excluding
both its result and error. These additive development fields require matching
0.3 producers and consumers; older turn records may omit them.

In current 0.3 development source, accepted-turn failures in finite, retained
and detached Runs enter the existing Connected Account recovery pipeline before
terminal Run projection. Session and Run scope share classification, policy,
result disposition, temporary-throttle waiting and continuation admission;
scope adapters supply the exact target, account materialization and cancellation.
Provider-native failure facts without a member identity are qualified against
the current registered binding, never an invented account selection. A Run
disposes its failed native runtime before rematerializing, resumes the same native
conversation/checkpoint and sends only the configured continuation with a fresh
input identity. Partial output is retained; the accepted input is not replayed.
Stopping a Run's wait does not cancel or fence its parent Session. Refused
recovery or native resume failure follows the ordinary terminal failure path.
Pre-admission rejection and unknown input custody remain authoritative and do
not authorize automatic continuation, even when their diagnostics retain
provider health evidence. Successful native completion records the same
scope's outcome before completion waiters settle, clearing its capacity streak.
Account replacement preserves the Run's existing lifetime switch budget.
This is source behavior; the loaded-daemon journey still needs validation.

Native authentication is carried by `context.session.services.auth` for a
Session runtime and the existing `context.executionRun.services.auth` for a
detached Run. Both use the same daemon refresh owner, bound to their actual
scope and lifetime. A Session-owned Run refreshes its own materialization;
this capability neither requires nor grants general `services.sessions`
access. Action consumers with declared Session access retain their genuine
Session-handle auth API.

The execution host bridge retains private Run control state through the existing
device-local execution registry, sealed separately from disposable visibility
markers. Admission and checkpoints retain re-resolvable launch selections,
exact input observations and native resume identity; they do not retain active
turn authority or materialized credentials. Scoped reads and resume admission
recover this state at the bridge owner. A live foreign host's record does not
authorize another bridge to recreate its controller.

In 0.3 development, terminal detached history is removable through the existing
[`session.delete` Action](actions.md). The bridge owns Account scope and terminal
admission; the registry's existing per-Run writer joins pending checkpoints and
removes the retained state and visibility marker, including predecessor filenames.
Deletion leaves the native conversation at the Agent untouched.

Current development readers also recover the registry's former identity-encoded
sealed basenames. After checking the payload identity, the existing per-Run
writer publishes the current basename without replacing an existing current
copy, verifies that copy, then retires the former name. The same ingress handles
pending WorkerUpdates, so acceptance checkpoints and terminal delivery keep one
owner. Acceptance retires both validated names under that same per-Run writer;
an overlapping older scan cannot republish accepted delivery. Unreadable entries
remain retained and make observation incomplete; the
registry reports each unavailable entry once and reopens it when its observed
file, device key or protection state changes. This is retained development-data
recovery, not a second writer or a released format guarantee.

Existing process supervision records proven host death or PID reuse as
`execution_run_host_lost`, not transport disconnection or inconclusive process
recognition. The interrupted input
fails, the native handle determines recoverability, and the retained failure
points to the partial transcript. The same fact feeds reads, waits and the
existing acceptance-ACKed WorkerUpdate path. Neither an unpaired transcript
call nor a historical `running` result proves current liveness. Resumable control
state survives marker collection; ephemeral terminal state follows the existing
terminal visibility lifetime once pending parent delivery is settled.

Native child termination also reaches the Run terminal owner through the existing
`runtime-ended` event, including between turns of a retained conversation. The
owner joins prior output publication, fails only the current controller occurrence
and retires its input attachment. A completed input stays completed; an interrupted
input fails without replay. The existing retention policy and native resume handle
determine recovery, and ordinary input to a failed or stopped Run receives the existing
typed refusal until explicit recovery. Pending reconciliation uses the lifecycle owner's
input admission and cannot turn that input into permission to resume or materialize
Connected Services. The explicit `scm.diffSummary.refine` and `scm.diffSummary.discuss`
Actions instead await the existing Ensure/resume Action before enqueueing input to a
recoverable Session-owned generator. Lazy runtime creation retains this event observation
before native opening. Session-owned and detached conversations share this owner;
the daemon's host-PID reconciliation remains a separate host-loss observation.
These are development-source contracts requiring a fresh loaded-runtime replay.

Session-owned Refine spends its root grant on one bounded `session.message.send`
child, not on a general send permission. After protected saved-result scope
admission, the SCM host signs that result's Session on the original authorization
carrier. Protocol's `scmRefineInputPurpose` owns the declaration consumed by both
CLI child credential admission and Home's native verifier: the saved Session,
bound Machine, Run recipient, `send_now`, and `localId === binding.requestId`.
Home also verifies the saved-scope signature independently of the packet signature
and requires the V2 Run Pending carrier. Identical retries use Pending's existing
Session/localId deduplication; another input identity or a direct send cannot spend
the Refine grant. Requester provenance and currentness remain required. The generic
Machine socket has no SCM policy branch. Loaded terminal/composer verification is
separate from these development-source guarantees.

An explicit recovery launch failure settles through the bridge's incumbent
`finishRun` owner. It preserves the typed Provider reason and any runtime issue,
publishes a new failed Run observation and retains a second parent WorkerUpdate;
it does not silently restore the previous failure. A superseded attempt cannot
settle its replacement. Missing native conversation state keeps its existing
permanent refusal and unavailable-checkpoint handling.

During explicit resume of a detached Run, the sealed terminal checkpoint remains
terminal until native loading succeeds. Connected Services materialization carries
the new controller's existing occurrence id and borrows the canonical resume owner's
in-flight preparation through the installed Machine runtime. That proof admits only
the exact active resume under the retained Run's matching host process generation
and Account lineage. A terminal record alone cannot materialize credentials; Stop,
replacement and runtime retirement invalidate the captured authority. Successful
native loading closes new preparation captures while the issued binding follows
that same controller lifetime. Runtime recreation also retains the Run's call and
sidechain ids, so the new detached context receives its native-home and runtime-auth
services through the same composition as first start. Startup redaction retains
only the startup code's closed reason; explicit Ensure and Ensure-or-start carry
that diagnostic in the existing Action failure `details`, without native exception
payloads or credential material. This is development source pending loaded-daemon QA.

Development WorkerUpdates classify Session, Execution Run and Workflow outcomes
through Protocol's `classifyWorkerUpdateEventV1`, using the shared Follow event
vocabulary. A failed or stopped source cannot become a successful completion
because its retained scheduling field says `finished`. Workflow attention is
eligible for intake while current and is withdrawn by the existing revision and
attention recheck after resolution. Authored Workflow input retains priority.

In 0.3 development, the Session intake publishes an Execution Run completion card
as its own transcript event as soon as the terminal attempt's WorkerUpdate is
sealed, including while the parent turn is active. Publication uses that retained
attempt's existing local id and the ordered transcript writer. Reconnect and
retained-host recovery keep that identity; later intake does not add another card.
The card does not accept or consume the pending parent input. Its context and
wake remain deferred until the parent turn settles, including when a person
steers the active turn. Failed and recovered attempts each retain their own typed
outcome and card. This source contract still needs the loaded Providers QA replay.

The development Execution Run and Workflow-origin inboxes ask the shared
`resolveWorkerUpdateFollowDeliveryV1` policy adapter whether an update may wake.
New Workflow Runs capture `follow.preferences`'s `runReportPolicy` in the accepted
snapshot's `resultDelivery` when origin reporting is requested. Direct and trigger
creation read that choice once; reports and resumed Runs use the frozen policy.
The origin input port applies its event selection during ordinary preparation and
its interrupt choice when taking a wake. Custom-off events supply neither input;
Quiet events remain available for the next natural turn. Historical snapshots
without a captured policy retain Important: successful results are quiet, while
failed/stopped results and current attention may wake. Delivery retains its existing
acceptance ACK; selecting a wake never consumes a different pending result.
This source implementation is not loaded-runtime certification.

The terminal error carrier reuses `SessionRuntimeIssueV1`: Run errors retain it
in `error.runtimeIssueV1`, Workflow leaf failures in `progress.reason.runtimeIssueV1`,
and receiver updates in `WorkerUpdateV1.runtimeIssueV1`. Retention, recovery and
prompt/card projections preserve source-reported usage-limit recovery details;
an absent reset time stays absent. Source Session hydration binds the issue to
the observed failed turn. This adds no error classifier or process-loss detector;
loaded-runtime validation remains a separate gate.

In current development source, a failed Session input or detached Run input with
a typed usage-limit issue projects the Workflow leaf as `needs_attention` and
interrupts the Run. The existing Run detail and Needs you projections retain the
provider's reset time and recovery details; they do not schedule an automatic
retry.
Failed original-reply custody retains the exact Session turn's typed issue in
that same projection. The Agent producer owns quota classification and reset
parsing; Workflow observers do not reinterpret older bare diagnostic previews.

In current development source, the existing connected-service home reclamation
scheduler also sweeps execution-run isolation homes. It reads live Run markers
and retained Run records through the execution registry, and uses the canonical
Run lifecycle projection to retain homes with a native resume handle. Unknown
custody prevents reclamation. The same sweep preserves non-symlink local
transcripts and manifest-declared resume state. Materialization persists the
Agent descriptor's native-state inventory separately from managed shared entries;
predecessor homes without that inventory retain their known native-state paths.
Unreadable or malformed inventory refuses reclamation, and shared native-home links alone
do not retain an orphan. Server Session references include active, inactive
and archived Sessions, and incomplete metadata or pagination refuses reclamation.
Materialization exit defers Session `csm_` homes to that server-aware sweep.
Exit, adopted-root and direct isolation cleanup preserve local resume state;
private declared native state survives credential rematerialization without
following shared-state links. Import, promotion and cleanup refuse redirected
child homes, including an aliased attempts directory, rather than following them
within or outside the configured base. Runtime and credential leases still retire at exit. The
existing orphan age and cleanup tick govern later reclamation, without another
timer or registry. These source contracts are not loaded-daemon certification.

Reopened retained Run records, control state, public markers and pending WorkerUpdates use the protocol's canonical stored-read projection: additive fields are dropped recursively, while malformed known facts still refuse. Custody comparison and acceptance ACK use that same projection. Device-local sealing, Run identity checks and new writes remain strict; stored-read tolerance does not authorize a new input or a different Run.

In current 0.3 development source, the execution registry names retained state,
WorkerUpdates and visibility markers with fixed-length identity digests. Exact
identities remain in their payloads, leaving native filename space for atomic
publication. WorkerUpdate conflict and acceptance checks still use sealed payload
identity; unreadable delivery custody prevents garbage collection. The Session
RPC registration owns one child-Run disposal promise, including idle retained
Runs. Physical runner retirement starts that disposal alongside foreground native
cleanup, before a suspended native disposal or Session close can strand children
from the departing generation. Session close joins the same promise before
releasing its Account snapshot and handler resources. Mode handoff and runtime
recovery keep the Session's independent child work; a planned replacement does
not adopt the retired generation's native children.
Before an admitted planned signal, the daemon's existing remainder owner captures
the exact runner process tree, including children tagged to logical Run owners.
Exit cleanup consumes those native PID/start witnesses before respawn. A live
replacement does not erase the departing generation's capture or become one of
its targets. Definitive Stop consumes this same remainder owner and reports its
physical cleanup outcome. Native cleanup therefore remains possible after the
old runner's graceful-disposal window ends; it does not depend on plugin disposal
or terminal publication finishing in that window.
Stop preserves each retiring generation's captured tree and checks every distinct
capture's result, reusing an already completed cleanup rather than repeating it.
These corrections require a fresh runner for loaded-runtime replay.

Current development source projects current execution-run work from the existing public `status`, `runClass` and optional `turnInFlight` through Protocol's `isExecutionRunActive`. A running long-lived handle with an observed `turnInFlight: false` remains available for follow-up without contributing background work. Bounded runs remain active through outcome settlement, while provisioning and older producers without a turn observation remain conservatively active. The bridge publishes work changes through its existing public-state source; the Session observer and roster consume the same classification. Voice work follows its existing setup, turn and lifecycle promises together with the current runtime turn witness. Reachability, retained lifetime and current work remain separate facts.

A retained provider-session handle proves which native session to resume, not that its state still exists. A definitive native resume rejection is classified by the Agent plugin; Codex's `thread/resume` application rejection for missing rollout state carries `AGENT_RESUME_PROVIDER_STATE_MISSING` through startup sanitization. The host resume owner records `execution_run_provider_state_missing`, and the lifecycle owner projects that retained Run as unavailable. Transient or unclassified failures remain indeterminate. Recovery never substitutes a fresh native thread for the requested identity.

Execution Run Ensure requesting resume without coupled input refuses `recoverable_with_input` with `execution_run_input_required`. Detached Runs use `execution.run.send` with `sessionId=null`, `resume=true`, a fresh `localInputId` and a message. In 0.3 development, a failed Session-owned bounded Run instead accepts `session.message.send` with its exact Run recipient, a fresh `localId`, a message and `requestedAction: { v: 2, kind: 'recover_execution_run' }`. Ordinary input remains refused; missing native state and reused input identities retain the sender's typed refusals. `execution.run.send` remains detached-only.

The exact Pending row retains that explicit intent. Admission requires the target Machine's input-admission epoch 3; older daemons receive `session_input_target_update_required` before a row is created. The bridge's Pending reconciliation binds only the explicit failed-bounded recovery input to the existing claim/settlement consumer, and delegates native resume and dispatch to `ExecutionRunHostBridge.send`. Native acceptance must commit the exact user anchor before recovered output can publish. Recovery never rearms an old blocked input. The existing requester-bound exact-input waiter settles only after the recovered input's completed turn is observed. Loaded runtime replay remains distinct from this development-source contract.

CLI `execution.run.wait` observations reattach to the original Run through the existing connection supervisor after transport loss. Reattachment invokes the same daemon event-backed wait, without launching work, replaying input or polling `execution.run.get`. A disconnected occurrence cannot settle the observation with a late acknowledgement. Caller cancellation retires only that waiter. The service's original finite observation deadline spans connection, reconnect and snapshot output backpressure. Requests resubmit the remaining budget with the wire's existing one-second quantum, while the caller signal enforces the precise deadline. Expiration ends observation and returns `ok:false, code:'observation_timeout'` when no completed owner reply is available; it supplies no invented Run status and does not reconnect after expiration. Unbounded observations remain unbounded.

Bounded recovery keeps its one exact explicit Pending consumer while the native
checkpoint resumes. The bridge's retained-input attachment cannot supersede
that current binding. Reviewer narration may still establish its ordinary
retained conversation when no explicit recovery consumer owns the target.
Existing native acceptance, not command admission, releases the recovered
reply's user-anchor barrier.

Input admission is not turn completion. The execution bridge's send acknowledgement
settles when the input is admitted, including bounded recovery; later output and
outcome settlement remain with the same retained Run. The existing
`execution.run.get({ waitForInputId })` request observes an exact current/last input
turn when its caller has that identity. It does not create input or await every
future turn of a long-lived Run. Run-terminal observation uses `execution.run.wait`
and the completion barrier below, rather than interpreting send success as output.

Terminal and combined terminal matches, including an initially terminal public snapshot, cross the host's completion barrier and then re-read the settled result. A terminal projection alone can precede transcript publication and retained completion custody, whose failure can change the Run's final status. Expiration during that barrier returns an observation timeout rather than matched completion. Passive state snapshots remain immediate projections, and an attention-only observation does not treat terminal state as an attention match.

In 0.3 development, Home reissues `execution.run.wait` after its target socket
disconnects, waiting on the existing method-registration push. The replacement
observation reads the host's retained state, including completion during the
gap. The original caller deadline includes discovery and offline time; a target
that remains offline settles with the existing timeout result. An unbounded
caller parks without a reconnect timer, and caller cancellation releases the
wait. Effectful RPCs retain their disconnect/unknown result and are never replayed.

The same observer accepts terminal, permission-attention, or combined conditions.
Attention is a projection of outstanding requests for the live controller
occurrence in the existing permission store, not a second permission ledger.
Passive observation returns an initial snapshot and then parks on the bridge's
existing state-change source with the last snapshot. Reconnect recovers current
state rather than missed event history, and snapshot delivery backpressure
survives reconnect. A deadline ends observation only; an unmatched attention
condition preserves the actual terminal snapshot in its timeout result. The
daemon re-arms long deadlines in Node-supported timer chunks without capping
the requested duration. Generic `wait`/`watch` consumers must explicitly adopt
these owner APIs; this source seam does not itself certify their integration.

## Retained SCM output publication

In 0.3 development source, a proven input refusal before any provider effect
settles an idle retained Run through the execution bridge's existing terminal
owner. The profile's terminal hook publishes failed saved outputs while retaining
usable earlier content. Pending keeps the refused input blocked; recovery admits
a separate input rather than replaying that refused row. A refused intervention cannot end
another active turn, and uncertain provider effects retain their existing custody.
Host pre-effect checks do not replace an incumbent turn's accepted input anchor.
Native dispatch installs its custody fence before effects are possible; only a
positive durable refusal can retain the active incumbent anchor. An unknown
native outcome continues to hold publication until its exact input is classified.
Loaded daemon/runner replay remains a separate validation boundary.

SCM explanation Runs use the existing `resumable` retention policy and
`long_lived` class within Session-owned or detached retained interaction. The host's
per-turn completion seam invokes `ScmDiffSummaryProfile`, validates structured
output against captured occurrences and publishes through the revisioned machine
result owner. A settled output does not imply that the native Run terminated;
ordinary chat does not write the result. Review narration consumes the same
publisher after findings settle. Detached narration retains null Session
association and uses the same Run sender, captured repository and protected
requester scope; Session narration keeps its Session Pending admission.
Input admission, cancellation, recovery and
generator replacement stay at their existing host owners. See
[SCM comparisons and walkthroughs](scm-diff-summary.md) for output, revision,
discussion and currently unverified integration contracts.

## Machine native effect admission

In 0.3 development, `machineSetupNativeEffects.ts` resolves setup's native scope
before effects or credential delivery. The existing engine reader observes the
selected execution profile once and unions its identity with retained engine
observations. Retaining engine A does not skip reading selected engine B.
When the selected Docker identity cannot be read,
including missing executables, permission failures and unreachable engines, it
reserves `allNative` in `machineNativeEffectAdmission.ts`. This serializes setup
against all native work on the Machine, including effects with empty keys.
A broad effect waits for running effects; later native work waits until it
settles. Waiting honors cancellation. Unknown native settlement still requires
the incumbent producer's proof. Docker installers and repairs can therefore run
before Docker is readable and report their own execution failures. Known engine
coordinates retain the existing conflict behavior.

Setup releases native admission when the interpreter and its owned native work
have stopped, including failed and unknown effect outcomes. Partial package facts
remain on the operation; they do not retain a Machine-wide lock without a live
process. Deployment admission failures retain the incumbent Action operation ID.

Combined Setup retains its accepted Workflow Run as the recovery owner when
the wait observer fails. The parent Action requires settled Run custody before
projecting a terminal outcome. Recovery locates pre-acceptance native work by
its original Home, Account, Machine and Action request identity; cancellation
uses that operation's existing abort path. Confirmed cancellation stops the
interpreter's owned subprocess tree. An unverified stop retains native admission
and a nonterminal uncertain operation observation. Cancellation leaves already
created vendor Docker resources in place.

## Rules for changes

- Extend the owning host path and migrate its callers together. Do not add another Agent registry, lifecycle loop, prompt queue, permission owner, thinking flag or whole-metadata state writer.
- Use the canonical `AgentSessionRuntimeEvent` schema at ingress and its public SDK projection. Host lifecycle/session/runtime event namespaces are host-emitted; a plugin emits native evidence through the admitted Agent seam.
- The optional `startingInputId` on host `@happier/runtime/turn-start` is the accepted Queue input's exact `localId`, stamped by the host only after a real accepted native start. Plugin-supplied attribution is stripped; absence does not prove an input cause. This fact alone does not classify a turn as fixing work.
- In 0.3 development, `session.input.result.get({sessionId, localId})` reads that exact input's existing accepted-turn/start witness and canonical result. A waiting turn stays pending. Plugin callers must match their original admitted input authority and receipt; missing proof from an older server is unavailable, not completion. The read adds no queue, lifecycle or counter.
- The development Channels PR Watch consumer keeps one incumbent obligation/input pointer in its existing binding progress. An Address or Auto-fix batch charges that PR's allowance only when the exact accepted input has a host start witness, including a turn that diagnoses or asks a question. Notify and Analyse do not charge. Queued, uncertain or still-pending inputs hold later fixing delivery; completion clears the pointer, not the consumed count. Own/unknown pushes and passing checks do not clear unresolved feedback. A retained other-writer push ends its sequence once, after accounting for any outstanding input. The existing ingress retention owner preserves a referenced active input even after its first reply projects. Under approved AM-QC1, exhaustion continuation is a direct Watch Action with current binding-revision CAS and the effective finite Account allowance, not a C1 question or answer consequence. Existing retained-link polling schedules only original known-no-effect exhaustion blocks through the incumbent retry/due-work owner when current fixing policy and allowance permit; unrelated blocked causes and Stop/Off do not resume. Triage alone presents its Inbox/detail controls through the host's declarative contributed-Action path and normal viewer policy. Existing-Session configured PR Fix sends enter this same Watch custody with their reviewed expected SHA and original attachments. Sequence resolution consumes only the existing Channels observation's current-head `pullRequestState.fixResolution` fact when `resolved && !incomplete` and no input is outstanding; absent, incomplete and older observations do not establish resolution. The host input-result fact alone does not establish native PR resolution.
- Auto-fix preparation reads the bound PR through the existing Session-targeted SCM Action and verifies its current native head against the accepted checkout after the ff-only pull. The frozen update remains historical evidence, including after an own push. Preparation checks the allowance without claiming the active input, then claims through the same binding CAS only after preparation succeeds; a known-no-start approval/preparation hold stays on the original ingress retry path. A failed claim retains no preparation proof, while uncertain sends reuse their existing proof and input identity. Retained old blocked preparation reservations are recovered only with the same explicit Auto-fix authority epoch and no preparation/accepted-input witness; changed policy and uncertain Address work are not inferred safe.
- Keep terminal/remote mode orchestration and cleanup at the host. An Agent declares its surfaces and native operations rather than choosing host policy.
- Keep UI activity and transcript views as projections of canonical facts. Retained UI data during refresh is not authority to admit new work.
- Retired public surfaces such as `RuntimeCoreV1`, `AcpSessionRuntimeV1`, `RuntimeControlContribution` and `RuntimeEventV1` must not regain consumers. [`agentRuntimeSurfaceContract.ts`](../packages/plugin-sdk/src/agentRuntimeSurfaceContract.ts) records the negative public contracts. Preserve a necessary released compatibility translator only at its seam, under [compatibility](compatibility.md#sdk-protocol-evolution).

## Related

[Plugin platform and SDK](plugin-platform.md), [Agent catalog](agents-catalog.md), [CLI architecture](cli-architecture.md), [Actions](actions.md), [encryption](encryption.md), [testing](testing.md).
