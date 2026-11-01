# Compatibility and version skew

This document defines when Happier preserves old behavior across UI, CLI, daemon, server, installers, and persisted state. The goal is safe upgrades and mixed-version operation without turning undeployed implementation history into permanent compatibility debt.

## Idle compaction records and capabilities (unreleased 0.3)

This is an in-place development SDK contraction: one strict compaction
descriptor replaces the old SupportLevel shape and duplicated bundled manifest
literals. External plugins targeting this development API must update their
Agent declaration and return the capability of the runtime actually opened.
An unsupported opened mode cannot inherit support from another mode.

Stored `context-compaction` events add `trigger: 'idle'` and optional measured
`tokenCountBefore` / `tokenCountAfter`. Existing manual, auto, threshold,
overflow and unknown triggers remain readable. Historical raw compaction
readers remain for retained transcripts; live runtime events use the canonical
typed writer. Runtime `outcomeUnknown` remains outside the stored phase grammar.
Only idle origin is newly quiet, including the owner-produced encrypted local
identity understood by the server's existing write admission.

The approved policy is a one-way upgrade. The predecessor 0.2 reader's closed
trigger enum rejects new idle records, so reverse mixed-version reading and
rollback to that reader are unsupported after these records are written. There
is no dual writer, rewritten trigger or old-reader alias. The observed predecessor
basis is `c16edc75540e5f8819932f9d90495564b9b2db7f`, scoped to its unchanged
`packages/protocol/src/sessionMessages/transcriptRawRecordV1.ts` trigger grammar.
The three optional Account preference maps preserve missing-as-inherited values
and require no stored-data migration. This is development-source compatibility,
not a release certification.

## Trigger

Apply this policy when a change affects a cross-component wire shape or semantic, persisted/session/settings data, schema or migration, feature/capability negotiation, installer or service state, upgrade/coexistence, or rollback. Routine internal refactors that leave these seams unchanged do not need a compatibility matrix or shim.

## Runtime failure transcript metadata (0.3 development)

Host failure messages carry the existing typed `SessionRuntimeIssueV1` in optional
`runtimeIssueV1` message metadata, beside the legacy `runtimeIssueCode` and
`runtimeIssueSource`. The canonical stored-message reader retains these declared
display facts for owners and authorized collaborators; malformed optional issues
are dropped without making the fallback text unreadable. Older readers may
ignore the new field and display the stored text. Typed Team failures omit the
generic Agent-failure prefix.

This is a presentation-only addition to the existing message-metadata envelope,
not an input, credential, recovery or permission authority. It changes no SDK
activation ABI, event union, admission rule or database schema. The inspected
moving 0.2 predecessor has no typed Team failure metadata; its messages remain
readable without it. No adapter, migration or client update floor is required.
Historical recovery controls and resource-name presentation are separate UI
composition; carrying the issue does not establish that those controls render.

## Provider connection usage (0.3 development)

The optional strict `usageSources` executable declaration, registered usage
parsers and explicit `providers.usage.refresh` Action are unreleased additions.
The response reuses existing Provider Account Usage snapshots and Q1 meters;
missing capability remains `not_supported`, and missing optional billing binding
remains `not_configured`. Unsupported older hosts must refuse unsupported
executable declarations through normal plugin admission, not silently grant a
new network or credential operation.

Separate billing credentials reuse the existing slot-keyed Saved Secret binding
format and Account/Machine writers. Only declared slots can be set; stale slots
remain clearable. No credential migration, alternate settings format, PAU ledger
or Connected Account revision is synthesized. The inspected moving 0.2
predecessor has no Provider contribution/usage Action seam; its existing PAU
meter records remain readable. No adapter for never-released development SDK
types or reverse-binary execution promise is introduced.

## Connected Account authentication facts (0.3 development)

Qualified V4 credential metadata may carry optional `authenticationProvenance`:
the observed successful authentication time and the executing Machine's qualified
`{ serverId, machineId }` identity. Here `serverId` is the portable Home server
identity, never a device-local profile alias; an unknown binding leaves the fact
absent rather than inventing a target. The existing profile/list projection carries
the same fact and optional `lastRefreshSuccessAt` from credential health. These
are display facts, not credential-selection, permission or currentness authority.
Their objects and existing mutation/identity envelopes remain closed.

Missing history stays unknown. Readers accept older profiles and credentials
without either field; persistence readers use the existing unknown-field-drop
projection. Native import, quota work and provider reconciliation do not invent
a sign-in time. A prepared settlement retains its captured fact through retry
and restart, and refresh retains existing provenance instead of replacing it.
No row-timestamp backfill, database migration or second health writer is added.

V4 is current development source, absent from the inspected 0.2.16 and moving
0.2 predecessor contract. Released outer Account profiles accept the existing
top-level V4 addition while their strict legacy service rows stay unchanged.
This does not introduce a promise to interoperate with stale, independently
bundled development V4 readers or a new client update floor.

The development V4 `GET /v4/connect/qualified/accounts` also accepts an explicit
`services` array through the existing structured-query codec. It is mutually
exclusive with `service`; the multi-service response is closed `{ services,
accounts }`, while single-service requests retain closed `{ service, accounts }`.
Service references and profile envelopes remain closed. Empty service sets read
no Accounts; an unknown selector never becomes an unrestricted Account read.
This filter requires the matching development server and has no fallback to
per-service fan-out or an older unfiltered operation. The inspected 0.2.16
stable/preview and moving predecessor have no qualified V4 route. No persisted
format, SDK activation ABI or released single-service contract changes.

## Discussion list outcomes (0.3 development)

Discussion summaries add optional, closed `roundOutcomeV1` and nullable
`openCommentCount` read facts. Current server writes maintain them with the
existing Workflow and Discussion transactions; stored round readers drop unknown
fields. The Workflow's private installed-worker storage packet carries only its
admitted built-in identity and non-content count/synthesis facts. Public Action
inputs cannot set a summary. PostgreSQL, SQLite and MySQL add nullable round JSON
and a root counter backfilled only from existing anchor/reply-target metadata.
Retained authored content and keys are untouched. This is undeployed 0.3 source,
with no old-writer or reverse-binary adapter. Missing count facts remain unknown.
The inspected clean scoped predecessor at
`01107c0e7a6b2d4b521573c6d69b53070187e76a` has no first-class Discussion seam.

## Automation managed-target index (0.3 development)

The V3 definition wire epoch adds optional nullable `managedTarget` structural
ids to the closed outer Workflow V2 recipe and public definition projection.
Absence remains unknown; `null` means known unrelated. The canonical Account
seal derives the field, and the definition CAS writes its indexed projection.
Older writers that omit it preserve the stored ids and invalidate the index
instead of erasing the relationship or trusting an old target. Unchanged recipe
and trigger-only writes retain the current index.

The closed structured definition query accepts exact managed-target demand and
an explicit temporary unknown-row inclusion. A current reader opens only those
candidates and verifies the private inline Action. An authorised client startup
pass backfills readable unknown current recipes through the same recipe CAS;
conflicts and locked rows retain the unknown fallback, without hot retries.
The fallback can contract when supported writers always emit the field and
retained current recipes are indexed. Unsupported structured queries remain
unavailable; they never become an unrestricted request.

This requires a matching 0.3 development Home. The inspected immutable Server
tags `server-v0.2.17` / `server-v0.2.17-preview.1` (both
`a2c45c86804b24e60ac0b76146a3ef36dfcaa15b`) and clean scoped moving predecessor
`29c845495702acde2824dae13067d8a09322b26b` expose V2 Automation definitions,
not this V3 recipe/query seam. Their retained templates cannot represent an
inline managed scope Action and remain readable under the existing conversion
owner. The additive PostgreSQL, SQLite and MySQL migration marks those
structurally unrelated legacy targets as indexed without opening content.
No new V2 field, released client update floor or reverse-development-binary
adapter is introduced.

## Managed Session birth relation (0.3 development)

The current Layout-1 creation request accepts the closed optional `managedCreation`
id carrier, reusing the immutable recipe's schema. Session birth owns its validation
and nullable relational column; rejoin never rewrites a stored relation. The new
closed `/v2/sessions/lookup-managed-birth` request/response returns only a unique
Account-owned Session id, including archived Sessions. Controller Moves do not
change birth identity; ambiguous matches remain unresolved.

New migrations are additive for PostgreSQL, SQLite and MySQL. Existing requests
without the carrier remain accepted. Existing rows retain null rather than an
inferred backfill from private content. Missing lookup operations (404/405) and
absent or ambiguous relations leave that source unresolved; Machine detail can
still use an existing FIN rule's source. Other HTTP failures and malformed
responses propagate. No Session or Run inventory scan supplies a missing relation.
Current managed creation requires the matching development Home; silently dropping
the carrier is not an older-server creation adapter. The immutable private recipe
remains the retry-meaning owner, not a second writer of the server relationship.

The moving predecessor inspected on 2026-10-24 is `../0.2` HEAD
`3482a9101ebb7ee2983608ef0deb00831dfcb2e7`, with clean scoped status/diff for
the Session schema, create route, CLI API and correspondence path. Its ordinary
creation request carries opaque metadata and no server-visible managed birth
relation. Retained content remains readable through the existing metadata reader;
no 0.3-to-0.2 rollback or new-writer/old-reader relation contract is introduced.

Durable Workflow Run admission uses the same optional closed `managedCreation`
carrier and an additive nullable `AutomationRun.managedCreationId` relation.
Ordinary Run requests omit it; historical Runs remain null. The incumbent Run
storage transport adds the closed `managed-birth.lookup` operation, whose
`{ homeId, managedId }` input returns `{ runId: string | null }` without Run
content. Machine detail resolves this exact relationship before Session
provenance, so task births at Keep never require Session or Run inventory reads.
Missing Run lookup operations (404/405) still allow the exact Session lookup;
malformed responses and other failures remain refusals. This is an unreleased
0.3 extension requiring a matching admission owner, rather than an ignorable
optional input on an older Home. No no-op Keep trigger, inferred relationship
backfill or historical Run-content scan is added.

## Baseline classes

### Project checkout authoring relationship (0.3 development)

The V1 Project Account row owner stores an optional, closed
`authoringSession: {serverId, sessionId}` display relationship beside the private
content in its existing reserved KV record. The qualified row key, relationship,
read requests, mutation requests and results remain closed. The new dedicated
`POST /v1/account/project-rows/authoring-session` operation records only this
relationship for an existing Account-owned checkout. It grants no access and
does not interpret a Session title or setup outcome.

Read/list requests opt in with `includeAuthoringSession: true`; requests without
that field and ordinary structural mutation acknowledgements keep their prior
wire shape. New readers accept absent relationship fields. A current UI talking
to an older strict row server retries its rejected opt-in census once without
the flag, then uses the existing hydrated-Session discovery. A missing recording
operation (404/405) retains the already-committed owner-private provenance.
Other failures propagate rather than pretending the relationship was recorded.
The Session's Home is stored by its established portable identity. When that
identity is unavailable, private provenance remains the fallback; a device-local
profile alias is never written into the shared relationship.

The persisted metadata needs no database schema migration. Structural mutations
and Account-mode conversion retain it; checkout deletion removes it. Historical
rows are not inferred or backfilled from private Session content. The new writer
runs only at Session creation/recovery, and identical retries do not advance the
row revision or publish another change. There is no new SDK epoch, client-update
floor or reverse-development-binary storage promise.

Setup authoring in 0.3 development can hand its private origin to Session birth.
The existing Machine operation-capability owner advertises
`sessionSpawnAuthoringOrigin: { protocolVersions: [1] }`; only an explicitly
supported leaf permits the optional closed `authoringOrigin` spawn input. The
origin and its nested destination references retain their existing closed
schema. This is a negotiated extension of the existing spawn operation, separate
from SDK package SemVer, with no new route, event union or database migration.
Missing, malformed or unsupported capability leaves retain the existing
post-create owner-private checkpoint and its typed failure. Older callers omit
the input and a new daemon preserves their creation behavior.

The daemon carries the admitted origin through its private runner startup
custody into `work.authoringOriginV1` in the initial owner metadata. The existing
Account-mode envelope writer owns encryption. The UI confirms the equal origin
through an exact owner read before the relationship POST and sends no origin
PATCH after handing persistence to birth. Missing or unreadable confirmation is
an `authoring_origin` failure, not permission to start a second writer. The
capability advertisement alone is not proof that persistence succeeded.

The existing device-local spawn-attempt record retains the chosen persistence
owner for deferred and recovered creation. An older record without that fact
can confirm an already stored equal origin; otherwise recovery refuses the
unknown handoff rather than guessing which writer owns it. Temporary-computer
creation retains an explicit legacy checkpoint until its own birth handoff is
negotiated. These adapters preserve older request/record shapes without a new
storage key, retry loop, timer or server-visible provenance content.
Cross-Home recovery reads operation and spawn-attempt custody with the admitted
destination Account. The originating Account still owns the draft and checkout
relationship; its Account id is never substituted for the destination's id.

The 0.3 development Discussion reply owner adds optional closed `returnPublication`
metadata to existing original-input JSON and a closed `discussion_publication` observation
mutation. Existing originals without that metadata remain readable; native outcomes are
unchanged. Failed-return presentation extends the same Discussion participant-delivery
projection. The existing original-reply hint adds optional `workflowRunId`; omission remains
valid. These are unreleased 0.3 contracts under the direct cut, without a new table,
migration, dual writer or adapter for an older development binary.
Approved Discussion replay uses that same mutation with `approvalArtifactId` for any
typed publication failure, including `discussion_answer_policy_denied`. Reject/Cancel
still require the exact Artifact; pending approval metadata cannot carry that decision
operand. This extends the existing closed development contract and requires matching
0.3 readers and writers, without changing released approval history or native outcomes.
The same development-only storage route accepts an optional closed `runId` selector
on `recovery.list`. Exact return/approval recovery requires the matching reader;
older requests without it retain broad lifecycle recovery. It changes no stored shape
or public Action/SDK input and is absent from the clean scoped moving predecessor
`dac1efd68dee668d15c0c84fa5cacd29c15fb176` inspected on 2026-10-25.
The scoped moving predecessor last rechecked at `01107c0e7a6b2d4b521573c6d69b53070187e76a`
has no original-reply or first-class Discussion corridor and no scoped staged/unstaged
changes there. This change does not reinterpret a predecessor-created reply format.

### Hard released obligations

- Active stable and preview releases count because both can exist on user machines or deployed infrastructure.
- Resolve each component independently. UI, CLI/daemon, server, desktop/mobile, and stack tags may point to different commits.
- Discover the current channel through rolling tags such as `cli-preview`, then record the immutable component version tag, commit, and relevant artifact/deploy evidence used by the check.
- Older releases count only when explicitly supported by policy or task scope; tag existence alone does not imply indefinite support.

### Moving `../0.2` predecessor frontier

- `../0.2` is expected to ship before this repository. Its real current on-disk code is a prospective compatibility input even when it is uncommitted or not yet released.
- Inspect committed, staged, and unstaged code in the relevant paths. Record `HEAD`, working-tree status, the relevant diff/basis, and what was directly observed versus inferred.
- Never modify or clean the sibling worktree. Dirty changes may be incomplete or concurrently owned; if the externally observable contract is contradictory or unknowable, report that uncertainty rather than inventing multiple speculative adapters.
- Track the latest observable prospective shape, not every superseded internal implementation. When the sibling evolves before deployment, refresh the comparison and remove support that existed only for a replaced, never-released intermediary shape.
- Recheck relevant sibling paths before handoff when they were dirty or advanced during the task. Released stable/preview shapes remain hard obligations regardless of later sibling changes.

### Non-obligations

Usage request attribution in 0.3 development extends the existing event ingest
and contribution projection. Older scalar usage reports and historical events
without this proof remain readable and project unknown attribution; they are
not relabeled from current Session metadata. The moving 0.2 predecessor uses
scalar `/v2/usage-reports` and does not advertise the event-ingest capability.
Its scalar transport remains the existing fallback, without request-source
proof. This is not a second accounting ledger or an inferred attribution shim.

Current event metadata may carry optional `usageAccounting.runtimeEventOrder`
with the host's existing `runtimeIncarnationId` and event `sequence`. It resolves
equal-source-clock ordering within that incarnation, not across runtimes or
missing witnesses. Event metadata is additive; stored accounting readers drop
unknown fields, and older scalar transport never receives this supplemental
request stream. Existing rows without the witness retain chronological fallback.
Duplicate ingestion preserves the stored fact and proof while retaining an
earlier valid same-runtime position; it does not synthesize a later source clock.

The 0.3 foreground daemon claim returns optional, credential-free
`sessionConnectedAccounts` through the same schema as native Session open. The
foreground startup reader consumes the canonical claim-response schema rather
than a second local response shape. Daemon-started Sessions carry the same bounded
optional field in their protected runner bootstrap after successful exact-purpose
materialization. Existing bootstraps without it remain readable and provide no
Account-reference proof. The bootstrap is private to the selected daemon/runner
source bundle, not a cross-version public SDK contract. The CLI retains the
materializer's selection controls from its explicit scope only for daemon
launches with a validated matching private bootstrap; the marker or caller
environment alone is insufficient. This changes no wire shape or stored data.
These correct
current-development launch projections; they add no persisted binding format or
historical attribution. The moving 0.2 predecessor has no foreground claim seam and retains its direct
Connected Service launch path.

The optional `usageAccountScope` materialization result and launch carrier are
additive 0.3 development evidence: older service results omit it and remain
unknown, and older hosts may ignore it without changing authentication. Only a
service's actual admitted credential revision may supply the classification.
Public usage continues to use the existing `usageAttribution` shape; no stored
row is backfilled from a current subscription or Session selection.

- `dev`/`*-dev.*` builds, untagged history outside the live predecessor frontier, abandoned experiments, and undeployed internal module paths are not lasting compatibility contracts.
- Do not keep aliases or adapters solely for an atomic internal rename/move whose old path never shipped.
- The predecessor rule preserves observable wire/data/state behavior, not `../0.2`'s internal architecture.

## Session PR watch integration (0.3 development)

The new Channels Watch/update envelopes, optional binding-owned watch progress
and optional Automation `prUpdate` evidence belong to unreleased 0.3 source.
Automation producers preserve omitted evidence for existing occurrences; current
readers validate supplied PR envelopes at the Channels boundary rather than
interpreting arbitrary workflow JSON as trusted instructions. Existing authored
literal workflows are not silently repaired or rewritten.

The inspected moving predecessor is `../0.2` at
`2bf968563bf2015455c0cd54bcc74e91f67891b9` (2026-10-24 recheck). Its relevant
new Watch/binding/result paths and `automationResultDeliveryV1.ts` are absent,
with no staged or unstaged changes at those paths. This is not a released
mixed-version Watch contract and does not justify a second watch store, dual
writer or undeployed-intermediate adapter. Retained link conversion remains
with the existing source/Channels relation owners; this watch integration does
not independently discard predecessor relationships. Package and composed
runtime validation are still required before claiming completion.

## Composer inline references (0.3 development)

Transcript annotations use the existing Composer attachment V1 record and
app-context contribution lifecycle. Their strict value is `{ quote, note,
source: SessionMessageRefV1 }`; it creates no primary message envelope or data
migration. Attachment presentation additionally admits optional `source` as a
closed committed-message reference for historical navigation. The presentation
object keeps its additive-open/drop read policy; existing records without a
source remain unchanged, and older presentation readers keep the existing
label/description fallback. No source link grants access to the message.
This is an unpublished 0.3 author contract under the direct cut, not a new
0.3-to-0.2 writer or rollback direction. The native renderer's legacy selection
event can still supply exact selected text without `renderedText`; annotations
retain that quote and committed identity without inventing source offsets.

This is an unreleased, one-way 0.3 format change. Current writers persist
`[label](happier-ref:<scheme>:<opaque>)` at the reference's position in text.
Protocol's [token grammar](runtime-core.md#session-input-and-inline-references)
uses the existing percent-encoded MentionRef destination. Identity stays in
the envelope's positionless `mentions[]`, draft reference ranges and attachment
records; the token alone cannot authorize or create a reference. Upload
descriptors gain optional `id`, matching the tray id and structured image input
id. Existing contributed attachments retain `instanceId`. Image ordinals are
derived, never persisted. The token bound is derived from existing label/ref
bounds and escaping; other mention and resolved-context bounds are unchanged.

The retained reader is for 0.2-created data:

- Messages with legacy `@`/`$` tokens keep the Markdown text and appended
  references row. `messageDisplayText.ts#stripLegacyAttachmentsBlock` hides the
  old `[attachments]` suffix where structured attachments replace it. Dispatch
  preserves an existing legacy listing once rather than duplicating it in the
  new reference block.
- Positioned legacy drafts load through `parseComposerStructuredInputMentionsForText`
  and `sessionDraftLegacyMigration.ts`. Their shared normalization rewrites
  each bound range into the inline grammar and shifts subsequent ranges before
  saving the current shape. Pending edits and rewind/fork hydration recover
  ranges from exact token occurrences.
- New references render inline; legacy references without inline tokens keep
  the row. A hand-typed workspace path may still appear in that row through
  the canonical path scan. That is text detection, not another token writer.

Observed predecessor basis, 2026-10-21: `../0.2` HEAD
`8a088dd70f57ccf43fade3543fb6a3e874bee12a`. Its
`packages/protocol/src/mentionRefV1.ts` defines positionless typed mentions,
the existing destination encoding and `maxTokenChars: 256`; its attachment
producers append `[attachments]` text and its draft readers retain ranges.
These are retained-data inputs, not an obligation for a 0.2 binary to read 0.3
writes. Under the all-component upgrade there is no 0.3-to-0.2 writer, alias,
dual format or old-binary rollback contract. Keep the historical reader while
0.2-created messages and drafts remain supported; undeployed 0.3 intermediates
do not get additional compatibility paths.

## Discussion attachments (0.3 development)

The strict development Action inputs for create/post/reply accept optional
`attachmentSources: [{blobId,path}]` on the invoking Machine. This operand is
effect-bearing and cannot be ignored: unsupported hosts must refuse it, never
post text while dropping selected files. Private publisher requests retain the
sources through active-turn or approval verification; server publications omit
the paths. The V1 upload metadata's optional closed `agent` arm binds the exact
publication and byte framing to the existing installed Machine key, Home and
Account. Its producer and server reader change together in this unreleased
0.3 direct cut; older strict upload readers refuse the arm safely. Existing
uploads without the arm and existing attachment content remain unchanged.

For this extension, the clean relevant predecessor paths were inspected at
`../0.2` HEAD `420e78875b59a5d50169d31497853c447498f470` on 2026-10-24. Its
Discussion source/upload corridor is absent; no Session attachment contract is
removed or rewritten by the new invoking-host operand.

New Discussion writers use one strict `attachment` content arm containing the
shared Session file/folder payload. Folder paths and empty directories are
content, not Machine-local authority. Stored-content readers remain tolerant of
unknown future part kinds; fresh writes do not accept undeployed attachment
intermediates. The existing inline attachment token is reused rather than
introducing a Discussion token family.

Bytes use the existing explicit plain/encrypted envelope and are bound to the
committed Discussion message. Exact reads require current Discussion access;
an older or unsupported Home cannot be treated as supporting the byte operation.
There is no fallback to a public URL, unrelated Artifact grants, or the sender's
Machine path. Account conversion includes retained attachment bindings and
bytes, including archived Discussions, in its existing fenced transition.

The predecessor frontier for this corridor was refreshed on 2026-10-23 at
`../0.2` HEAD `a487b2ec48873bfc0ad67bb1d31be0a2cffd3c92`. The relevant Protocol,
Session attachment and CLI Artifact/Discussion paths had no committed change
from the earlier `e7c3bd55849a0d00e86eb74a26f478f96c6bc0e0` inspection. Dirty
AgentInput changes add send-menu/shortcut options, not a new attachment input
shape. Its Session attachment inputs remain supported by the shared owners.
Discussion attachments are new 0.3 development behavior, not a released 0.2
write format or a promise that old binaries can read new writes.

## Public-profile integration boundary (0.3 development)

Public-profile publication is an unfinished new capability, distinct from the
implemented username operations below. A feature-missing server must not be
treated as supporting it, and a public-profile request must not normalize into
the existing private Usage path or a generic Account-KV/Artifact write. Existing
private recap inputs, seven styles and three formats retain their own support.

Historical Accounts and Usage without ownership evidence remain readable by
their existing private owners and count in the approved public population unless
known Team evidence excludes them. Known Team usage means a Happier Team
credential, a genuinely Team-owned Session, or a provider workspace plan proved
by the connected-service owner. Unknown ownership, including API-key usage and
imported native history, does not require personal-ownership proof or a history
rewrite. Running-total residuals and turn-less rows count under the same
reconciliation as private Usage.
`UsageQuery.population` selects `public_eligible_personal` explicitly; omitted
or explicit `all_personal_history` retains ordinary behavior. The canonical
transport omits that default so older strict request parsers keep accepting
ordinary reads. The new public selection is gated by `account.publicProfiles`;
an unsupported server cannot silently fall back to the broader private query.
The scoped accounting owner reconciles all baselines before excluding known
Team contributions through one eligibility predicate. Public detail uses the
same eligible contributions and Session evidence, not every turn in a mixed
Session. Whole-Session message counts do not establish that membership and are
omitted for this selection. Excluding known Team usage defines the intended
population; neither that exclusion nor unknown ownership alone makes coverage
partial. Source-history evidence still determines completeness.

Current Session ownership is Account-owned (`Session.accountId`); Team/Group
grants and `primaryTeamId` authored context do not transfer that ownership.
No Team-owned Session input exists in the current model. This is not a claim
that Team credentials or proved Team subscriptions are personal.

Publication, snapshot and nested authority writes now use closed schemas at
`account/publicProfile.ts` and `account/publicProfilePublication.ts`. Their
stored readers drop unknown presentation fields and field ids; missing consent
is false and malformed known consent or facts fail closed. The additive
publication table does not publish historical Accounts or change their keys.
No released route, mixed-version publication or active supporting-server
guarantee is claimed before the consumed integration exists.

## Account username intent and release (0.3 development)

`Account.username` remains the single service-scoped identity used by Friends.
The canonical username policy and transaction-taking mutation in
`apps/server/sources/app/social/usernameUpdate.ts` admit explicit changes,
provider fill/unlink, provisioning and provider-reset transfer. The existing
authenticated social profile's provider-suggestion fallback is presentation,
not ownership of a username.

The additive identity migration preserves retained username bytes, including
underscore/hyphen and customized-policy names. It initializes
`usernameAutoFillEnabled` to false for retained non-null names of unknown origin,
and true for null names and new unclaimed Accounts. Explicit set, including a
same-name replay, and release disable auto-fill. Only a matching name assigned
while auto-fill remains enabled can clear on identity unlink; a matching linked
provider login alone does not prove retained provenance. Existing holders may
retain names newly excluded by reserved-name or configurable claim policy.

`ReleasedUsername` stores only name and expiry. Explicit release clears the
Account name and creates a 30-day hold in the same transaction. No claimant,
including the former holder or provider fill, can acquire it before expiry.
Repeat release does not extend expiry, rename creates no hold, and Account
erasure does not remove a hold. Recovery transfer of an Account's actual current
name preserves its intent bit without a voluntary-release hold; a different
desired name is a new claim.

The existing username POST preserves its request, success and 400/409 error
envelopes for older clients. New reserved/held conflicts map to its existing
`invalid-username`/`username-taken` errors. The new strict check and release
operations have their own closed schemas; no input can supply an internal
mutation role. Against a server missing either operation, current UI/CLI Action
transport reports `unsupported_action`; it does not simulate release through an
empty set or infer availability locally. Ordinary username set keeps its own
older-server support. On current development servers, the existing shared
username route eligibility admits claim, check and release when
`account.publicProfiles` is enabled, independently of Friends and its identity
provider requirements. When profiles are disabled, the existing Friends
eligibility remains in force. This does not enable Friends discovery or
relationships, and the same username policy, reservations and mutation owner
still apply.

The prospective predecessor inspected on 2026-10-21 was `../0.2` HEAD
`8a088dd70f57ccf43fade3543fb6a3e874bee12a`, with clean scoped status and
`diff HEAD` for Account schema, social policy/update, username route/UI adapter,
GitHub/OIDC writers and OAuth finalize routes. It has nullable unique usernames,
trim/lowercase normalization, configurable defaults of 3–32 characters and
`^[a-z0-9_-]+$`, and the original Friends-gated set envelopes. Its direct provider
and finalize writers establish retained-data input shapes, not a requirement to
preserve those internal owners or matching-login provenance inference.

Public stable/preview release pages were read on 2026-10-21 and resolved to
immutable `server-v0.2.16` / `server-v0.2.16-preview.1` at
`22ac8263cfdbcdb845441b9044ff18199cf7652e`, and
`ui-web-v0.2.17` / `ui-web-v0.2.17-preview.19` at
`b8d1c449c46ab4dfa8637db36b66f643d149e66d`. Source comparisons confirm this
username seam. The immutable server
[stable manifest](https://github.com/happier-dev/happier/releases/download/server-v0.2.16/linux-x64.json)
and [preview manifest](https://github.com/happier-dev/happier/releases/download/server-v0.2.16-preview.1/linux-x64.json)
identify those versions, channels, versioned archive URLs and build commit, with
workflow run `37794037498`; publication timestamps are respectively
`2026-10-08T16:02:29.363Z` and `2026-10-08T16:09:18.975Z`. This is public
publication metadata. The immutable UI
[stable checksum file](https://github.com/happier-dev/happier/releases/download/ui-web-v0.2.17/checksums-happier-ui-web-v0.2.17.txt)
and [preview checksum file](https://github.com/happier-dev/happier/releases/download/ui-web-v0.2.17-preview.19/checksums-happier-ui-web-v0.2.17-preview.19.txt)
were also readable and name the corresponding versioned web archives. No
archive/signature verification or evidence of which binary a particular service
deploys is claimed. Deployment provenance remains unverified.
Additive schema does not establish safe old/new server writers sharing one
database: an older writer bypasses intent and holds. Such coexistence is not
claimed or implemented by this identity vertical.

## Session viewer read projection (0.3 development)

The Account-private `viewer` object in Session detail/list records is an
additive-open read projection. Older clients drop unknown outer viewer facts;
known fields and their nested read-state, relevance, attention, Follow and
notification schemas remain strict. New required viewer facts therefore need
the normal reader-first transition before the server emits them. This keeps an
independently updated Home from blocking an older daemon's Session attach on a
new presentation/read fact, without allowing unknown data to acquire access,
routing, mutation or persistence meaning.

## Machine RPC method absence (0.3 development)

The Home distinguishes unsupported Machine operations from temporary routing
failures before forwarding. A successful empty method-room lookup plus a
connected, available Machine whose Home-owned acknowledged registration list
omits the method returns `RPC_METHOD_NOT_FOUND`. The daemon uses that same code
for an absent local handler. Failed discovery retains the existing availability
grace, then returns `RPC_TRANSPORT_UNAVAILABLE` before dispatch, not evidence of
an absent capability or client. An eligible local socket is preferred without
an adapter-wide census; global single-answering-client selection still requires
that census. An unknown registration list or a registered method missing from
its room remains `RPC_METHOD_NOT_AVAILABLE`;
an absent daemon retains `target_unavailable`. Session-owned routes keep their
own current-publisher availability decision.

Current cluster peers also answer room discovery through the server-only
`happier:socket-room:query:v1` event. This supplements the existing adapter
census because its timeout discards partial replies. One authenticated room
member is positive routing or Machine-presence evidence; an incomplete census
cannot establish absence, unsupported methods, or global client uniqueness.
Account Machine inventories retain observed identities as `partial`, and
unobserved Machines remain unknown. Broker admission keeps its existing
identity, lifecycle, capability, entitlement and currentness checks. Older
servers continue answering the original `fetchSockets` census; a silent older
target still yields the existing transient failure rather than inferred presence.
The adapter's existing fetch deadline owns the operation; no additional timer,
retry, cache or cluster membership policy is introduced.

Session runtime Action placement uses that same snapshot, accepting a carrier
only after the Session publisher owner validates its committed generation,
current fence and Machine access. It revalidates the projection after discovery;
a stale publisher or revoked binding cannot select placement. Committed Pending
input placement remains independent of live publisher discovery. Daemon reconnect
hydration publishes REGISTERED hints from positively observed Account-room members
even when the census is incomplete; UNREGISTERED still requires complete absence.

Resource clients classify only affirmative `RPC_METHOD_NOT_FOUND` as unsupported.
The existing unsupported latch and daemon-state recovery remain unchanged;
temporary failures retain the ordinary retry/recovery path. No client RPC field,
registration protocol, timer or retry policy is added. The registration shape
is pinned to CLI `cli-v0.2.16` / `cli-v0.2.16-preview.1` at
`b8d1c449c46ab4dfa8637db36b66f643d149e66d`, whose Machine socket sends
`{ method: '<machineId>:<method>' }` only for installed handlers. This preserves
the reachable 0.2-daemon → 0.3-Home direction without supporting undeployed 0.3
intermediates or a 0.3 client against a 0.2 Home.

## Confirmed background runner refresh (0.3 development)

Ordinary runner-refresh V1 and process-attested V2 request bodies are unchanged.
The explicit `daemon.sessionRunner.restart.confirmedBackground` operation accepts
those same strict bodies and delegates to the ordinary restart owner with only
native-background interruption allowed. It preserves child draining, foreground
refusal, process identity and Provider binding security confirmation. No request
reason proves consent.

The app confirms raw reported activity, independent of presentation freshness,
and also confirms a current daemon's native-background busy result. Only after
that consent may a missing dedicated method fall back to the original V1 or V2
operation; authorization, cancellation and other failures never downgrade.
An older client using the ordinary operation safely receives busy for active
native work. A current daemon accepts an omitted native activity field from a
non-reporting runner; a successful unknown report permits refresh, while an
actual read failure refuses it. The optional native slot extends the existing
unreleased 0.3 Session-input live-work response in place. An old 0.3 development
reader of a new runner is not a released coexistence contract.

The inspected immutable CLI `cli-v0.2.16` and UI `ui-web-v0.2.17` tags at
`b8d1c449c46ab4dfa8637db36b66f643d149e66d` retain the strict V1 request;
artifact publication provenance was not independently checked for this port.
The moving 0.2 source intent includes PR607 refinements through `5763a9844b`.
The new operation adds no persisted data or downgrade reader. Remove the
missing-method adapter when supported original-operation-only daemons are no
longer a reachable app target.

## MCP Test ingress (0.3 development)

Current MCP Test Actions and UI requests address a saved server with `t: 'byId'`.
The daemon's V1 RPC reader separately retains `t: 'draft'` for the released
`ui-web-v0.2.17-preview.19` client at
`b8d1c449c46ab4dfa8637db36b66f643d149e66d`: its `McpServerTestPanel`
sends the unsaved server and optional binding. The ingress adapter folds the
binding's configuration overrides into the draft before passing it through the
canonical reach resolver and daemon test pipeline. It adds no catalog write or
second test pipeline. Remove this ingress when support for those released 0.2
clients testing against an upgraded daemon ends. The moving predecessor at
`f18aba940c5c56e5b24454e176c836c171098a2d` still produces that request.

Test explicitly selects its one requested server through the canonical Session
selection resolver, including an Off or ruleless server, without changing its
reach rules. A successful saved-server Test records tool annotations in the
existing catalog snapshot. Read-only Session tool projection still denies
unclassified tools; checking an `allow_read_only` server first supplies the read
annotations needed to expose its read tools after restart with resume.

## Artifact query hints (0.3 development)

The existing `artifact.list` Action accepts optional `kinds` and
`approvalStates` selectors and admits explicitly selected approval headers.
Its input remains closed and uses the canonical approval-state schema; its
strict header output is unchanged. This is a matching-development-client/host
extension, with no new endpoint, content envelope or older-Home adapter.
Unfiltered document lists retain browser membership, and specialized approval
body and mutation admission is unchanged.

Artifact kind filtering is an additive HTTP and persistence extension.
Current readers send the optional coarse `kind` query, exact `kinds` set, or
`browserListed=true`. These wire selectors and `unclassified` are mutually
exclusive. Browser selection is the complement of the canonical Artifact kind
policy's non-listed types, not a whitelist: unknown and classified null-kind
ordinary documents remain candidates. It uses the same typed coverage envelope
as exact-kind reads, with no older-Home fallback in this one-way 0.3 contract.
The daemon negotiates new exact-hint writes through the canonical
`artifacts.queryHints` server feature. Missing or malformed support resolves to
typed `unsupported`; ordinary content writes omit the optional new hint rather
than sending a tagged value to a retained coarse-only schema. This operation
negotiation does not establish general mixed-component compatibility.

The one-way 0.3 upgrade does not support a 0.3 client against a 0.2 Home.
The query-hint operation degrades safely as described above; it is not a general
legacy-server adapter. Current readers still require authenticated owner, access
and Account-mode projections. The data compatibility obligation includes retained
0.2-created data opened through the current Home.

Writes without kind remain accepted. Predecessor rows have null kind; earlier
development rows can have only a coarse kind. An opaque header edit without a
hint invalidates the previous classification; a body-only write retains it.
Protocol's single extraction keeps the existing coarse family and normally the exact
private `header.kind`, without extracting content, names or titles. Managed-Delete
approval headers additionally derive a domain-separated subject key from the admitted
Home and managed-Machine ids. Its indexed hint combines the approval kind with that
key so accepted Delete retirement selects only the exact target; the private body and
revision-fenced approval transition remain authoritative. Its stored
form is `v1:<coarse>:<exact-or-empty>` in the existing nullable string column and
Account/kind index. Read projections still expose coarse `kind`; `kindHint`
presence distinguishes a canonical exact classification from a legacy row.
The existing MySQL column's 191-codepoint boundary limits optional metadata,
not the supported private header type string. Shared extraction omits an
unrepresentable hint; valid private content is neither rejected nor truncated,
and the row remains unclassified. Explicit malformed wire hints still fail
validation. This encoding needs no additional schema migration.

The shared `listArtifactHeadersV1` owner requests the indexed selector and
propagates server-derived coverage: complete with count0, or partial with the
unclassified count and reason `unclassified_legacy_rows`. Neither UI inventory
nor selective reads write metadata. The previous automatic read-triggered repair
was withdrawn after a live write-burst regression. The replacement is one
explicitly paged native daemon Account bootstrap pass, labeling every openable
owner legacy header across all type families. Its `ownerAccountId` selector
intersects authorization; ordinary unclassified discovery also includes
authorized shared rows. The derived count uses the same requested scope,
including for an empty exact-kind set. Labels use the observed header CAS
at the existing metadata-only batch owner. Unopenable/refused rows remain
unclassified and keep coverage partial. No completion marker is stored. While
partial, the same reader may resolve legacy headers through the existing
coarse/unclassified path; that branch stops executing once derived coverage is
complete. Bodies remain selected-id only. New Artifact writers set hints at create.
Current 0.3 development approval queries also carry optional `approvalStates`
and `approvalSessionIds`, backed by nullable state/Session relationship columns
and additive provider migrations. These selectors compose with kind selection;
non-approval kinds are unaffected by the state selector. Approval headers from
0.2 remain readable without either hint. Known-kind rows lacking state join
the existing unclassified header pass, and the native daemon bootstrap writes
the extracted hints through the same metadata-only header-version CAS. An opaque
header change without hints clears them; a body-only change preserves them.
Settled private receipts retain their existing format and exact-id readers.
No read-triggered backfill, cleanup policy or replacement receipt store is added.
State-filtered absence does not certify Artifact deletion. The UI inventory
owner refreshes only formerly matching pending identities by exact header batch
before absence reconciliation; exact not-found retains normal deletion handling.
This prevents an open-queue refresh from discarding concurrent settled receipt
discovery. It does not fetch settled bodies or add a metadata writer.
The scoped predecessor recheck at `01107c0e7a6b2d4b521573c6d69b53070187e76a`
found no staged or unstaged approval/schema changes. Its UI writes the same
V1 approval kind, status and Session binding inside the private header, without
the new server columns. The current Home accepts that retained data; a 0.3 client
against a 0.2 Home remains outside the supported direction above. PostgreSQL
runtime validation and current generated-client publication remain separate
integration checks, not claims established by this source description.
Adapters keep classification progress in `kindCoverage`, distinct from existing
read/decryption `coverage`. A fully resolved legacy answer is readable-complete
even while its server index remains partial; genuinely unavailable sources are
still incomplete and retain their existing refusal behavior.
The browser stream already includes legacy and ambiguous indexed candidates,
so it does not run a second unclassified discovery pass. Opened private headers
still apply the same kind policy, including after selected body reads. An
annotated approval subject hint can also be an unknown ordinary kind string;
it cannot be prefix-excluded without losing the latter. Those candidates may
therefore still be read and privately filtered. MySQL candidate paging compares
stored hints bytewise so its retained case/accent/space-insensitive collation
cannot discard supported unknown kinds. Current grant and content admission
remain authoritative after candidate selection.
Exact-kind HTTP responses in this undeployed, one-way 0.3 contract require the
typed witness; the old Boolean alone cannot certify absence. The predecessor's
unfiltered array response is unchanged, not an exact-kind compatibility shape.
An exhausted scoped structural read may render retained locked rows and reconcile
absent baseline members within its kinds without claiming readable completeness;
unavailable/non-exhausted observations remain additive. Concurrent local changes
retain the same captured-map admission and reconciliation fences as full reads.
Equal labels are no-ops, and labels
change neither private bytes, header/body content versions, nor Artifact recency
and row sequence; discovery AccountChanges remain independent. Needed labels
share the existing CAS owner through the ordered metadata batch transport, not
per-id HTTP bursts. Ordinary coarse-only inventory does not demand exact hint
refinement. Private header
validation, Account-mode, current access and custody remain authoritative.

The original nullable kind column/index migration is still required for a Home
that lacks that earlier extension. Environment owners deploy migrations and
generate shared Prisma clients; this exact-kind extension adds neither another
column/index nor an operator backfill. The current server contract must load
before changed tagged writers/exact readers are used, followed by matching
client reloads. Retained 0.2 rows are labeled by their owning daemon through the
current Home, not UI-reader repair or an operator full scan. A refusal settles
to a typed result for the daemon run; the next attempt is the next bootstrap,
never the next reader fetch or a retry timer.

## Map the seam

For the changed concept, identify:

- the canonical domain owner;
- every producer, consumer, reader, writer, serializer, parser, and persisted artifact;
- the old/new component versions that can actually meet during rollout or rollback;
- the wire, semantic, persistence, and operational expectations at that seam;
- any existing split-brain, duplicate decision path, fallback, or compatibility adapter in the touched corridor.

An existing same-concept split-brain in the touched corridor must be consolidated at the canonical owner. A compatibility adapter may translate released or predecessor shapes, but it must not independently decide domain behavior.

## Direction and rollout

- New readers accept supported old shapes; new writes use the canonical current shape.
- Old readers need to accept new writes only when coexistence, independent component rollout, or rollback makes that direction reachable.
- New clients talking to old servers must capability-negotiate or degrade safely instead of assuming the new contract.
- Old clients talking to new servers retain released behavior for ordinary compatible changes and for every operation the new server can still execute safely. A major incompatible server change may require a newer client for the affected operation, but that support boundary is an explicit developer/product decision—not an agent-selected default.
- Persisted-state changes consider both old-writer → new-reader and, when rollback/coexistence is supported, new-writer → old-reader.
- Prefer operation-scoped graceful degradation over connection-wide rejection: admit the old client, keep unaffected reads and writes available, and return a typed upgrade requirement only when the requested operation cannot be performed safely. Reject the whole connection only when no authenticated operation can be made safe. `agent-transition.md` is the current worked example: an old daemon answers `session.agentTransition` with `RPC_METHOD_NOT_AVAILABLE`, the client maps that one code to a no-effect operation-scoped rejection, every other transport failure maps to an indeterminate outcome rather than a false "nothing happened", and Machine presence — not the error — decides whether the reader is told to update the CLI or that the machine is offline.
- For an incompatible transition, prefer prepare/expand → activate/migrate → contract when mixed-version coexistence or rollback is an approved requirement. Do not assume that old clients must read new writes merely because the server is self-hosted.

Before adding dual writers, parallel persisted formats, rollout modes, operator flags, socket-drain protocols, or a mandatory client floor, compare their lifetime cost with the actual user behavior required. If preserving old-client/new-server behavior for a major change would require substantial machinery, stop and obtain an explicit developer/product decision among: operation-scoped degradation, a documented client update requirement, or the heavier compatibility transition. An agent must not silently choose either forced upgrades or heavy compatibility machinery. This exception is for genuinely incompatible, high-cost transitions; routine server changes must remain compatible and must not manufacture client-update requirements.

### Autonomous exchange Turn-begin witness (0.3 development)

The new optional `startingInputId` on a Session `begin` mutation identifies the
host-correlated accepted input that caused that exact native Turn start. It is
sent only when the current Home advertises `sessions.autonomousExchange` as
enabled; ordinary human Turn mutations keep their previous wire shape. An
older Home's strict Turn-mutation reader rejects unknown fields, so a current
CLI must hold a countable autonomous effect before provider dispatch when the
bit is missing or malformed, rather than omit the witness and run uncounted.
The current Home accepts older clients' witness-free begins without inferring
an input cause or counting them. The moving `../0.2` predecessor inspected at
`40f515ff4bfe55b839e2dc585292f960164ee1e9` has a strict `begin` schema
without this field; the relevant predecessor paths were clean at inspection.

### Question-wait primary turns (0.3 development)

An authored wait-mode question ends its exact primary Turn as `waiting`, not
completed or cancelled. This refines the existing, unshipped cumulative
stored-content V4 declaration; it adds no version, header or minimum client
floor. Current Homes already advertise V4 as their current supported wire
version while retaining the existing V2 minimum for incumbent operations.
Before publishing a wait-mode question or ending its native Turn, the question
owner requires that existing advertised wire version to be V4 or newer. An
older or unknown Home returns `question_turn_yield_unavailable`; continue-mode
and ordinary native questions keep their existing paths. This is operation
wire admission, not a new feature flag or connection-wide update requirement.

The CLI reader at `cli-v0.2.16` and `cli-v0.2.16-preview.1` (both
`b8d1c449c46ab4dfa8637db36b66f643d149e66d`) strictly parses the four-state
primary-Turn union. For peers below V4, the server's canonical compatibility
projection withholds waiting history rows and projects the current status as
unknown, without sending a ready or cancelled result. External-message cursor
settlement still treats waiting as unresolved input; withholding an unknown
history row cannot advance that cursor past it. V4 peers retain the typed state.
Older UI reconciliation can retain historical readiness, so this projection
preserves readable transport rather than promising V4 waiting UX on older apps.

The moving `../0.2` predecessor was rechecked at
`f16a3759a3944bc4be4bbb7e14a3e6a01397f7b5`; its relevant schema and HTTP reader
paths were clean. The [runtime owner](runtime-core.md) owns waiting semantics;
this adapter only translates reader shapes.

Development Follow question originals optionally carry the request owner's closed
`currentHandler` Session value on their exact request reference. Existing unbound
references retain their original keys; an actionable handler assignment has a
distinct accepted-input key so an earlier generic notice cannot consume its offer.
This refines unshipped 0.3 Follow custody without a new store, migration or wire
epoch. Older strict development readers refuse the new field rather than discard
it, so the server and consuming CLI must load the extension together. The question
answer Action and its present-person/manager admission are unchanged.

### Retained skill bundles (0.3 development)

The inspected 0.2 predecessor at `82f2997875dd45b0af68bbee2763d095aaa87505`
writes skill Markdown verbatim and projects registry names/descriptions with a
first-colon line reader. Its stored inputs therefore include unquoted description
colons and other non-YAML scalars, as well as safe relative POSIX paths such as
`refs/CON.txt`. Current stored reads retain these inputs at the canonical bundle
owner: YAML decoding takes precedence, with the exact predecessor line projection
used only on YAML syntax failure. New imports and writes stay canonical and
portable; Windows materialization refuses only a Windows-invalid item. This is
forward stored-data admission, not a legacy writer or a parallel catalog. The
[skill content contract](plugin-platform.md) owns the detailed behavior; real
predecessor writer captures live in `packages/protocol/fixtures/`.

New repository and multi-skill upload imports retain an optional `sourceFolderName`
in the encrypted Artifact header's `skillLock`. The current content reader carries
that single directory segment to the Session materializer; edits preserve it.
Headers and Session manifests without it keep declared-name delivery, with no
migration. This is an unreleased 0.3 extension of the closed lock and daemon
materialization request, not a new plaintext Artifact field. The current SDK
delivery also requires each item's absolute `directory`, returned by the
materializer and forwarded by the runner. Plugins use it for path reads, copies
and identity matching; deriving the folder from the declared name loses accepted
imports and renames. The delivery envelope, each item and each native-disable
record remain closed; no optional unknown field acquires path authority. This
is an in-place correction of the unpublished 0.3 delivery contract, independent
of package SemVer, with no released epoch transition or old-development fallback.
The one-way upgrade does not support old 0.3 development daemons or Agent adapters
reading the new shape; reload the runner, daemon and plugin adapters together
before replaying it. Retained headers and Session manifests do not change.

Well-known skill indexes and pack links add a `wellKnown` provenance arm in
unreleased 0.3: `indexUrl`, item `name`, the materialized bundle `digest`, and an
optional `publishedDigest` recorded only after publisher-artifact verification.
Preview pins travel through the existing link `source.refs` carrier alongside
Git tree refs; Add re-verifies selected content before writing any library items.
Existing Git and upload locks stay readable without a migration. This closed
union extension follows the one-way 0.3 development cut, with no old-development
reader adapter. The inspected 0.2 predecessor at
`cc0dbf9ab862f81f8aa94fc3fc1186fb53245963` has neither the current registry ref nor
skill provenance schema paths, so this arm does not replace a predecessor format.

### Account trigger deletion receipts (0.3 development)

The current Automation deletion transaction returns the removed definition's
`templateVersion` as `removedRevision` in its successful V3 response. Whole-set
`workflow.trigger.remove` forwards that evidence in its existing closed result;
child-trigger removal still returns the updated set. Both receipt readers
accept omission from an older Home without inventing a revision. These are
additive fields in development contracts, not new mutation inputs or a new
wire epoch. The prospective 0.2 UI deletion client consumes only success from
V2; this does not restore V2 routes or promise mixed V2/V3 operation.

The existing row-inventory ordering helper retains this evidence for the
focused Account so delayed acknowledged writes at or below the removed
revision cannot restore a deleted trigger set. Read revalidation remains
authoritative: equal revisions may enrich health, and an absent identity may
reappear as a genuinely recreated row. Receipt history is display ordering,
not read or mutation authority, and retires with the Account's trigger state.
Without removed-revision evidence, clients keep revalidation and the existing
ordering limitation for previously unseen higher revisions.

### Home identity connection Team usage (0.3 development)

Home identity connections may include `teamsUsingIt`, an optional read-only list
of `{ teamId, name }` facts from explicit Team authentication-policy Home-method
references. Current projections share that usage reader with removal admission
and resolve it once for the connection set. An unavailable method or an archived
Team can still have a configured reference; inherited Home sign-in choices are
not explicit uses. This list grants no Team content or roster authority.

The Home connection V1 envelope and each Team identity remain closed. The
generated SDK DTOs project the optional field from that same Protocol schema;
no mutation input, persisted shape or wire epoch changes. Omission by an older
Home means unknown usage, while an empty list means no explicit references.
Readers continue accepting omission. This is an unreleased 0.3 projection, not
a promise that older clients can execute the new Home identity operations.

### Quota recovery details (0.3 development)

The moving 0.2 predecessor keeps optional `recoveryCreditDetails` outside its
strict Provider Account Usage base body. Plain V3 records carry the facts in
metadata after negotiating `connectedServices.quotaRecoveryCreditDetails`;
encrypted records carry an account-sealed supplemental facet. Its inspected
released readers at `22ac8263cfdbcdb845441b9044ff18199cf7652e` retain the base
usage while ignoring optional sealed-envelope facts.

Current 0.3 V4 usage snapshots retain the rich optional details in their existing
snapshot, material identity and history owners. The approved all-component,
one-way upgrade does not need another V3 negotiation flag or a competing plain
writer. The existing legacy storage reader reattaches actual predecessor metadata
facets. Encrypted current/history reads and qualified quota projections use the
canonical sealing owner for supplemental facts. Their omission remains valid.
Credit inventory status and count authorize actions; saved quantities and display
reasons never establish debit permission independently.

The SDK recovery facet retains canonical credit statuses and accepts the existing
plugin `unavailable` status only at the host adapter, where it becomes `unknown`.
Known pre-debit failures can explicitly report a certain no-effect outcome;
older plugins that omit this information retain the existing conservative unknown
receipt behavior. Legacy reset RPC aliases delegate to the qualified established
credential owner rather than authorizing scalar V2/V3 transport. This is forward
data and ingress compatibility, not a restored second credential or debit path.

### Antigravity account data (0.3 development)

Antigravity's 0.2 service id, `antigravity`, is a persisted-data input to the
qualified service `happier.agent.antigravity` / `antigravity-account`. Its bundled
compatibility declaration admits stored OAuth credentials, profile/group defaults
and runtime-issue references into the existing qualified owners. Current writes
use qualified identity. OAuth project metadata survives as `projectId` in the
qualified credential and becomes the native ACP token's `project_id` at
materialization.

This is storage ingress, not a new scalar public-service alias. The existing
closed legacy peer service set remains unchanged, and Antigravity advertises no
legacy peer operations. Reverse profile/revision projections must omit this
storage-only mapping rather than publish a scalar Antigravity row. Internal
physical database identity columns do not grant an old peer operation.

The additional 0.2 defaults carrier is read by the existing qualified preference
migration and retired on edits/deletion through that owner. It is not copied into
a second 0.3 default chooser. Fetched settings that reject the canonical schema
refuse qualified launch defaulting instead of selecting cached or native
authentication; network failures retain the existing cache policy. Runtime
issues retain generic failure, retry and reset information while their stored
service references are normalized once.

The approved all-component, one-way 0.3 upgrade does not require 0.2 outward
reader negotiation, but does require forward readability of actual 0.2 data.
Generated compatibility publication, real stored-row/revision checks and current
package validation remain required integration gates. Retire the storage adapter
when those persisted 0.2 inputs leave the supported data window, not merely when
old processes disappear. This integration is unreleased and still under validation.

### Retained quiet input (0.3 development)

Pending Input revision 5 adds the closed `retainedContext` materialization proof
for exact informational originals still retained by the current publisher's
local queue. The parent proof-bearing request is also closed. A CLI sends this
operand only after observing revision 5 support; an older or unknown Home leaves
the operation unavailable instead of silently ignoring the proof. Ordinary
requests without retained context retain the existing revision 2–4 ingress.
The server verifies the same-Session claimed rows, informational admission and
current publisher before excluding them from rejoin/claim selection. It does not
resolve those rows or infer native acceptance. The materialization proof adds no
persisted format.

File review notes extend the existing unreleased 0.3 admission operand and
receipt with optional `nextTurnNote: 'file_review_note.v1'`. Authenticated Pending
admission stamps this content-free intent; the action and paths remain inside
the ordinary Session content envelope. The runtime requires both this receipt
and a valid note payload before retaining the input for the next actual turn.
The retained-context owner recognizes that same receipt, so an informational
note cannot block the following ordinary input or acquire its permission
identity. Existing 0.2-created inputs without the marker keep their ordinary
semantics. This evolves the undeployed 0.3 contract in place. Before publishing
a note, CLI and UI senders require the existing advertised Pending revision 5;
older or missing support returns a typed delivery failure without a Pending POST.
The predecessor's open HTTP body strips unknown operands, so merely sending the
marker would not establish quiet delivery. The UI's existing wire-version owner
retains revision 5 through initial admission and replay rather than projecting
the note onto an older wire. No new capability bit is introduced.

The inspected moving 0.2 predecessor at
`89868c98f0cddc0a42fc3a97b2b3e311363756ed` advertises revision 2 and ignores
unknown fields at its materialization ingress; its relevant paths were clean.
That reader cannot safely consume this proof, hence the operation-scoped
capability requirement. This is a 0.3 development contract, not a released
mixed-version or loaded-runtime certification.

### Pending reset starts (0.3 development)

Runtime failure diagnostics keep the predecessor's closed failure POST fields
and activation authorization fields unchanged. The optional, strictly decoded
`failureDetails` query carries only closed diagnostic codes; a predecessor
without that query reader ignores it and still performs the exact failure CAS.
Current Session reads expose those facts as the separate additive
`pendingActivationFailureDetails` projection. The existing failure column accepts
the predecessor's scalar code and the current flattened diagnostic JSON. These
diagnostics neither alter activation authority nor claim delivery, and do not
introduce another writer or retry path.

The diagnostic JSON is forward-only development storage: a 0.2 server reader
recognizes only the scalar failure code and cannot project these new writes.
The current reader preserves 0.2-created scalar failure state. This does not
promise predecessor-server coexistence or downgrade; old-client reads of the
unchanged authorization envelope are a separate direction.

Managed accepted-input Start failures use that same failure-code field with the
closed development vocabulary `managed_start_refused`, `managed_start_denied`,
`managed_start_expired`, and `managed_start_failed`. The installed controller
reports through the existing signed activation-failure route even when Ask
settles before native admission. The pending owner compares the original input
and `requestedAt`, retains its queued content, and publishes the failed state;
an explicit retry rearms the same input with a newer timestamp. Native or approval
error prose is not persisted in this field. Unknown codes are omitted by stored
readers, and the current reader still accepts predecessor `runtime_start_failed`.
This extends unreleased managed-wake contracts; it adds no migration, reverse
0.2 writer, or promise that a predecessor understands managed wake.

The existing Pending Input numeric protocol revision 4 advertises the new
identity-bound `reset_start` arm, installed Machine release, and source-filtered
waiting read. That read can also return optional `unboundEntries`: content-free
identities of owned, admitted, unconsumed Session Pending input. Its omission by
an older reader is not authority to invent an Account-wide queue or disclose
prompt content. Earlier positive revisions retain their own main/target-aware input
behavior. A new daemon must omit its reset operation leaf unless the cached Home
supports revision 4 and the concrete reset owner is mounted: Machine capability
publication is a strict complete projection, not a place to send unknown leaves.

The inspected 0.2 predecessor uses four strict Pending action kinds. Its UI
treats an unknown non-null action as a blocked unsupported row, never as default
enqueue; other rows remain readable. The server holds reset rows before claim,
refuses reset admission to unsupported Machines, and releases to the already
supported enqueue shape. This adds no reverse writer or rollback representation.

The reset set Action retains the existing-row request and additionally accepts a
strict `initialInput` in the canonical plain or Session-encrypted content envelope.
The initial-input effect uses the same Pending admission owner and creates the
row held from its first write; it never enqueues ordinary input before binding.
The stored message projection preserves the existing `modelSelectionV1` carrier,
including malformed presence. Its canonical model-selection reader validates the
intent; projection cannot erase it and cause a legacy-model fallback.
Fresh opened B and its exact accepted witness qualify the current window before
the effect. The server also checks installed-target capability and accepted
history identity before creating custody. Unknown or stale windows do not fall
back to immediate delivery. The development signed reset root carries a strict
input-bound projection of Session/local input, qualified source, B record, meter
and accepted witness. It authorizes only Account-mode currentness and exact
source/record/witness preparation reads, then the matching Pending effect.
Plain issuance derives these facts from the input; encrypted issuance signs the
visible projection, which the canonical opener compares with the decrypted input.
That projection uses fixed-size canonical domain-separated Session/source/record/
witness digests and a full mutation-purpose digest, retaining the decoded Action
input budget without copying large accepted identities into signed HTTP headers.
Missing or mismatched facts fail closed. This changes only the unreleased 0.3
signed contract and introduces no reverse 0.2 writer or generic Account authority.

### Project and checkout identity (0.3 development)

Current development checkout resolution has one Protocol owner:
`workspaces/workspaceRefResolutionV1`. Exact selection qualifies a WorkspaceRef
id with its Home, or supplies Home, Machine and normalized root; a full address
also verifies the checkout id. An unqualified id is accepted only when the whole
candidate set is unique. Duplicate candidates remain ambiguous, rather than being
collapsed or narrowed to the active Home. UI Home aliases and target-platform
path helpers adapt to that same owner.

Accepted refs retain a stable Project anchor, `projectKey` (the ref id for an
unenriched predecessor). Adding Source or hosting facts cannot change that anchor
or merge independently accepted Projects. A new checkout may join its host-proven
native parent or dedicated copy source, or a unique, proven same-Home Source or
repository association. Personal Project widget
Artifacts use the anchor; filesystem access and plugin grants use the exact
checkout. Home-qualified local checkout preferences read bare-id predecessor
values only when canonical resolution proves their unique Home.

Canonical writes are strict. Stored ref readers drop unknown fields recursively
while validating known identity and enrichment fields. These are development
source contracts, not a released row-storage rollout or loaded-runtime QA claim;
Project row persistence has its own Account/Home owner.

Session Project association uses `resolveSessionProjectKeyV1` at that same
Protocol owner. The optional nullable `Session.projectKey` row field carries the
accepted Home-local anchor; readers qualify it with the row's Home and can group
or filter before private Project refs or labels load. Missing and null both mean
not yet published. Older rows remain readable through exact Machine/root
association, using a published sandbox's host `machinePath`. An explicit
Home-qualified `workspaceId` selects its accepted checkout independently of the
Session's subdirectory or execution Machine. Legacy `projectId` only checks a
resolved ref; it cannot establish association alone. Incomplete or ambiguous ref
coverage remains unavailable rather than becoming a guessed Project.

The accepted-workspace registration publishes the key through the existing
owner metadata tuple patch. Omission preserves the stored key; shared-editor
and migration patches cannot set it. The additive nullable column has no SQL
backfill: the server cannot derive private Project association. Pre-upgrade
Sessions may remain keyless. The visible list retains their exact Machine/folder
group and demands the open Home's existing Projects read while those rows are
visible. Foreign Homes retain the fallback until their accepted row key arrives.
This is a development-source contract; retained database deployment and loaded
runtime validation remain separate evidence.

Project titles remain private Account content, separate from that row anchor.
`projects.organization.update` edits or resets only the existing Project
organization row's `label`, using its expected revision and preserving pin,
visibility and context. A reset removes the organization override; it does not
rename an accepted checkout. `projects.workspace.update` remains the exact
checkout metadata operation, not a competing Project-title writer.

Worker-copy classification uses optional creation provenance on the same Sync
relationship: `worker_clean_copy` binds distinct source and target WorkspaceRefs
to that relationship's endpoints. Retained provenance cannot be added, removed,
or redirected in place. Stored relationships without it, or with an unknown
provenance kind, remain readable ordinary Sync rows and do not qualify for worker
admission or worker-copy retirement. Canonical worker retirement refuses them
before graph mutation; ordinary Sync termination remains separate and unchanged.
The existing `workspace.sync.relationship.create` Action accepts optional
`purpose:'worker_clean_copy'`, with the user's required target Machine and path.
Its relationship owner stamps endpoint provenance before bootstrap; a fresh ref
inherits its proven source anchor without requiring a Project object. A folder
already anchored to a different Project is refused before bootstrap. The owner
never upgrades an ordinary relationship's provenance. Missing copies return typed
`worker_copy_missing` no-acceptance facts before operation admission; UI recovery
opens the existing Sync creator with the Machine selected and path left for the
user. Dequeue flushes only the admitted existing route and retains its provenance.
These are 0.3 development source contracts, not released or loaded-runtime QA
claims. An ordinary link or committed receipt does not supply copy provenance.

New 0.3 worker-copy relationships store `committedAtMs: null` while staged. The
existing relationship owner replaces it with the commit timestamp only after
the target commit settles, in the same publication that enables the link.
Pause/resume preserves that fact. A failed creation retains the explicit null;
an absent field on an older row conservatively retains possible native custody.
The Project Service binding observer excludes only worker-copy definitions with
the explicit null marker. Committed and legacy paused links still require a
complete native binding observation; an unreadable endpoint returns unavailable
with its Machine identity. This recorded creation fact does not replace the
target-local materialization receipt or authorize removal of target files.
The stored relationship and placement result remain closed V1 objects; the
tolerant stored reader accepts an absent legacy field and validates present
values. These undeployed 0.3 refinements introduce no supported old-reader/new-writer
or rollback direction.

Service placement observations in 0.3 development carry an optional bounded
`reasonCode` when native custody cannot be read. Machine-specific failures also
retain the Machine identity; Account/topology currentness and malformed binding
failures remain distinct from absence. The closed V1 reader accepts omission
from earlier development producers. This diagnostic grants no execution or
control authority and adds no persisted state or supported rollback direction.

### Widget and organization stored readers (0.3 development)

WorkBoard widget placement refs retain their original server label, which can
be client-local, as part of the persisted placement key. The admitted Board Artifact fixes the
Home for Actions: the widget port projects its placements into the caller's
captured routing scope and translates edits back to their stored refs, preserving
item order and canvas positions. Account and Artifact access checks still apply;
another local server label cannot bypass strict host-target admission. Ambiguous
retained instance ids refuse edits instead of selecting a placement arbitrarily.
The Board UI supplies its current binding to executable widget bodies; a stored
placement alone cannot activate reads. This development correction changes no
wire schema or stored key and does not establish loaded-runtime certification.

Account Settings' retained legacy JSON carriers use the same stored-read owner.
Valid predecessor profiles and SavedSecrets remain readable above current
collection or byte budgets; new-write admission applies those budgets and
returns a typed refusal. Present profile/secret data must not recover to an
empty default merely because it exceeds a new-write budget. Automatic Voice
machine selection and recovery now remember their target in the device's
Account/Home-scoped runtime memory, not in Account Settings. The never-shipped
`executionMachine.autoMachineId` field is dropped by the stored Voice reader;
an explicit fixed machine choice remains an Account preference.

### Settings alias contraction (0.3 development)

The canonical Account Settings catalog no longer admits the historical preference
aliases `viewInline`, `expandTodos`, `usePickerSearch`, `compactSessionView`,
`compactSessionViewMinimal`, `reviewPromptAnswered`, `reviewPromptLikedApp`,
`lastUsedPermissionMode` or `lastUsedModelMode`. Its retired-root classifier also
excludes them from effective reads and history restore. Raw captured documents
remain separate from that projection: ordinary preference mutations do not erase
untransferred sources.

The prospective producer inspected for these aliases is `../0.2` at
`e087d15a2f0cce1de6de8ef0895d9c8bcc035056`, with a clean relevant
`accountLegacySettingDefinitions.ts` UI registry (the separate dirty Protocol
change adds a Connected default). This is predecessor-worktree evidence, not
a claim that this exact tree was released. The UI compatibility seam
reads its compact booleans into `sessionListDensity`, `usePickerSearch` into the
two current picker preferences, and the permission alias into target-keyed
permission intent. Explicit current preferences take precedence. These readers
do not write old aliases back; they remain required while supported predecessor
documents can enter the Settings opener. Dead presentation, feedback and model
state has no replacement policy. The sensitive inference source has a separate
[SavedSecret transfer contract](encryption.md) and is not globally retired.

Viewer selections remain an Account preference, not an entity transfer. The
catalog uses the viewer owner's existing 64-KiB encoded-value budget and 128-entry
schema; the enclosing Settings document retains its 512-KiB budget. Selectors use
the SDK's canonical spelling. An unavailable plugin identity remains stored;
temporary resolution fallback does not authorize rewriting that intent.

Profile definitions/bindings, prompt stacks, folders, invocations, external links,
registry sources, context selections, role overrides and historical guidance
entries are read-only raw sources, not writable Settings definitions. The
Protocol Settings owner retains their existing domain schemas only for
provenance admission; current readers use Profile rows, prompt-library rows or
Role Artifacts. Captured raw sources and history remain until their respective
destination/control admission proves cleanup safe. The Profile and prompt
source owners perform that conditional removal, not the effective Settings
parser. Builtin Profile enablement, run-instruction enablement and the genuine
Agent spawn/allow-list/delegation/approval policies are still current Settings.
Remote-host, notification and Connected metadata sources follow their existing
private-row importers under the same destination-first rule. Their Settings
exports do not remain live fallbacks. These source readers are removable only
when the supported predecessor/raw-history census no longer needs them.

In 0.3 development, skill reach rules use the same prompt-library entity-row
authority under `skill-rules`. That row has no retained 0.2 Settings root: its
first write still requires captured Settings currentness, but source cleanup,
history normalization and encryption conversion skip its null root. Presence
and versioned deletion prevent initialization from restoring removed rules.
The row reader drops additive stored fields and rejects duplicate rules for
the same skill, place and Agent scope; current writes use the closed record.

The development Prompt Library list reads only physical keys recognized by
its canonical key schema, before decoding their envelopes. Unfamiliar rows,
including opaque content and tombstones, stay stored and confer no prompt
authority; they do not make known context unreadable. Known rows still fail
closed on corrupt content, key disagreement or Account-mode mismatch. Direct
reads and mutations reject unknown keys. Account-mode conversion and its
post-state check retain a complete prefix census and refuse unknown rows;
display omission does not authorize a conversion that leaves them behind.

`skills.rules.set` resolves skill names or ids through the Account Artifact
library and applies the shared reach intent to the row revision it read. A bulk
change commits in one row CAS, returns each item's previous rules for Undo,
and returns `conflict` when that CAS loses. An unreadable row or incomplete
Artifact inventory is `catalog_unavailable`, never an empty rules value.
The shared rules Action spec supplies CLI `skills on/off/inherit` and declares
the same approval behavior as MCP rules: present-user UI changes apply directly;
Agent, CLI and MCP callers ask by default unless the existing policy waives it.
These are unreleased development contracts. The bundled `happier` skill has one
deterministic Everywhere rule in the initial `skill-rules` row; existing rows,
Off rules and removed places never reseed it.

Context-stack skill migration adds deterministic rules at the Account and
Project layers, Profile seeds and Session includes. It retains legacy coding
entries as inert stored data so retained `disabledInheritedEntryIds` can still
map to skills at start/attach and become Session excludes. Shared Project
attachments yield per-viewer Account rules and remain stored. Migration
at the Profile and Session owners consumes enabled legacy entries once: the
existing row's `skillMigrationV1: true` field is written with its seed or include
in the same CAS. Removing that positive selection without Off does not restore
it on reload. The kept marked entries still resolve inherited exclusions;
predecessor readers ignore the additional field.
Profile positive migration classifies only enabled, unconsumed entries; a disabled
unavailable Artifact does not withdraw the catalog. Voice dropping and retained
Session inherited exclusions still classify their disabled references.
Account and Project migration record the scoped deterministic legacy entry ids
in `skill-rules.value.consumedLegacyEntryIds` on the viewer's existing destination
row, in the same CAS as the projected rules. Rule edits and deletion preserve
these ids, and later migration skips them before Artifact classification. Shared
Sources are never written; each viewer consumes their attachments independently.
The canonical strict Prompt Library row schema accepts this optional field;
stored readers continue to ignore unknown fields. This is an unreleased 0.3
contract, so a QA server must reload that schema before testing new writes.
Classification preserves proven inherited excludes when an unrelated own
Session bundle is unavailable. Unresolved required inherited custody withholds
skill delivery through the existing capability notice, not Session startup.
Private Run preparation reads only its captured Account custody and Artifact
transport, including with ordinary Account credentials. Qualified references
use the existing Home identity owner; foreign Home credentials are not borrowed.
Skill-schema bundles are never pasted; retained generic bundles keep their
existing text.
Voice skill entries are dropped without a rule or include. The migration uses
the existing catalog, Profile, Project and Session owners and adds no mapping
store. Existing library skills without an applicable rule or Session selection
stay Off. These source contracts still require the composed program live check.

Launch Profile publication likewise uses only the admitted Profile-row port.
It replaces the captured row's definition under its existing revision check;
enablement, prompt attachments and private binding masks stay on that row. The
published Artifact contains no private bindings. The unused raw-Settings
publication writer and its dependency union have been removed rather than kept
as a second mutation authority.

Artifact-backed Profile Save uses that same private row writer for binding
changes, including explicit None masks. A binding-only edit does not rewrite
the Artifact or pin inherited defaults; unchanged editor timestamps are not a
body edit. A combined edit first acknowledges the captured private row and
Artifact revision, then updates the authored Artifact body while retaining its
published default bindings. These are separate acknowledgements: a later body
failure leaves the acknowledged private row intact and returns failure, not
complete success. The editor retains its draft; reload the current row before
reapplying it rather than retrying the old row revision. This development-only
owner correction introduces no new wire or persisted format.

Launch Profile rows also carry private `skillSeeds`, defaulting to an empty list
when older stored rows omit the field. `launch_profiles.save` edits those seeds;
the generated save command accepts repeated `--skill` names, resolved through
the canonical Account skill Artifact inventory. New Session admission adds the
seeds to `capabilitySelection.skills.forceIncludeSkillIds`, retaining explicit
Session exclusions. Resume consumes the stored Session selection without
reapplying the Profile seeds. Seeds stay on the private row and do not become
reach rules or published Profile Artifact content. These are 0.3 development
source contracts; the Profile catalog adds seeds from classified enabled legacy
stack entries while retaining those entries for inherited exclusion identity.
New Profile Save stacks, including first Artifact membership attachments, use
the current prompt-stack authoring placement contract. Existing rows and
captured duplication retain their stored placements through the row owner.

### Tolerant stored-data readers

Collection filter records in 0.3 development are a narrowing-sensitive exception
to dropping unknown stored fields. The canonical filter owner registers its
stored-read projection with `json/storedReadSchema.ts`, so nested Follow rules,
SessionTargets, Boards and saved spaces retain unknown core conditions and
extension selections as opaque data. Known fields retain their validation.
An unknown or list-only condition evaluates unavailable in an unsupported
evaluator; a known miss still dominates. Effect dispatch requires a fresh match.
Strict current writes reject unknown fields and daemon-rule writes reject
list-only fields. Opaque stored conditions never become executable callbacks,
access authority or a successful filter. These are development source contracts;
no current-to-predecessor rollback writer is introduced.

Development Session creation provenance retains earlier immutable recipes through
the canonical recipe stored projection. A stored string directory becomes a path
intent, and the former nullable `mcpSelection` carrier becomes the current
`capabilitySelection` carrier, preserving explicit MCP choices and null. This also applies when
opening the recipe inside Account-owned Session metadata. Current writes still
require the current directory and capability fields; malformed or missing known
provenance remains invalid. The projection preserves creation retry meaning and
does not discard the birth record to make the enclosing metadata readable.

Session capability Actions in 0.3 development source keep the released
`mcpSelectionV1` and `mcpSelectionRestartRequiredV1` shapes. The generic metadata
codec also owns the skill selection and its applied baseline; its optional
`capabilitySelectionApplyV1` field is a refusal/status projection, not desired
policy or a durable work queue. A raw predecessor MCP selection patch reaches
the same settled-turn synchronizer. Attach retains pending baselines; a fresh
start acknowledges only the selections it actually prepared. The preview RPC
adds generic capability fields while retaining its old MCP response projection
for supported older clients. Current Actions validate the strict generic output,
so a reachable older producer lacking those fields is an invalid input/unsupported
producer response, not evidence that the Machine is offline. Native per-Session
Off writes an exact native skill name through the existing overlay selection
contract; it does not require an online scan to save the desired change.

Stored widget definitions, instances and placements, Session/WorkBoard and Home
layouts, Companion preferences, workspace tabs/canvas state, and legacy folder
settings read their known fields and drop unknown object fields recursively.
The Protocol-owned `json/storedReadSchema.ts` derives persistence projections
from the canonical schemas, preserving required identities, domain refinements
and opaque JSON values. UI-local persistence schemas use the same stripping
policy. Organization display envelopes use a stored projection only when opening
database content; HTTP snapshots and mutations remain strict.

The same policy applies to Account catalog values, device-local Settings and
pending deltas recovered after restart, stored Session drafts and delivery facts,
CLI custody/checkpoint/permission records, and plugin Collection values and
source-instance checkpoints. Custom preprocessors register their stored
projection at the schema owner so an internal strict reparse cannot undo the
read projection. Composable plugin schemas use Protocol's schema-derived
stored reader, exposed as `createProtocolStoredReadSchema` through the SDK's
`/protocol` facade, rather than a second validator. This facade is for persisted
reads only; operation inputs and writes use the original strict schema.
Opaque JSON remains opaque until
its semantic owner projects the recognized stored fields. Unknown fields do
not acquire routing, permission, credential, or mutation authority.

In 0.3 development, Provider Account Usage current records, retained history
pages and exact reset-witness reads use this persistence projection. History
and witness payloads then pass the canonical write validator's known-field,
record-identity and payload-mode invariants. New writes remain strict.

Authentication and typed interpretation are separate boundaries: authenticate
the original material covered by the format, independently of typed projection.
Package Asset integrity covers its complete logical body JSON; hosted UI
integrity covers the exact file set and file bytes, not header annotations.
Never authenticate a stripped projection instead. Likewise, a retained request
may expose projected known facts without changing the original replay body or
the digest/tag computed from the original intent. Newly authored requests and
proofs still pass their strict input validators.
Voice provider Settings owners separate retained `parseStoredConfig` from
strict edit `parseConfig`; readiness and runtime readers consume the former.
Known credential identities, slots, references, modes and consent still require
validation. Unrecognized provider/version carriers remain opaque recovery data,
not silently accepted current configuration.

Action/request inputs, runtime events and wire results keep their strict
validators. Writers emit the current canonical shape, including when editing
an opened record. This changes additive-field read tolerance, not the persisted
format, storage-mode authority, access policy or supported version frontier.
Stored Plain Machine content uses the same projection at `machineStoredContent`:
an extra envelope field is ignored on read and dropped on re-encoding, while
required content, encryption-mode agreement and strict encoded writes remain enforced.
The generic Artifact header remains an open metadata custodian; kind-owned
readers project its known fields. Artifact body and private-revision readers
drop extras separately while retaining body, Artifact/revision binding and
encryption-mode checks. Source validation is not loaded-runtime certification.

Saved Home profiles read their retained connection descriptor through
`StoredHomeConnectionDescriptorV1Schema`, dropping additive fields recursively
while retaining identity, origin, revision and endpoint validation. Incoming
descriptors and feature responses remain strict. When a signed-in Home moves,
address admission confirms the saved and selected addresses before forwarding
the incumbent credential, then reads its exact authenticated descriptor at the selected
address and commits through the existing credential/profile adoption transaction;
public discovery alone cannot replace a retained descriptor generation.

### Live-stream relay diagnostics (development)

`capabilities.machines.liveStream.serverRouted` is an optional read projection.
Current relay policy caps are optional positive integers: `{}` means the Home
has configured no explicit limits, while `caps: null` means relay policy is
unavailable. Malformed diagnostics normalize at the Protocol capability owner
to `caps: null` and `disabledReason: 'relay_caps_missing'`; they cannot invalidate
Home identity or unrelated feature gates. Relay operations still require their
canonical feature and grant admission, and invalid caps never become an
uncapped policy. Authorization and stream wire schemas remain strict about
their known fields.

The inspected `../0.2` predecessor at
`4651997217a36250e203643f2bd002dbf7a93321` has no live-stream capability producer
or reader. Omission retains the existing disabled default. The earlier 0.3
required-cap reader was development-only; update managed server and daemon
support together rather than inventing policy limits to satisfy stale output.

### SCM status snapshot transport (development)

The current machine `scm.status.snapshot` RPC omits neutral per-entry facts:
zero line counts, false area/binary flags, and null rename origins directly at
the machine producer, before its existing shared request/cache publication. The
canonical working-snapshot schema supplies their defaults for validated reads;
there is no separate transport schema or encoder. UI RPC admission checks the
response envelope through its existing admission owner, and the existing snapshot
mapper restores defaults in its normal entry pass without an additional per-entry
schema parse. A neutral statistics object may be empty. Nonzero counts, rename
paths, both status columns, binary facts,
and explicit statistics-completeness flags remain intact; no changed paths are
truncated. The domain and plugin SDK working snapshot remains fully populated.
File/commit diffs and worktree enrichment keep their existing separate RPCs.

Full status responses remain valid inputs to the same schema and UI mapper. This development
transport changes no persisted repository or Session data. The one-way 0.3
component upgrade does not support an older UI reading sparse responses from a
new daemon; update the producer and its consumers together.

### SCM live diff review-unit discovery (development)

The existing `scm.diff.file` read response adds optional `reviewUnits` only for
successful reads with explicit `area: 'both'`. Its outer object remains
additive-open/drop; each unit is closed and carries the canonical opaque key,
hunk/run indices and old/new line coordinates. Existing responses without this
projection remain valid. Older open response readers may drop it safely; no
input, wire epoch, persistence format or mutation authority changes.

The host Action executor derives these units from `buildReviewUnits`, also used
by live Discard. Agents copy selected keys into the existing comparison entry's
`changeKeys`; the mutation owner still revalidates exact live membership. Captured
`changeRefs` and comparison identities retain their separate semantics. Omitted
diff areas keep the backend default rather than being relabeled as combined.
The clean scoped predecessor at `dac1efd68dee668d15c0c84fa5cacd29c15fb176`
has the open response without review units. This is unreleased 0.3 read-projection
behavior, with no compatibility adapter or new client update floor.

### SCM reviewed marks selectors (development)

The canonical `scm.diffSummary.reviewed.mark` and `.unmark` Actions retain the
implicit V1 saved-result selector (`cwd`, `resultId`, `changeRefs`). Files-only
reviews also use a closed V2 selector (`v: 2`, `cwd`, `comparisonId`, `source`,
optional Session namespace, and `changeRefs`); they do not require a generated
or saved narration. V2 also accepts the explicit live selector `source` plus
`changeKeys` without a comparison id. That Action validates the keys against
the current working-tree diff, without capturing it. The selected
Home/Machine/root authority reads retained comparisons for occurrence selectors;
caller comparison bytes are not authority. Session and turn sources additionally
retain their Session admission. All selectors use the same content-keyed Record
V1 `{ v: 1, scopeId, reviewedChangeKeys }` and
`workspace:scm-reviewed:scope:<encoded scopeId>` key. There is no parallel store
or RPC. Native UI Keep writes the keys of displayed evidence through the same
Account-mode-admitted KV port, independently of Machine reachability.

Retained bare-turn capture and saved-result comparisons are qualified on read
from their stored Session/turn/receipt metadata by the capture source owner.
This is a projection, not a database or Account-KV backfill; comparison and
occurrence IDs remain unchanged. Ambiguous old bare-turn mark records are not
guessed into new scopes or deleted. PR reviewed scopes reuse the existing
comparison identity without endpoint or request-witness inputs. A witness refresh
does not change that scope; the request freshness key remains witness-sensitive.
Other reviewed scope keys are unchanged. This is unreleased development behavior.

V2 is an explicit operation epoch because the captured selector is an
authority-bearing input, not an ignorable optional field. A terminal supporting
only the strict saved-result form rejects V2 before an Account write; unaffected
operations and V1 remain usable. This is a development contract, not a claim
that a released terminal advertises V2. The inspected `../0.2` predecessor at
`715e6bbfdabdd7c24b18ceb8904ab2e80370cb05` had no reviewed-marks producer or
reader in the Protocol, CLI SCM and UI Session Files paths, which were clean.
The earlier comparison-keyed 0.3 record was unreleased and is replaced in place;
it has no retained-data migration. Released-artifact support at this seam has
not been established. The released review-comment anchor union is unchanged:
terminal and transcript Ask use fenced composer text rather than a new anchor kind.

### Plugin projection invalidation (development)

The development daemon also carries optional
`daemonState.contributionRegistryProjectionRevision` through the existing Machine
content transport. It is a nonnegative integer for projection invalidation, not
Machine identity or execution authority. Running-state publication initializes an
absent revision; the existing plugin-registry publication bridge advances it.
Current UI readers accept retained states without it and use the existing generic
daemon-state-version invalidation for those states. Marked states use the specific
revision and daemon identity, so unrelated daemon-state publications remain cheap.
No Machine content codec, Account-mode decision or database schema changes.
The inspected clean `../0.2` state producer at
`3a0f38b9d5d1fd1a3debe7a2d140178b14aca0ac` omits this field; its retained states
remain readable. This is development-source behavior, not a claim of loaded or
released mixed-component certification.

### Local-service Machine summary (development)

The optional `daemonState.localServices` field carries the Protocol-owned strict
`LocalServiceMachineSummaryV1` presentation union. Its V1 epoch is independent of
package SemVer. Each member is closed: `ready` carries the listening user-service
count; `unknown`, `error`, and `disabled` carry no count. Missing or malformed data
is unknown to consumers. The existing Machine content transport and Account-mode
encryption decision remain authoritative.

This safely ignorable optional projection changes neither Machine identity nor
authorization or mutation admission. The inspected `../0.2` predecessor at
`17ba05df68d4d3d4cad1c1241b58e63805db37ed` has no summary producer; old Machine
states remain valid and supply no count. New daemons reconstruct their projection
from the current inventory and republish through the existing Machine lifecycle,
without a persisted format migration or a parallel count writer.

### Plain Machine and credential predecessors (0.3 development)

The moving 0.2 predecessor writes plain Machine metadata/state as base64 JSON
`{t:'plain',v}` and the existing data-key carrier as base64 `{t:'plain',v:null}`.
Current 0.3 readers recognize that carrier as plain without a Machine database
mode column. Retained encrypted predecessor Machines on an already-plain Account
stay locked until the old key holder performs the existing whole-content
conversion described in [encryption.md](encryption.md). Neither case generates
replacement Account encryption material.

The canonical CLI credential reader accepts 0.2's explicit
`{token,encryption:null}` and its genuine legacy/data-key shapes; current 0.3
plain writes may omit `encryption`. Historical custody survives ordinary
same-Account refresh, while active provisioning follows authenticated Account
currentness. The all-component upgrade requires a fresh terminal/QR pairing link
for an in-flight predecessor request; it does not preserve the predecessor's
reader-negotiation decisions. The 0.2 Account-link QR carries the recipient public
key and reader support bit; its recipient secret exists only in the mounted
Restore QR view. A saved image of that link is therefore an in-flight pairing
request, not a recovery-key backup. Its additional applied auth-reader migration history
is retained by the existing SQLite deploy owner rather than copied into a second
0.3 pairing authority.

### Machine resources and Storage (0.3 development)

The transient V1 resource summary preserves the sampler's optional
`memory.pressureSource` (`kernel_level`, `psi`, `events`, or `none`). Its memory
presentation object is additive-open/drop: readers accept omission without
inferring a source, drop unknown presentation fields, and strictly validate
known fields. The summary envelope, other metric objects and series points
remain closed. The shared summary strip and full Memory tile use the same
localized provenance wording; samples and this value projection are not
published in `daemonState.resources`. This refines an unreleased 0.3 read
projection without changing its V1 epoch or package version. The inspected
0.2 predecessor at `b3e25a20bd6b8969e5a8b20b149c30d9705b591e` has no resource
summary or vitals module in the corresponding Protocol paths; no predecessor
writer or reverse compatibility adapter is introduced.

Storage is a new Machine RPC V1 epoch, independent of package SemVer. Current
contracts live in [`storageV1`](../packages/protocol/src/storage/storageV1.ts),
the [`Storage Action family`](../packages/protocol/src/actions/specs/storage.ts)
and the exact-Machine route policy. Its requests and mutation/identity envelopes
are strict; stored Pile and Trash readers discard unknown fields without coercing
invalid known identities. Presentation sizes and reasons accept and drop additive
fields. Pile refs, item checks, and staying refs optionally carry the canonical
catalog title; absent titles remain readable. Review/check presentation objects
drop unknown fields while nested identity and mutation envelopes remain strict.
Titles do not participate in cleanup authority or review tokens. Category reads
use the Protocol's typed evidence vocabulary for display. Evidence is a skippable
presentation list: readers preserve known codes and the `recognizer:` / `manifest:`
namespaces, normalize unfamiliar string codes to `unknown`, and reject non-string
values. The UI supplies localized labels and a neutral unknown label; evidence
never grants cleanup authority. Opaque directory digests receive titles from their
owning Storage category rather than becoming display names. Category reads
can include exact `trashEntries` restoration metadata;
an entry id is not filesystem authority, and the daemon rechecks every effect.
Scan views additionally serve an optional `root` with the selected folder's facts,
independent of the paged children. The Storage service projects its protection
through the same owner as every child; List, Map and Rings consume these facts for
their headline and breadcrumb. Its absence remains readable on older answers.
Disk refs reuse the served `nodeId` as both `itemId` and path, including exact-byte
ids; invented item labels confer no authority. A rejected collection preserves
`storage_item_not_collectable` through RPC and Action output normalization.
Session-bound Storage tools default an omitted Machine target through the existing
Action contextual-default owner, while explicit targets remain explicit.
Accepted Storage operations use the transport's unbounded operation wait with
bounded connection setup. A consumed acknowledgement remains settled after caller
cancellation; uncertainty does not prove that no item moved.
Summary volumes can additionally report optional verified-Safe `canGoBytes`.
Readers accept its absence as unreported rather than zero; older presentation
readers drop this additive field. It conveys no cleanup authority and is omitted
from recipient summaries.
Storage summary presentation also accepts optional `suggestionsTotalCount`,
`suggestionsSafeTop`, `suggestionsSafeTotalCount` and `suggestionsSafeFreesBytes`.
Current producers send up to eight rows per mixed/Safe
preview (the largest bounded widget presentation), with the actor-filtered full count; `suggestions.list`
remains the full inventory read. Readers accept older unbounded arrays and an
omitted count as unreported coverage; older replies lack the dedicated Safe preview.
These additive-open/drop fields carry no
cleanup authority and do not change the Storage V1 epoch, stored data or
mutation/identity envelopes.
Summary volumes also accept optional `pileFreesBytes` and `trashFreesBytes` for
exclusive cleanup forecasts, independently of allocated `pileBytes`/`trashBytes`.
These are additive-open/drop presentation facts within Storage V1, with no authority
meaning. New UI readers omit a forecast when absent; older readers can discard the
fields. Temporary-directory Trash entries retain the existing owner-marker bytes
beside the payload; manifests and owner data keep their existing schemas. Entries
without a retained marker remain readable, but cannot recover a witness already
deleted by the former retirement path.
Development scan inputs remove client-supplied `drawableNodes` in place. Every
interactive, direct-folder relist and scheduled native scan consumes the protocol's
`STORAGE_CHART_MAX_DRAWABLE_NODES` export, also prescribed by the approved Map/Rings
culling contract; visual integration is separate from the runner's implementation.
Never-before-scanned present volumes need no prior client request to be scheduled.
This unreleased input does not acquire a compatibility alias or a separate headless
budget.

Scan progress is an additive-open/drop presentation object inside the closed
scan identity/target envelope. `progress.usedBytes` is optional: folder scans
omit the unknown denominator, while whole-volume scans retain measured zero.
The local index reader normalizes retained folder denominators before reads and
resume; current writers omit them. This is an unreleased Storage V1 correction,
not a second wire epoch or support for mixed 0.3 development intermediates.
The clean relevant paths in `../0.2` at
`3482a9101ebb7ee2983608ef0deb00831dfcb2e7` (2026-10-24) contain no Storage scan
producer, reader or UI surface; no predecessor adapter is required.

Settings extend the existing `metadata.resourcesPolicyV1.storage` section. Missing
sections receive current defaults through the stored reader; writes remain strict
minimal patches through the single daemon metadata-field CAS owner. Protected-folder
Actions use that same revisioned writer and return its conflict/current-policy
result. No second settings file or server copy of the scan index is introduced.
The index is a machine-local projection, with at most one current and one previous
complete database per present volume; opting out removes the owned scan databases. Pile refs
and self-describing Trash manifests remain protected local state, not published
Machine content. See [Storage ownership](cli-architecture.md#storage-sizing-pile-and-trash-03-development)
and [Machine encryption boundaries](encryption.md#machine-metadata--daemon-state).

The inspected clean predecessor at
`e087d15a2f0cce1de6de8ef0895d9c8bcc035056` has neither the Storage RPC/domain nor
the resources-policy module in these paths. These additions impose no new
connection-wide update floor or dual writers. On an otherwise compatible admitted
transport, unavailable Storage methods are an operation-scoped feature boundary;
unrelated operations keep their existing contracts. The independent encrypted
socket epoch below still applies. The resources-policy and local-manifest readers do not establish supported
rollback to a predecessor that never produced them. These are development-source
contracts, not released availability or mixed-version runtime certification.

### Encrypted socket RPC binding (v0.3 development)

E2EE socket RPC uses the shared codec's V2 plaintext envelopes: requests bind
the complete target-prefixed method, caller-generated 128-bit call id and request
direction; responses bind that call id and response direction. Unbound encrypted
payloads are never accepted alongside V2. Current readers reject unbound,
malformed or mismatched envelopes with `RPC_UPDATE_REQUIRED`, including unbound
responses from an older daemon. A v0.3 responder refuses a 0.2 request before
handler dispatch; a 0.3 caller cannot trust a 0.2 response. All components must
upgrade together under the one-way 0.3 boundary. This is an intentional wire
epoch change, independent of package versions, and introduces no persisted state,
new key or negotiation. It does not prevent request replay. Plain-mode accounts
and reserved server-origin methods keep their existing contracts. See
[encryption.md](encryption.md#encrypted-socket-rpc-routing-v03-development).

Development requests may add optional `traceId` as transient diagnostic metadata
when the existing cancellation/signed `requestId` is absent. It is safely
ignorable: it carries no authority, cancellation, routing or result-custody
meaning. Home replaces it with target-local diagnostic correlation; missing or
malformed metadata does not change the operation. Existing authority envelopes
and their closed schemas are unchanged. This adds no wire epoch, persisted data,
mixed 0.2/0.3 stack support or rollback reader.

### Machine Session-log diagnostics (v0.3 development)

Machine diagnostics register and call `daemon.session.log.tail`; `session.log.tail`
is Session-only. The Machine operation retains its explicit log path, response and
path-safety rules. The existing `bugreport.getLogTail` has a different diagnostics
allow-list and response contract and is unchanged.

The standing one-way 0.2 → 0.3 ruling requires all components to update together,
with no rollback or 0.2/0.3 cross-component support. Only 0.2-created data must
remain usable. A released 0.2 UI or daemon using Machine-prefixed `session.log.tail`
against a 0.3 server is outside that boundary, so the server retains strict scope
enforcement without a legacy registration or routing exception. This rename changes
no persisted data, log contents or historical log reader.

### Saved agent-start policy (development)

`sessionAgentSpawnPolicyV1` retains the strict 0.2 V1 field set, including
`allowEnvironmentVariables`. Admission refuses explicit environment overrides
when that flag is false, including an empty environment object; omitted
environment overrides remain allowed. Profile-inherited environment remains governed by
profile selection. Settings reads strip unknown keys
and recover malformed fields independently through their field defaults; a bad
field cannot erase another field's deny rule. Durable approval evidence uses
`SessionAgentSpawnPolicyV1StrictSchema` and rejects malformed or unknown fields.
Account bounds failures reject the policy instead of replacing it with open defaults.

The development-only role and Agent-target allow-lists live in the separate Account
setting `sessionAgentStartAllowListsV1`. The host reads it into the admission context;
`admitAgentStartV1` remains the single decision owner. Null means unrestricted and
an empty list allows none in that selection family. The UI writes this setting
independently, so a current V1 policy remains readable by 0.2 strict readers.

### Android file actions native runtime (development)

The development UI's Android Save As, Open With, and Share actions require the
compiled `HappierFileActions` Expo module. The destination uses the fresh
`0.3.0-native` runtime train for non-publicdev lanes; publicdev retains Expo's
fingerprint policy. This train is distinct from the predecessor's native runtime
and must be paired with a new native build before publishing its updates. Do not
use a runtime maintenance override to send this JavaScript to a binary without
the module.

Workspace downloads and previews continue through the canonical prepared transfer
carrier; the port does not restore predecessor bulk-RPC probing or alter encrypted
transfer contracts and daemon-owned limits. Native cache files have independent
storage identities while Android receives the original display name. Failed or
canceled document copies remove the newly created destination; a provider that
refuses deletion produces an error identifying the remaining document. Web and
iOS keep their existing download actions.

### Native date/time picker availability (development)

An OTA update cannot add a compiled native module to an installed app. The
current UI package defaults non-publicdev Expo lanes to its configured
`happierExpoRuntimeVersion` train; publicdev defaults to fingerprint compatibility, and
explicit runtime overrides remain configuration-owned. A runtime match alone is
not evidence that the installed binary contains a newly added native SDK.

The shared `DateTimePickerPopover` native adapter owns the installed-capability
check before lazily loading `@react-native-community/datetimepicker`: the iOS
view registration, or all four Android bindings eagerly required by SDK 9.1.0.
`LocalDateTimeEditor` consumes that same decision and hides unavailable picker
buttons in both Session reminders and Temporary-computer package expiry. Manual
date/time editing and domain validation remain unchanged, including the reminder
modal's saved-reminder/preset-retry flow. Equipped binaries keep their native
picker; web retains its JavaScript picker.

This preserves older-native/new-JavaScript behavior only where the actual OTA
runtime admits that combination. It does not establish that a particular 0.2
binary is eligible for 0.3 updates. Remove the guard only when no supported
eligible binary can lack the SDK; delivering native modules still requires a
native app build.

### Native Doc passage selection (0.3 development)

Exact passage comments use the existing enriched-Markdown native menu event's
full `renderedText` snapshot, committed `sourceMarkdown` basis and UTF-16
selection range. A menu from a different rendered basis cannot supply mapping
evidence for the latest callback. The native dependency
patch and its generated event emitters must be included in a rebuilt iOS/Android
app; JavaScript or an OTA alone cannot add that payload to an installed binary.
Older native events without the full snapshot do not publish a whole-block or
quote-searched substitute; legacy text-only custom menu callbacks remain usable
without source-mapping evidence. The marked-text refinement data contract passes the
captured Markdown and a completion callback for the same native renderer and
source mapper; the visible refinement host remains a Doc UI handoff.
This is development behavior, not evidence that the host is composed, an
installed app has the patch, or native selection/accessibility release checks
have passed.

### Voice duration settings (0.3 development)

The canonical Local conversation and Local direct settings schemas accept
positive integer speech-request timeouts, retaining only the JavaScript timer
maximum of 2,147,483,647 milliseconds. Local conversation accepts positive
integer idle-agent TTLs in seconds without a Happier upper bound. There is no
protocol minimum of sixty seconds for idle TTLs or one thousand milliseconds
for speech requests.

The released `ui-web-v0.2.15` and `ui-mobile-v0.2.15` readers at
`88d45f33a5e5faf3235f621ee168a6f0ca58762d` admit idle TTLs of
60–21,600 seconds and speech-request timeouts of 1,000–60,000 milliseconds.
Their parser rejects an out-of-range Local adapter and retains its defaults.
On 2026-10-08 the maintainer explicitly approved longer values and removal of
unsupported lower bounds, accepting this older-client defaulting consequence.
Current readers still accept settings within the released ranges; current
writes preserve admitted values without a transition, shim or parallel policy.

### Voice settings and transcript memory (development)

Voice Agent preferences retain the selected Agent id, exact target key and
qualified contribution identity. The unused selection-time
`agentProjectionGeneration` observation is no longer persisted in 0.3
development. Stored readers tolerate and drop that unknown field without
changing the selected Agent; this removes no 0.2-created selection contract.

The Voice transcript reset boundary lives in the Account KV row
`voice:transcript-memory:v1`, through the existing mode-aware JSON/CAS owner.
Forget advances this boundary only when remembering conversations is enabled;
it applies to replay from every carrier in that Home/Account. Initialization
reads the same row for transcript stamps and replay requests. Run/resume metadata
clearing retains its existing bound-carrier scope, and ordinary Session history
is preserved. No Account preference is written by Forget.

The clean 0.2 predecessor at `420e78875b59a5d50169d31497853c447498f470`
writes `voice.adapters.local_conversation.agent.transcript.epoch`. That field
remains an inert retained source through unrelated preference edits and seeds
an absent memory row. An existing row is authoritative, including after later
resets; malformed memory fails closed. Current `voiceSettingsV1` preferences
contain only `transcript.persistenceMode`. The legacy source reader remains
until supported 0.2-created settings no longer need it; this is a one-way data
upgrade, with no mixed-version reset writer or rollback contract.

### Voice presence settings (development)

The device-local `voicePresenceContainer` chooses `top_bar`, `island`, or `orb`.
Missing or malformed values resolve through the existing local-settings parser to
the responsive default: Island on phones, Top bar otherwise. Container selection
does not change the admitted attempt, microphone, transcript, or Account-scoped
conversation settings.

The inspected clean `../0.2` Voice and local-settings owners at
`388915739e64655b454e0bee8198833a54e6eabc` retain Account `voice.ui.surfaceLocation`
(`sidebar`, `session`, `auto`) but have neither of the old orb booleans. Current
ingress still accepts that Account field; it is not the new placement authority.
The replaced `voiceOrbEnabled` and `voiceOrbExpanded` were 0.3-only choices, so
their removal does not create a predecessor-data migration or a second writer.

Private owner Voice bindings retain optional nullable `targetServerId` alongside
`targetSessionId`, matching the current Home-qualified Voice binding writer.
The strict owner envelope preserves that field; the shared projection does not
disclose the binding. The inspected current `../0.2`
`voice/sessionBinding/voiceConversationBindingMetadata.ts` writer omits the
field, and those bindings remain readable through the same current owner.
No new caller authority, persisted format, or old-component rollback path is
introduced.

### Native voice word segmentation (development)

Voice endpoint and client-owned interruption policy share one Unicode text
normalizer and meaningful-word owner. Browser word boundaries use
`Intl.Segmenter`; native boundaries come from the UI-local
`HappierTextSegmentation` module using Apple's `NLTokenizer` and Android ICU
`BreakIterator`. The bindings provide boundaries only: phrase matching, noise
filtering and the measured short-word backchannel gate remain JavaScript-owned.
Native dictionaries can differ around a word-count threshold; release QA checks
CJK and Thai short acknowledgements and multi-word turns on both platforms.

An eligible OTA update cannot add this module to an older installed binary.
Resolve native capability lazily when its word-gated voice path starts and
refuse missing capability through the existing visible
`provider_setup_required` failure, rather than weakening word gating or
failing app startup. Unrelated operations remain usable. This is current
development source, not evidence that a particular older binary admits the OTA
or that native release checks have passed.

### Native mode catalog projection (development)

`sessionModesV2` adds an explicitly unknown accepted current mode independently
of known available options. Its canonical Protocol reader accepts retained strict
`sessionModesV1` and `acpSessionModesV1` records, but a present malformed V2 record
cannot fall back to stale V1 state. One current-authorized publisher writes V2
and projects unchanged strict V1 only when accepted current is known. It does
not write null, sentinels or additional properties into V1, or treat desired mode
intent as accepted. Agent transitions clear all catalog generations together;
forks retain the same canonical facts without inventing a selection.

This is current 0.3 development metadata, not a new 0.2 reader obligation or a
mixed 0.2/0.3 coexistence promise. The supported one-way upgrade retains V1 data
and reads it through the same canonical owner. See [the catalog owner](agents-catalog.md)
for the native source and publication lifecycle.

### Terminal metadata projection (development)

The released `ui-web-v0.2.12` terminal reader at commit
`a357c65536ba89669422977d6f7daf9aa0d17e73` rejects `herdr` in both terminal
enums. Where an existing legacy flat-metadata flow reaches that reader, current
writes project the enum values to `plain` and carry Herdr through additive
`hostKind` and `requestedHostKind` properties. The shared Protocol terminal
owner immediately restores the canonical host and removes those recognized
selectors on read; opaque metadata fields survive the round trip.

This is a bounded terminal-field seam, not support for an older UI opening 0.3
Account-owned envelopes or participating in the all-component upgrade. Layout-1
writes retain their Account encryption and strict owner envelope. Its terminal
schema composes the same canonical known fields with the existing closed,
bounded policy rather than keeping a separate host enum or an unknown-field bag.
The pinned historical terminal reader fixture validates only the flat seam.

### Terminal workspace and RPC attribution (development)

Ensure and Restart use the same terminal launch request schema, including optional
`sessionId` attribution. Current session controllers send it for either operation;
Restart can also retain the previous PTY's attribution when a caller omits it. The
request field supplies attribution after daemon state loss without introducing
durable terminal identity. Session-restricted RPC owners reject a different Session.

The inspected clean `../0.2` terminal RPC and Protocol owners at
`388915739e64655b454e0bee8198833a54e6eabc` accept extra launch-request fields but do
not consume this attribution. Current callers therefore remain accepted there,
without promising Other sessions discovery on that older daemon. The same
predecessor's Details and URL owners create only `terminal:embedded` with a
`{ kind: 'terminal' }` resource. The current workspace reader seeds that member
when predecessor workspace state is absent; an unresolved current instance is
unavailable rather than a request to create another shell.

The current device-local terminal member also accepts optional
`openCancelled: true`. Omission preserves the preceding open behavior; a decline
survives leaf replacement until explicit Open or Restart. The member, target,
approval reference and layout remain closed schemas. This development-only
presentation field changes neither terminal RPCs nor approval authority. The
clean moving predecessor at `f18aba940c5c56e5b24454e176c836c171098a2d`
has no `terminal/workspace.ts` member producer; its absent workspace continues
through the existing default-member reader. No reverse 0.3-to-0.2 layout writer
or migration is added.

Borrowed `terminal_view` members in current 0.3 development can retain the
actual accepted `workspace` address separately from the process `cwd`. Project
admission checks that exact address and its Project association; a nested cwd
does not replace the accepted root. Inline and docked Project output use the
same attachment-to-checkout resolver. The member and nested address stay closed.
Docking consumes the output Action's freshly authorized operation snapshot,
so an earlier UI projection cannot select another terminal or checkout.
No unknown field supplies routing authority. This is device-local presentation
state, not a terminal RPC or a new plugin launch API. The predecessor at
`f18aba940c5c56e5b24454e176c836c171098a2d`, rechecked on 2026-10-16, has no
`terminal/workspace.ts` producer or current Session terminal workspace owner.
Existing members without the optional address keep their prior admission path;
no reverse 0.3-to-0.2 workspace writer is supported.

### Terminal-host account settings (development)

The same released UI at `a357c65536ba89669422977d6f7daf9aa0d17e73`
strips unknown fields inside `sessionTmuxByMachineId` when echoing that map.
Non-tmux machine choices use the additive top-level
`sessionTerminalHostByMachineId` setting, which the legacy raw-baseline writeback
preserves. Protocol owns its schema and retained-shape normalization;
`terminalSettings.ts` owns the effective host for launch and presentation.
Modern edits patch that map and the legacy tmux projection together. None/tmux
choices retain the released boolean, session-name, isolation and temporary-path
semantics.

A released same-machine `useTmux: true` remains authoritative. Its false value
also accompanies non-tmux choices and cannot distinguish a repeated echo from
an intent to disable Herdr; older UIs do not gain Herdr controls. Protocol
normalizes the development-only nested `terminalHost` only when the new map is
absent, so an explicit new-map clear cannot revive it. Remove that development
reader once retained nested settings are no longer encountered. Immutable reset
keeps the canonical root absent and removes only its recognized nested aliases;
tmux options and unknown neighbors remain intact. After a lost write response,
the CLI confirms the reset only when replaying that same canonical mutation on
readback is unchanged. This seam
preserves retained settings shapes, not older-client access to 0.3 Account
envelopes or a mixed-version all-component upgrade.

### Current-Session presentation custody (development)

Current-Session presentation bind, acknowledgement, and retirement are
Session-owner-only RPCs. The Home stamps the authenticated Account and exact
socket connection onto the private forwarded authorization context; public
`clientId`, focus, and acknowledgement fields never establish custody. The
UI issues these connection-affine RPCs only through the active Home's persistent
socket: an active-socket pre-issuance failure is preserved, and an explicit
non-active Home fails closed instead of creating an ephemeral scoped socket. The
daemon accepts an acknowledgement or retirement only from the exact origin that
won the current process-local binding, and the Home retires that origin when its
socket disconnects. A mounted UI also retires the exact binding on unmount or
Account/Session-scope retirement. Rejected binds are read-only and do not clear
an incumbent command.

This contract is development-only and ephemeral: it adds no persisted binding,
lease, timer, generation, or compatibility registry. The inspected prospective
`../0.2` predecessor has no Current-Session presentation RPC, so there is no
older wire shape to retain; new callers fail closed when the method is absent.

### Organization standing snapshot readers (development)

The development `GET /v2/session-organization` accepts `projectionVersion=2`
from current readers and returns every requested attention standing. This changes
neither the persisted standing format nor the snapshot's `schemaVersion: 1`.
Without that declaration, snapshots containing at most 500 standings retain the
released representation. A requested standing snapshot above 500 returns HTTP 426
with `error: 'client-upgrade-required'` and
`requirement: { v: 1, kind: 'session-organization', minimumProtocolVersion: 2 }`.
Only that refresh requires an updated client: writes and reads that do not request
standings remain available. Rows are never truncated or deleted for compatibility.

The bound belongs to the strict reader released as `ui-web-v0.2.11`
(`98ea8fb76733b1dd785d38c31360179cafa84824`), not to current product capacity.
The HTTP adapter owns this projection check; organization queries and mutations
remain the single domain owners. Remove the legacy check only when support for
that released reader is explicitly retired. The inspected released server query
whitelist ignores the new query parameter; this does not expand the supported
old-Home directions of the one-way 0.3 transition.

### Browser request headers and CORS

A new browser request header changes both the endpoint contract and its CORS preflight contract. Before shipping one, test the new client against the exact supported predecessor relay and verify that every value in `Access-Control-Request-Headers` is already accepted by that relay's `Access-Control-Allow-Headers`. Adding the header to only the current relay's allowlist does not preserve new-client/old-relay compatibility: the browser rejects the request before the endpoint can negotiate or degrade it.

Prefer an existing CORS-safelisted header, a query parameter, or the request body for non-sensitive capability negotiation. Use a custom request header only when its semantics require one and supported predecessor relays already allow it or explicitly negotiate that support. Validate the real `OPTIONS` request for every reachable browser-origin/relay direction rather than relying only on same-process route tests. When browser code needs to read a new response header, include and verify the corresponding `Access-Control-Expose-Headers` contract as well.

### Self-hosted relay release checks

The public release profiles treat self-hosted relay upgrades as independent
component upgrades, not as a fleet migration protocol. For a stable release,
prioritize these directions:

- current UI, CLI, and daemon core flows against a supported older
  self-hosted relay;
- bounded core flows from a supported older client or daemon to the current
  relay, preserving unaffected operations and returning a typed update
  requirement only for an unsafe operation;
- persisted state written by the supported prior release read by current
  readers; and
- current-writer to supported old-reader only when rollback or coexistence
  can actually make that direction reachable.

The release agent derives the affected, reachable directions from the actual
diff and supported released baselines while it performs the initial release
inspection, before release-note/version materialization or a release commit.
That single inspection also owns the public-note proposal and validation
selection. After materialization, the agent only confirms that the final delta
contains the approved release inputs and no unexpected runtime-reachable
change; a full second analysis is required only when the source contract
changed. Exact scripts can prove named behaviors
against named artifacts—for example the published-server-v0.2.1 pending-queue
regressions or a `docker-release-assets` published-channel → local-build
upgrade—but none of them issues a general compatibility verdict. The Docker
upgrade suite runs in a normal profile only when the diff affects relay
storage/schema, startup/runtime dependencies, authentication persistence,
encryption storage, or upgrade behavior, the release changes the server, and a
supported published relay predecessor exists. A server version change alone is
insufficient. Broader installer, platform, and
historical-version exploration remains risk-selected deep certification.
Release orchestration does not wait for every
self-hosted process, impose a mandatory client floor, orchestrate a database
migration, or coordinate a global cutover.
If a concrete migration has a writer-drain or maintenance-window requirement,
its dedicated migration procedure owns that external operation.

### Connected personal metadata (development)

The inspected moving `../0.2` Settings definitions produce profile labels,
default-auth pool-adoption dismissals, exact global/per-Machine CLI warning
booleans and sparse account/pool-member disclosure keys. The development reader
qualifies those addresses against an admitted complete inventory; punctuation is
not an identity parser. The literal profile ID `default` and explicit false
values remain unchanged. Unknown or ambiguous addresses retain their source for
repair rather than becoming an empty successful import.

Labels and acknowledgements move into independent Account-mode catalogs;
disclosure moves only through the actual device-local persistence owner. A
present row or revision-retaining tombstone prevents reseeding from Settings or
history. Complete row proofs authorize only the corresponding history roots,
not caller-supplied root claims. Historical disclosure snapshots remain read-only
history, not live authority; the remaining retired-root restore cutover must prevent
their reinstatement. They do
not receive an unrelated Account-row proof or a new device-import ledger.
Pinned quota meters, quota strategies and genuine
default preferences remain with their existing owners. This is a development
source transition with consumer/restore activation and composed checks still being
integrated, not a new released-client compatibility floor or rollback guarantee.

### Connected Account Pool selection clock (development)

The qualified V4 group row owns the active member and its selection time together.
Every member change writes `state.activeSince: { accountId, atMs }` and the same
`state.lastSwitchAt` in the selection transaction, including automatic switches
and fallback after disabling or removing a member. Re-selecting the same member
keeps its time; runtime status writes cannot replace it. Clearing the active
member clears both timestamp fields.

The same selection transaction records the existing `state.lastSwitchReason`.
The closed V4 active-account mutation accepts an optional `switchReason`, using
the stored cause's string shape; omission means `manual`, including re-selecting
the same account. Runtime-state writes preserve recorded provenance. Disabling
or removing an active member records a manual replacement through this same
owner. No V3 switch header or legacy group transport is added on this line.

With priority strategy and `autoRestorePrimaryWhenReset` enabled, the canonical
candidate selector can restore an eligible primary from fresh healthy quota
observed after an automatic limit fallback, without requiring a provider reset
time or surviving member failure marker. Manual provenance prevents the override.
Older rows without provenance retain the landed-reset proof; unknown history is
not treated as an automatic fallback. Existing quota freshness and member
eligibility policies are unchanged.

`useQualifiedConnectedAccountGroups` exposes that identity-bound `activeSince`.
An older row without a matching identity-bound clock remains readable, but its
selection time is unknown: historical `lastSwitchAt` alone cannot label the
current member. This is the Pool selection time, not evidence that an existing
Session has hot-applied that account. The inspected clean `../0.2` group schema
at `17ba05df68d4d3d4cad1c1241b58e63805db37ed` has optional `lastSwitchAt` and no
`activeSince`; those persisted rows need no backfill or invented clock.

### Automatic pool quota-reset opt-in (development)

The shared V1 pool policy accepts optional `autoUseQuotaResetsWhenExhausted`;
absence means false and is not materialized on reads. Current qualified V4 pool
routes mask this field while `connectedServices.autoQuotaReset` or a dependency
is disabled. They preserve the saved choice, and policy edits merge against stored
policy so an edit from a masked reader cannot erase that choice. Re-enabling the
feature makes the stored choice effective on subsequent recovery reads.

The UI offers the opt-in only with the server feature bit and an applied Connected
Account descriptor declaring `recoveryCredits: { supported: true }`. The descriptor
fact is projected with the service; the runtime additionally requires the matching
recovery-credit facet. Missing facts fail closed.

The 0.2 source-line Accept-header adapter protects strict released V3 group readers.
It is not revived on this development line: pools use qualified V4 identities and
the retired V3 group endpoints are not a current transport. This change does not
establish rollback from development V4 storage or plugin descriptors to 0.2.
The locally available stable and preview predecessors `server-v0.2.11`,
`server-v0.2.11-preview.2`, `cli-v0.2.11`, and `cli-v0.2.11-preview.2` all
resolve to `98ea8fb76733b1dd785d38c31360179cafa84824`; their route, API, and
Connected Account schema trees have no qualified V4 group transport.

### Pool quota-limit selection (development)

`quotaLimitSelection` is optional in the shared V1 pool policy; absence and
`mode: 'all'` retain predecessor behavior. Qualified V4 readers and writers use
the same policy owner, and older 0.2 readers reach their released compatibility
projection rather than the V4 transport.

`windowDurationMs` is an optional additive quota-meter fact. Updated readers use
it for presentation and expiry-first pool ranking; older readers ignore it.
Pool-selected display projection filters only meters and
preserves account-, subscription-, freshness-, and recovery-credit fields.

Provider rejection codes (for example Claude's `rate_limit`) are not allowance
IDs. When the provider does not identify the exhausted allowance, recovery keeps
that identity unknown and uses the existing account-level recovery policy; only
an explicit allowance identity can be excluded by the pool selection.

The existing V1 runtime-auth recovery event's `cancelled` carrier also contains
terminal policy outcomes. Its existing `reason` distinguishes explicit
cancellation from recovery that stopped without an automatic retry. Current
readers use the shared protocol interpretation; no new event enum or persisted
recovery state is introduced. Primary-session failures remain visible even when
independently owned background runs continue.

Expiry-first is the development default for new or absent pool policies. Explicit
`least_limited`, `priority`, and `manual` choices remain unchanged. Among eligible
members with fresh headroom above the existing soft-switch threshold, the daemon
prefers the earliest future reset of the longest selected usage allowance or an
independently fresh subscription end with renewal off. Unknown durations use the
effective allowance; stale, missing, renewing, and passed dates add no preference.
Ties and inadequate-headroom recovery retain headroom then member-order ranking.
Healthy active members remain sticky; this does not schedule swaps or restart sessions.

Qualified V4 pools consume the canonical policy directly. The retired V3 routes
remain retired: the 0.2 old-reader strategy projection and authoring-support bit
are not added to V4. Runtime quota-store and Provider Account Usage projections
share one meter normalizer, while policy-specific allowance filtering remains
selector-owned. UI summaries describe the strategy rather than duplicating the
daemon's automatic ranking; explicit manual switch suggestions use member order.

### Provider Account subscription facets (development)

The canonical V1 sealed usage envelope retains the predecessor's optional separate
`subscription: { observedAtMs, ciphertext }` facet. The Protocol opener verifies
its record identity and observation binding; corrupt or wrong-key facets fail
closed, never fall back to plaintext. New E2EE quota writes use the canonical full
envelope sealer, not the base-ciphertext-only helper.

The daemon quota coordinator merges subscriptions through the shared
`mergeProviderAccountSubscription` owner, both after a cold V4 read and before
scalar or qualified writes. A quota-only refresh retains the last valid
subscription; a failed subscription refresh retains it with its refresh error.
Subscription changes participate in the existing material fingerprint so they
are not suppressed as unchanged quota data. Plain writes use the same semantic
merge; opaque server storage preserves the separate E2EE facet without opening
it. No parallel persistence format or subscription reader is introduced.

The development Connected Account SDK quota result now admits optional
`ProviderAccountSubscriptionV1`; its host result owner snapshots the trusted
in-process SDK result before the coordinator consumes it. External quota wire
remains strict. Stored usage readers project recognized fields before applying
the shared known-field checks.
Plugins omitting the field retain their quota behavior. This is a development
author-surface extension, not a predecessor SDK contract or a promise that an
older host accepts newly authored plugin results.

The development SDK quota-limit result also carries the consumed optional meter
facts (`windowDurationMs`, `modelId`, scope, labels, units and confidence).
Canonical PAU diagnostics are retained by the quota projection; their optional
`retryAtMs` describes the existing producer backoff, not another retry owner.
Readers accept retained snapshots without diagnostics or retry timing. The
qualified V4 development UI consumes producer error status alongside last-known
meters; bootstrap sources use `not_loaded` and do not assert a fresh observation.
No credential identity, runtime union or persisted record key changes.

The development Usage insights quota read retains material accepted B snapshots
at the existing Provider Account Usage write owner. History is scoped to the
actual qualified record identity, paged over the caller's requested range, and
keeps the same plain/sealed envelope and separate subscription facet as current
B. Once the first actual accepted observation is retained, timestamp-only
refreshes do not manufacture additional usage samples. Existing retained
current records remain readable when their accepted history is not yet available;
readers must not invent a historical witness or join distinct credential records.
The existing [B Account-mode conversion lifecycle](encryption.md#provider-account-usage-history-03-development)
clears these records and their cascading history; this is not a historical
rewrap or a promise of continuity across mode conversion.

`connectedServices.quota.get` is a read, not a provider refresh. It opens current
and requested history under the captured Account encryption mode and projects
pace only from witnessed window duration, reset and utilization facts. Unknown
or incomparable evidence is explicit. Advisory targets do not enforce a spend
ceiling. Optional subscription monetary facts distinguish provider-observed
paid amounts from versioned, dated list prices; absence is not a zero cost or an
inferred payment.

In development page reads, the B owner derives `pageFacts` before returning to
the Usage Resource: all earlier-curve points and exclusions, witnessed reset
windows and the latest immutable reset witness. Together with current meters,
pace and ended-window results, these are the facts Plans consumes. Packed
observations remain in B's protected persisted document, rather than being
repeated in each Resource slice. Exact-history requests still return every
requested record. This is an undeployed 0.3 read-projection change; neither the
retained 0.2 record shape nor the protected document's encoding changes.

An exact-history client can drain its requested range through one captured quota
Action read. The client starts at the existing page
size, grows later pages by the accepted volume, and publishes current capacity
and accepted prefixes independently of entered-price and Pending metadata. It coalesces unchanged
material runs to their witnessed endpoints without dropping reset or entitlement
changes. A remaining cursor still marks partial history; failures retain that
prefix, while authority refusal retires it. This is an in-process read option,
not a new wire or persisted format: ordinary quota Actions retain one-page
semantics and exact witness reads remain unchanged.

The development V4 history operation also admits
`{ recordId, projection: { range, resolution: 'accepted_observations' } }`.
Its closed read result is `{ projection, complete }`; a missing materialization
is explicitly incomplete. HEAD on this demand returns no body and exposes
`x-happier-usage-projection-complete` and its representation's `ETag` under
`Cache-Control: no-store`. The client
then reads the stable `/history/document?recordId=…` resource, which carries the
protected prefix and conservatively reports `complete: false`. Only the demand
operation asserts coverage. The client uses the HEAD result for the actual demand
only when both ETags match. A mismatched document read falls
back to the original atomic demand GET, then the existing backfill path when
incomplete. A now-null document also backfills instead of inheriting completeness.
The document supports standard HTTP revalidation with `ETag`,
`Cache-Control: private, no-cache` and `Vary: Authorization`. Matching conditional
reads return an empty 304 only after qualified source, Account-mode and
accepted-prefix admission. Moving range endpoints do not change the document URL.
The existing Account Resource retains the admitted document and validator beside
its B read state, shared across batches and retired with Account/credential authority.
A successful PUT acknowledges the actual stored document's ETag when its exact
range/count/frontier matches the submitted cohort, including when an equivalent
write retained existing ciphertext. A competing wider document is re-read instead
of binding its validator to the producer's smaller body. The Resource can therefore retain
the document it just produced without downloading it again. Conditional HEAD
returns an empty 304 with freshly admitted demand coverage when that document is
unchanged; current-record/freshness changes and new accepted tails do not change
the document identity. An incomplete demand extends the held prefix through exact
tail reads. A reader can include its content-free `heldProjection` coverage in
the demand HEAD. The same storage owner checks that held count/frontier against
accepted history and returns `x-happier-usage-projection-prefix`, bound to that
coverage rather than the other writer's ETag. A compatible extension uses exact
tail pages without downloading the other body. If that writer already published
the derived range, the reader re-admits its actual derived prefix and omits the
duplicate PUT. Its locally sealed body never borrows the other ciphertext's ETag.
A changed accepted prefix, range origin or Account mode retains the full
read/backfill or typed refusal path. Backdated or removed witnesses arriving
during tail acquisition therefore cannot inherit the earlier HEAD's completeness.
No separate response cache or timer is added. Browser preflights admit
`If-None-Match`; the original demand GET separately exposes the document validator
as `x-happier-usage-projection-document-etag`, because its own body also carries
changing demand coverage. Missing HEAD support or an unexposed coverage/ETag header uses the original
GET contract. Stateless transports without HTTP caching still receive a full document.
Stateless callers can use the platform HTTP cache; a cold or evicted representation
can still transfer a body. A successful PUT does not prime that platform cache.
A qualified PUT to that same route accepts a closed
Account-mode protected projection with its record, range, accepted count and
frontier. The server admits only a complete accepted range and preserves other
record metadata. Clients open the protected content and validate its identity;
plain coverage metadata must also agree with its packed observations. The
`meter_readings_runs_v1` dictionary format separates meter definitions from
changing readings and groups consecutive equal material. Every immutable id and
exact clock delta remains, preserving irregular poll times and sample counts.
New projections omit historical per-fetch diagnostics. Current readings, exact pages
and immutable witnesses retain those diagnostics and their existing shapes.
No retention horizon or polling policy is introduced.
Existing records without this metadata remain readable and backfill on demand.
The current encoding marker is required on new development projection writes
and in the packed body. Stored reads tolerate a missing metadata hint: the
protected body's encoding determines whether it is current. The server retires
recognized superseded plain bodies; the authorized client classifies opaque
bodies only after authenticated opening. Superseded bodies are repacked from
exact history through the same qualified replacement path, even at unchanged
accepted count/frontier; an unmarked opaque document cannot suppress that write.
Mode, authentication and malformed current-body failures do not become backfill.
No decoder for superseded development encodings is retained. The plain/E2EE content
envelope, exact-history API and immutable reset witnesses are unchanged.
This is an undeployed 0.3 read materialization, not a predecessor writer, a second
allowance authority or a promise of reverse 0.2 process compatibility.

The development `connectedServices.subscription.price.set` Action sets or clears
an amount and currency for an exact qualified connected account. It uses normal
dangerous-write approval and captured Account-mode authority. The entered amount
is retained in the existing Connected personal metadata Account-row catalog and
composed as `enteredMonthlyPrice` into the exact-account quota read. It is labelled “you entered”
and remains separate from observed paid amounts and dated list prices. Provider
refreshes cannot erase it; unknown subscription periods still cannot produce a
period-qualified price or fit result. Entry requires an owned connected account,
not an accepted B record, and never creates a quota identity. Existing label and
price edits retain each other's facets; account cleanup removes both together.

Current-period monetary selection uses the witnessed subscription start and end,
effective/as-of dates, current subscription freshness, and matching tier/region
where the fact requires them. An unknown period or unmatched fact remains
unavailable. Subscription refreshes that omit a monetary observation retain
previous dated facts; those historical facts do not become the new period's price.
The canonical pace projection supplies its qualified observed curve and linear
depletion instant, so chart readers cannot requalify history independently.
Usage page money totals likewise preserve each kind and denomination separately,
with every contributing accounting source in the aggregate provenance.

U3 refreshed the moving predecessor's actual usage/subscription files at clean
`c03f1e9625ec924bfadde207eacd1b28530a8af0`: its strict separate facet has no
monetary facts, and remains a supported forward input. The immutable
CLI/Server v0.2.11 source (`98ea8fb76733b1dd785d38c31360179cafa84824`) has no
subscription facet at all. Neither basis establishes reverse old-process
consumption of new development writes; this extension adds no dual writer or
new mixed-host promise.

`connectedServices.pools.selection.get` reads the target daemon's own selector
decision and comparator order. It does not switch a credential, acquire a lease
or create a cross-pool value ranking. Existing UI summaries and explicit manual
switch intent remain presentation/authoring seams, not automatic selectors.

The inspected clean `../0.2` usage paths at
`17ba05df68d4d3d4cad1c1241b58e63805db37ed` supply the separate-facet input contract;
development V4 qualified account transport is not a promise that older clients
can consume that transport.

### Model-entitlement pool disable opt-in (development)

`autoDisablePlanInvalidAccounts` is another optional V1 policy field whose
absence means false. Qualified V4 routes expose and accept it only while
`connectedServices.autoDisablePlanInvalid` and its fallback dependency are
enabled; masked policy edits preserve any stored choice. No 0.2 Accept-header
adapter is revived on this line.

The Codex plugin emits model-scoped `plan_invalid` evidence for explicit
ChatGPT-account unsupported, unavailable, or not-enabled model responses. The daemon records a 24-hour
per-model exclusion. When the pool opt-in is true it also disables that member;
manual re-enable clears the automatic-disable marker and runtime blockers.
Generic or provider-scoped `plan_invalid` evidence never triggers persistent
disable. Qualified V4 persists the marker, model cooldown, and disabled flag in
one member mutation guarded by both group generation and runtime-state revision.
For a finite Run's rejected initial input, the provider also attests that no
turn work was accepted. The Run's scoped materialization bridge validates the
exact activation, runner, member, generation, credential revision and model
before the existing pool coordinator records the exclusion and selects another
member. These rejected starts do not consume turn or hourly switch limits;
ordinary switches retain those limits. Exhaustion reports
`connected_service_run_model_unavailable` with the requested model. This is an
unreleased 0.3 source contract, not a change to the predecessor's daemon. Detached
Codex's canonical Run host now supplies bounded native-home reads and Run-scoped
refresh through the existing materialization control channel and shared daemon
authority. Focused and composed source checks do not establish loaded-daemon or
released availability.
The projected `ConnectedAccountUiProjectionEntryV1` contract is also absent from
that predecessor; its current strict development schema adds the optional
recovery-credit declaration together with its producer and UI consumer.

### Requester Machine bindings and work-summary preparation (development)

The development AccessKey migration changes only its Machine foreign key from
`(machineId, accountId)` to `Machine.id`. Existing requester/Session ownership,
tuple uniqueness, encrypted bytes and versions remain unchanged. SQLite and
PostgreSQL migration probes preserve predecessor rows; MySQL and retained-stack
deployment are separate outstanding validation, not established availability.
Foreign AccessKey admission still requires the shared Machine grant owner and
verified requester runtime channel.

The nullable `Session.runtimeMachineTarget` field retains the exact Home,
requester, Session, Machine and installation committed by the admitted publisher.
Closing that publisher preserves the placement; a later admitted publisher
replaces it in the existing publisher transaction. Predecessor rows have no
placement until an actual publisher establishes it. Stored readers drop unknown
fields, then recheck the original tuple, Home, installation and current Machine
access. Invalid or retired placement cannot select another AccessKey or adopt a
replacement installation. Cold pending input and Workflow origin delivery consume
this same fact; Session DTOs do not expose the internal placement. The additive
provider migrations and loaded-runtime journey require their own validation.

`MachineWorkSummaryV1` is a new strict read projection: `current` carries the
complete requester Account display identities and integer Session/task/terminal
counts; `unavailable` carries no inferred counts. Both object boundaries reject
unknown fields, including work identifiers and content. This is neither a
stored-data reader nor an inventory producer. Its Action, RPC and mounted UI
must consume the canonical live inventory and owner-or-Manage admission; the
schema alone does not make that operation available.

The development-only, server-origin Machine access-loss RPC also reads a private
requester census from that same live inventory on publisher reconnect. Its closed
requester-census arm returns Account ids and explicit coverage, without work ids
or content. The Home unions those subjects with existing AccessKey bindings and
rechecks current effective access before invoking the incumbent cleanup owners.
Sessionless services, terminals and operations therefore do not depend on a
Session AccessKey for recovery. Missing census support or unknown coverage remains
observably incomplete; known revoked subjects can still be cleaned. Existing
per-subject cleanup requests keep their shape, and retained Session history is
not changed by this recovery.

The installed development terminal runtime consumes C42's admitted original
requester Account ports for accepted Project shells and exact own local Session
workspace reads. Current Machine Use does not grant access to another requester's
terminal or Session. Each operation retains requester attribution and current
custody; no Agent or custodian credential is manufactured. This replaces the
unreleased blanket custodian-only terminal classification, not the separate
signed finite Project-script original-caller guard.

Execution Run preparation, active budget custody, visibility markers, private
retained lifecycle records and pending terminal delivery preserve the admitted
`RequesterWorkAttributionV1` tuple. Automation claim and Workflow coordinator
custody carry their captured host admission through the same live inventory.
Session-owned Run starts consume exact protected child custody, or an ordinary
accepted Session marker with the current process generation and command hash.
The extra decoded credential annotation is immutable, nonenumerable and never
part of the persisted credential codec. Private Action options carry admitted
Workflow attribution only across the existing in-process host seam; a public
request or Session metadata cannot provide it.
These optional fields do not upgrade legacy work: missing attribution or
conflicting active observations make the summary unavailable rather than hiding
that work behind an attributed duplicate. Current public Run projections omit
the host-local field; stored readers tolerate its absence and unknown fields.
The inspected `../0.2` marker reader retains unknown fields through its
passthrough schema, so its local marker read is not claimed to strip this
nonsecret tuple. The private retained lifecycle format has no corresponding
predecessor reader. Neither format grants runtime authority or changes Run
placement, and source-level coverage alone does not establish a loaded journey.

### Account display names (development)

Undeployed 0.3 stores one nullable `Account.name`. The additive PostgreSQL,
SQLite and MySQL migration backfills it from trimmed legacy first/last columns;
those columns remain read-compatibility data. Current profile writers use only
the canonical name. An explicit null clears it and must not resurrect stale
legacy columns. Readers of a released profile with no `name` field may join its
legacy first/last fields at the Protocol compatibility boundary.

The 0.2 Account-profile reader is passthrough, while released social and direct
sharing readers require first/last fields. Current producers therefore retain
both fields, projecting the complete chosen name into `firstName` and null into
`lastName`. This preserves nicknames and multi-part names without guessing their
structure. The strict new self-name mutation accepts no Account id and adds no
new name-length limit. Protocol owns the name → username → null label rule for
both server and UI; Account ids are not display fallbacks.

Home People ordering belongs to `listHomeAccountsInTx`: owners, then admins,
then members; named rows precede unnamed rows within each role. The keyset
captures `(roleRank, unnamedFlag, sortKey, accountId)`. Provider-native SQL folds
the name (or trimmed username fallback) and retains its first 32 Unicode code
points for sorting; the Account id breaks ties. This is sort precision required
by the unchanged 512-character cursor ceiling, not a name-length limit. Ordering
and continuation use the same provider-specific SQL expression and bytewise
comparison. A renamed row may cross the captured boundary or recur; unchanged
rows remain complete even when the boundary Account is renamed or deleted.
This replaces the unshipped creation-time cursor in place with a new query
binding, without retaining that intermediate ordering or adding a second codec.

The development Home Account list response carries optional `total`: all Home
Accounts before pagination, including suspended and disabled Accounts, counted
in the same transaction as the page. Overview uses this exact people total;
answers without it retain the loaded-row count and `+` while more pages remain.
This extends the undeployed V1 read response without changing cursor semantics.

### Direct sharing and Account erasure (development)

The development Account-erasure transaction preserves direct grants that the erased
Account authored on somebody else's Session. The canonical grant service reassigns
their non-null `SessionShare.sharedByUserId` to that Session's owner, preserving the
grant identity, access level, permission delegation, key envelope, and creation time.
This field is current compatibility provenance, not immutable audit history or access
authority. Existing direct-share readers continue to receive a real Account profile.
Received grants are removed, and owned Sessions use the ordinary recipient-aware
deletion lifecycle. Direct and public access logs retain their existing policies:
erasure removes logs identifying the erased Account, and deleting a share cascades
its logs; logs for surviving shares and other Accounts remain subject to normal
retention.

### Session access projection normalization (development)

Retained 0.2 public Session links keep their legacy token and wrapped-key
derivation. Flat layout-0 metadata is not recipient-safe: anonymous reads return
typed `metadata_privacy_upgrade_required`, never the raw flat metadata. On the
owner's initial 0.3 visit, authenticated owner-only discovery includes pending
shared Sessions outside the active list, and the existing currentness-checked
metadata tuple writer upgrades them. The same link then reads the recipient-safe
projection. The pending viewer asks the owner to open Happier; it does not treat
the privacy refusal as revocation or silently weaken the projection. This is a
retained-data upgrade direction, not a new old-server fallback or rollback claim.

Current Session readers treat a valid strict `effectiveAccess.v = 1` projection as
the sole access presentation authority. A present but malformed current projection
is unavailable and cannot fall through to released owner/direct inference. Only
true absence of `effectiveAccess` permits the released `share` translation; that
translation never represents Team- or Group-only access.

That rule has one implementation: `readSessionAccessProjectionRoleV1` in
`packages/protocol/src/sessions/access/sessionEffectiveAccessV1.ts`, which maps a Session
record to `owner`, `recipient`, or `unavailable`. It is representation normalization only
and never decides authorization. A record with neither field is treated as released owner
content when `metadataLayoutVersion` is absent or `0`, and as unavailable otherwise, so a
newer layout a reader does not understand fails closed instead of being read as ownership.
Persistence keeps the same separation the projection does: `SessionShare` is the direct
grant table only, while `SessionTeamGrant` and `SessionGroupGrant` hold collective grants
that a released reader never sees — see
[session-collaboration.md](session-collaboration.md).

The UI preserves the same distinction through hydration, access events, Voice,
encryption migration/key resolution, and reconnect state. Its additive warm-cache
field stores the current effective projection, or `null` for malformed-current
unavailability. Older cache entries without that field remain readable through the
released flattened fallback. Released direct-share events may refresh a normalized
legacy projection only when it has no current `sources`; they never replace a
sourced current projection or the fail-closed `null` marker.

Current development by-ID hydration reads prior full rows and admitted publication
only from the requested Home. A retained row with the same Session id on another
Home is not prior state for that request; each Home retains its own list row.
Account lifetime, encryption generation, and the by-ID Home/mode checks still
reject stale responses.

Server-side, the released owner/direct seam and the version-qualified current seam
are two presentations of one access decision, not two admissions. Released
unqualified V2 lists and unqualified by-ID detail leave Team and Group grants out
of the answer, but they resolve through the same
`resolveSessionAccessForOperation` owner, so omitting `accessProjectionVersion`
cannot widen a credential: a verified Session-scoped Runner principal stays a
capped `edit` recipient with no owner metadata on both projections, and its
persisted activation/Machine/AccessKey binding is revalidated on both. The
released branch passes the row it already loaded to that owner rather than
projecting access itself.

The prospective `../0.2` predecessor inspected at
`ac30c50856abd2265c14459e77ee3384da1698ad` (branch `dev`, clean) in the relevant CLI/UI
Session-detail consumers:
`apps/cli/src/session/transport/http/sessionsHttp.ts`,
`apps/ui/sources/sync/engine/sessions/sessionById.ts`, and
`apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope.ts`.
The committed Account/client encryption requirements do not change listing
or access-projection behavior. The predecessor still has no `effectiveAccess`
producer or consumer and no ephemeral Runner. Its `V2SessionRecordSchema` and
`SessionSummarySchema` remain `.passthrough()`, so current additive projection
fields are accepted. The former direction "a 0.3 client against a 0.2 Home", which the
server-only `sessions.collaboration` decision and a UI direct-only legacy share adapter
served, is not supported under the one-way 0.3 upgrade (every component updates to 0.3
together, no rollback); that bit, its `HAPPIER_FEATURE_SESSIONS_COLLABORATION__ENABLED`
switch and the adapter were removed on 2026-09-24. Current clients select the
version-qualified projection, Team/Group grants and initial access from the exact Home's
`sharing.session` decision. The surviving obligation is data: direct shares a 0.2 Home
persisted in `SessionShare` remain effective and readable in 0.3 through the same
access evaluator, independently of that decision.

### Session draft rollout

The current development UI stores browser draft repositories and pending-message outboxes in
IndexedDB, outside Web Storage's small synchronous quota. Native clients retain MMKV. Browser
startup prepares drafts before restoring Sync or rendering draft consumers; a failed preparation
uses the existing app recovery boundary rather than treating saved drafts as absent.

The draft repository writes a compact local v2 envelope and reads both v1 and v2. Equal base/local
documents and pending fields are stored once and reconstructed on read; independent conflict
values are retained. This does not change the synchronized draft document or server wire format.
Older UI binaries cannot read this local v2 representation.

Legacy browser values are removed only after their IndexedDB transaction commits. Migration
preserves conflicting copies and reports a failure instead of silently choosing one. Reload older
open tabs when updating the UI so they stop writing the retired Web Storage records. Concurrent
editing from an unupgraded tab during migration is not supported: old Web Storage writers cannot
participate in IndexedDB transactions. Browser
outbox operations await local transaction completion before reporting local custody; enqueue
acknowledgements cannot retire a concurrently recorded cancellation.

Draft autosaves retain failed writes in memory, expose the existing error status, and retry through
the repository's flush owner. Browser draft updates preserve unrelated replicas written by another
tab and reject conflicting changes to the same replica. IndexedDB still has browser/disk limits:
an error is not permission to discard drafts or pending messages, and unsaved in-memory edits must
be preserved before reloading. These device-local stores are not substitutes for server acknowledgement.

Synchronized Session drafts are negotiated through the `sessions.drafts` server feature bit. A new
client fails closed when that bit or the typed routes are unavailable and retains the incumbent
local-only behavior; it does not send draft records through generic Account KV routes. A capable
server reserves the draft KV prefix so old generic-KV clients cannot read or overwrite typed draft
rows.

In 0.3 development source, unsent child-conversation, Plan, Review and Delegate launchers use that
same repository. Their text, references, attachments and explicit launch selection occupy separate
`happier` extension fields on the parent Session draft, keyed by launch intent and role or Discussion origin.
The parent's message composer remains independent. Reload restores the saved launcher identity and
choice, including when hydration finishes after mount; accepted submission clears only its captured
fields, preserving edits made while admission was pending. These fields use the existing draft
envelope and encryption/CAS owners. Loaded UI validation remains separate from source availability.

Development V2 draft operations use the same repository, physical rows and CAS while preserving
strict V1 reads, writes, conflicts, cursors and events. V2-only Run/discussion and Project Open
addresses, plus successor new-Session content, use the distinct V2 socket and AccountChange hint schemas. Current
clients materialize their exact addresses before advancing the change cursor. Account encryption
transitions opt into the V2 draft directive when captured Account-owned content needs it;
older strict servers reject that directive before mutation. The
[Account transition contract](./encryption.md#account-mode-transition-status) owns resealing and
replay; Session-bound drafts never participate solely because their address uses V2.

New Discussion V2 addresses may carry an optional UUID `draftId`, serialized as
`new-discussion/<draftId>`. The unkeyed `new-discussion` address retains the ordinary
New Discussion draft. Keyed drafts use the same rows, encryption, CAS and Account-mode
transition owner; they do not alias or replace the retained singleton. The key is
closed identity data: an unavailable V2 operation retains the keyed local draft and
must never retry it as an unkeyed write. This is part of the one-way development
upgrade below, not a new V1 address or mixed-version coexistence contract.

Development Discussion V2 documents also retain an optional, nullable `replyTarget`
field with the existing field mutation identity and closed Discussion reply-target
schema. Missing fields read as no deliberate Reply. Navigation focus is never
converted into this field. Current writes, reload and captured-field clearing use
the same private payload, encryption and CAS owners; released V1 documents and
addresses are unchanged. This follows the one-way 0.3 development upgrade, without
an old/new draft writer pair or a rollback promise.

New-Session V2 authoring retains the title, creation identity, explicit memory choice and qualified
prompt stack in the canonical synchronized field catalog. Another client can therefore reopen a
Bot or Ask Happier draft with those choices. Existing 0.3 device-local copies are read only when
the corresponding canonical field is absent; a canonical clear wins. The next authoring edit
writes the recovered values through the catalog and removes their local copies. Device-local
unsaved Instructions editor content stays local. A draft whose original client never synchronized
its identity or prompt references cannot recover them from its text alone. These are development
V2 fields; the released V1 projection remains unchanged.

Development Project Open drafts use `project-open/<draftId>` through the existing draft
repository, reserved KV prefix, field mutation identities and revision CAS. Their V2 document
retains unfinished selections separately from strict submitted Open inputs, uncertain inputs
and acknowledged/retired outcomes. It has no Composer or Session binding. This address/document
cannot be projected into V1 or a synthetic new-Session draft. An unavailable typed draft route
does not authorize an Open effect with an unretained intent. The retained draft does not replace
Machine acknowledgement or prove filesystem effects, setup completion or exclusive checkout custody.

### Automation predecessor data (development)

The 0.3 development line updates server, daemon and clients together, without rollback.
Undeployed 0.3 snapshots and earlier recipe spellings are not compatibility contracts.
Current Automation transports use V3 directly; there is no V2 route, API-epoch probe,
representability adapter or older-component update-required fallback. This does not
remove the canonical Automation feature gate or Account authorization.

The current V3 definition also has an explicit `observationOnly` arm for Event
enrollment. It has no execution recipe or execution assignments. The existing
Definition stores its strict marker and matching `templateVersion` in
`templateCiphertext`; private source configuration remains in the existing
Account-mode trigger envelopes. Readers preserve this arm explicitly through
setup, catalog adoption, pause/resume, placement changes and Account-mode
transitions. It follows the same undeployed 0.3 direct cut, with no new
definition kind, store, old-client adapter or reverse-write obligation.

The development-only webhook correspondence result also accepts optional
canonical readiness and nonsecret endpoint binding observations. Its existing
`ready` discriminant still means the binding can be attached, including before
provider setup is confirmed; it does not itself authorize the monitor to stop
polling. The monitor requires verified readiness and exact contribution,
source-instance, target and revocation observations. Missing observations keep
the existing fallback active. This unreleased 0.3 extension retains the closed
result envelope and the present-user/plugin caller split; it adds no operation,
principal, store, persisted format or released-reader adapter.

The closed V3 worker claim and signed-claim receipt Run projections require
`leaseExpiresAt`, the server-granted expiry captured by the claim transaction.
Both direct and Automation-origin workers initialize the existing heartbeat
from that expiry; response delivery and receipt replay never grant a fresh
lease duration. Successful heartbeats advance the confirmed expiry, while
transient renewal failures retain only the last confirmed lease. This is an
undeployed 0.3 direct cut: its server producer and daemon reader update together.

The development V3 Run list also serves Account-wide attention at
`GET /v3/automations/runs?attention=required`; the definition-scoped list accepts
the same filter. It includes ordinary failed, dispatch-failed and uncertain Runs,
plus blocked Channel reply handoffs, even when no Session was created. Accepted
managed Workflow Runs remain under their existing attention predicate. The list
returns paged structural summaries, without private execution content or per-Run
history reads. Inbox consumes this membership through the shared Run-window owner
and opens the exact Automation Run route. Existing lifecycle changes clear
membership; this read adds no acknowledgement or permanent-dismissal contract.

The compatibility obligation is data created on 0.2. Its stored manual schedule maps
to zero automatic triggers; retained cron/interval schedules and enabled Machine
assignments remain readable through the current server's stored-row projection.
Reading those rows does not recreate a V2 runtime or old-client API.

In 0.3 development source, retained 0.2 `templateCiphertext` rows use the
Protocol-owned `automationTemplatePayloadV1`/`automationTemplateStoredV1` codec
in the daemon, Account trigger projection and UI read adapters. Explicit plain
and encrypted V1 envelopes, including the predecessor outer Session-id
consistency check and template-only raw-secretbox recovery, remain readable;
the canonical trigger Action checks persisted Account mode before opening content.
On a plain Account, an encrypted predecessor existing-Session template bound to an
authenticated retained E2EE Session remains paused until present-user review and
Save; it is not an encrypted execution exception. The server validates that exact
same-Account Session binding, not arbitrary ciphertext. A keyless reader projects a locked legacy row
with deletion available. Generic Account crypto does not gain an
untagged-ciphertext fallback.

The Account transition converter owns explicit per-row recovery of predecessor
templates targeting a plain Session or no Session. It uses genuine historical
material, writes canonical plain content through `templateVersion` CAS, and does
not repeat an already-plain write. A failed decrypt stays locked; a CAS conflict
requires a fresh read. Templates bound to retained E2EE Sessions are not rewritten,
and their historical material remains in existing device custody until no longer
needed or explicitly discarded. These are development-source upgrade guarantees,
not evidence that the loaded runtime or a release has been certified.

Retirement also retains material for returned encrypted trigger definitions and
opaque predecessor Run summaries. The 0.2 transition did not convert Run summaries;
current inventory can return their explicit `legacySummaryCiphertext` representation
even on a plain Account. Recovery does not reinterpret or rewrite that history.

The existing V3 PATCH mutation remains closed. Its recovery-only
`templateCiphertext` input is mutually exclusive with `executionRecipe` and
`observationOnly`; the two current definition arms are also mutually exclusive.
This is a
direct cut of the undeployed 0.3 request, not an ignorable extension promised to
an older server. The current CRUD owner requires the stored predecessor source,
plain Account mode, unchanged target and revision CAS; ordinary recipe writers
cannot use it to downgrade current content. No reverse 0.3-to-0.2 write or rollback
adapter is introduced.

The canonical trigger Action owner converts representable predecessor rows on
ordinary read through the existing inline converter and one Automation
revision-CAS reconciliation. It retains the Automation id, trigger ids and each
assignment's enabled state and priority, including zero or multiple assignments;
conversion creates no Artifact. Channel bindings address that same Automation
id and remain associated, rather than vetoing conversion. Unrepresentable
settings refuse without rewriting execution bytes.

A plain Account's encrypted template bound to a retained Session instead pauses
recipe-free, retaining the exact ciphertext. Its projection is
`legacy: { editable: false, reason: 'created_in_0_2', lockedReason: 'review_required' }`, with unavailable
execution health; ordinary reads neither request its key nor decrypt its private
content. The UI shows “Needs your review” using the existing attention treatment.
A present user opening the row requests a deliberate review through the
authenticated retained-Session/historical-material path. Its decrypted draft stays
local to the popover, not in the shared trigger store. Opening changes no private
stored content and does not resume execution.

Save uses `workflow.trigger.update` with `confirmLegacyConversion: true` and the
opened revision. Its notice explains that the normal plain Workflow stores the
reviewed content without E2EE and resumes enabled triggers; the Session itself
remains E2EE. That reconciliation preserves the original triggers and all original
assignments when the reviewed project is unchanged from the authenticated Session,
including zero/plural assignments that do not contain its Machine. A deliberately
changed project replaces placement through the normal authoring contract. Later
present-user enabled/trigger-only edits use recipe-free reconciliation and retain
those assignments and the opaque private definition body. Failed
key authorization or a lost revision leaves the original paused ciphertext intact.
Agent or unattended callers cannot take this confirmation path. Trigger removal
needs no conversion; a legacy toggle cannot bypass review. Ordinary per-trigger
enable behavior still enables only the selected trigger, whereas conversion
confirmation retains each sibling's enabled state. This is development-source
behavior, not released or loaded-runtime QA evidence.

When a new-Session predecessor omits both Agent fields, the converter resolves
the canonical default Agent before constructing execution selection and any
Agent-qualified model reference. Explicit unsupported launch settings still
refuse conversion; existing Sessions retain their authenticated Agent identity.
The current converter preserves a new-Session predecessor's native Agent
`resume` token as `providerSessionResume`: it still creates a fresh Happier
Session, rather than treating that native token as a Happier Session id.
Predecessor environment values use the existing Agent launch-environment schema
in the Workflow's private execution selection; they are not rewritten into
Launch Profile secret references or synced Session draft fields. Agent-start
environment policy still applies. For a fresh Session, a requested checkout name
and base ref use the existing `new_worktree` selection and SCM creation-intent
owner; omitted values keep the incumbent generated name and committed-revision
behavior. An existing-Session predecessor checkout draft was a no-op and keeps
that Session's actual directory instead of creating a worktree. Separate display
text stays distinct from the Agent prompt, and unchanged prompts retain their
exact original bytes.

Inputless Session steps now persist a truthful `session_ready` correspondence
for either fresh creation or existing Session acquisition, without authored input
or a fabricated receipt. Recovery reuses that durable correspondence and the
existing stable Session-creation custody. Explicit existing-Session steps ready
the target through the canonical inactive-resume owner before admitting Pending
input; failed resume admits no prompt. Offline launch choices flow through the
canonical runtime snapshot, whose timestamped permission/model policy accepts
newer incoming values and incoming-wins ties. Same-Agent portable driver choices
retain native recovery identities; different-Agent choices are refused and a
retained live process keeps its actual driver. Retained Session ciphertext never
gains an automatic Account-plain fallback.

Definition conversion alone does not certify preservation of already queued
predecessor Runs. The inspected 0.2 producer at
`639a32ec0e832dedb35d5a5809c36717c568225f` creates queued Runs without an
`executionInputEnvelope` column or frozen input. Development migration checks
now preserve null-input queued/claimed rows only before execution evidence
exists across PostgreSQL, SQLite and MySQL; the migration does not invent frozen
recipe bytes. MySQL enforces the complete input arm in insert/update triggers,
because its cascading produced-Session foreign key cannot participate in a CHECK.
Its preflight also refuses retained `run_started` event evidence. Effectful open
predecessor history still refuses activation. The development claim owner now
first-freezes a safe null-input Run from its definition through the same input
owner as new admission. The existing claim CAS commits those bytes and the lease
together, preserving the Run's assignments and checking that no execution evidence
appeared. Existing non-null frozen inputs are never replaced from the Automation's
later mutable definition. A retained Session ciphertext template stays held for
explicit review, and an already-started historical Run is not replayed merely
because its definition was converted. This source behavior does not certify the
loaded retained-data upgrade journey.

For a non-null frozen predecessor input, the current server claim/admission owner
may promote an ordinary queued or reclaimed Run into canonical Workflow custody
only before execution evidence exists. It converts that exact frozen input, not
the Automation's later definition, and retains the input bytes. A retained
encrypted template on a now-plain Account remains held for review. This server
boundary does not resolve the null-input migration above or authorize acquiring
a Session on a different Machine from its canonical runtime owner.

Current-development assigned inventory may carry `executionRecipeVersion: 2` for
an actual canonical recipe. Missing/null means unclassified, not legacy execution
permission. The existing Automation Run-detail route may carry a canonical
`workflowRun` identity and open its result through `workflow.run.get`; it omits the
historical recipe payload for that custody. Channels reply-handoff retry remains
the existing same-Run mutation, not a second Workflow executor or execution retry.

The retired `/automations/[id]` and `/automations/edit?id=` routes only resolve
the existing direct Automation read, then open the bound workflow's trigger
section or the Account trigger popover in Workflows. A deleted row lands in
Workflows with a not-available line; a transport failure keeps Retry rather than
claiming deletion. The full parallel Automation editor is removed, not the
retained template codec or historical data.

Current development trigger-set projections use the Automation's `templateVersion`
as their revision. Trigger authoring writes advance it in the owner's transaction,
including recipe-free removal and individual trigger CRUD. Current strict recipes
advance their outer `templateVersion` with the row
without opening or resealing private envelopes; retained 0.2 template bytes remain
unchanged. Trigger-local revisions remain independent. A delayed pre-removal list
therefore cannot replace the newer removal result in the shared UI store.

### Workflow Session input admission (development)

Typed Session inputs confer no authority by themselves. Current admission records
per-leaf `sessionAuthorityBindings` only after exact target resolution and the
starting principal's current Session-corpus check. Session-authored direct and
trigger starts retain their own/led restrictions; person-authorized starts use
that person's current access. A matching retry after a lost start response
returns the existing Run receipt (`admission: 'existing'`) after checking that
the accepted authorization is still current; it does not re-run target
admission or widen the retained witnesses. Every effect that uses a target
re-checks current Session access at execution time. Runtime Actions resolve the existing run/logical-invocation/attempt
correspondence against the accepted leaf and its exact lexical frame, so one
child's target never becomes another child's authority.

The signed ReviewComment principal carries that invocation's `workflowScope` to
Home. The scope, its addresses and its invocation identity are closed objects
covered by the existing Machine-installation signature. Home checks the Run's
assigned host, invocation slot and current Session access again. A snapshot or
principal without the new witness cannot extend origin-only authority. These
undeployed 0.3 producers and strict consumers move together; an older consumer
rejects the extended header rather than granting broader authority. No schema
migration, reverse writer or older-development compatibility mode is added.

Input/item-bound Agent engines and their finite accepted `engineBindings` are
closed development Workflow declarations and private snapshot content. Unknown
engine fields or choices outside the admitted roster refuse before execution.
They use the current 0.3 direct cut; no predecessor reader or reverse writer is
added for these undeployed managed Workflow shapes. Native Workflow activity in
0.2 remains a separate contract.

The optional `authenticatedStarterV1` in the accepted Workflow origin is a closed
development fact, with closed qualified requester identity and request reference.
Only current authenticated direct-person host admission produces it; public
Workflow start inputs reject starter claims. It records a cause, never authority.
Existing snapshots without the fact remain unknown, and Session participants
consume it through the existing protected Action-attribution input. These
facts also travel on the closed Workflow approval caller for Account-bound
starter consent before any Session exists. Unknown fields are rejected, and
absence never identifies the Run owner as a person. No public Action input or
released V1 approval history changes. These undeployed producer and strict reader
shapes move together under the Workflow
direct cut; older development readers reject the field rather than silently
dropping its meaning. The inspected clean `../0.2` at
`29c845495702acde2824dae13067d8a09322b26b` has no current accepted-origin or
Workflow admission owner at these paths. No new transport epoch, server column,
migration, reverse writer or rollback adapter is introduced.

The current daemon may return a strict `launch_retired` detail with
`SPAWN_FAILED` after its startup owner verifies process exit and custody cleanup.
The Workflow Session creator accepts it only for the requested spawn nonce, then
uses the existing failed-invocation fact. This is a current 0.3 producer/consumer
cut; older spawn failures and retained Workflow rows without decisive evidence
remain unresolved, rather than gaining proof from their error code or age.
No persisted format, migration, rollback adapter or timeout is added.

Current development Session-conversation reuse refusals retain their existing
codes and carry optional `WorkflowConversationUnavailableDetailsV1` facts through
`WorkflowActionFailureV1Schema` and invocation progress. These closed objects name
the rejected selection or resolver check and include only expected/observed kinds
and non-secret identifiers. Configuration values, credentials, prompt text and
working-folder paths are not diagnostic payloads. Missing retained delegation
depth and deleted origin Sessions use the same diagnostic owner. The daemon writes one structured
file-log event at the refusal; `workflowProblemPresentation.ts` renders the same
facts from Actions and persisted Run detail. Model and permission intents remain
Session Pending decisions, and inactive Sessions remain eligible for the existing
resume path. No reuse eligibility or lifecycle decision changes.

Historical progress and refusals without details remain valid. The Workflow
feature is an undeployed direct cut: these strict V1 diagnostic additions move with
its current readers and coordinator, without a released-reader or rollback shim.

Workflow cancellation in current development targets the same Run across claim
and progress writes. Its existing `expectedRevision` field is an observed lower
bound: a newer revision may be stopped, while a future revision or terminal Run
still refuses. The server applies cancellation against the current revision under
the existing publication locks. Pause, resume, replacement and recovery retain
their exact currentness checks. Terminal cancellation and settled execution or
publication custody remain separate facts; accepting Stop does not invent proof
that an admitted operation stopped or a Discussion reply was delivered.

Current development Workflow definitions accept declared decisions beyond
`continue | stop`, including strict `{decision, reason?}` results, and input-bound
`until`/`evaluate` round limits. Admission freezes a positive safe integer; inline
Workflow frames retain their resolved inputs in sealed body progress. Loop
closing records add a strict decision/stop-condition/exhaustion outcome; exhaustion
now completes successfully. Existing `continue | stop` and bare-string results
remain accepted, and existing iteration-array result paths remain unchanged.
Current authored references additionally accept a value-only item `path` and
the `last` array result-path segment. Numeric array paths and object properties
retain their meaning. Older development readers reject or misinterpret these
new forms; the current reference schema and input resolver move together.
This is an undeployed Workflow direct cut, not a released-format compatibility
shim. Old development readers cannot execute these new definitions correctly;
use the current admission and coordinator together. No new rollout mode or
dual writer is introduced.

Inline Workflow body progress also retains the selected project workspace as
`frameProjectWorkspace`, including its generated-checkout creation intent.
The frame's separate `workspace` pair owns the child's lazy generated default.
Current readers preserve and verify both pairs on resume; a deleted or mismatched
recorded checkout is unavailable and is never automatically recreated. New
generated frame-project names use a project-slot suffix; the child's default
keeps the invocation-qualified default name. Recorded intents keep their names.
Explicit restoration resolves an unmaterialized child's default through the
canonical frozen ancestry owner. A frame can propagate either slot's failure,
so restoration verifies all its recorded generated pairs before publishing a
replacement attempt; it does not guess the failed slot or recreate a checkout.
This is the same
undeployed direct cut: the strict V1 private progress shape changes with its
coordinator and readers, with no older-development reader or rollback shim.

Workflow child prompts use Session input admission protocol V2 with the invocation
purpose and Workflow Run provenance. Direct final-result delivery no longer writes
a Session Pending input: the origin runtime pulls current Run state into the host's
context-only WorkerUpdate slot. Neither path invents an Automation id or uses
Automation reply handoff. Updated Session readers
accept both V1 and V2 request, provenance and settled-authority records, while
Automation and other incumbent V1 writers retain their existing shape.

Automation workflow definitions use the strict stored recipe epoch `v: 2` in
the existing private Automation definition body. They have no synthetic legacy
target projection (`targetType` is `null`). At occurrence admission, the
incumbent Automation transaction creates the parent Run and attaches its opaque
definition envelope; occurrence evidence remains a separate frozen Automation
envelope. Before root coordination, the assigned daemon binds its canonical
payload to declared inputs exactly once and seals the immutable accepted
workflow snapshot used by origin-neutral Runs. Actual 0.2 templates remain
readable through the canonical trigger conversion owner, and retained Run data
through the historical Run readers. The stored strict one-shot read shape is
not an adapter for obsolete copied Workflow definitions.
Retained 0.2 flat-template prompts stay literal, including brace text, when run
or explicitly converted to a Workflow; native current one-shot input-token rules
do not reinterpret or restrict those historical prompts.

Conversion in 0.3 development keeps the exact Automation id and therefore its
Channel binding. Existing-Session conversion uses that Session's authenticated
Agent identity and actual project/Machine, not an arbitrary retained assignment.
The shared trigger owner writes the inline recipe through the existing Automation
revision CAS; unsupported templates remain unchanged with a typed
`legacy_conversion_unsupported` reason. Retained encrypted templates on plain
Accounts require the present-user review and Save described above.

Predecessor recovery follows the Account-transition and retained-Session paths
described above. The 0.2 transition to plain could leave Automation ciphertext
whose outer template requires genuine historical Account material; its embedded
Session key does not decrypt that outer template. Plain/no-Session-target rows
can be explicitly recovered to canonical plain content through the existing
converter and `templateVersion` CAS. Templates bound to retained E2EE Sessions
stay encrypted and paused until present-user review and confirmation. A key-holding
device opens the local review through the authenticated Session/historical-material
path, then Save writes the normal Account-plain Workflow; the Session itself stays
E2EE. A keyless reader stays locked with deletion available. Historical material
stays in existing custody; discarding it is an explicit user action, not a generic
reader fallback or recreated Account key.
These implemented development paths do not certify a loaded runtime or release.

The current development trigger context replaces the earlier copied-definition
payload in place. It seals workspace, execution target, constant inputs, optional
role overrides and either an inline definition or context for the row's live
`workflowDefinitionId`; the assigned Machine remains in Automation assignments.
`readTriggerTargetV1` rejects missing or ambiguous targets. Library, `builtin:`
and qualified `plugin:` references share one parser; parsing does not establish
catalog availability. This is not a released V1 format change. Direct admission
and Automation claims share the Protocol accepted-snapshot materializer: it
normalizes the program, freezes role overrides and child definitions, derives
the effective permission ceiling, applies ORC policy, checks the assigned
Machine's targets, then seals. Unsupported catalogs fail closed. Frozen
`causeWorkDepth` travels in the Automation claim receipt,
not private trigger input, and scoped conversation causes may carry `triggerId`.

Saved-definition admissions freeze `source.savedBy` for direct and Automation-origin
Runs. The field is required for a saved source; an explicit null records a header
without authorship. It is private display metadata, not execution or authorization
authority. Accepted Runs never re-read the mutable header to recover authorship.

Accepted development snapshots require `workDepth`, `authoredDefinition`,
`materializedLeaves`, `frozenChildren` and explicitly nullable display metadata.
There is no pre-materializer snapshot fallback. Fresh
Session and detached Agent steps receive the accepted depth plus one; protected
Workflow input and provenance depths must agree. `profileId` denotes a Launch
Profile, never a plugin execution-run profile. Detached steps freeze portable
Launch Profile defaults at admission and refuse nonportable profile behavior;
dispatch does not look up execution-profile custody. Loaded-runtime and package
validation of this finalization remains tracked by the implementation lane.

The internal Workflow storage admission operation accepts only a direct origin,
and its authenticated publisher Machine must equal the target Machine. An
Automation occurrence never enters through that route: its canonical Automation
transaction creates the parent and attaches the Workflow body there.

At `accepted-snapshot.resolve`, a scoped Automation freezes its Account-owned
`scopeSessionId` into the Run's `originSessionId`; the server checks both the
current scope and Session ownership. This context does not change the Run's
Automation origin or immutable cause. Explicit originating-Session delivery
initializes the same acknowledgement as direct admission; otherwise it remains
null. An exact acceptance replay uses the frozen scope and delivery choice,
preserves an advanced acknowledgement, and does not reread a later scope edit.

Development Run projections retain a nullable `sourceArtifactId` frozen at
direct admission or Automation accepted-snapshot attachment, plus
`ownerAccountId`. Inline/catalog Runs retain a null source; private snapshots
are not server-decrypted to infer a source.
`workflow.run.list` without a source filter lists the caller's own Runs. A source
filter selects that workflow's caller-visible history. Current development
Team visibility requires the Run's exact frozen Team grant on the source
Artifact and the caller's live effective membership in that Team; personal or
other-Team grants alone do not preserve it. Exact reads, source-filtered history,
summaries and recipient-key census consume the same Run access owner.
Cursors bind both Account and source/filter scope. `workflow.run.summaries`
has two exclusive development request shapes. `{sourceArtifactIds,recent}`
retains saved-workflow latest, recent and Needs-you facts with byte-bounded
`remainingSourceArtifactIds`. `{automationIds}` returns each requested
Automation's latest caller-admitted managed Workflow Run status, or an answered
null, with byte-bounded `remainingAutomationIds`. Latest order is
`createdAt DESC, id DESC`; inline sources and different Automations sharing a
saved source retain distinct Automation identity. Requested ids filter access;
they do not grant it. The Automation result contains public state, custody,
attention and creation time, not accepted snapshots or private progress.
Its capture is released before result materialization and exact byte paging;
returned Run members undergo fresh admission before disclosure. Neither shape
imposes a row-count cap. Remaining ids preserve input order and are unanswered,
not null results.
The development attention list accepts an explicit `projection: 'membership'`
for consumers such as the closed Inbox badge that need admitted membership but
not private display facts. Omission keeps the full list projection. Membership
does not open or transfer accepted, root or held private content; its explicit
response marker distinguishes unrequested private facts from an opened untitled
Run or unreadable content. Membership updates the existing window's ordered ids
and paging frontier, not the full Run-body map. Exact readers therefore retain
their normal missing-body acquisition, while the durable Account change applier
continues to materialize changed Run bodies before advancing its cursor.
Private destination, Discussion and subtree filters
and requested invocation provenance require the full projection. Both modes use
the same attention predicate and fresh Run admission; no server decryption or
second badge cache is introduced. Cursors also bind the projection. The existing
response-byte boundary still owns paging, so a thinner page may contain more
valid rows. An open Inbox or Work consumer promotes the same window to full
private display demand, including when a membership read is already in flight;
refresh retains the previously loaded ordering frontier. These undeployed 0.3
producers and consumers update together, without an older-development adapter.
List, detail, wait and summaries share the server's attention predicate: failed
Runs, or non-cancelled Runs with actionable invocation rows. Accepted managed
Automation Runs use this Workflow predicate and are excluded from ordinary
Automation attention, so a failure without a Session still appears once in Inbox.
Linked step Session attention folds beneath the same Run. An interrupted state,
pending physical Stop custody, failed origin delivery or a settled exhausted
result alone does not add attention.
Lean list rows expose `attentionRequired` from that same membership, including
exact Run reads used by Boards. Other projections may omit it; omission is
unknown, not false. Ordinary child-row wakes refresh this fact without advancing
the parent control revision; aggregate attention-membership changes advance the
existing parent revision as described below.

Workflow Session inputs use the current input-admission owner directly. There is
no older-daemon capability preflight or V1 downgrade before creating or mutating
a Session; the strict input/provenance parser still rejects malformed content.

Each Workflow invocation input has one protocol-derived stable identity including
its exact invocation record. Ordinary Session steps use the existing Pending queue;
`origin_session` steps use the required context-only `workflow_step` input and the
origin's input-admission owner. Originless admission refuses an `origin_session`
leaf with typed `invalid_input`. The producer freezes its rendered text alongside
the admitting correspondence; the origin consumes that exact text without a
second role or result-contract renderer. General authored/recovery input can exist
before rendering, but an origin input cannot be consumed without its frozen text;
this is a current admission phase distinction, not an older-snapshot reader.
Only the input owner decides withdrawal. A positive host
event restores dispatched custody after restart; a missing event does not prove
withdrawal. Permission settlement and the exact-turn transcript observer remain
authoritative. An omitted Workflow timeout selects explicit no-deadline observation;
a supplied timeout starts at the accepted host event and is not restarted on rejoin.

Origin Run delivery stores nullable `originDeliveryAckRevision`: null disables
delivery, and enabled admission initializes it to zero. The origin reads current
snapshots above this acknowledgement and advances it monotonically only after
provider acceptance. Aggregate attention-membership transitions advance that same
Run revision: the first hold above a zero acknowledgement and a later re-entry
after acknowledgement are deliverable, including when the origin reconnects.
Ordinary child facts remain row-local; siblings entering or leaving a hold while
the Run still needs attention do not advance its revision. Fact acknowledgements
include `parentRevision` from the same storage transaction; workers adopt it
monotonically before their next parent CAS. A failed acknowledgement for one Run
remains retryable without stopping delivery for other Runs in the origin Session.
Pull and exact Run reads use the shared attention predicate, so admission
rechecks reject a resolved
or superseded snapshot. There is no second delivery cursor or replay of resolved
holds. Delivery does not hold invocation custody. The retired
`result_delivery` input purpose and `workflow_result_delivery` provenance are not
accepted by current development readers; the distinct Automation/Channels reply
handoff remains unchanged. This is an undeployed Workflow direct cut, not a released
Session V1 removal. Package and loaded-runtime verification remain pending.

Workflow-only `attached_run` execution is retired in current development source
(FIN U5 feature removal). Workflow targets are Session or detached Background run;
the retired target and its private correspondence are rejected, not reinterpreted
as Session execution. Native Session-attached Execution Runs outside Workflows
remain unchanged. Detached starts require the real initial prompt.
The daemon derives the Run identity from the existing
host-stamped Action request id for the exact Workflow input, so a response loss
or failed correspondence write rejoins the already-started Run instead of
starting or sending it again. This is Run-manager idempotency over the existing
Workflow input identity and Run registry, not a second Workflow receipt store.

Boundary Resume's content-free `workflowResumeRequestedRevision` is a nullable
Run column and an optional field on the closed V3 Workflow claim and existing
claim receipt. A successful claim clears the column in the claim transaction
and passes the consumed revision to the current worker; a replay of that same
claim preserves its disposition, while a new claim omits it. Pause or Cancel
supersedes an unclaimed Resume. Null storage means no pending Resume, and absence
from a claim means it consumed no Resume; neither is an old-row compatibility
fallback. Managed Workflows are undeployed and have no released or 0.2 predecessor
seam: current server and worker are refactored in place, with no obsolete
development shapes or guessing from checkpoint pause state. Ordinary current
one-shot Automation claims carry no Workflow Resume request.

Workspace restoration is an explicit development-only `workflow.run.resume`
recovery choice. The server projects only coarse eligibility from public Run
state and the existence of an execution row; the authorized client opens the
selected private progress and qualified frame-owned correspondence and requires
recorded creation intents and Git worktree descriptors before offering Restore
workspace. Execution is routed to the exact Machine frozen in the accepted
snapshot, verifies only those recorded checkout paths through the incumbent
SCM currentness owner, and publishes the new
attempt under the same expected-Run-revision check before any retry work starts.
It never falls back to a suffixed or newly selected checkout. Because managed
Workflow Runs remain development-only, this closed Action/availability addition
updates the current protocol in place and establishes no released mixed-version
compatibility adapter.

Recovery eligibility belongs to the shared Account Run Action owner, which uses
exact input-owner observation and current conversation capability; prepared
continuation content is not eligibility evidence. Missing workspace and a stop
acknowledgement do not prove an input inactive. Replacing proven-stopped input
with uncertain effects additionally requires acknowledgement for that attempt.
Reattach observes the recorded input without starting, sending, or allocating an
attempt. Its signed Machine fact write uses the existing `invocations.fact`
operation with the exact row's `expectedContentRevision`, the observed parent
`expectedRevision` and `resolution: 'observed_terminal_execution'`
instead of a fabricated worker `parentAttempt`. The server requires the exact
assigned interrupted Run with pending custody and the current invocation; it
permits only observed settlement, preserving the parent revision and claim.
The incumbent claimed-worker fact shape remains unchanged. This observation
arm is development-only and changes no persisted format or released contract.

Managed Workflow Runs are origin-neutral `WorkflowRun` rows driven from the frozen
accepted snapshot; observed Claude activity snapshots remain presentation-only and
never drive the coordinator. Schedule and occurrence admission freeze the reviewed
definition plus applicable Artifact revision: later library or Automation edits
affect only future admissions, never admitted Runs. All 0.3 components update
together; older-component interoperability and rollback are unsupported. There is
no reverse migration, dual write, Workflow compatibility mode or rollback-only writer.

Current-development root progress optionally retains accepted destination leaf
labels and exact last-observed invocation facts in `stepProgress.destinations`.
The same root envelope/currentness projection carries them through lean Run
lists; no public database columns or extra history reader are added. Counts-only
root progress remains readable, and a missing leaf observation stays unknown.
Observation ordering uses the existing unique per-Run physical sequence
and the exact record's content revision, including after reload. This is an
in-place 0.3 addition, not an older-component interoperability promise.

The current-development review cut adds invocation and parked-parent
`waiting_for_review`, canonical decimal `contentRevision` on every invocation,
and the outbound `review_required` update kind. Current producers and consumers
move together. Decimal strings are the current lossless JSON representation of
database BigInts, not a historical-format reader. Only a current completed invocation exposes successful result
data; a stored draft alone is not completion. Private Workflow payloads now use
per-run keys and strict owner/Run/purpose bindings. Pre-cut development content
is intentionally unreadable, without a dual-key reader or historical reseal.
The inspected `../0.2` Workflow owners are absent at
`17ba05df68d4d3d4cad1c1241b58e63805db37ed`; ordinary Automation and Session
data remain separate predecessor obligations.

Current-development Workflow Actions preserve `history_not_readable`,
`encryption_setup_required`, and `waiting_for_keys` from the per-Run key owner.
These are distinct from malformed private content (`content_unavailable`) and
an unavailable storage boundary (`storage_unavailable`). Recognized database
failures at Workflow storage HTTP admission return 503 with the latter code;
unexpected application exceptions remain with the global error owner. A failed
read never establishes mutation currentness or an empty successful result.
The review UI keeps a fieldless Wait's card and disabled Continue visible while
its exact evidence is pending or unavailable, and offers reason-specific recovery.
Only successfully read exact evidence can enable mutation. This is development
source behavior, not verification of a loaded QA runtime or a released contract.

The current Account-transition inventory GET reads the captured Home directly,
without an older-server feature probe or inventory-426 translation. Request failures
remain failures rather than a fabricated empty inventory. This development cut does
not activate dormant V5 or downgrade current requests to predecessor transition wire.

### Same-machine session handoff (development)

Same-machine handoff extends the current V3 operation without another transport or
persisted shape. Path-backed Sessions require an explicit, different local target
before the source stops. Managed Sessions retain their existing private-directory
allocation. The existing local durable bundle path works without a network transfer
carrier; the `sessions.handoff` feature decision still applies.

Source cleanup shares the target job locally, requires completed target commit, and
must not stop the successor by Session id. Abort preserves an already completed job.
Tracked cancellation remains available during preparation and closes before target
launch, which begins publishing the target's canonical Session metadata. The accepted
launch then completes confirmation, commit, and cleanup through its existing nonce
observation owner. This is development behavior, not a released rollback guarantee.
Predecessor request adapters and cross-machine transfer contracts remain seam-owned;
unsupported operation versions fail before execution rather than pretending to move.

### Existing native session-state handoff (development)

The development handoff contract adds optional `stateTransfer: 'transfer' | 'existing'`.
Omission preserves transfer. Existing-state mode verifies the exact Agent-native Session
already on the target rather than exporting/importing its conversation data; it rejects
copy payloads and requires `workspaceAction: { kind: 'none' }` (or its omitted equivalent).
A managed directory that requires allocation/materialization is not an existing-state target;
that carrier is rejected at the shared Action/start/prepare policy boundary.
Same-machine explicit existing-state uses the same resolver and lifecycle; topology does
not silently change a default transfer into existing-state.

The current V3 capability and read-only existing-state check are negotiated before source
mutation. Missing, malformed or predecessor V2 capability cannot authorize this mode:
the operation reports an update requirement, and the caller may explicitly choose transfer.
The development UI keeps transfer on by default and disables the option when either peer cannot prove
support. Its Action adapter preserves explicit `existing`, disables workspace copying, and
keeps `existing_session_state_unavailable` inline in the picker. Turning transfer on and
submitting again is an explicit choice, never an automatic fallback. Same-machine moves
hide the toggle and retain ordinary transfer. The current 0.2 predecessor's V2 `existingState` bit does not prove V3 support.
Its V2 carrier and the current V3 request must never be silently reinterpreted across versions.

Agent plugins provide the optional public-SDK `handoff.resolveExistingState` hook through
current generation-bound execution surfaces. It returns the same native identity, source
and launch hints as import, but must not copy or repair native state. Claude resolves the
exact transcript in the target's effective config root, including a re-homed project; Codex requires
the exact native index row and its existing rollout in the target's effective native homes.
An unsupported Agent or missing state fails closed, with transfer offered as the remedy.
Target preparation and final launch recheck the native state under their effective environment;
when the host supplies the complete effective child environment, plugins do not restore
native-home variables removed from it by falling back to the daemon environment.
the final check is not a second state-action owner. The ordinary confirmation/commit/abort
owners remain authoritative. Governed callers retain exact accepted Session and Machine
authority for the read-only preflight rather than borrowing ambient custodian authority.

This is development source behavior, not a released compatibility or loaded-runtime claim.
The feature's integrated and live evidence is tracked in its existing execution lane.

### Workspace-sync handoff rollout

Workspace handoff is operation-scoped across UI, daemon, and Machine RPC versions. A current
client may send the canonical `none`, `copy_once`, `create_relationship`, or existing
`relationship`, or `linked_workspace` action only to a daemon that understands that exact action. A predecessor daemon
that cannot execute the requested workspace action returns
`workspace_sync_update_required`; the client keeps the connection and unrelated Machine/session
operations usable and asks for that daemon to be updated. It must not reinterpret the request as a
legacy file-transfer job or report a successful handoff without the workspace result.

The development-line `linked_workspace` choice carries only the target Machine/path in the
public Action. The current daemon resolves the admitted Session's source and the exact target
WorkspaceRefs from its current Account settings, then invokes the controller-owned
`daemon.workspaceSync.prepareBetween.v1` operation. A controller without that exact method
returns `workspace_sync_update_required` for the linked operation; the caller must not silently
fall back to a direct copy or claim that a first completed link prepared the destination.
The result records only the links actually traversed and their observed statuses. A later
retry starts a fresh route check, not a persisted cursor or replay of the second link.

The development-line devcontainer bind-workspace extension keeps the admitted child
Machine and Session as the execution identity. Only physical workspace work is routed
to its current controller, through the existing Workspace Sync RPC family. A parent
without the exact private `daemon.workspaceSync.handoffSourcePhase.v1` member returns
`workspace_sync_update_required` before Session quiescence or Agent export; there is
no SSH, legacy-copy, or generic parent-Account fallback. The installed child socket
retains the original child admission, actor and caller constraints. Home verifies
that scoped routing, while the parent rechecks the current child relation, controller
installation and native bind root before preparing or finalizing a write.

Source commit and abort release only the exact operation and original context retained
by the existing parent preparation owner. They can settle that custody after source
adoption, cancellation, native replacement or withdrawal of the original actor's grant;
they do not restore effect authority or reuse a retired borrower credential. Current
installed-child custodian transport and parent installation/Home authentication remain
required. An unavailable retired child socket cannot manufacture cleanup authority.
This private routing does not expand public Session-handoff or Workspace Sync policy:
a missing scoped chosen-target producer fails closed, and reaching a physical parent
with the daemon's ambient custodian credential is not admission to the chosen child.

The current daemon remains the sole relationship-settings writer and uses the external Mutagen
sidecar as the sole reconciliation engine. Mutagen session identifiers and private broker details
are daemon-local implementation state, not wire or persistence compatibility contracts. A missing
verified external engine artifact is an `engine_unavailable` failure for the requested workspace
operation; it does not authorize a fallback to the retired replication engine.

The current development Workspace Sync extension retains pairwise relationship persistence and
derives linked sets from their existing WorkspaceRefs and controller roles. It does not persist
a group or rewrite valid beta-controlled two-way relationships. Direct Project creation uses
`workspace.sync.relationship.create` and the same relationship writer and destination approval
owner as handoff; it cannot disguise existing-folder attachment as an older handoff request.

Current status replaces the unmeasured `changedFiles` field with no substitute count and names
the process-local cycle observation `lastCycleObservedAtMs`. Endpoint scan/transition problem
facts come from the matching engine producer. Missing endpoint evidence is unknown, not clean.
The controller's clean-result predicate gates dependent execution and fresh/recovered Copy once;
raw manual Flush remains a diagnostic operation. A completed cycle does not establish immutable
inputs or global convergence.

The 0.3 development Machine publication is a readiness-only invalidation signal,
not a second private relationship-status channel. The existing daemon-state version
orders that signal; current UI consumers refresh admitted status/conflict reads for
their demanded exact Home/controller scopes and retain last-known values while
refreshing. Full relationship detail, cursor invalidation and stale-response
rejection remain owned by those existing private reads and stores.

Ordinary Machine metadata/state publishers share the strict publication contract in
`machines/machinePublishedContentV1.ts`. Stored readers tolerate additive or retired
fields and retain supported predecessor host facts, including
`startedWithCliVersion`; UI metadata still treats malformed optional CLI-update
facts as absent. Their new writes do not echo retired private Sync fields or unknown
peer/transfer bags. Tolerant reading does not migrate the retained blob: wider key
delivery must check the entire opened current content and its committed versions,
or remain pending until an authorized custodian rewrite. The incumbent legacy
content-key transition intentionally rekeys the exact opened bytes; it is a retained
content transition, not an ordinary publisher or a second privacy projection owner.
Converting that key cannot make unsafe retained content eligible for delivery.
This refines unshipped 0.3 source in place; it is not a loaded-runtime or release
safety claim.

Machine grant and Team membership effects consume the same canonical effective
access union before and after the complete mutation. The existing membership
wrapper captures Machine and Session impacts together; a surviving direct, Team
or Group grant must not be treated as final loss. Final actor-room invalidation
occurs after commit without deleting Session history or retained AccessKey bytes.
This is incomplete development source: socket disconnection alone does not certify
settled Session or process cancellation.

The development Machine content-key lifecycle reads predecessor owner data with
either an absent legacy-secret envelope or an Account-key envelope, then converts
both ciphertexts and the owner envelope as one conditional state. Conversion
preserves the opened blobs rather than treating a tolerant read projection as a
privacy migration. New E2EE Machines use random resource keys; Plain Machines do
not allocate key material. Registration adopts the returned winner and does not
independently replace an existing envelope or ciphertext. New encoded writers
send the exact owner-envelope identity and expected content revision; recipient
opening envelopes remain separate from this `keyBasis`. Retired writers refuse,
and a lost transition acknowledgement is observed without automatic replay.
Current contexts, caches, hydration and RPC use the existing update carrier.
These wire refinements replace unreleased 0.3 shapes in place; historical reads
are custodian-only and malformed present envelopes never become legacy or Plain.
Shared recipient preparation observes the authenticated custodian Machine and
runs that existing conversion before the strict current-holder census. Foreign
Manage holders retain their delivered key tuple, not historical custodian reads.
The development grant projection carries member-level compatibility and key
recoverability separately from grant-edit authority; both initial continuation
and Retry consume its canonical `canPrepareKeys` result.
This describes current source, not a successful composed runtime certification.

Reviewed conflict resolution refines the development Action in place: source and explicit
destination entry expectations are required, including complete structural identity for a
directory replacement. Historical approval records remain readable, but an older loser-only
pending request cannot execute by fabricating a reviewed source. Captured bytes use the existing
finite transfer, and target authority rechecks the approved effect. Partial and unknown outcomes
do not authorize automatic replay or unattended application to a later-reconnecting endpoint.
These current-development shapes do not create a second resolver or a compatibility alias for
an unshipped input. Exact operation support must be checked before effect; unrelated operations
remain usable when that support is absent.

The development pin selects the published `0.18.1-happier.11` engine at
`0139d6755f7281c84899b207de3179235afe9b9e`, which supplies the extended compact engine
problem/selection contract. Existing daemons must load the updated CLI and acquire that verified
manager/agent pair before using it. The historical `.9` endpoint shape still returns
`workspace_sync_update_required`; consumers must not guess missing fields, accept a second
dialect, or silently run a dirty fork as a fallback. Source-built integration evidence alone
does not prove that an existing daemon has loaded the new engine.

The first capable client imports the retired local existing-Session text/semantic stores and the
singleton new-Session draft into the canonical draft repository. It removes each legacy value only
after the corresponding canonical record is durably acknowledged, so an interrupted import remains
recoverable. The legacy readers are migration adapters, not parallel writers, and may be removed
when supported persisted local state no longer requires them.

The 0.3 upgrade is one-way: every component updates together, with no supported 0.2/0.3
coexistence or rollback to 0.2. Drafts created on 0.2 remain supported data. The 0.3 reader
validates and preserves the published 0.2 `machineId`, `serverId`, `agentId`, `backendTarget`,
`modelId`, and `codexBackendMode` fields; its UI projects only exact safe equivalents into
canonical execution, Agent, and native-model selections. Canonical 0.3 fields, including
explicit clears, win over predecessor values. Current new-Session authoring writes the
canonical V2 document; an unavailable V2 mutation keeps the local draft and is not retried
as a V1 write. Existing V1 documents remain readable through the current payload union.
Remove historical-data reader bridges only when those persisted drafts are no longer
supported inputs; the absence of old running clients alone is not a removal condition.

Draft documents preserve bounded unknown extension fields as JSON. This lets a client without a
newer composer contribution edit fields it understands without deleting newer semantic data; it
does not authorize that client to execute the unknown contribution. Raw generic-file bytes, local
file handles and URIs, credentials, secret values, and local presentation state remain outside the
compatibility shape. Plugin semantic attachments, mentions, fallback presentation, and opaque
execution-target-bound staged-media handles may round-trip; execution still fails closed when the
owning plugin or target is unavailable.

### Session-owned run input convergence (development)

The development Action contract sends Session-owned run input through
`session.message.send` with an optional strict participant recipient. Main
Session input omits the recipient. `execution.run.send` requires explicit
`sessionId: null` and retains direct delivery only for detached runs; its
`prompt`, `steer_if_supported`, and `interrupt` modes do not become Session
pending actions.

Attached `execution.run.send` calls receive
`session_input_target_update_required` before a direct send. The approved 0.2
compatibility adapter keeps the released request parser for this refusal; it
must not approximate the old delivery modes or retry against the main Session.
Remove that adapter only when the last supported 0.2 UI/CLI-to-current-daemon
attached-send direction closes. Existing run and transcript records remain
readable. Attached chat follows `session.message.send` Action settings, while
detached chat follows `execution.run.send`; settings are not copied between IDs.

Targeted admission requires the exact target Machine's `sessionInputAdmission`
revision 2 and the nested execution-run pending resource
`POST /v2/sessions/:sessionId/execution-runs/:runId/pending`. Released servers do
not match that nested route, so they cannot strip the target and report a
main-Session success. Missing support must fail before relay or mutation, without
dropping the recipient; a target send never becomes a main-Session send, and an
unavailable capability snapshot is withheld rather than published as a false
negative.

The reachable directions are:

| Direction | Required behavior |
|---|---|
| Released client main send → current stack | `required` — unchanged. Main input carries no recipient, takes no target query, and pays for no capability check. |
| Current client main send → supported released server/daemon | `required` — unchanged. The existing no-target path stays usable. |
| Current client targeted send → released or partial stack | `required` — fail closed before mutation with the operation-scoped `session_input_target_update_required`; no row, no relay, no recipient-dropping retry, and unrelated operations stay usable. |
| Released client attached `execution.run.send` → current daemon | `required` — the same operation-scoped refusal through the retained released request parser. Detached `sessionId: null` sends keep working. |
| Current target rows → released-server rollback | `unsupported` after activation. No dual writer, mirror, or rollback-only path exists for target rows; recovery is ordinary Pending state. |
| Released persisted rows → current readers | `required` — old pending rows read as the implicit main target (`targetExecutionRunId IS NULL`); transcripts, sidechains, and markers stay readable. Old terminal transcript rows have no server-private Run binding, so main-message retry remains compatible while a targeted terminal retry that cannot prove its exact target fails closed rather than inventing a match. |

The nested target resource, its strict body, and the plugin-facing recipient
projection are undeployed 0.3 development shapes: refine them in place at the
Action and admission owners rather than adding a reader for a superseded
intermediate. These are operation-specific development contracts; the composed
live target-send and mixed-version gates must pass before the feature is
described as available. The delivery semantics themselves live in
[Pending delivery architecture](pending-delivery.md#execution-run-targets).

### Deferred Action approvals (development)

Released `ApprovalRequestV1` Artifacts remain readable as history using their
released closed status vocabulary. They carry no current replay authority: a
current attempt to execute one fails safely as `approval_stale`. Current
effect-bearing approvals use strict `ApprovalRequestV2`, including the immutable
execution origin admitted before the user is asked to decide.

Approval is not an execution lock by itself. After an approval decision, the
existing Artifact is the durable effect-custody owner:

```text
open -> approved -> executing -> executed | failed
```

The executor must win the Artifact compare-and-set from `approved` to
`executing` before performing the effect. A duplicate caller reads the winner's
state instead of running the Action again. Current policy, credential, Home,
runtime, target, and resource authorization are revalidated against the stored
origin. In 0.3 development, only unsigned host-CLI requests for Account-placed
Actions with durable input custody gain app replay through the approving app's
authenticated Home adapter. Signed/external and Session requests retain their
exact admitting daemon, including Account-placed Actions. Machine-placed,
plugin and live-only-input requests likewise retain their exact-daemon or
admitted live invocation custody. The immutable input, Action id, requester,
Home and Account remain bound to the Artifact. One-time results reach only the deciding app's
`liveExecution`; Agent reads, observations and durable history receive the
Action's material-safe projection. If the
effect may have happened but terminal persistence cannot be proven, the
Artifact remains `executing` and later callers receive
`approval_execution_outcome_unknown`; they do not replay blindly.
Current V2 terminal receipts also record whether the Action effect was attempted.
Direct `approved -> failed` settlement records `effectAttempted: false`; terminal
settlement after the `executing` claim records `true`. Existing development V2
records without this presentation fact remain readable and do not gain inferred
execution history.

Canceling an approved but unclaimed V2 request preserves its approval decision
and settles it as `failed`, with `approval_canceled` and `effectAttempted: false`.
The same rule applies to development target/plugin approvals. Repeated cancel
or approve decisions return that terminal receipt. The transition owner rejects
this cancellation receipt once the request is `executing`; its Artifact CAS
also refuses a claim that races the cancellation write. Open requests retain
their existing `canceled` settlement, and released V1 history is unchanged.

The Artifact header is an index, not authority. Current readers hydrate the
body, validate its strict approval-family schema, and require every duplicated
header field to agree before presenting or acting on it. A contradictory or
unknown body/header combination fails closed.

Managed-Machine Delete approvals duplicate only a domain-separated subject key
for `(Home, managedId)` into that index. Accepted Delete retirement queries the
existing Artifact index by this exact non-content key, then revalidates the body
and uses the normal revision-fenced approval update. A transient refusal leaves
the accepted Delete successful; the next accepted-delete/currentness transition
retries the same lifecycle convergence without a timer or Inbox-side filter.

Project Service Starts in 0.3 development use the existing private
`approvalSubjectKey` header index to identify the SOURCE Machine/checkout before
mounting body readers. This private Home/Account-scoped index hashes only Machine
and checkout ids, contains no command or Service name, and grants no execution authority. A supplied hint must agree with
the strict V2 body. Headers without this development hint remain readable;
Project observation can reuse an already-admitted local body to select them,
but does not hydrate unknown identities across the Account. Released V1 history
and predecessor V1 writers are unchanged. A Service census shares demanded
Devcontainer child facts only for that observation; reconnect or a real later
observation reads them again, including after a failed read.

This is an in-place development evolution, not a second approval store or a
backfill requirement. Undeployed target/plugin approval schemas may be refined
in place through the same Artifact owner. Released V1 bytes and readers remain
the historical compatibility boundary.

For live-only target/plugin approvals in 0.3 development, the original admitted
invocation retains the confidential operands and the same approval Artifact id
through settlement. Its captured Account/Home writer publishes the terminal
outcome, effect-attempt fact and any admitted operation-credential identity on
that Artifact. Neither confidential input nor handler output is persisted by
this receipt path. Success, failure and uncertain execution retain the original
requester and execution origin; an unacknowledged receipt write reports
`approval_execution_outcome_unknown` without retrying the effect. Once the live
waiter is gone, another approval attempt remains `approval_stale`; history is
read through the existing approval reader rather than replaying the operands.

Storage proposals in 0.3 development optionally retain `storageRetryResults`
inside the same strict V2 Artifact. This is an append-only list of strict settled
Pile results, limited to the original execution's unsuccessful items with distinct
batch and Trash entry ids. The transition owner preserves the terminal status,
original subject, decision and execution; the field supplies no replay inputs or
authority. Existing V2 records without the field and released V1 history remain
readable. The predecessor has no Storage proposal or V2 execution contract;
current development V2 writers do not promise rollback to those V1 readers.

## Ephemeral Runner release compatibility (development)

`happier-runner` is a 0.3-only release product. Its strict V1 release manifest is
owned by `@happier-dev/release-runtime/releaseManifest`; the publisher validates
what it emits and the server is the only public-release acquisition adapter.
Activations pin product, version, target, and lowercase SHA-256, so an existing
activation never follows a rolling tag. The creator downloads the exact archive,
checksums, and Minisign signature named by that verified projection and applies
the same release-runtime verifier before local package assembly. It also requires
the archive basename to encode that exact product, version, and target before it
performs any network acquisition. An exhausted immutable release-tag `404` means
the version is not published; transport failures, other HTTP statuses, and
malformed publication metadata remain a retryable publication-unavailable result
rather than being reported as positive absence. The signed
checksum envelope carries the Runner archive's exact compressed byte size and
closed entry list (path, kind, expanded size, mode, and link target when
applicable); the release manifest and Home-safe projection must agree with that
signed metadata. Acquisition rejects compressed-byte overrun or underrun, and
assembly rejects any missing, extra, colliding, unsafe, or size-mismatched entry
before the package is usable.

Current 0.2 clients and servers have no Runner activation or runtime contract.
New clients hide Temporary computer against an old server; old clients continue
ordinary Session and persistent-Machine operations against a new server, and a
materialized Runner Session remains readable as an ordinary Session. No dual
Runner manifest, token, activation, or socket shape is retained solely for
unreleased 0.3 work. Existing Machines retain effective `persistent` kind.
Shared V1 manifests for released non-Runner products remain readable without
Runner archive metadata; those products neither emit nor interpret these fields.

The `EphemeralRunnerActivation` table is a 0.3-only Home-owned record with no
predecessor shape to read or write. Its strict V1 lifecycle advances one way —
`pending → claimed → consented → materialized` — and every pre-materialization
state can instead reach `closed` carrying one of `canceled`, `declined`,
`expired`, `revoked`, or `failed`; each closing transition is conditioned on that
pre-materialization set, so a materialized activation is never retroactively
closed. `apps/server/sources/app/ephemeralRunner/activationLifecycle.ts` owns
closure and erasure. Deleting the creator's draft closes that draft's
pre-materialization activations in the same transaction as the draft tombstone,
and Account erasure closes every remaining pre-materialization activation as
`revoked` and then deletes only `closed` rows. A materialized activation is
deliberately left to the Session deletion owner, which removes the row with its
Session (`apps/server/sources/app/session/delete/deleteSessionTree.ts`), so an
orphaned materialized row keeps blocking Account deletion instead of being
hidden by a cascade. Nothing outside 0.3 reads this table, so rolling back to a
build without the Runner contract leaves these rows unread rather than
reinterpreted.

The strict V1 activation-create request may carry the optional literal
`authorizeUnattendedTeamAccess: true`. Omission is the safe compatibility shape:
the activation remains usable for independently authorized personal/direct work
but cannot satisfy a restricted Team's authentication policy. When present, the
Home copies only current evidence from the verified creator credential into the
activation's server-owned snapshot. That intent and snapshot are never written
to the exported activation package or endpoint projection. The exact materialized
Runner token carries the currently valid evidence in signed V2 provenance; every
restricted Team selection, readiness, Session creation, broker open, and broker
effect re-enters the canonical Team-authentication qualifier.

The development-only 0.3 Provider broker grant also carries the exact opening
signed credential's `initiatorTokenEpoch`. Broker open and every subsequent
request or model-catalog admission recheck it through the same Account revocation
owner as bearer authentication. Signing out everywhere therefore ends existing
broker authority without turning the tunnel-opening expiry into a runtime
lifetime. This is a strict direct cut: grants without the epoch are rejected,
not upgraded from current Account state. PAT credential-row revocation remains
independent; ordinary PAT bearers cannot open this broker route.

The published payload is never the bare Bun executable. Bun 1.3.5 established
that the standalone runtime exposes its embedded CLI dispatcher when `BUN_BE_BUN`
is inherited; the current 0.3 development pin reproduces that behavior through
`scripts/pipeline/release/bun-runner-hardening.test.mjs`, which reads the canonical
`apps/stack/scripts/provision/.bun-version`. Therefore the
shipped product is the Rust shell in `apps/cli/runner-native-shell`, which refuses
unknown arguments and clears the environment before spawning the Bun core as a
nested sidecar. Release admission rejects any candidate that reaches the embedded
dispatcher. Per target the archive contains exactly one payload root beside the
adjacent `happier-runner.activation.json` the creator client adds: Linux ships one
AppImage named `happier-runner` that contains the core as a bundled sidecar;
Darwin ships `Happier Runner.app` with the core at
`Contents/MacOS/happier-runner-core`, which the builder asserts before archiving.
`packages/protocol/src/ephemeralRunner/runnerPackageLayout.ts`
owns that layout and the publication-eligibility list;
`scripts/pipeline/release/lib/runner-packaging.mjs` is the release-side mirror the
builder, asset preparer, and admission all consume, pinned to the Protocol source
by `scripts/pipeline/release/runner-native-shell.test.mjs`.

Linux x64 is the first publication-eligible build/publish/smoke target. This
eligibility lets the release owner produce and validate an immutable candidate;
it is not a Home availability claim. The Home projects only exact records from a
verified immutable publication. The `sessions.ephemeralRunner` Home feature is on
by default, with `HAPPIER_FEATURE_SESSIONS_EPHEMERAL_RUNNER__ENABLED=0` as the
operator opt-out; publication eligibility and release checks are separate from
that feature decision. Linux arm64, Darwin x64/arm64, and Windows x64 retain the
same product/manifest target identities, but must not be projected as available
until their immutable native artifact and applicable platform-signing evidence
are published. Building a target does not make it available: the builder can
compose the Darwin shell, but only with a real Developer ID
identity and notarization output, and it fails closed rather than emitting an
unsigned or ad-hoc signed Runner. Darwin trust is owned by
`notarize-standalone-binary.mjs`, which signs the JIT-entitled nested core before
sealing the app, notarizes, staples, and records schema-3 `app-bundle` evidence —
the released schema-2 standalone-payload evidence keeps its own online-ticket
contract and is not reused for a bundle. Windows' two-executable portable,
no-installer shape is approved (Lane 13 A05). It remains unadvertised until the
existing release producer and admission owner implement and verify timestamped
Authenticode for that shape and publish an eligible immutable record. Missing
signing integration is implementation work under that approval, not a request
for another product amendment or permission to bypass admission with a build flag.

The Home feature decision is on by default;
`HAPPIER_FEATURE_SESSIONS_EPHEMERAL_RUNNER__ENABLED=0` is the operator opt-out.
Current source contains the authenticated pre-Session credential selection, Pool
source-eligibility and exact-Machine binding, signed broker-readiness
authorization, and production Runner consumer. Those source paths continue to
fail closed on missing or stale readiness. The composed creator-to-endpoint-to-Session
journey on a loaded runtime and the platform-trust evidence above are release
checks owned by release automation and human QA, separate from the feature
decision and from an availability projection that still requires an exact
artifact in a verified immutable publication.

Runner Follow consumes the ordinary Session Follow preparation contract rather
than defining a Runner protocol. The exact method is
`daemon.sessionFollow.sourceKey.prepare.v1`, with strict Protocol request,
authorization, and `installed` response schemas. Lane 09 owns that contract,
hydration, current-edge reconciliation, and accepted-effect acknowledgement.
The Runner composition owns one exact-Machine receiver, one process-local source
material resolver, edge-removal pruning, reconnect registration, and terminal
disposal. It has no Runner engine, Runner store, durable source-key cache, or
second Follow loop. The unreleased, closed V1 source projection requires each
message's nullable `localId`: an existing stable id preserves original ordering,
while explicit null identifies a legacy row. Omitting this field is invalid,
not permission to consume an unadmitted original as terminal context. Current
server and Runner readers move together under the 0.3 direct cut; no persisted
format or database migration changes. The prospective `../0.2` source inspected at
`7e1ce993c408c0f634b81267aac2bcd8e7859975` has no observed Runner or preparation
method; new clients therefore fail closed against it instead of negotiating a
parallel format. Refresh that dirty sibling's relevant bytes before activation.

In unreleased 0.3, the existing post-commit source-key preparation `waiting`
result may also carry a bounded `cause` diagnostic. Its strict Protocol schema
accepts omission from earlier writers and rejects arbitrary error text or extra
fields. Follow partial results and committed manager/spawn results retain the
same cause. These codes identify the observed preparation branch; they grant no
authority and do not promise that a retained creation settlement will refresh
when a Runner later registers. The private preparation RPC request,
authorization and installed response remain unchanged.

In unreleased 0.3, the closed `SessionTurnMutationV1` and receipt envelopes also
admit the host's `session_opened` action. It retires only an older startup issue
from the Session projection after confirmed native open; the historical failed
turn remains readable. CLI producer, durable transport and Home consumer update
together under the all-component direct cut. The scoped clean `../0.2` frontier
at `a487b2ec48873bfc0ad67bb1d31be0a2cffd3c92` lacks this action; current readers
still accept its existing mutations, while mixed 0.2/0.3 components and reverse
writes are unsupported. The existing receipt table records the new action; no
persisted fields or database migration are introduced.

The local UI spawn-setup projector retains `RPC_TRANSPORT_UNAVAILABLE` in the
existing optional `launchError.rpcErrorCode` closed enum. This admits the
existing transport code without changing a daemon producer; the prior timeout
and `RPC_OUTCOME_UNKNOWN` values remain accepted.

## Plugin Platform direct-cut frontier

### Project page author contract (0.3 development source)

Source repository admission canonicalizes the known legacy SCM hosting-provider
ids through the existing protocol alias owner. Source create, update and stored
reads share the credential-free repository selector, so accepted development
records with `github` resolve to the registered qualified identity before clone
dispatch. Custom provider ids remain exact; clone discovery has no alias table.
This does not add a migration or an older-binary rollback contract.

The development `appPage/project` extension retains manifest V2 and the Host UI
context V1 vocabulary; these wire names are independent of package SemVer.
Executable View declarations, policy expressions, qualified destinations, rich
Project targets and `projects.pages.list` inputs/results are closed, including
the accepted Source, repository and strict checkout shapes nested inside them.
The Project target uses `projectKey` with optional qualified `source`, `checkout`,
`repository` and observed `branch`; current-source Project mounts migrate together. Widget owner
fields retain their own existing names through that same context adapter.

Contextual Resource session/surface arms accept optional `target` using that
same strict public target owner. Session targets add optional repository, branch
and `headOid`, with an exact sessionId match on the Session Resource arm. Readers
still accept prior contexts without target; global context is unchanged. New
context facts do not become credential or effect authority. One declaration-owned
`counts` binding can select an ordered labelled record from a dynamic JSON
Resource; the old strict scalar `countResourceId` shape remains supported,
mutually exclusively. These are coordinated development-source extensions, not
new claims that an older strict host accepts their additional fields.

The new target and repository policy fact cannot be safely ignored by an old
host. Existing engine/toolchain and artifact `hostUiApiRange` admission must
reject an unsupported declaration, never reinterpret it as an app page. The new
host preserves target-less app shorthand and existing valid app URLs. No
released old Project-context reader has been established, and current `dev` to
the predecessor SDK rollback remains unsupported under the direct-cut ruling.

Read-only source-frontier verification on 2026-10-24 resolved origin's immutable
`cli-v0.2.17` and `server-v0.2.17` to
`a2c45c86804b24e60ac0b76146a3ef36dfcaa15b`, and `ui-web-v0.2.19` to
`63829e3cd6a8f1f48b10891af0c8b2313e51ac7e`. The prospective `../0.2` checkout
was `2bf968563bf2015455c0cd54bcc74e91f67891b9`; its exact plugin/SDK/page/pinning
corridor had no staged or unstaged changes. These observations establish a source
basis, not deployed artifact support or a published SDK census. Package API
regeneration, published SemVer review and loaded-platform certification remain
separate checks; no compatibility shim or new epoch is inferred from missing
publication evidence.

The Plugin Platform simplification is a direct cut within the unreleased 0.3
development line. The current working tree was rechecked on 2026-09-24 while
the checkout HEAD was `08b245d0337e7ee6b1bad249cdb79081b809449b`.
The repository-local immutable source tags rechecked at the same time were `cli-v0.2.11`,
`cli-v0.2.11-preview.2`,
`server-v0.2.11`, `server-v0.2.11-preview.2`, `ui-web-v0.2.11`, and
`ui-web-v0.2.11-preview.186` at
`98ea8fb76733b1dd785d38c31360179cafa84824`; `ui-mobile-v0.2.0` at
`e49afc11e8d8c068043bc108722ca2ed90b11d1d`; and `ui-desktop-v0.2.0` at
`ed11a23e45fb18b6ef7a7f13c256ab148c8d50a3`. Their app and package trees
contain none of the current Happier Plugin Availability/materialization,
`.happier-plugin` manifest, Provider-contribution, installed-generation,
occurrence/currentness, or Plugin UI artifact contracts. The release registry
uses `plugin-sdk-v` for the separately published Plugin SDK pair, but the local
tag set contains no such immutable tag. This is repository-local source and
publisher-contract evidence; it does not claim an independently queried
deployment or npm-registry state.

The current development Agent Session output contract accepts omitted host `turnId`
for Session-scoped transcript output, and treats a witnessed `sidechainId` as Session
scope even when an originating host turn is recorded. Existing foreground writes with
required turn identity remain accepted unchanged; foreground lifecycle events still
require that identity. This is an in-place development contract change under the
Plugin Platform direct-cut basis above, not an established released predecessor
migration. See [runtime scope](runtime-core.md) for the consumed host behavior.

The prospective `../0.2` source was inspected read-only on branch `dev` at
`439125d17582cdfa7534a156737d52559565353b`, including the committed tree,
zero staged changes, four tracked unstaged changes, and no untracked files. Its
dirty paths cover the Codex app-server and request-user-input implementation and
tests, outside the Plugin Platform corridor. Neither the
complete on-disk app/package tree nor the unstaged diff contains the Plugin
Platform identifiers above, Re.Pack/Module Federation runtime identities,
`immutableGenerationId`, `hostUiApiRange`, or a plugin persistence model/file.
Refresh this comparison before activation if that moving predecessor changes.

Consequently there is no released or prospective old/new Plugin Platform wire
or persistence direction to preserve through aliases, dual writers, or
framework-version admission. Managed third-party installation generations are
the current design's immutable package custody, not a predecessor
compatibility shim. Development source is evaluated into a process-local
occurrence; its last accepted occurrence is not persisted for restart
recovery. Current-development `AccountPluginIntent`, `AccountPluginRelease`,
`AccountPluginUiArtifact`, and `PluginMachineMaterialization` rows, managed
third-party generation-store files, and digest-keyed UI artifact caches remain
forward-only current data; they do not create an old-reader or old-writer
direction for `../0.2`.

The repo-local development Stack uses dedicated `mac-host` server placement.
Live-process file-descriptor evidence from server PID 51343 identifies its
active SQLite database as the target-scoped
`/Users/leeroy/.happier/stacks/repo-dev-a1cc5e0671/cli/stack-state/dev-target-mac-host-dfcbfd6a94d90609/server-light/happier-server-light.sqlite`.
A read-only check on 2026-09-23 found all 118 current source migrations applied
with matching checksums, including the `d484…` automations migration and the
`20260920230000_migrate_session_subagent_source_custody` migration applied on
2026-09-21. The current `reporterSourceCustody` schema is present, and SQLite
`quick_check` and foreign-key checks are clean.

The live ledger has 122 applied rows. Its four ledger-only development
identities—`20260810140000_add_event_automations_v1`,
`20260810210000_contract_session_turn_anchor_projection`,
`20260813110000_add_automation_event_source_status_reporter_immutable_generation`,
and `20260815180000_backfill_automation_execution_dispatch_state`—refer to
source directories consolidated away during development. Their presence alone
does not establish a deploy blocker; the canonical deploy result owns that
decision. The parent-level mac-host database and the Linux-local database at
`/home/leeroy.guest/.happier/stacks/repo-dev-a1cc5e0671/server-light/happier-server-light.sqlite`
are inactive files, not the current Stack migration target. None of these
development-only ledger shapes is a released compatibility direction or
justification for a product alias, bridge, or reader.

### Automatic Session turn transcript-anchor projection (0.3 development)

The server automatically converts historical Session turn anchor projections
before starting its API, using the existing JSON-derived converter in bounded
transactions. A restart safely rescans the rows; completed updates are idempotent.
This is the same path for fresh installs and forward upgrades from 0.2 on
PostgreSQL, SQLite, MySQL and PGlite. No operator command, approval environment
variable, cache marker or removed migration identity activates the projection.
The current capability payload advertises turn projection directly.

The external-shareable transcript still checks each Session's legacy and
inconsistent rows in its read snapshot. An unconverted row holds the cursor at
the first unsafe page sequence; removing the global activation switch does not
relax these publication or turn-settlement barriers. Existing anchor JSON stays
the authority; scalar ranges remain its query projection. Conversion does not
rewrite message content or introduce a second transcript.

### Collection readers and answering-client routing (0.3 development)

Independently upgraded apps retain their compiled Collection reader refs. A
current writer admits an exact compatible reader through Data's existing access
resolver or refuses that Collection with `collection_update_required`; the app
must not substitute the writer contract. No released 0.2 Collection/Run-on
contract was found in the inspected clean predecessor corridor at
`f18aba940c5c56e5b24454e176c836c171098a2d`; no 0.3 intermediary shim is retained.

Collection GET responses require the producer's `absenceEpoch`, including when
`row` is null. A missing epoch is invalid; readers do not invent epoch zero for
an unpublished intermediate response.

Exact answering-client selection is authority-bearing and cannot be an optional
field an older relay silently ignores. The canonical reverse RPC transport uses
the `answering-client.v1/` method prefix plus a closed `answeringClient` envelope.
The current relay normalizes this operation into the incumbent authenticated
Machine continuation and applies the selector before dispatch. A relay without
that operation refuses the unknown method without executing the mutation;
the caller reports `client_routing_update_required` and never retries through
unselected delivery. Client-routed UI Actions accept exact `clientId` in their
closed input, including reads. Without it, current selection uses a sole eligible
client or the unique latest focus transition stamped by the existing `ui-focus`
push; missing or tied history returns `client_ambiguous` with candidate ids and
the `clientId` remedy. Optional candidate metadata in older ACKs may be absent;
that remains typed ambiguity. Updated strict Action readers are required for the
new selector field; an older reader refuses it rather than silently rerouting.
Exact socket addresses expire on reconnect,
and a missing selected client refuses without replacement. No persisted format,
Run-on writer or store is added.

## SDK protocol evolution

The 0.3 development SDK adds `exec.clients.connectJsonRpc` for existing Unix
WebSocket endpoints. Existing process-client `spawn` operations keep their
contracts. The new connection handle has no process identity or manufactured
process-exit result; connection errors preserve real OS codes and syscalls for
the caller's existing readiness policy. Available and unavailable invocation
facades expose the same method. This is an additive development API with no
persisted-format or candidate-index change.
`PluginJsonRpcClient.onNotificationReceived` is also a required synchronous
receipt subscription on matching development host/SDK builds. Codex consumes
those notification facts for its existing approval metadata projection;
request/response dispatch still bypasses ordered domain callbacks.

The 0.3 development External Sessions author contract adds optional
`hydrateCandidates`, an in-process selected-page display operation under the
existing runtime ABI. Its source, candidate request/result envelopes and nested
identity/link fields remain closed. Only title, cwd and message count can change;
count, order and all other candidate facts are checked against the admitted input.
The host derives one positive support facet from the current registration and
returns typed unsupported when absent. Matching development host and SDK source
are required; no method-presence version fallback, new wire epoch, persisted index
format, migration or reverse-development adapter is introduced. Existing v2
indexes remain readable because enrichment happens after selection and is never
persisted. The 0.2 predecessor has no plugin SDK External Sessions author operation.

### Attached bounded Run recovery (0.3 development)

Explicit recovery uses the existing `session.message.send` Run recipient with
the closed requested-action epoch `{ v: 2, kind: 'recover_execution_run' }`.
Its Action input, Run routing identity, Pending mutation and Machine capability
envelopes remain closed. Ordinary requested-action V1 and omitted legacy values
retain their current reader/normalizer behavior; recovery never normalizes to
ordinary enqueue. The existing Pending JSON column retains the new intent,
without a migration, second writer or alternate recovery endpoint.

This effect-bearing intent is negotiated through epoch 3 of the existing
`sessionInputAdmission` Machine capability. A current Home refuses a target
advertising only 1 or 2 with `session_input_target_update_required` before row
creation. Ordinary main/Run input still requires only 1/2 respectively.
An older strict requested-action reader rejects the new epoch; it cannot
silently authorize ordinary input. The transport's existing target admission
and settlement epochs are unchanged. No public SDK symbol is added.

The inspected immutable CLI stable `cli-v0.2.17` and preview
`cli-v0.2.17-preview.1` both resolve to
`a2c45c86804b24e60ac0b76146a3ef36dfcaa15b`; their public Linux manifest
metadata reports those versions/channels and the same build commit. Their
`sessionMessages/pendingRequestedActionV1.ts` writes strict ordinary V1,
Session Send has no exact Run recipient, and their daemon advertises no
`sessionInputAdmission` capability. The clean scoped moving `../0.2` frontier
at `29c845495702acde2824dae13067d8a09322b26b` has the same relevant shapes.
Old-client/new-Home ordinary writes and retained old data remain supported;
new recovery against an old daemon is an operation-scoped update refusal.
A current recovery writer requires the current target-aware Home. Reading
new recovery rows with old development binaries, or rolling this unreleased
author contract back into 0.2, is outside the direct-cut support direction.
No dual writer, rollout flag or operator mode is introduced.

Machine operation-capability stored reads evaluate each declared leaf independently
through `machines/operationProtocolCapabilitiesV1.ts`. An unknown version or
malformed known value withdraws only that leaf's support; valid siblings remain
available. Exact version tuples and other known values are still validated, while
unknown outer and nested properties retain the existing drop-on-read policy.
Authenticated complete-projection publication and event admission stay strict.
Admission V3 advertisement still uses the existing Home Pending V3 negotiation:
the immutable `server-v0.2.17` and `server-v0.2.17-preview.1` source and inspected
moving predecessor advertise Pending V2, so they receive primary-only admission.
Target-aware pre-admission-V3 readers are unreleased development intermediates;
older QA server processes must reload current source to consume V3 publications.

The development Composer region placement `statusStrip` extends the existing
closed executable declaration in manifest V2; Composer surface input remains
V1 and host/runtime API remains 1. Its optional `emphasis: 'quiet' | 'prominent'`
is also part of that closed development declaration and requires the matching
host; omission follows the public badge's `prominent` default.
Its renderer binding, identity, occurrence,
scope and mount envelopes stay closed. Existing before/after declarations remain
valid. This is an unpublished SDK author-contract extension under the direct
cut: older strict development hosts reject this placement, so authors require
a matching host. It is not an ignorable optional input or an open routing union,
and adds no mixed-version adapter or persisted format. The inspected 0.2
predecessor at `01107c0e7a6b2d4b521573c6d69b53070187e76a` has no plugin
contribution/Composer region corridor.

Plugin UI executable compatibility is negotiated only through the artifact's
`hostUiApiRange`. One artifact id names one byte-identical CommonJS bundle on
web, iOS, and Android; React, React Native, Expo, Hermes, and app patch versions
are not artifact admission keys. Artifact bytes are addressed by digest. A
daemon-process-local occurrence establishes contribution currentness, but it
must not become a second byte identity or mount-compatibility gate.

A wire epoch describes compatible semantics, not an exact property census. Every
material object boundary, including nested objects, is classified explicitly as
`closed`, `additive-open/drop`, or `additive-open/preserve`; a parent policy
never silently classifies its children.

- **`closed`** rejects unknown properties. It is mandatory for identities,
  qualified references, Account or credential selection, permissions, routing,
  mutation inputs/outcomes, authoritative lifecycle facts, executable
  declarations, and runtime unions. Stable Host Events are always closed.
- **`additive-open/drop`** may accept bounded optional unknown properties only
  for transient, presentation, or read projections where an older consumer can
  safely ignore them. Normalization removes those properties.
- **`additive-open/preserve`** may retain bounded unknown properties only when
  the component is an explicit round-trip custodian for a persisted document or
  opaque provider configuration. Preserving data never grants identity,
  authority, routing, credential selection, persistence-policy, or trusted
  prompt/transcript/UI power.

Known fields remain strict under every policy: required fields stay required;
invalid values do not coerce; and owner-justified encoded-byte or semantic
cardinality bounds still apply where the actual wire, storage, or operation
contract requires them. Implementation safety guards such as serializer/parser
recursion depth are private fail-safe details, not public semantic JSON quotas.
An accepted unknown is data, not authority.

An optional input is compatible only when an older implementation can ignore it
without falsely reporting success. Otherwise advertise an optional
operation/capability or introduce a new wire epoch. Likewise, a new union member
is compatible only in an explicitly skippable, bounded presentation list.
Identity, presence, permission, pagination, retry, and mutation-outcome unions
need an existing safe `unknown` arm or a new epoch; they are not skippable by
default.

npm package versions and exported wire epochs evolve independently: a later npm
major may still export V1, and a later npm minor may make only V1-compatible
additions. A public cross-plugin business protocol is a separately publishable
package with any valid scoped or unscoped npm name ending in `-protocol` and
explicit `/v1` and `/testing/v1` exports. Its npm scope identifies its author
and grants no additional protocol authority. One existing protocol-only package
may also own several domains through explicit domain-versioned pairs such as
`/ci/v1` with `/ci/testing/v1` and `/releases/v1` with
`/releases/testing/v1`. Each pair names that domain's wire epoch and conformance
fixtures; adding a domain does not rename or replace the existing `/v1` and
`/testing/v1` epoch. A domain's incompatible evolution requires its own explicit
epoch under the same rules above, independently of package SemVer.

The package contains schemas, types,
helpers, and conformance fixtures only—not host runtime, persistence, provider
implementation, credential materialization, polling, or a private
`@happier-dev/protocol` dependency—and it has no `latest`, `current`, or
`default` aliases. Compatible
package copies interoperate through serialized protocol identity/version and
runtime validation, never JavaScript object identity.

The package README and nearest `AGENTS.md` must name the feature's domain owner
and link here rather than copy this doctrine. New feature-protocol code must use
one synchronous executable validator/normalizer that derives its bounded public
JSON Schema; independently handwritten parser/schema pairs are not allowed.

The approved SDK r0.31 direct cut does not make current `dev` → `../0.2`
rollback a supported direction. Do not add predecessor readers, dual writers,
aliases, writer-floor waits, or rollback-only gates for unpublished author
contracts; forward migration and current-version integrity still apply.

The unreleased `ui.listExtensions` manifest family is optional; manifests that
omit it retain their prior normalized shape. Its descriptor, fields, sources
and mark references are closed. It uses the existing UI declaration projection
and adds no persisted host-row data or runtime registration. The 0.2 predecessor
has no plugin UI projection reader. Earlier 0.3 development strict readers
reject the new projected entry's field and therefore the describe response;
they are not a supported mixed-version author contract. This is no additional
client update floor, compatibility adapter or negotiation layer. Executable UI
compatibility continues to use the existing `hostUiApiRange` owner.

The development Machine registry describe remains wire protocol version 1.
Its optional full-read `knownProjectionDigest` is safely ignorable: an older
daemon returns its full response, and a client accepts a full response without
the optional `projectionDigest`. Only an explicitly matching digest request may
receive the separate closed `{ protocolVersion: 1, unchanged: true,
projectionDigest }` response. The client requires its exact held digest before
reusing admitted inputs; that witness does not replace current Machine access
or daemon authority checks. Named exact reads retain their existing envelopes.
This opt-in read optimization changes no executable declaration, runtime event,
persisted format or downgrade floor. The inspected 0.2 predecessor at
`29c845495702acde2824dae13067d8a09322b26b` has no registry describe corridor.

The same development full read optionally accepts `knownSectionDigests`, including
an empty array for cold negotiation. An older daemon safely ignores it and returns
the full response. Only an opted-in caller receives the closed `sectioned: true`
framing envelope: its ordered parts are literal JSON spans or closed section
records carrying a digest, optional body spans, and inline Machine-value spans.
The digest binds the body spans, not authority or freshness. Bodies are grouped by
plugin within each projection section; origins, occurrences, source custody,
availability, authorization and targeted snapshots remain inline. Reassembly
requires every referenced digest from that Home/Account/locale's held inventory,
verifies supplied body digests, and passes the complete reconstructed response
through the existing strict nested projection schemas before adoption. Invalid or
missing bodies are `invalid-response`, never an empty catalogue or an automatic
retry. Named selections do not accept this option. The existing matching full
digest still takes precedence and returns the unchanged 124-byte envelope.

Current development callers may instead opt into `deferredSections: true`.
Only that opt-in receives a closed digest manifest. Its nested section map is
read-only byte addressing; section bodies, included-body records and cursor
envelopes are closed. `sectionRead` is sent only after the matching daemon has
advertised this operation in its manifest response, and is invalid on named
selections. Older daemons ignore the first-read hint and return their full reply;
older clients keep their existing full or inline-section framing. This extends
wire epoch 1 independently of package SemVer and changes no persisted format,
executable declaration or runtime event union.

Deferred index framing is negotiated independently within wire epoch 1. A client
offers `supportedSectionFrameVersions: [2]` on describe; only an offered version
may appear as `sectionFrameVersion: 2` in the closed manifest. The client sends
that selected version on subsequent `sectionRead` requests only after the
advertisement. Version 2 sends raw serialized index text. Without advertisement,
the client first admits the original JSON array of index spans. If unversioned
hydration fails, or the manifest advertises an unsupported frame version, the
transport issues one full describe with every section/conditional hint removed.
That answer goes directly through the full response parser; another manifest is
refused without further reads or automatic retries. Negotiated version-2
hydration failures still settle as `invalid-response`. The existing loader result
carries `deferredHydrationRejection`, a closed branch name without bodies or
digests, including after successful full-read recovery. Without deferred-section
support the existing inline-section or full response applies. No dual parsing
selects an encoding. The original encoding remains necessary while QA
stacks can hot-reload a UI ahead of their daemon, and can be removed once both
sides on every such stack negotiate version 2. Old clients that make no offer
receive the original closed manifest and array encoding. Digest identity still
binds the same logical spans in either encoding.

The existing build serves each requested digest in JSON frames at most 48 KiB,
paging larger valid bodies without truncation. Extra small bodies are returned
only when explicitly requested and fitting the same total frame budget. Clients
verify every digest, parse demanded sections with the existing projection schemas
and retain explicit completeness at the shared loader. Missing catalogues remain
unknown to readers requiring them. A matching full digest still returns the
124-byte unchanged response, including when the client holds only demanded
sections. Hydrating additional sections may reuse an already current manifest
only when the caller explicitly permits fresh-cache reuse; an explicitly fresh
read still asks current daemon authority first.

### Action operation observation epochs (development)

The existing daemon Action-operation owner exposes two read epochs over the same
store. V1 list/get retain the closed snapshot reader inspected in clean `../0.2`
at `37a6541578749067b49d4579be8c752c9591b8c8`: only `forkRequest`,
`spawnAttempt`, and `handoff` domain references, with the original terminal
`errorCode`/`error` pair. Its response projection omits current domain references,
`setupReview`, `observation`, `operationCredentialUses`, and failure `details`; it never rewrites retained
custody, state, revisions, or revision notifications.

Current V2 operation reads and current approval receipts retain content-free
`operationCredentialUses` from actual host credential materialization. They
describe the admitted label/kind, owning Account or Team when known,
purpose-binding reason, and admission-time currentness; they neither grant
credential access nor assert continuing readiness. Terminal/rejoined outcomes
remain unchanged. The existing V1 response and push projection omit these facts.

Managed controller failures in the current development V2 read retain a strict
`managedControllerRequest` diagnostic: the static request path, failure category,
observed HTTP status when available, and safe machine-readable code when supplied.
The controller request owner validates responses before returning them; enrollment
and Action execution preserve that observation through the terminal operation.
Response bodies, messages, headers, credentials and schema issue values are never
part of this diagnostic. V1 continues projecting only `errorCode` and `error`.

The unreleased Machine-provisioner V1 role schemas are exported through the public
SDK and serialized into manifest V2 Action declarations. A current host accepts an
older result-schema snapshot that omits optional properties, including nested facts;
required fields, retained property constraints, object closedness and union arms
still match the canonical role. Descriptor-owned native Resource/operation value
schemas and Action input schemas remain exact. Actual result
readers retain their closed validation. This declaration comparison replaces
field-specific diagnostic exceptions, without a new wire field, schema-reference
registry, migration or reverse-development-binary compatibility promise.

Managed native failures in the same development V2 read retain a closed
`managedNative` detail with `nativeCause`: an HTTP status class and optional
documented vendor code, a documented gRPC status/Modal SDK error class, or a closed
local cause. `native_configure_refused` retains exact HTTP status 400 for a
message-only configure refusal; it does not imply that no setting was applied.
`native_delete_refused` carries the same exact status for a native Delete that
did not complete; an earlier Stop or partial effect may already have occurred.
`native_route_unavailable` and `native_lease_ended` distinguish a locally
unsupported acquisition route from a coordinator's terminal retained lease.
`native_route_not_found` carries exact HTTP404 and a closed route kind
(`inspect`, `run`, `stop`, `delete`, `pull`, or `configure`). Lume's pinned
0.6.1 handlers report missing VMs as HTTP400, so route404 never proves absence.
The shared provider-facts schema owns this allowlist; native messages, response
bodies, metadata and credentials are excluded. Hetzner input/uniqueness failures
may additionally carry `fields`: a closed, cardinality-bounded list of documented
create-request field names, restricted by the native producer to submitted keys.
It carries no validation messages or dynamic label paths. This extension uses the
same development direct cut; SDK/controller, Home readers and app must consume
matching schemas before the new diagnostic producer is loaded.
Acquire's rejected, unknown and
pending results, provisioner check/options/observation results, and refused or
unknown native-control results accept the same optional fact. Options can
explicitly report `provider_unavailable` without presenting a
failed catalog fetch as an empty catalog. Existing results without the fact stay
valid. These are unpublished managed V1/operation V2 extensions under the direct
cut, requiring matching current readers; no adapter for stale development
schemas or change to the released V1 operation projection is introduced.

Managed bootstrap questions in current V2 operations use one closed union for
provisioning consent, SSH trust/replacement and remote service replacement.
Trust carries its host and fingerprint facts. The development managed response
Action requires the exact projected question; the current task owner also checks
its kind atomically before accepting a response. This requires matching current
managed UI/Action/controller readers under the same direct cut. Ordinary SSH
setup retains its existing password flow, and released V1 operation reads still
omit managed domain references. No persisted format or migration changes.

Current Actions, Workflow observation/recovery, UI reconciliation, command output,
and prepared-copy completion use the existing V2 list/get methods so they retain
those richer facts. Stop uses the unchanged V1 cancel method. This is a bounded
read-epoch projection, not a second operation owner, parser, or promise of mixed
0.2/0.3 stack support. Remove it only when the original V1 reader contract is
explicitly retired; unrelated operations and retained operation results are
unchanged.

In 0.3 development source, declared Service Start publishes its source-qualified
`projectService` reference with purpose `start` through this same V2 owner.
Copying, preparation and native launch remain phases of that Start; a complete
binding read may be unavailable until native establishment settles. Mounted
Service rows retain the operation's progress during that interval and invalidate
their existing native readers on settlement. Finite setup retains its separate
review/output custody. V1 continues omitting the service reference; the Start
request and native result formats are unchanged. This is a development V2
extension, not a new observation channel or a released mixed-version guarantee.

V2 list can select `requestIdentity: { actionId, requestId }` for the newest
retained host receipt in the admitted Account, Machine and optional Session
scope. Selection precedes response projection and skips unrelated durable-domain
reconciliation. Accepted manual Session creation uses this selector, then waits
on the exact operation through the existing get owner. Both the request and
nested identity remain closed; V1 rejects the selector and a client requiring it
never falls back to an unfiltered predecessor inventory. The clean relevant
`../0.2` paths were rechecked at `3482a9101ebb7ee2983608ef0deb00831dfcb2e7`;
that predecessor registers V1 only. This development extension adds no retained
data format or second operation owner.

While the shared Action executor holds a blocking Ask, current operation progress
uses `waiting_for_approval` and carries the existing `approval_request_created`
reference in `progress.approval`. The reference identifies the Inbox Ask; it grants
no decision authority and contains no Action inputs. All wait exits clear it before
the domain owner continues or settles. V1 retains the phase and label but omits the
reference through its existing progress projection. This is development-only V2
observation data; the snapshot and nested reference remain closed schemas.

V2 get separates snapshot reconciliation from `refreshSetupReview: true`, which
awaits the retained producer's current setup effect before a human consent
decision. Ordinary reads can refresh in the background; identical progress and
review facts do not publish another revision. The refresh operand belongs only
to the closed V2 request. V1 rejects it, and an unavailable V2 method cannot
satisfy a required fresh review through a V1 fallback. `includeSetupReview`
retains its existing wait-only contract.

Current managed bootstrap observations capture the native resource and controller
installation on the V2 managed operation reference independently of an installer
task. An actual installer task supplies only its task id and kind. Already-enrolled
native boot recovery uses the same correlation without inventing a task or replaying
installation and pairing. Detail shows observed progress and Retry only when that
operation's captured facts match the retained managed row; a later successful retry
clears the failed diagnostic. Missing capture is unavailable evidence, not permission
to borrow an older failed operation for a rebuilt resource. This replaces an
undeployed task-nested capture in place. V1 continues omitting the managed reference;
no new operation store or retained-data migration is required.

### Notification channel sender source migration (development)

The current development `NotificationSender` request makes `categoryId` optional:
plugin-originated service sends retain the qualified plugin category, while host
Activity sends omit it. This required-to-optional sender change is a development
source-contract cut, not a V1-compatible relaxation for existing senders. Authors
must update and rebuild category-dependent senders before consuming host Activity
notifications; no synthetic category or silent compatibility shim is supplied.
The plugin `notifications.send` service still requires a declared category. See
the [author migration guide](../apps/docs/content/docs/plugins/services/notifications.mdx#channel-sender-source-migration-development).

### Detached Execution Run plugin context (development)

Real Agent Sessions keep the existing Session V1 request, event, context, and
host-service contract. A Session-primary Agent may additionally declare the
versioned `executionRunContext: { versions: [1] }` capability and return the
matching `sessions.executionRunContextV1` runtime facet. Only that facet receives
the host-stamped `execution_run` scope; it has no `context.session` and exposes
only host services whose authority is meaningful without a Happier Session.

The declaration and runtime facet are inseparable. A detached Run fails with the
existing operation-scoped `execution_run_protocol_unsupported` result before a
provider effect when either side is absent. Genuine Session operations remain
available, so older plugins do not need a compatibility adapter and the host must
never substitute the Run id into a Session V1 field. Composer attachment V1 also
remains Session-only; the additive V2 resolve callback carries the same truthful
scope, while SessionMedia continues to reject outside a Session.

The prospective `../0.2` checkout inspected at
`c4deb153e7d4740f06bfeee94b70cfda95d47068` has no observed execution-run context
facet or Composer V2 callback in the relevant SDK, Protocol, and CLI runtime
paths. Those unpublished author contracts therefore create no reverse adapter or
rollback obligation.

## Proportionate matrix

List all affected reachable directions and mark each `required`, `unreachable`, or `unsupported` with a reason. Direct seam tests cover each required direction. End-to-end rows are selected by risk and real deployment order.

Do not run a full Cartesian UI × CLI × daemon × server matrix for an internal or unrelated change. Require broader combinations when a shared protocol, persistence shape, installer/service state, or rollout ordering actually couples those roles.

## Evidence and tests

- Prefer real released/predecessor artifacts, serializers, clients, or provenance-pinned golden vectors.
- A fixture reconstructed from current types is not evidence that the released or predecessor reader/writer behaves that way.
- Use the smallest discriminating test for each material direction, then add risk-selected upgrade, coexistence, rollback, and state-continuity flows.
- Do not multiply shallow permutations. A new test must distinguish a plausible incompatibility, reader/writer mismatch, semantic change, or rollout failure.
- Record the exact tag/commit/artifact or sibling worktree basis, component roles, direction, command, and result.

## Compatibility path lifecycle

Every retained compatibility path records:

- the released or prospective source shape it supports;
- its producer and consumer;
- whether it exists for upgrade, coexistence, rollback, or persisted historical data;
- the canonical owner it delegates to;
- its removal condition.

Remove the path when its support window has ended and evidence shows no supported reader, writer, or stored shape still requires it. Do not remove a released-data reader merely because current writers stopped producing that shape.

### Home profile descriptors (0.3 development)

Shared-database Stack consumers keep descriptor continuity in their private
runtime directory, selected by the preset's explicit shared-DB consumer fact.
This is a QA/development topology: the source and consumers share the database's
one Home identity, while each consumer retains its own descriptor history.
One client profile must follow a single consumer; it must not alternate between
consumers of that shared database. Their revisions do not form one shared
endpoint history, so a different consumer's equal revision can conflict and a
lower revision can be ignored by the client's monotonic descriptor admission.
The source Stack and ordinary PostgreSQL/MySQL servers retain database-backed
continuity. Each consumer publishes and restarts from its own private history;
it neither reads nor writes the shared continuity row. Earlier undeployed 0.3
storage selections do not establish a compatibility transition or revision floor.

The UI's existing `server-state-v1` profile owner retains one exact
`homeConnectionDescriptor` for descriptor-backed Homes. Endpoint and revision
decisions read that snapshot; duplicate-profile merges keep its canonical URL and
public ingress together. The active runtime snapshot's revision is a derived,
non-persisted projection. The development-only `irohEndpoint` and
`connectionDescriptorRevision` profile fields are ignored and are not written.

Ordinary URL-only profiles remain readable and usable over standard networking.
Their source shape is present in `ui-web-v0.2.11` and
`ui-web-v0.2.11-preview.186` at
`98ea8fb76733b1dd785d38c31360179cafa84824`, and in the clean prospective profile
owner at `../0.2` commit `9dd9c2580be619b4907257f94174e45ba5517976`.
Those profile shapes contain no Iroh endpoint or descriptor revision fields.
Once a Home has an exact descriptor, a revision-less manual update cannot replace
its connection destination; an exact current Home descriptor is required.
The CLI refreshes changed profile endpoints through authenticated publication.
A port move with retained publisher continuity advances the descriptor revision.
If publisher history is lost or disconnected, the CLI refuses a lower revision
with `stale_home_descriptor`; different Home authority is `identity_mismatch`,
and different content at the same revision is `home_descriptor_conflict`.
Recovery restores that Home's own verified continuity before republishing; it
does not lower the client's admitted frontier. A shared-database consumer's
private continuity therefore belongs with that consumer when its server moves.
Public privacy-reduced observations do not allocate a revision or erase private
facts from the retained authenticated descriptor.

In current 0.3 development, successful env-only CLI enrollment and seeded daemon
authentication retain the exact Home descriptor on the existing credential
scope. Its initial URL-derived profile id remains immutable; credentials and
Machine state are not copied to another id. An endpoint move can then use the
ordinary authenticated `server set --server-id <existing-id>` admission above.
Daemon startup first materializes ordinary URL-only metadata at that same scope,
so reconnect can read a saved profile even when exact publication is unavailable.
This metadata does not establish Home identity authority.
For an older env-only CLI home with no saved Home binding, explicitly retaining
`HAPPIER_ACTIVE_SERVER_ID` selects its existing credential and Machine scope at
the new user-configured destination. A bare changed `HAPPIER_SERVER_URL` still
derives a different scope when no saved profile matches. Public Home identity
alone does not authorize scanning or rebinding credentials across those scopes.

The separate device-local Account Service endpoint accepts only `source: 'default'`
or `source: 'user'` on both reads and writes. The abandoned `configured` source
is not normalized into a policy choice. It has no endpoint-record producer in
the above stable/preview profile owners or the clean prospective profile owner
at `08e278be495e8f3a1b744bd1d069fc48d2d3276f`; an invalid persisted endpoint is
discarded without changing Home profiles or focus.

### Current finite-transfer admission (0.3 development)

The 0.3 transition removes the old-daemon missing-declaration probe and
`legacy_machine_rpc` carrier. An absent, malformed or disabled daemon
transfer declaration is not support. Presentation and execution share the
current declaration reader; ordinary daemons must declare finite import and
export. A restricted Runner has no daemon transfer state and instead declares
`finiteTransferRpc` in its current, server-revisioned operation capability
projection. Endpoint publication alone does not establish finite-transfer
support: the same endpoint also carries workspace and broker traffic.

Iroh selection requires current application support, both
`machines.transfer.directPeer` and `machines.peerMediation`, the canonical current
endpoint descriptor, and a usable host carrier. Browser clients additionally
require the published relay hints. Under IR-105 (2026-10-13), browsers select
Iroh when usable and otherwise select the Home's server-mediated encrypted
transfer RPC phases. This applies at the canonical transfer owner to Found,
registry JSON, workspace files and the other finite Machine families; callers
do not make their own fallback decision.

The Home phases consume the same prepared-transfer capability and dispatch to
the incumbent daemon transfer handler in-process. They retain its encrypted
chunks, import lifecycle, destination completion and current authority checks;
they create no second byte store or filesystem admission path. Signed callers
spend their admitted operation root through
`resolveMachineRpcExternalActionEffectV1`, with the exact installed target and
phase body still verified by the Home. A browser in Standard-only mode uses
this Home route. Native prepared transfers retain their Iroh requirement.
The daemon keeps the prepared-transfer owner available for Home RPC when its
optional direct listener is disabled; that does not enable the finite Iroh
application on an endpoint published for other Machine applications.
Initial selection precedes preparation. A failed browser Iroh acquisition may
use Home only after successful custody cleanup, before any transfer HTTP phase
was sent; cancellation and Account retirement still refuse the operation.
Once the HTTP requester is acquired, failures never replay through Home,
matching Machine RPC's unknown-delivery rule. Undeclared daemons remain
unavailable without a declaration probe.
Session-scoped attachment admission remains separate; Composer media remains
independently negotiated.
This contraction changes live component admission, not readers for data created
by 0.2; no persisted transfer format or data migration is introduced.

### Mobile notification permission responses (0.3 development)

Notification permission buttons reuse `session.permission.respond` with the notification's exact `(Session, turnId, requestId)` and saved Home/Account credentials. The shared Session response owner retains its existing void-success result and accepts structured success; explicit failures and malformed results reject. The ordinary Session UI still resolves transcript projections against its live pending request. The exact notification adapter preserves the notification's turn instead of replacing it with a newer loaded turn. The existing CLI turn-custody check remains the receiver authority. Live iOS and Android responses use the same exact-turn adapter without switching the focused Home or navigating; retained pending-decision records supply review navigation only and cannot replay an answer.

Remote request push preserves the producer's captured request turn through the existing notification content owner; device-local request notifications already carry that turn. Payloads without it cannot answer: live/background mobile callbacks record a generic review notice without navigation; cached launch responses provide review navigation only. The 0.2 source intent at `794937289f` and `c6a67110ed` uses an occurrence UUID and a separate permission operation. Those changes are unreleased at this port boundary: 0.3 uses its existing turn-bound contract rather than adding a UUID-to-turn conversion or another permission operation. This does not establish mixed 0.2/0.3 live-component support under the all-component upgrade policy.

The existing native notification task handles Android action callbacks alongside Session-change wake reconciliation. Equipped iOS builds retain the live native response completion until the claimed callback finishes or the OS expires its background execution. That custody is process-local, survives an in-process JavaScript reload, and does not turn a cached response into permission authority. iOS permission categories require authentication; SecureStore access stays `WHEN_UNLOCKED`, and `Answer` remains foreground. Within the current JavaScript runtime, identical callbacks share work and retain only confirmed acknowledgements for the exact bound request; conflicting decisions cannot overwrite them, and every other settled outcome remains retryable. Live actions use a caller-owned scoped connection without changing the global network gate, focused Home, or ordinary socket pool. An unhandled cached launch response performs only safe review navigation; a permission response already consumed in the running app does not reopen after remount. Generic body-tap navigation keeps its existing hook lifetime, so a new live tap can navigate after remount. The presentation-recovery notice can retain the original Home/Account target, without a request or answer. Readers still accept the previous untargeted flag. Review revalidates saved credentials and refuses a replacement Account; it never replays a response. Android SDK 55 task support already belongs to the native application. The iOS completion/claim/expiry extension requires the patched Expo native module in a fresh binary and a new non-publicdev `happierExpoRuntimeVersion` train; publicdev keeps its fingerprint policy. An installed binary without that API keeps foreground permission categories when registration reports unavailable. This fallback does not guarantee that later execution failure will foreground the app. End-to-end notification-action lifecycle and physical-device validation remain outstanding; this is not a released-capability claim.

### Inline question replies and notification presentation (0.3 development)

Request-preview and local notification producers project supported simple questions through `push/notificationQuestionActions`. One single-select question with up to three choices can offer numbered native actions; one short freeform question can offer text input. The static category and complete display mapping must fit the existing push budget together, otherwise the producer retains ordinary Answer navigation. Privacy-off and missing Account/turn metadata also retain that path. The opaque Home-owned `activity_alert` consumer remains preview/navigation-only; it does not gain a separate native question parser.

Inline answers reuse `session.user_action.answer`, the shared Action-to-RPC answer mapping and `sessionRespondToUserAction`, with an exact saved Home/Account scope. The CLI request owner checks a supplied turn at admission and again against the published request before settlement, so reused request IDs cannot answer a later turn. Ordinary turnless callers retain their existing contract. Unlike the source 0.2 occurrence-aware reply extension, the existing 0.3 response contract genuinely permits void success. The public notification entry owns its existing overall response lifetime, including lazy loading; cancellation cannot issue a later answer. No new response operation, replay store or request journal is introduced.

Ordinary OS request notices are dismissed only after positive canonical completion of their exact Home/Account/session/request/turn. Missing or compact-only Session data is insufficient evidence. Cleanup runs independently of local sending preferences and inspects only Sessions named by presented notifications. On Android the local sender preserves the request category channel when the sound policy supplies no override, while custom and silent sound channels remain authoritative.

### Remote-push diagnostics and quiet-hours authoring (0.3 development)

The Account Action `notifications.push.test` uses the authenticated exact-registration route `POST /v1/push-tokens/:tokenId/test` and the existing Home push sender. The server chooses fixed content and verifies that the token belongs to the authenticated Account. No CLI, broadcast fallback, delivery-receipt loop or new retry owner is added. Service acceptance is distinct from device delivery; transport failure is unconfirmed. Sender results and default-on logs expose partial acceptance. Supported older Homes without the route remain unavailable for this diagnostic.

The custom Account/device quiet-hours editor writes through existing settings Actions and delivery-policy schemas. Authoring validates an evaluable time zone and schedule through one input owner; historical persisted readers retain their existing recovery/default behavior. Existing schedules remain authoritative until Save succeeds. This adds an editor to the current policy, rather than a second scheduler or persisted format.

### Request notification previews (development)

The 0.3 development Notify me Action adds `notify_me` to the webhook topic union
without changing existing topics or payload version. Its optional navigation
uses the existing `sessionId` field or an additive `runId` field. The Activity
owner applies the same attention-policy privacy projection before push, webhook
or plugin delivery. No notification persistence migration or Inbox record is
introduced. Webhook integrations that validate a closed topic enum must accept
this new topic before opting into Notify me delivery.

The Account endpoint-catalog transition is development-only and still in progress.
Its source reader accepts the genuine predecessor Expo Push and HTTP(S) webhook shapes,
preserves their channel ids, six topic fields and exact opened signing bytes, and derives
the builtin push channel only when the source root is absent. An explicitly empty source
stays empty; an admitted empty row or tombstone never reseeds from preferences. Signing
material moves to a SavedSecret Resource rather than a second inline delivery secret.
Catalog consumers treat an unsupported Home route, unreadable row or incomplete inventory
as unavailable, without a push fallback. This does not declare the Settings-based UI
editor retired or certify retained source/history cleanup.

Request previews use the existing `attentionDeliveryPolicyV1` channel/event privacy
owner. Remote push and Live Activity permission and user-action events default to
`include_preview` unless an explicit event preview policy restricts details; legacy
`requestIncludeMessageText` preferences are translated at the existing settings
adapter. Webhook request content defaults on unless the destination sets
`requestIncludeMessageText: false`. Disabling either disclosure decision omits
request details from the body and `request.toolDetails`.

Device-local ready and request preview overrides are separate fields under the
existing `attentionDeviceOverridesV1.localNotifications` owner. The request
override defaults to `account`, delegating to the shared policy. Notification
routing and permission-response schemas are unchanged; richer content uses the
existing text fields, with no new server operation or migration.

The released 0.2 notification editor at `98ea8fb76733b1dd785d38c31360179cafa84824`
(`ui-mobile-v0.2.11`, `ui-web-v0.2.11-preview.186`) rebuilds nested legacy
notification settings and strips unknown fields. A missing remote request flag
therefore restores previews, following the user-selected default. An older editor
can erase an explicit opt-out; users can disable previews again from an updated client.
Older CLI senders ignore this preference and retain their reduced hints.

### Changed Files attribution (development)

The unreleased Changed Files projection separates content confidence from Session/turn
attribution in the canonical Protocol merger, `sessions/changes/mergeTurnChangeSets.ts`.
An exact checkpoint delta can have only possible attribution when another checkpoint
interval overlapped. Correlated Agent/tool evidence remains independently attributable,
while workspace touched paths supply only best-effort content and possible attribution.
The derived per-file and summary axes do not introduce another persisted change-set document.

The foreground host publishes one terminal Diff recap after its existing checkpoint
lifecycle joins normalized tool evidence with the final checkpoint result. The runtime
transcript publisher writes that combined card; the checkpoint lifecycle does not write
a second recap. Bound native turns await that write in their terminal transcript
projection, preserving the existing required-write failure outcome before settlement.
Native turns without a dispatched checkpoint binding and standalone Runs
use the same publisher with provider evidence alone. Original tool rows remain separate
evidence, unavailable checkpoints retain provider evidence, and empty turns emit no recap.
At that join, the CLI checkpoint projection expands home-relative forms with its canonical
path helper and uses the shared Protocol repository-path normalizer against the resolved
Git root for both current and rename-source paths. Absolute Agent paths and relative Git
paths therefore retain both observations under one root-relative identity; the existing
merger selects content and statistics once. Separator normalization and sibling-prefix
containment stay with the shared path owner, not a transcript/UI dedupe path.
This changes new development-source publication, not previously stored transcript rows;
loaded-runtime verification still requires the rebuilt host and a usable Agent turn.

The same merger normalizes evidence paths against the resolved repository root and retains
all contributing observations through rename chains; copies remain independent. Consumers
use that projection rather than reconstructing lineage from the final filename. Across
turns, a later tool patch is not a Session-wide diff. Continuous recorded text spans can
produce a best-effort net comparison, but tool text may be only a fragment: equal aggregate
endpoints cannot prove that the file is clean. Missing or discontinuous net evidence remains
unavailable, and scoped review does not substitute the current working-tree diff for it.
The Session's canonical latest-turn identity selects the turn view even when that turn
has no file evidence; older file changes remain available in the Session view. Hosts without
that identity retain the evidence-chronology fallback. Checkpoint capture preserves runtime
sequence ranges before asynchronous publication rather than using transcript arrival order.

Checkpoint overlap is historical, process-local capture evidence. The CLI registry uses
the resolved SCM root, remembers overlap for each interval after peers finish, and closes
the interval when final capture completes, before asynchronous diff projection. An interval
without observed overlap says nothing about writers in other CLI processes, daemons,
editors or shells. Project membership does not establish filesystem authorship or isolation.

Current checkpoint writers use `shared_worktree` when overlap was observed,
`no_happier_checkpoint_overlap_observed` when the process-local registry observed none,
and `unknown` when the observation is unavailable. The former development-only
`exclusive_worktree` value was removed from the strict reader after the inspected 0.2.11
stable/preview CLI and UI tags and the current predecessor corridor showed no producer.
No compatibility adapter reinterprets that unshipped exclusivity claim.

The clean prospective predecessor corridor at
`b23f95ed354e8d49183017e487bdb75f217017de`,
`packages/protocol/src/sessionChanges`, names Agent turn correlation `providerTurnId`.
The current evidence schema normalizes that field to `agentTurnId`, preserving an explicit
current field when both are present. Invalid aliases and unrelated unknown fields remain
rejected. Current writers use `agentTurnId`; remove the reader translation only when
predecessor-produced change sets cease to be supported inputs. These reader provisions
are not certification of mixed-version deployed clients or completed live UI validation.

### Session message authorship in development

The current authenticated transcript adds an optional nullable `accountActor` presentation field. Its Account identity and minimal profile are strict nested schemas; older message envelopes may ignore the additional field. An omitted field preserves previously projected actor metadata during an update, while explicit null clears it. New clients render no inferred author when an older server omits the field. Public/external transcript projection remains separate and omits the Account actor.

The nullable `SessionMessage.authorAccountId` relation is derived from the immutable admission receipt and uses `ON DELETE SET NULL`. Historical rows without a valid human receipt remain unattributed. Deploy current receipt-derived writers, run the [provider-neutral backfill and disagreement audit](pending-delivery.md#human-authorship-in-development), and verify its result before author-based personal Session scopes activate. Additive DDL alone does not establish old-server restart or overlapping-writer support. No JSON-query fallback, repair worker, or second author store participates in this transition.

The Session record also carries an optional `hasOtherNamedCollaborator` audience-existence signal: true when the current authorized human audience contains another Account besides the requesting viewer. It is presentation-only (the transcript self-byline "You" suppression), independent of live presence, and never a roster, authorization input, or grant source. Omitted means the producer did not project it; consumers preserve the last known value instead of asserting a solo Session, and an explicit boolean always replaces it.

### Session visual references (0.3 development)

These are development source contracts, not released availability or deployment
certification. Session visuals retain the existing `surface/item.v1` record owner.
Stored items without a creation destination read as `board`; current creation
records `transcript`, `board` or `both`. Pin and Unpin remain layout operations and
do not change that creation intent or create another item.

The centralized transcript producer captures a small collection of corresponding
visual references before sealing acknowledged tool completions. Multiple native
tool results in one raw message remain one message, with every corresponding
visual represented. The negotiated transcript observation V2 epoch carries the
collection to the existing message writer; V1 retains ordinary text delivery
without the unsupported association. Historical import V3 carries the same optional
collection through the existing batch writer. Its older V2 fallback preserves the
messages but omits the association, so a public visual is honestly unavailable
rather than read through a parent or generic-record fallback.

The retained server-private message JSON column stores the canonical collection;
one shared read codec also accepts the earlier development singleton. Each current
member names an item and its acknowledged record incarnation in the current
Session, plus the exact original item/revision/address for recognition. The
committing writer validates every local record independently: an unavailable member
does not discard valid siblings or otherwise valid text. Content correction clears
an old collection unless the writer admits a replacement. Public reads select an
admitted member index of a published message under the existing share grant and
cutoff, not an independently supplied item id. Fork imports associate independently
owned child records. Original identity is recognition only, never parent-read
authority. An earlier copied singleton without original identity cannot safely
identify a sibling and fails correspondence closed; no source identity is invented.

Public Session-share requests add optional `networkOff`, with absence reading as
`false`. The canonical request binder omits false, preserving the ordinary request
shape. An explicit true must also be acknowledged as true before either client
reports successful issuance. Older strict servers can refuse the option; an older
permissive server that strips it leaves the existing outcome-unknown result, never
a falsely confirmed network-off link. That unknown result does not prove that no
server-side link was created. The stored option can restrict the shared sandbox but
does not itself admit network access. See the
[Session share API](api.md) and [public encryption boundary](encryption.md) for
the canonical envelopes and viewer contract. The additive message/share columns
require the canonical provider migrations; source generation alone does not prove
deployment against retained data.

### Enterprise identity and directory provisioning (0.3 development)

Managed identity providers, Team identity connections, and directory sources are new
additive tables in 0.3 development source. Nothing about them is released, so the only hard
obligations here are the released `AccountIdentity` and `LinkedProvider` shapes they extend.
The domain itself is described in [enterprise-identity.md](enterprise-identity.md).

| Direction | Required behavior |
|---|---|
| Released UI → new server | Ordinary built-in and deployment authentication remains usable and strict `LinkedProvider` remains parseable. Managed administration is simply absent from an older client, never malformed. |
| New UI → released server | Ordinary Home authentication falls back to the released `/v1/features` projection **only** when `/v1/auth/entry` answers 404, 405, or 501. Team-managed operations are unavailable rather than sent to a permissive generic route. |
| Released database → new server | Migrations are additive and preserve every existing `AccountIdentity.provider` value and profile byte. No environment-provider row is backfilled, and there is no foreign key from `AccountIdentity.provider` to the managed provider table, because built-in and deployment providers intentionally have no row. |
| New schema → old server | Not a supported direction. Additive tables alone do not establish safe old-binary startup. |
| Mixed fleet after activation | Not supported. Every authorize, callback, and finalize handler must resolve managed providers before managed configuration is activated. |
| Old-server rollback after activation | Not supported, and no rollback-only writer or persistence path exists. This does not remove released-client support against a new server. |

The activation sequence is therefore prepare, then all-capable activation: add the tables,
codecs, readers, and catalog with managed providers disabled; replace every server process
that can receive an OAuth start, callback, or finalize; then activate managed configuration
and writes.

One compatibility reader is retained deliberately. `securityBinding` is optional in the
persisted OAuth attempt and pending schemas
(`app/api/routes/connect/oauthExternal/oauthExternalSchemas.ts`), because a server process can
be replaced while attempt rows it authored earlier are still inside their TTL. That reader
carries no managed or Team authority. `hasInvalidOAuthSecurityBinding` exists so a
**malformed** new binding can never be misread as a legitimately absent one. Its removal
condition is the drain of every legacy-writing server process plus the maximum attempt and
pending TTL — a server-authored ephemeral lifetime, which client support windows do not
extend.

Because none of this has shipped, an unreleased intermediate shape carries no obligation:
correct it in place rather than adding a reader for it. Persisted directory projections are
reconstructible from their upstream source, but native memberships and Group contributions
written from them are not — they are ordinary native facts owned by
[teams-membership-and-groups.md](teams-membership-and-groups.md) and follow that owner's
rules.

### Native email/password authentication (0.3 development)

The following describes the current development source, not a released feature.
The method is default-on, with
`HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED` and its provisioning key as the
operator opt-out described in [feature-gating.md](feature-gating.md). Persisted
Home policy and operation-specific mail readiness determine effective actions.
There is no disabled-until-validation activation gate. Current-source tests and
runnable development journeys remain implementation checks; physical-device,
real SMTP and production-like infrastructure evidence remain release checks.

The immutable stable server source tag was rechecked on 2026-09-26 as
`server-v0.2.12` at `a357c65536ba89669422977d6f7daf9aa0d17e73`.
The moving `../0.2` predecessor was inspected read-only at
`9047258b99545a8ce84923789c87945fcaeb1e69` with a clean worktree. Its bounded
auth, credential and schema paths contain no native-password or Account API-token
contract. These are source observations, not artifact/deployment certification.

`AccountEmail`, `AccountPasswordCredential`, and the native email identity are additive
tables and rows in 0.3 development source; the nullable password-mutation purpose/digest
fields extend the unreleased `KeyChallengeV2` migration in place rather than shipping an
add-then-alter history. Nothing here is released, so the released obligations are the
existing Account, identity, and credential shapes the new tables extend.

The incumbent Account-encryption migration request likewise gains only an optional strict
prepared `passwordCredential` participant. Released clients cannot have the unreleased
password row and retain their passwordless transition behavior; current clients with an
enrolled password must supply the participant, and the server fails closed instead of
flipping the mode beside a source-mode credential. No reader or dual writer is retained for
superseded, undeployed development request drafts, and the staged V5 route stays disabled.

The approved 0.3 upgrade is one-way: every component updates together, with no
mixed 0.2/0.3 operation or old-binary rollback. The former old-client-safe
`email_password` omission has therefore been removed. `/v1/features` publishes
the effective method decisions through `toPublishedAuthMethods`, while
`POST /v1/auth/entry` remains the complete contextual Home/Team/invitation
projection. Both consume the same policy owner; neither creates another
availability decision.

| Direction | Required behavior |
|---|---|
| Current 0.3 client → current 0.3 server | Native password actions use the current effective-method and contextual-entry contracts. |
| Mixed 0.2/0.3 client/server | Unsupported under the all-component one-way upgrade; no old-client omission or minimum-client simulation is required. |
| Released database → new server | Migrations are additive and preserve every existing `AccountIdentity` value and uniqueness rule; the native-identity widening is applied forward through the owning unreleased migration, not by a second lookup or digest alias. |
| New schema → old server | Not a supported direction. Additive tables alone do not establish safe old-binary startup. |

A password-only Home is a permitted operator configuration. Governance still
protects currently usable Account login routes and the final active Home
administrator through the canonical auth-domain check; it does not impose a
0.2-client floor. Forward readability of 0.2-created data remains required:
existing credentials, recovery-key bytes and provider identities are preserved,
and released migrations remain immutable. Purpose-bound mutation challenges
must still be rejected by ordinary login redemption. These invariants require
neither a compatibility writer nor a separate rollout protocol.

## Migration history

Migration source has a stricter authoring boundary than ordinary internal code:

- A migration is **local-only** while it has not shipped in a supported stable or preview artifact. Local-only migrations may be edited, renamed, consolidated, or removed before publication.
- Once a migration ships in a supported stable or preview artifact, its name and bytes are immutable. Correct later behavior with a new append-only migration; do not rewrite, rename, or delete the released migration.
- Shared development branches and `*-dev.*` artifacts are evidence that a development database may need explicit reconciliation, but they do not create a lasting product compatibility obligation. Before the next supported release, their migration source may be corrected or consolidated in place when the final transition is still unreleased.

Before publishing a feature, consolidate local-only migration churn into the smallest clear transition from the published schema to the intended final schema. Do not retain add-then-drop columns, temporary tables, renamed draft identities, checksum aliases, or corrective migrations solely because a developer database applied an earlier draft. Retain multiple migrations only when each step serves a real rollout, backfill, transaction, provider, or mixed-version requirement.

If the deterministic repo-local development stack bound to the current checkout applied a local-only or development-exposed draft that is later rewritten, the database must be reconciled in place as part of the same implementation task:

1. resolve the current checkout's deterministic repo-local stack and verify its repository path and managed database ownership;
2. treat its database as retained, non-disposable development data—never delete, reset, recreate, replace, truncate, clean, or discard it;
3. do not ask for separate confirmation and do not create a backup, snapshot, or clone for this narrowly scoped repo-local reconciliation;
4. compare its actual data, complete physical schema, and migration ledger with the intended final schema;
5. quiesce only stack-owned writers when required, apply the exact provider-specific schema/data delta or canonical backfill transactionally, and update only the matching ledger record after the transition succeeds;
6. run the canonical migration deploy twice, then verify current source checksums, the ledger, provider integrity, and foreign keys;
7. restore the stack's prior running state when it was quiesced.

The migration edit and its repo-local reconciliation are one work unit owned by the last editor. Any later edit to the migration invalidates earlier checksum/ledger reconciliation evidence and requires the later editor to repeat reconciliation before handoff.

For `main`, shared, staging, production, external, another checkout's/named QA stack, or otherwise user-owned databases, prepare the provider-specific procedure, back up or snapshot when required, and obtain explicit approval before mutation. If stack identity or database ownership is ambiguous, fail closed without mutating any candidate.

That reconciliation is an operator/development action, not a shipped compatibility path. Do not add runtime checksum exceptions, migration-name aliases, duplicate no-op migrations, or automatic ledger repair merely to preserve unpublished development history.

Keep PostgreSQL, SQLite, and MySQL migrations aligned by intent. Before publication, validate both a clean migration from the published baseline and the executed repo-local reconciliation path when affected; use the approved reconciliation path for other retained databases. After publication, preserve the exact migration history and test upgrades append-only.

### Unistyles native bindings (development)

The development UI upgrades Unistyles from 3.2.4 to 3.5.3 and Nitro Modules
from 0.35.6 to 0.37.1. Non-publicdev lanes use the new `0.3.1-native`
runtime train, so this JavaScript cannot be delivered to binaries containing
the previous bindings on `0.3.0-native`. Publicdev retains Expo's fingerprint
policy. Rebuild the native development client after installing these dependencies;
a Metro reload alone cannot update the native bindings. Publish the matching
native build before publishing an OTA update for this train.
React Native's CocoaPods post-install owner marks glog's namespace-fragment
headers textual, so Swift can import Nitro's public Fabric headers without
Clang attempting a submodule import inside `namespace google`.
