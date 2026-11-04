# Search and Commands

Universal Search is the one query surface for commands, sessions, projects,
transcript messages, settings pages, workspace files, commits, and trusted
plugin entities, with platform-specific hosts (web/desktop modal, native
keyboard-seated overlay, the canonical `/search` route) and one contextual
session-list consumer. This page is the internal canonical description of its
current 0.3 development architecture. Published behavior lives at
`apps/docs/content/docs/organize/search.mdx`.

Status: implemented through production callers on the 0.3 development branch;
not part of a released stable version. The app-shell provider now opens the
universal modal or native route, a web link to `/search` hands its query and scope
to that one modal and leaves the route, native `/search` renders the same controller, and the
session-list destination and escalation use that route. Source integration is
not a substitute for the plan's still-required loaded browser, iOS, Android,
accessibility, and Lane 09 evidence.

## Canonical owners

| Concern | Owner |
| --- | --- |
| Open/close, query context, shortcut handling | refactored app-shell search provider (`CommandPaletteProvider`); native routes the persisted `commandPalette.open` identity to `/search` |
| Command inventory | `buildCommandPaletteCommands` (navigation, recent sessions, settings, feature decisions, plugin Actions, keyboard labels); adapted to `SelectionList` sections by `buildCommandPaletteSelectionListSections` |
| Result list, input, selection, a11y, virtualization | `SelectionList` and `useSelectionListDynamicSections` |
| Universal section construction | `apps/ui/sources/components/appShell/search/buildUniversalSearchSections.tsx` — a thin adapter over domain owners, deliberately not a registry |
| Normalized result/target identity | `universalSearchResult.ts` (`UniversalSearchResult`, source-namespaced option ids, exact target facts) |
| Activation | `activateUniversalSearchResult.ts`, dispatching to the canonical session/project/file/SCM/settings/command/plugin owners after the host is dismissed |
| Route and presentation | `/search` (`UNIVERSAL_SEARCH_ROUTE`); `transparentModal` on iOS/Android; on web/desktop the route draws nothing and opens the modal over the shell |
| Native keyboard geometry | `UniversalSearchNativeHost` + `universalSearchNativeGeometry` over the existing keyboard-aware screen, scrim, and safe-area owners |
| Session-list search | stable `SessionListSearchChrome` plus `sessionListSearchGroups` and `useSessionListMemorySearchAugmentation`; session rows only, with a `Search everything for …` escalation into universal Search |
| Home transcript execution | Lane 07 Home search route/service (explicit target, feature admission, capability readiness) |
| Daemon transcript execution | daemon memory owner (explicit server + machine, Unicode tokenizer, archived policy, removal/reconciliation) |
| Files / commits / settings / sessions / projects | existing workspace-file search, SCM owner, resolved settings catalog (Fuse), synchronized projections/catalogs — adapters only |
| Text in files | `workspaceFileContentSearch` through `machineWorkspaceFileSearch` and the daemon `workspaceFileSearch` handler; no persistent content index |
| In-surface Find | shared `packages/plugin-ui/src/presentation/find/` presentation and display-text matcher; ephemeral transcript, review and file models; editor/terminal engine adapters |
| Standard conversation content | `sessions.external.candidates.list` with `searchTarget: 'content'` → `candidateQuery.ts` → plugin codecs and SDK `sessions/file-stores` content-search helper; shared `openExternalSessionCandidate.ts` for browser and Search activation |
| Indexed conversation content | incumbent daemon Memory worker, `memoryFtsIndex.ts`, `searchMemory.ts`, and existing normalized external transcript readers |
| Conversation fan-out and merge | `sync/domains/search/searchConversations.ts`, through the Account adapter `sync/ops/searchConversations.ts`; `useConversationSearch` serves the palette, activated scan surface and History Conversations mode |
| Machine Search settings and index clearing | `MemorySettingsV1.conversationSearch`, existing daemon-local settings persistence/RPC, and `memoryWorker.clearIndex`; Action specs remain the public dispatch owner |
| Next | session-core pending age comparator/selector, `activity/source/buildPendingNavigationFromSource.ts`, `nextPendingRequest.ts` and `navigateToPendingRequest.ts`; mounted `NextPendingNavigationHost` |
| Plugin declarations and execution | `contributes.searchProviders` in the contribution catalog + the existing Action dispatcher (`executeAction | openSurface`) |
| Feature admission | `packages/protocol/src/features/catalog.ts` via `useMemorySearchProvider`; see `feature-gating.md` |

## Workspace replacement (0.3 development)

Replacement extends the Text in files source. The Machine previews and applies
through `daemon.workspaceFiles.replace.preview.v1` and
`daemon.workspaceFiles.replace.apply.v1`; clients do not loop over individual
file reads and writes. `machines/workspaceFilesReplace.ts` owns the pure byte
transformation for both operations. Literal replacement keeps dollar signs
literal; regex replacement follows JavaScript capture and replacement patterns.
Matching and replacement stay within one line.
An explicitly armed Replace mode accepts an empty replacement to delete the
selected matches; an empty field alone does not arm replacement.

Preview hashes cover raw bytes, including a UTF-8 BOM. Apply receives only
reviewed files and their excluded match positions. The writer prepares every
target before changing any file. If a target changed after preview or its edits
cannot be applied, the whole set is refused: affected targets report their
refusal and the others report `skipped` with `edit_set_aborted`. Invalid UTF-8, UTF-16 and binary
content are skipped; the transformation preserves a UTF-8 BOM and existing
line endings. Every successful write uses the editor's guarded atomic writer.
Returned inverse edits support hash-guarded Undo through the same replace Action
without server-held pre-images. Apply results and their Undo retain the original
Machine, root and Account; another search scope cannot adopt them.

The Universal Search composition owns draft exclusion, selection and preview
freshness. Retained previews render with their captured matcher; a changed
query, option or replacement disables Apply until a fresh preview succeeds.
Files already dirty when previewed stay excluded until a new preview. A selected
target that becomes dirty after preview refuses the whole Apply before dispatch.
Apply covers only loaded, selected matches. Surface composition and loaded
runtime acceptance are separate from these Machine contracts. Regex discovery
inventories files through ripgrep's existing exclusions/ignore/hidden policy;
the JavaScript matcher alone decides matches. This includes JavaScript patterns
that ripgrep cannot compile and avoids differing Unicode boundary semantics.
Whole-file continuation pages expose only complete selectable files, with
explicit incomplete coverage for an indivisible result beyond the existing
transport boundary. Replace apply and Undo enter the canonical danger Action.
Its existing host operation owns cooperative cancellation between files and
retains the terminal acknowledgement, including completed-file inverse edits,
in the same in-memory operation result. Clients cancel and wait for that exact
operation rather than treating acceptance or a cancelled observation as its
file result. These are unreleased source contracts, not completed
loaded-surface validation.

## Data flow

1. An entry point (shortcut, sidebar Search destination, native action,
   `/search`, session-list escalation) opens the single search provider.
2. The provider builds the command inventory once per open and composes
   sections through `buildUniversalSearchSections`: static local sections
   (commands, sessions, projects) plus dynamic sections bound to explicit
   targets (transcript, files, commits, plugin providers).
3. Every remote/corpus section declares `visibleWhen: query is non-empty`, so
   an empty query is a pure UI state — bounded recents and suggested commands,
   zero wire requests.
4. `useSelectionListDynamicSections` owns per-section debounce,
   `AbortController`, and independent loading/error/success state; sections
   publish without blocking or clearing each other.
5. Selecting an option commits the result identity; the host dismisses, then
   activation re-resolves currentness at the canonical owner and awaits it.
   Failures surface through the canonical error owner — no fire-and-forget at
   the surface seam, no retargeting to the currently focused Home/machine.

The workspace UI Action owner distinguishes accepted, refused and intentionally
cancelled navigation. File and project openers preserve cancellation as `null`
rather than collapsing it into refusal. Search dismisses before awaiting the
navigation decision; declining an unsaved-changes or approval decision leaves
the current file/draft alone and does not present a Search error. Actual refusal
or an unexpected activation exception still follows the existing error path.

Built-in adapters map results to `SelectionListOption` immediately. The
UI-internal `UniversalSearchResult` shape exists to keep target identity and
activation separate from presentation; it is not a wire protocol, a row
database, or an SDK type.

Immediate Session matching is metadata-only: canonical Session id/title,
project or workspace display label, path, tags, host, and machine metadata.
Arbitrary hydrated transcript and tool content is excluded from this local
haystack and belongs to the selected transcript provider. The existing bounded
first-user-message title fallback remains searchable because it has already
been promoted to the Session's visible canonical title; this does not admit any
other transcript body into immediate matching. Exact title/session/project
matches precede other metadata, then transcript-provider order, with outside
matches kept in the contextual `Other matches` group.

## Session-list identity, lifetime and filters

The contextual Session-list consumer shares rows with the existing per-Home
runtime; it does not give Search ownership of those rows or the pagination
frontier. The following Lane 07 corrections are required and in progress on the
0.3 development branch. They are not a completed-validation or release claim.

- An explicit `{ serverId, sessionId }` remains exact through route hydration,
  activation and workspace display. Only a verified profile alias may normalize
  its Home. An unavailable Home does not become the focused Home, and a bare-ID
  project match cannot replace facts belonging to the qualified row.
- Mounting another consumer with unchanged credentials preserves the existing
  Home's rows and frontier. Actual credential replacement retires the affected
  projection through the credential/runtime lifecycle, not a consumer's mount
  callback. Refresh requested during pagination retains its page-one replacement
  intent and settles only when that refresh finishes.
- Each acquisition owns its cancellation. Independent reads may share hydrated
  rows, but one cannot supersede another merely because both use the same Home,
  query or `rowOnly` membership. Deletion or revocation during asynchronous
  hydration must still exclude the address when membership is published.
- In a fixed Team view, pruning the last authoritatively deleted Group restores
  that Team audience rather than broadening the list to every accessible Session.
  An incomplete roster cannot prove deletion. The compact tag selector exposes
  each applied tag as an independent multi-selection state, separate from the
  keyboard-highlighted option.

These corrections belong to `useHydrateSessionForRoute` and the existing display
target owner; the credential and `concurrentSessionCache` lifecycles;
`sessionSnapshot` and `sessionListQueryController`; and the shared
`sessionListViewFilters` / `SessionListSearchChrome` controls. Their consumers must
also preserve [list incompleteness](protocol.md#session-awareness-development):
exhausted cursors do not prove that all authorized rows were returned.

## Target scoping

Scope is Search-local and contextual. Opening the
surface captures the caller's exact Account/Home/session/machine/workspace
context. When another reachable Home or workspace is available, the compact
scope control changes only this Search instance; it does not change the app's
ambient focus. Session-list escalation carries that list's selected Home into
the same scope owner.

- Changing scope rekeys the existing SelectionList dynamic sections, whose
  cancellation and stale-publication fences retire the superseded work.

- Home transcript search targets the exact selected server/Home; the target is
  captured in result identity and activation, so a focus change mid-query
  cannot re-key or activate results under another Home.
- Conversation search can target one machine or **All machines** in the selected
  Home/Account. The fan-out owner queries online machines through exact
  Account-bound machine RPCs and the existing concurrency-limited task runner.
  Offline machines remain visible as coverage gaps. The session-list's existing
  contextual memory adapter still resolves one explicit machine; it does not
  own universal conversation fan-out.
- Files target the exact current workspace; commit search additionally stays
  within that workspace's current Git branch or current Sapling parent set.
  With no workspace present the section is omitted rather than pointed at an
  arbitrary one.
- Sessions/projects/settings read local synchronized projections; plugin
  providers target currently admitted plugin Actions.

All-machines conversation search stays within the selected Home/Account; it
does not aggregate every Home. There is no server-side
**universal aggregation** endpoint. Plaintext Personal Home transcript search
does have its own authenticated, feature-gated `POST /v1/home/search` endpoint;
it is one source-specific executor, not a general search coordinator.

## Conversation search settings and Actions (0.3 development)

Each machine stores Search choices in the existing `MemorySettingsV1` record,
under `conversationSearch`; there is no separate Account settings key.
`standardSearch.enabled` defaults to true. Disabling it refuses native content
scans at the daemon's canonical external-candidate Action boundary, returning
unsupported coverage with `contentCoverageReason: 'standard_search_disabled'`.
Metadata/title browsing is unchanged.

`indexExternal` defaults to disabled, no selected Agents, all history
(`historyDays: null`), and tool output excluded. It selects native transcript
ingestion through the existing Memory worker, which also requires Memory to
be enabled. Positive whole `historyDays` values constrain eligible history;
an empty Agent list selects none, including Agents installed later.

The existing machine settings RPC carries the complete record. Search settings
get/set (`search.settings.get/set`), index status (`memory.status`), clearing
(`memory.clear_index`), and client-placed cross-machine conversation search
(`search.conversations`) are public Actions in the [Actions platform](actions.md), projected to
the existing generated Actions reference.
Cross-machine execution delegates to the mounted client Search coordinator.
`Settings → Search` and the Memory page share `useMachineMemorySettings`, the
single UI reader/writer of that machine's record. Search offers **Search on
demand**, a link to **Memory search**, native indexing/Agent/history/tool choices,
index status and **Clear index**. The current settings page displays machine-wide
status; the per-source projection below is consumed by search selection and Actions.

`daemon.memory.status` advertises optional per-source readiness in `sources`.
Native entries identify an Agent and configured source key; Happier entries
identify a Session. For native sources, `ready` means the initial eligible
inventory is complete and every retained conversation has reached its tail
with complete searchable coverage. Pending appends and routine inventory
refreshes do not erase that initial coverage. Read failures, replacement,
revisions, budget eviction and clearing still invalidate readiness; it is not
a promise that every concurrent append is already searchable. Happier Session
readiness follows the queue's completed `indexed` or `empty` outcome, unless a
transcript revision or an active transcript indexing operation is pending. Session inventory
sequences can include non-message events; they do not reopen a completed
transcript scan. Session `updatedAt` also changes for metadata and does not mark
transcript content dirty. The worker revalidates retained content once on first
observation after startup; later edits arrive through the durable transcript-change feed.
A batch removes checked snapshots from its active Session set
before yielding and removes each completed Session before reading its siblings.
The optional `worker.sessionProgress` diagnostic separates the inventory's
`observedSeq`, the deep lane's checked/excluded `checkedSeq`, and its transcript
`indexedSeq`; `worker.activeOperations` projects the existing operation kinds
and Session sets. Older daemons omit these diagnostics. Status reads do not create or update indexing cursors, so they
can read the WAL snapshot while another connection owns the writer. Native
error rows carry `errorCode` and an allowlisted, content-free `errorReason` from
the bounded reader. Vendor exception text, paths and transcript content are
excluded from that diagnostic; a successful retry clears it. The native
indexing batch records a failed conversation independently and continues its
other selected conversations; that source failure does not reject the worker
tick. Cancellation still stops the batch. The deep
index retains native reader progress after eviction and records incomplete
searchable coverage in that same source state; unchanged tails or new appends
do not restore evicted history. Clear/rebuild or source replacement restores
coverage. Older development state without that coverage fact remains unready
until rebuilt. Explicit `auto` search skips
the standard scan only for an exact ready native source; unknown, indexing,
disabled and error states retain the configured standard-search fallback.
Older daemons without the advertisement never imply native freshness. Palette
typing remains indexed-only. Readiness is relative to configured backfill,
content/coverage and disk policies; it does not prove exhaustive history.

The public `memory.get_window` Action accepts either a Session sequence range
or a native `{source, sourceItemId, cursor?}` locator. Native windows return
`externalSnippets` through the same authenticated, exact-machine RPC. Native and
Session identities cannot be combined. Credentialless Session-bound MCP does
not gain native transcript authority.

An explicit older-page native locator is validated before use. If its page ends
at the target, the same window traversal used for an implicit locator recovers
the newer padding from the indexed neighbour or native head. An invalid explicit
locator keeps its discontinuity result.

`memory.clear_index` is a danger Action and requires approval by default,
including when invoked by the present user without an explicit confirmation
waiver. The worker stops and drains indexing before clearing its derived SQLite
databases, including native source cursors and progress. It retains saved
settings and inference models (subject to the existing delete-on-disable
policy), then resumes the saved indexing configuration. An enabled worker can
rebuild immediately; clearing is not
secure physical erasure or a promise that the index remains empty. In 0.3
development, the Settings button executes this same Action under its captured
machine, Home and Account. It honours configured approval waivers and explicit
approval requirements, waits for the approved result, and refreshes that
machine's status after a successful clear. Rejection or Account retirement does
not redirect the clear to the page's newly selected target.

## Memory index and native ingestion (0.3 development)

The daemon's `memoryWorker.ts` owns saved settings, Account/Session revisions,
shared native observation demands, hint Execution Runs and record commits,
fresh document admission, and status/search reads. `memoryIndexer.ts` owns
transcript decoding, native readers, the shared source scheduler, FTS/deep
writes, pruning, and embedding models. Its production binding registers a
host-owned `process` + `demand` service with the existing background-service
lifecycle. The generic service bridge carries requests, cancellation and
status; the child loads only daemon-admitted Agent readers. Query embeddings
return vectors and native verification returns pages through that boundary.

A run drains admitted work and continuations, closes its writer handles and
exits. The daemon retains wake sources and starts a fresh child for later
demand; hint idle/rate/backoff deadlines come from the existing hint admission
owner. The inventory freshness cadence observes Session metadata without
starting a child when eligible transcript frontiers are unchanged. The work
pump runs for real changes and the next scheduler deadline; unchanged settings
reloads do not demand another process. Children drain their own continuations
and hints that become due before settlement. Settings retirement and Clear index join terminal process settlement
before deleting files. Daemon SQLite readers do no schema setup or migration;
the indexer is the writer. A failed child remains visible as an error, and an
absent child does not erase retained coverage. This describes development
source wiring; the composed daemon RSS/latency and child-exit replay remains
an integration validation requirement, not a measured performance claim.

Restarting the daemon reuses retained summary, deep and native index data when
its saved indexing policy is unchanged. The cursor database retains the policy
baseline; older indexes are qualified using their existing row policy keys,
with unproven cursor-only progress rewound. A real policy change removes the
affected old-policy content before background reconstruction. Startup and
settings admission do not rebuild transcripts. A failed startup access check
keeps the worker and status/settings RPCs available, reports an error, and
withholds index paths until the existing inventory loop can requalify access.

Native title/transcript display hides only reproduced Happier base guidance
and installed-Agent catalog blocks. The coding-plan delivery renderer and its
inverse live together in `prompts/promptPlanV1.ts`: its length-qualified frame
delimits content but does not establish authorship. A framed plan is hidden
only when its entire content matches those known producer blocks. Variable
context and unreproducible plugin resources remain visible verbatim, including
their frame. Historical base-prefix rules retain their exact producer text.
This is display cleanup, never provenance, identity or authorization.

The UI's `normalizeExternalSessionTranscriptMessages` applies the same
base/plan inverse to user text in native transcript display projections. The
History exchange preview and linked transcript page/read-after views consume
that projection, including Find. Unverified wrappers therefore remain visible
and findable. Content matching searches the original text even when a known
prefix is hidden; a clean snippet is preferred only when it contains the query.
Native `raw` records, persisted imports and Agent input retain their original
bytes.

For historical bare Agent guidance, the native candidate invocation binds the
reader derived from the same current Agent catalog used for injection
(`providerPromptBehaviorRegistry.ts`). The SDK's scoped reader serves native
title decoders, the bounded scanner and content matching, including separately
bundled SDK copies; concurrent reads do not replace one another's catalog.
Removed or changed historical plugin text cannot be reconstructed from a
current declaration alone. Existing native title precedence remains intact.
For transcript page/read-after display, the bounded host adds optional
`displayUserText` only when that catalog-derived inverse changes a native user
record. The UI uses it under the same native/imported message identity. The
field is presentation only, is not admitted from plugins, and is absent from
terminal projections; `raw` stays byte-exact. Older responses without it still
use the Protocol base/plan inverse at the UI display boundary.

The host verifies connected native homes physically at configured-source
admission using the SDK's `resolveVerifiedNativeHomePath`, and grants the
returned physical path to native readers and retained/configured adapters.
Repointing a lexical ancestor of a relocated root after admission therefore
does not redirect an existing grant. Relocating the whole homes root and
linking shared state inside an admitted home remain supported. This assumes
the daemon user's verified directory components remain trusted; it does not
bind filesystem handles against changes to those components. A profile that
has never created its home still returns retryable unavailable.

The packaged ripgrep transport sends its payload over stdin. Explicit regexes
use ripgrep's pattern-file stdin, and admitted file operands are split into
launches within the CreateProcessW command-line boundary. Every file is kept;
no query or family is truncated, and a failed launch cannot become a complete
empty result. A signalled or failed native batch ends the launch loop before
another child can escape the existing process-tree cancellation. Native
decoding remains the content-match authority.

Candidate link/import annotations currently use indexed external-link tags.
The shared hit-status owner shows “In Happier” for a positive link/import
annotation. A missing annotation, even after a standard scan with complete
external-link tag lookup, does not prove that the native conversation is absent
from Happier. Such rows stay neutral. “Not in Happier” requires an authoritative
absence proof; the current annotation response supplies none for hosted native
Sessions, so the UI does not show that label.

The synced Session store retains decrypted owner native-resume identity and
workspace metadata through `ownerMetadataView`. Ordinary native metadata does
not carry a canonical external-source identity, and the native Agent's source
qualification can require resolving its files on the Machine. An id/cwd match
alone is therefore not promoted to a link annotation. The browser adds no
inventory read, index or per-hit RPC to establish it.
`hostedExternalSessionIdentity.ts` remains the hosted proof used by link.ensure
after native source resolution. Activation still recovers an existing hosted
Session there; an authoritative `linkedSessionId` opens that Session through
the existing shared candidate opener.

`memoryFtsIndex.ts` is the common FTS5 owner for deep message chunks and light
summary shards. It uses weighted `bm25(body, identifiers)` retrieval, requiring
every query term group; a multi-word query cannot rank a chunk on a single
common word. Identifiers retain their whole spelling and split components
(for example, `session_handoff` and `session handoff`). Prefix matching and
one-edit/transposition repair use the index vocabulary, qualified by the same
source, Session and date predicates as retrieval. Short terms remain literal.
`packages/protocol/src/memory/memorySearchText.ts` owns text normalization,
identifier splitting, CJK segmentation and the SQLite tokenizer contract,
also consumed by plaintext Home search.

`searchMemory.ts` produces match-centered excerpts from retained original text,
supports query-bound opaque paging (`hasMore` / `nextCursor`), and inclusive
`createdAfterMs` / `createdBeforeMs` filters on the indexed time range. Deep
retrieval retains optional embedding reranking; combined hint/native results
merge by recency. The Account fan-out also merges by recency, never by comparing
scores from different indexes: indexed hits use their ending message time,
standard hits the native conversation's update time. Session ids deduplicate
Home/daemon results; native identities include machine, Agent, source and item.

Happier-session inventory is restricted to the owning machine using decrypted
owner metadata; foreign and unknown owners are excluded and retained access is
reconciled before publication. Account transcript-change hints invalidate
indexed content even for same-sequence edits. The existing worker rewinds and
reindexes summaries/chunks and their embeddings rather than trusting a stale
committed shard.

`MemorySourceV1` distinguishes `happier_session {sessionId}` from
`external_transcript {agentId, sourceKey, nativeSessionId}`. Opted-in native
sources use the existing worker/deep database. `externalTranscriptSources.ts`
materializes configured sources, acquires current plugin readers, and registers
demand with the incumbent `registerAccountingSource` / `watchFileChanges`
observation pipeline. `externalTranscriptIndex.ts` pages normalized history
with `pageTranscript`, then advances opaque tails with `readAfterTranscript`.
There is no new watcher, index or polling loop. Native and Session work share
the worker's existing tick/disk/coverage budgets. The native history window
adds a rolling cutoff to the existing backfill/content policy, enforced on each
selected source turn even when its tail is unchanged; tool output is a separate
opt-in. Selected Agents must actually supply usable readers.

The native traversal owns one ordered work list. Observation-driven refreshes
share its existing allowance with initial backfill, so active conversations
cannot starve initial history and completed conversations need not wait behind
the whole initial backlog. An admitted multi-page history continues before
another unstarted conversation; it does not wait for every first page in the
corpus before receiving its next older page. An observation with native ids
prioritizes those conversations; a file notification without ids refreshes completed peers in
that source. A replacement retains refresh priority through all of its new
pages, rather than returning its unfinished replacement to the initial backlog.
Structural changes during a crawl alternate a fresh discovery continuation with
the retained initial-coverage continuation, within the same page allowance.
Fresh discovery can admit new siblings without restarting initial history; only
an uninterrupted complete inventory proves absence. A directory-delivered named
write outside a demand's known files requests topology discovery for that demand,
including when its creation notification was missed. Known files keep the
incremental path. The configured source allowance still bounds each scheduler
turn; admitted continuations drain in the same child without interval polling.
Large windows can require substantially longer than thirty minutes.

The deep database's internal `coverageComplete` bit records retained coverage
(no budget eviction), not exhausted initial history. Readiness additionally
requires the native page frontier to have reached its tail. A retained older-page
cursor with that bit set still means indexing. Source keys remain independent
index partitions: a user home and a connected-account home can expose the same
native conversation. Exact-source searches retain that scope; unified results
deduplicate those aliases at `mergeConversationSearchHits`.

Memory requests native identities and activity without optional title enrichment.
Claude and Codex apply the requested activity cutoff before transcript enrichment
and candidate-page admission; Memory retains its eligibility filter for readers
that ignore these optional inventory hints. Source observation remains source-wide
so an older conversation can become eligible after an append. A short window
therefore reduces body work, rather than promising a bounded filesystem inventory.

Source disappearance removes derived chunks, FTS and embeddings after complete
inventory or explicit missing/unavailable evidence. Replacement or an expired
native cursor resets that source for re-reading; a failed or incomplete read
does not prove deletion. Native hits carry source/item/optional page cursor,
never a fabricated Happier sequence. `getMemoryWindow.ts` resolves native windows
through `pageTranscript` and returns `externalSnippets`.

The palette and History Conversations mode query indexed conversations while typing. Activating the standard
search row runs `auto`: ready native sources use the index, and unknown/stale
sources retain the enabled standard fallback. `standard` explicitly scans;
`indexed` never starts a scan. `useConversationSearch` cancels superseded queries
and keeps continuations qualified by their producing machine/source.

Machine presence and background inventory updates do not create a new query or
erase its hits, selection or cursors. Each explicit Search more or Retry reads
current Machine admission through the Account operation. A native continuation
uses its already-published exact source declaration rather than rediscovering
the whole machine catalog; the daemon still validates that source and cursor.

Stop retains published hits and the unfinished page's continuation. Retry gives
that same page a fresh cancellation controller; without a continuation it
restarts the search. A late reply from the stopped page cannot replace Retry's
result, and Account retirement still cancels the replacement request.

Machine and source pages publish after Account authorization as they complete, without
waiting for slower sources. Loading remains active for unfinished work; a
response timeout reports incomplete work, not machine unreachability.

Mixed indexed queries issue conversation and document requests independently;
fresh document admission does not delay available conversation hits. The palette
publishes these authorized snapshots through SelectionList's existing query and
abort fences while the remaining work stays loading. Only a settled result is
cached across mounts, and document failure retains the conversation hits with
unavailable document coverage.
Machine statuses are `ok`, `offline`, `outdated`, `partial`, or `disabled-by-settings`;
`standardSearchEnabled` is present only after a successful settings read. An
omitted value means unknown, never an explicit off setting or permission to scan.
`conversationSearchCoverage.ts` owns the palette/scan coverage wording. Standard
scans cannot apply message-date bounds and report partial coverage rather than
substituting conversation update times. History supplies its selected Agent/source
to the same owner. The native index applies that filter before ranking and paging,
and binds continuations to it. A ready selected source works even when standard
search is disabled. The palette offers a scan only when an enabled standard
fallback has an unready or unknown source; History retains explicit Search and
Search more for that source. Thread-inclusive History remains partial unless an
explicit standard scan covers the Agent's threads: native inventory currently
indexes top-level conversations only. Indexed/Scanned row meta and the shared
coverage presenter distinguish the result origin and completeness.

## Feature versus capability

`search` (server-represented, fail-closed, on by default) admits Home
plaintext transcript search; `memory.search` admits daemon-local memory
indexing and its settings; `capabilities.homeSearch` is diagnostic only
(ready/indexing/unavailable) and never authorizes a request. Missing or
malformed feature data fails the Home provider closed while the shell and
unaffected sections stay usable. `useMemorySearchProvider` is the single
Home-versus-daemon decision seam for both the universal surface and the
session list; details in `feature-gating.md`.

## Privacy and storage

The two transcript providers are distinct privacy implementations:

- Home search reads plaintext envelopes into a rebuildable `search.sqlite`
  projection on the user's Home. `POST /v1/home/search` authenticates the
  present user, resolves that user's visible session ids, and applies those
  ids both to prepare the requested scope and to filter queries; ACL/share
  state is not copied into the index. Server startup performs no transcript
  inventory or index rebuild. The first request prepares its visible Sessions
  through the canonical paged reader, including shared Sessions owned by
  another Account. Later requests prepare newly demanded Sessions while
  retaining scopes already prepared in this process. Live upserts maintain
  only demanded Sessions; repair rebuilds that demanded union. Each hit is
  message-granular, but its shared `summary` field contains a match-centered
  snippet rendered from pristine message text (or the complete text when it
  already fits), not a guarantee that the full message is returned. Storage
  policy admission uses the canonical enum/parser.
- Daemon memory indexes decrypted transcripts on the machine that owns them
  (light summary shards / deep chunks, optional local or remote embeddings).
  The SQLite conversation index is plaintext on that machine, including when
  its source transcripts are E2EE. Native indexing is off by default and scoped
  by machine and selected Agent; it does not send E2EE text to Home search.
  Derived rows are removed through the daemon removal/reconciliation owner
  when sessions are deleted, revoked, or excluded by archived policy; copy
  may promise exclusion from search, never secure physical erasure.

Neither path creates a server-side universal index. `docs/encryption.md`
owns the underlying storage/encryption contracts.

The workspace-file corpus cache is bound to the incumbent Account lifetime.
Account retirement clears reusable entries and fences late publication before
another Account can observe the same server/machine/root tuple.

## Text in files and file anchors (0.3 development, integration in progress)

`workspace.files.search` is a machine-placed, safe read Action shared by UI,
CLI, MCP and Agent callers. Its input is the strict daemon request plus
`machineId`; the invocation context supplies the Home rather than accepting an
independent Home in the request. The daemon authorizes the workspace root and
uses packaged ripgrep JSON output. Searches are literal and case-insensitive
unless the caller selects case matching or regular expressions.

The Text in files section uses the existing Search scheduler and exact scope
fence. It groups hits by file, with line numbers and matching-line snippets.
The UI requests two surrounding context lines; the active hit expands its
context preview while other hits retain their compact snippets. Preview focus
does not commit or open the hit. UTF-8 offsets become one-based UTF-16 columns at the
daemon boundary. Unsorted parallel ripgrep returns one page, closing at a file
boundary under the existing machine transport payload ceiling. An early stop
returns `hasMore: true` and partial coverage; Search shows “Refine your search”.
There is no continuation cursor. Skipped non-text or oversized file records also
leave coverage partial rather than claiming an exhaustive search. Invalid patterns,
offline transport and older daemons produce distinct states, not empty matches.

Both workspace trees and the path browser now use `useWorkspaceFileQuery` over
the canonical `workspaceFileSearch` owner. That owner distinguishes incomplete
source `corpusTruncated` from displayed-page `hasMore`, and carries glob-query
cancellation. Daemon filename globs include directory descendants, retain the
shared exclusions, and preserve usable paths from a partial ripgrep failure.
Filename requests carry the remaining scoped RPC budget as `budgetMs`; the
handler counts daemon admission time and the ripgrep boundary returns bounded
captured output with `truncated: true` at expiry. The Home relay waits for that
domain result without a competing acknowledgement deadline. Caller cancellation
still aborts the process tree. A caller timeout alone does not establish Machine
unavailability. Filename enumeration uses newline-framed, line-buffered output
to retain complete paths found before expiry; filenames containing newline
characters are unsupported.
`WorkspaceFileSearchUnavailableError` carries typed failures to the UI instead
of turning a failed search into an empty result. Source integration and focused
owner checks do not substitute for the lane's remaining package and
loaded-runtime validation.

`sessionFileDeepLink.ts` owns typed file-anchor parsing and serialization for
standalone links, session panes and project routes. Search parses a final
positive `path:line[:column]` without splitting Windows drive prefixes or
literal path colons. Anchors travel in navigation state; the Search query and
options travel only through the destination-owned in-memory file Find seed,
never a URL or persisted tab resource. The Find viewer consumer is a separate
surface owner (`FileViewerFindSurface` or the editor's native Find adapter).
It consumes the seed after mounting and selects the addressed match; seed
transport alone does not prove the composed loaded Search-to-Find journey.

## Code navigation and symbols (0.3 development source)

The Files & Editor development source implements on-demand language intelligence.
Opening a file in View or Changes does not start a language server. An
explicit definition, hover, references or Check problems request activates the
Machine-side session; files without a capable server retain name-based lookup
through workspace content search. Those fallback references are labelled text
matches, not semantic references, and retain Text in files' exclusions,
cancellation and coverage reporting. Same-named symbols can produce false
matches and unrecognized declaration forms can be missed.

The document-symbol source uses the existing Shiki highlighter's syntax scopes,
including Markdown headings, as an approximate client-side baseline. A passive
controller read may query an already activated, capable server. The single
`documentOutline.ts#selectDocumentOutline` owner prefers a nonempty usable server
answer, or an empty answer from a ready session that is not loading. Cold,
loading-empty, missing, failed or incapable answers retain the baseline; an
authoritative empty answer remains empty. Server selection positions become
1-based file-line anchors through the existing file opener. This baseline remains
active-file outline data.

The Symbols scope queries `workspace/symbol` through the File page's existing
controller (`workspaceSymbol`), also used by `code.symbols.workspace`. This is
explicit demand and may start the Machine-side server. Every new query cancels
the previous one. Results retain their own workspace path and symbol line;
activation uses the canonical file opener. Missing workspace-symbol capability,
an older daemon or an unavailable Machine retains the active document outline,
explicitly labelled with its file rather than implying project-wide coverage.
There is no second index.

The existing References panel and phone sheet also host Calls for servers that
advertise call hierarchy. Incoming and outgoing queries retain the server's
opaque item reference and use that same controller. Problems separates open-file
diagnostics from an explicitly requested project result. Selecting Whole project
does not run a check; Check the whole project does. The controller owns its
checking, cancellation, failure and retained result, and no polling is added.
Ask to fix uses the existing range/context builder in either scope; unopened
project files are read only when Ask needs their saved text.

Global Search obtains its default folder scope and symbol source from the
presented File page in the active pane, through the existing
`readActiveFileViewActionOwner` bridge, not DOM focus.
The File owner combines its selected-tab state with the destination's existing
presentation focus; retained background destinations do not compete as active
Files merely because their local File tabs remain selected. Its live-buffer/flush and
passive outline readers stay with the File page's existing intelligence owner;
there is no second active-editor registry or saved-disk substitute. Explicitly
addressed Search and terminal Jump retain their own scope rather than inheriting
the presented File. These are unreleased source contracts; loaded UI acceptance
and released availability remain separate checks.

## Search, Find and external History (0.3 development)

Search selects a target across entities. Find matches text inside the mounted
surface. External History content search scans Agent-owned conversations on
one explicitly selected machine, including conversations not yet linked to
Happier. These are different authority and privacy boundaries.

Find uses the shared `FindBar`/`FindController` contract and pure
`matchFindText` for decrypted display text and code-line models. Chat's
`useTranscriptFind` consumes `SessionTranscriptSource`, its existing paging
and decryption pipeline, and `transcriptFindText` display projection. It does
not use raw provider JSON or Home FTS. Matching E2EE chat text happens on the
client device; Find does not send that text or query to a server search.
Loaded rows answer immediately, older ranges are searched on demand, and Stop
retires Find work without stopping normal sync. Unsearched ranges, unreadable
text and stopped work preserve incomplete coverage. Images and Mermaid
diagrams are non-text media and are excluded from text matching.

Chat landing delegates to `jumpToTranscriptTarget` and the existing
group/tool/clamp expansion owners. Superseded Find intent cancels its pending
reveal and jump takeover, including a reveal waiting for the next visual frame.
Review uses `useChangedFilesReviewFind`
over the existing diff loader/store, including folded context and unloaded
files in the review's diff corpus. Binary/error files make coverage partial.
Fold reveal is temporary and offers **Fold again**, without writing folding
preferences. Code-line landing and decoration use the mounted renderer's adapter.
In 0.3 development, Pierre 1.5.2 keeps its host mounted during Find and range
selection. Its adapter paints the shared UTF-16 Find ranges through the CSS
Highlight registry inside its shadow root and reveals offscreen lines through
the existing virtualizer. A failed worker pool switches affected diffs to the
Happier renderer without changing the saved renderer preference. Pierre remains
a rendering and annotation engine; editing uses Happier's editor owners.

Monaco owns its native widget; the host seeds/controls public editor actions
and never adds a second Find bar or matcher. The mounted registry reports its
focus truthfully for Actions, while physical shortcuts pass to the engine.
`ui.find` returns host-known seeds/options with engine-owned counts unavailable.
Native CodeMirror delegates to
`@codemirror/search` through its existing WebView bridge. Terminal Find
delegates to xterm's SearchAddon over retained rendered cells, never PTY bytes.
Scrollback and decoration bounds yield limited coverage. Ghostty and Termux
have no Find facet; capability follows the mounted renderer, so an actual
xterm WebView fallback supports Find on native clients.

The keyboard provider's mounted Find registry arbitrates focus and handled
versus pass-through disposition. Mod+F opens the focused surface; session
composer focus belongs to chat. Enter/Shift+Enter step in the Find input,
Mod+G/Shift+Mod+G step while that surface's Find is open, and Escape restores
focus. Outside a findable surface, or on a second Mod+F from its open Find
input, browser Find remains available. A handled terminal Find chord does
not also reach the PTY.

History keeps the existing metadata browse owner for **Titles**;
`searchMode: 'full'` still means fuller metadata. **Conversations** uses the
unified conversation-search owner above, adapting native hit identities into the
existing candidate Open/Find path. Standard content scans use
`searchTarget: 'content'` only after explicit activation and require a positive
advertised `contentSearch` capability.

An explicit Search or Return records its intent while a typed-query indexed
lookup is pending; current settings still authorize the eventual native scan.
Home metadata publications keep the credential binding and mounted Browse
query, mode and results. A changed credential lookup URL, removed Home or real
credential mutation retires authority through the shared credential-scope owner.

### Native Agent coverage (0.3 development)

| Agent | Standard search and opt-in indexing in 0.3 development |
| --- | --- |
| Claude Code | Local JSONL transcripts; appends and rewrites use the existing reader. |
| Codex | Local rollout families; app-server-only threads without a readable transcript remain a coverage gap. |
| Pi | Native JSONL history, through the shared decoded-text search helper. |
| OhMyPi | Native JSONL history, with source-wide change observation. |
| Antigravity | Native JSONL history, with source-wide change observation. |
| OpenCode | Decoded messages from its native client; requires an available endpoint. |
| Gemini | CLI v0.64.0 JSONL recordings and legacy JSON; patches, checkpoints and inclusive rewinds select visible history. |
| Qwen Code | CLI v0.25.3 JSONL, including archived chats; active-parent replay and streaming fragments preserve visible text across compression. |
| Copilot | Event-v1 history; transient deltas and model-only compaction data are excluded. |
| Droid | Schema-2 history characterized from CLI 0.170.0; follows the visible active parent chain. |
| CodeBuddy | CLI 2.170.0 JSONL, including native replay and rewind. |
| Grok | Paired summary and history files; producing CLI version unknown. |
| Cursor CLI | JSONL transcripts with v1 chat metadata; producing CLI version unknown. |
| Kiro | V1 paired CLI chat store; separate ACP V3 history remains unsupported. |
| Kimi Code | CLI 0.18.0 / wire protocol 1.4; retains compacted history and applies undo/clear boundaries. |
| Kilo | CLI 1.0.25 JSON session/message/part files; other storage dialects remain unsupported. |
| FX | CLI v0.0.14 schema-4 events and referenced tool results; legacy formats and opt-in sessions-v2 remain unsupported. |
| Auggie | CLI 0.36.0 JSON snapshots; backups and temporary files are excluded, and summaries cannot recover discarded history. |
| Devin | CLI 3000.6.7 schema-16 database; active ancestry excludes abandoned branches and private thinking. |
| Custom ACP | Unsupported without a named definition and characterized native-history reader; list/resume alone is insufficient. |
| CodeRabbit and DeepSec review Agents | No arbitrary native conversation corpus is characterized; their Happier review output belongs to Happier-session search. |

Both modes require readable history on an online machine and a matching development daemon. The table describes characterized formats, not every version of an installed Agent. Unknown formats and unreadable ranges report partial or unsupported coverage, never a complete search with no matches. Installed-CLI capture and platform validation remain release checks for the new readers. File readers require no export or vendor process; OpenCode uses its native client.

Devin reads only private temporary byte copies of its database and WAL, opens those copies read-only, then deletes them. SQLite never opens the vendor files. A copy taken during a write may be slightly stale; failed reads retain indexed history, while confirmed deletion removes it.

Each positive declaration is backed by one plugin-owned projection for candidates, transcript pages and read-after. Source observation includes transcript, topology and semantic sidecars through the incumbent accounting/observation pipeline; matching uses the SDK helper and Protocol `contentSearchMatch`. There is no second watcher or content index. Tool-input metadata and model-only summaries are excluded. Native rewrites replace the indexed projection; unavailable stores do not prove deletion.

Kimi joins `KIMI_CODE_HOME` (default `~/.kimi-code`) session state/index with the main wire log. Auggie resolves `~/.augment/sessions` or the admitted `augmentHome`; FX resolves `~/.fx/sessions` and observes referenced results. Gemini shares discovery with resume import under `GEMINI_CLI_HOME/.gemini/tmp` or the default home; Qwen resolves `QWEN_RUNTIME_DIR`, `QWEN_HOME` or `~/.qwen`. Kilo reads XDG `kilo/storage` without loading the vendor's migrating Storage module. Grok/Cursor/Kiro fixtures are pinned to upstream and vendor documentation; no producing native CLI version is inferred.

Claude/Codex/Pi/OhMyPi/Antigravity use host-provided packaged ripgrep where safe, then re-match decoded text. Unicode/escaped/process-unsafe queries retain decoded fallback; OpenCode matches decoded native-client messages without ripgrep. Codex shares root-family discovery per candidate page and retains identities and possible snippets instead of all bodies; rollback selection precedes authoritative matching. The requested page size counts candidates, and empty partial pages preserve continuation.
No transcript body is written into the persistent candidate metadata index;
optional content indexing belongs only to Memory. Codex
app-server-only threads have no searchable file corpus; unsupported sources,
older daemons, interrupted scans and partial coverage are stated explicitly.
The standalone History scan is machine/source-local. Universal Search has the
explicit All-machines scope above; typing queries indexes, never standard scans.

The shared helper's content producers cooperatively yield within the existing
host invocation deadline, including while reading or decoding a file. Coverage
is per query: `partial` means a match for this query may have been missed.
The shared ripgrep prefilter can exclude files, and Claude also uses its
candidate byte offsets to admit individual lines before decoding. Excluded
files or rows cannot contain a match under those admission patterns; skipped
malformed, undecodable or unsupported rows therefore do not make this query
partial. Admitted damaged or unsupported rows still make coverage partial.
Decoded hits go through Claude's full scan for branch ancestry, title and exact
ordinal; unresolved ancestry remains partial. Unsafe or transformed queries
retain exact decoded fallback when admission cannot prove exclusion. A yielded
page retains completed hits, marks coverage partial and returns a continuation
that keeps the unfinished candidate. Both presenters show incomplete coverage
even for a settled empty partial page, and offer **Search more conversations**
when a cursor remains. Stop preserves incomplete coverage. In current 0.3
development source, transcript continuations retain source-bound row positions
and re-decode native text before publishing a hit. Claude content cursors carry
the search start time T0, the last fully visited file's recent-first position
(mtime and stable native identity), and progress for at most one unfinished
transcript. Each page lists current files afresh. The main pass visits files with
mtime <= T0 strictly after that position; appends to visited or unrelated files
cannot reset it. After the main pass ends, a single final pass captures T1 and
visits files with T0 < mtime <= T1 using its own recent-first frontier. This also
reaches an unvisited file modified since the search began. Files written after
T1 require a fresh search, so actively written files cannot loop through the final
pass. The existing page-merge owner deduplicates scanned hits by native candidate
identity even when the matching message changes. No corpus inventory, transcript
text or query store is carried between pages; cursor size is independent of file
count and uses the existing bounds. Intermediate development content cursors
return `source_invalid` and start a fresh search. Native path authorization and
unfinished-transcript source validation still apply. Claude reads a captured
file prefix, bound by the existing physical-generation and bounded head/boundary
anchors. Appends, including appends while scanning or capturing an anchor, do not
invalidate that prefix; replacement, truncation or a changed anchor still reject
it. The T1 pass covers changed files under the traversal contract above. Codex reports a
retryable Agent failure when
unavailable native
listing prevents ordered progress, and does not reopen native streams already
marked complete. Cancellation, source changes and result-byte limits can still
prevent a page from completing; a cursor alone does not certify exhaustion.
Standalone MCP reaches this same machine operation through
`createCliActionDeps`'s `hostExternalSessionActionTransport`, after canonical
admission/approval and exact-machine target reconciliation.

In 0.3 development, native discovery, `sessions.external.link.ensure` and
`sessions.external.transcript.page` are callable from Agent, MCP and CLI
surfaces. Transcript paging uses the native source's explicit Machine; no
linked Happier Session is required. Linking keeps its danger approval default.
Machine-only approval currentness uses the same implicit Machine target as
execution replay; a contextual Session such as standalone MCP's `cli-global`
does not replace that target. Explicit signed targets remain unchanged.
The low-level Follow leases and secure read-after refresh remain host-owned
RPC contracts; initial/older/newer transcript pages provide the Agent read flow.

The conversation-search owner preserves failed native sources alongside successful
hits as optional `failures` coverage: `{ machineId, agentId, sourceKey, errorCode,
retryable }`. `search.conversations` returns that same coverage through its strict
output schema to app, Agent and MCP callers. An empty successful search therefore
differs from an Agent that could not search. Raw daemon error messages stay out of
the result. Browse and the palette reuse the external-session error presentation
owner and offer Retry only for retryable failures; a daemon that omits retryability
retains explicit Retry. Retry reuses the existing page operation for the failed
source and its cursor, keeping other sources' hits and coverage. Action callers
can target that source with `machineIds` and `query.externalSource`, carrying its
qualified continuation in `query.cursor` when present.

In current 0.3 development source, deadline-triggered RPC cancellation is a
retryable timeout; an explicit Stop remains cancellation. The daemon's Agent
failure diagnostics retain closed host admission reasons, source-validity checks
and exception classes,
without logging native cursor contents or arbitrary Agent error messages. Titles
keeps rows already served by the current preparing generation when a later page
fails, marks preparation stopped, and exposes the failure for retry.

Claude's initial linked-transcript window uses `hasMore` and `nextCursor` for
older readable history; reaching a page boundary is not `truncated`. The shared
native record classifier skips observed bookkeeping (`cost-state`, `atis-latch`,
attachments and queue state) without declaring content loss. Unknown or malformed
native records project to a visible, fixed unsupported-content marker through the
shared SDK file-store projection; surrounding messages, paging and Find remain
readable across Agent CLI releases. The marker contains no native payload, and
the safe diagnostic still reports the unsupported record. `truncated` is reserved
for real source loss, such as replacement, an invalid source anchor or an unread
record boundary. The Session initial-window reader keeps those discontinuities
closed. Bounded source diagnostics reach the daemon's existing
`agent_failure` safe-token logger and are not copied into transcript text or
the public page response. A normal bounded initial window renders immediately,
retains its older cursor and can be searched by Find as older pages load.

Claude's native tool-result image blocks use the same visible unsupported-image
meaning as top-level image blocks. Their inline bytes, including the native
Read metadata's duplicate base64, stay out of transcript pages; text, tool
correlation and non-binary metadata remain. An image therefore cannot strand
older readable history behind the existing page byte budget. A failed older
read retains its cursor and loaded rows. Find's existing failure note offers
Retry while older history remains, and a successful retry clears that paging
failure without reopening Find or changing the query.

Both History entry points use `openExternalSessionCandidate`, preserving the
existing link/open guards without implicit materialize or takeover. Landing
maps `sourceItemId` through `makeExternalSessionHistoricalImportLocalId`,
then uses the transcript jump host and ephemeral Find seed. Source ordinals
are never treated as Happier sequence numbers. If the target cannot resolve,
Find can still open on the query. Query/options remain in memory, outside
URLs, settings and logs.
The shared chat handoff awaits the existing unsaved-changes navigation guard
and the opener before staging the seed. A retained copy of the same Session
must not consume the new launch while departure is pending; cancelled
navigation stages nothing. Account authority is checked again before the
admitted navigation callback and before publication. Transcript hydration then
uses the existing destination consumer and Find model, not a second seed path.

## Next and client Actions (0.3 development)

Next uses summary-only candidate admission and distinct-other-session counts;
it reads pending detail on invocation and selects by the session-core age
comparator, with unknown creation times after known times. It routes to the
exact Home/session address, revalidates access and pending state, and focuses
the primary answer through existing prompt/permission landing owners. It
does not resume a session or answer a request. Header, post-answer composer
and phone count pills all invoke the same mounted navigation port. Failed
delivery, unread items and broad Inbox/operational badges remain separate.
Confirmation answerability uses the shared protocol predicate at summary,
detail and landing boundaries. The CLI metadata tuple producer derives
`sharedActionConfirmationSummaryV1` from the next `actionConfirmationsV1` map,
including completed-request coverage, on each metadata mutation and CAS retry.
The server commits its independent `pendingSharedActionConfirmationCount` in
the same Session metadata CAS. Personal attention composes it with the owner's
Agent-state counts under the existing tracking, publication-ceiling and
`approveRuntimePermissions` rules. The attention query includes that contribution,
so an unopened shared-editor approval can become a Next candidate. Request age
still comes from the canonical on-demand detail reader; no second timestamp or
pending-request store is introduced. Loaded-runtime evidence remains separate
from source integration.

`ui.find`, `ui.prompts.picker.open` and `session.pending.next` are
client-placed display/navigation Actions. The canonical `actionExecutor`
delivers admitted client Actions after approval/prepare through
`clientActionReverseDispatch`, using the existing authenticated machine-scoped
reverse-RPC channel (`ui.actions.execute.v1`). The connected app executes them
through `createDefaultActionExecutor` and its mounted domain adapters; there is
no second Find, prompt or Next executor. Find, Next and the picker are exposed
to Agents and MCP.

Session-bound Find, picker, composer, Next and conversation-search calls select the app viewing the addressed
Session, through the same channel's Session-qualified method. An explicit composer Session takes precedence over
the invoking Session. The app's current-UI owner advertises that method only
while the Session is viewed and rechecks it before execution. No matching view
returns the Action's unavailable result; multiple matching clients return
`client_ambiguous` without execution. Calls without a Session address also
require a single answering client. They never fall back to an arbitrary app.
Other client Actions retain their existing placement-specific routing.

Next and conversation search still operate across their requested Account scope;
the invoking Session selects which app executes them. Unbound calls use the
generic connected-client room and require one answering client.
Availability advertisements are routing hints; the server's current registration selection decides absence
and ambiguity, so a missed advertisement cannot by itself return `noClient`.
Current-context reads use their dedicated mounted-current-context room.

With no advertising app connected, Find and the picker return
`{ status: 'unavailable', reason: 'noClient' }`, Next returns
`{ status: 'unavailable', reason: 'noClient' }`, and other client Actions use the typed
`unavailable`/`noClient` failure. A connected app without a suitable mounted
surface/composer returns `noMountedSurface`/`noEligibleComposer`. Find never
returns corpus text; Monaco counts remain engine-owned. Approval-required
calls create or wait on the canonical approval request before delivery;
rejection/cancellation does not execute the Action. A lost or malformed
response after issuance returns `outcome_uncertain`, with no automatic retry.
The generated published
[Actions catalog](../apps/docs/content/docs/plugins/api/host-actions.mdx)
owns exact schemas and declared surfaces; do not maintain a second catalog.

`prompts.invocation.create` adds a shortcut to an existing prompt document
through the same captured-Account Prompt Library row writer used by the Save
form. It is a danger, client-placed Action (approval required by default,
user-configurable). Canonical token validation rejects reserved, Action-owned
and duplicate tokens; the invocations row uses one revision CAS, preserves
neighboring entries and returns a conflict without replay. A saved document
remains saved when optional shortcut creation fails; the UI never retries
document creation for that partial failure. These are 0.3 development contracts.

An admitted native History hit can be linked with `sessions.external.link.ensure`
(danger), then opened with `workspace.tabs.open` (safe). Its optional `find`
input carries the query and native message identity into the existing one-shot
chat handoff, scoped to the destination Home and current Account credentials.
The handoff normalizes the native identity exactly as the History UI does;
neither query nor Find target enters a URL or persisted tab resource. Missing or
retired destination authority fails closed. This is a 0.3 development contract.

Committed message rows and native menus share `useCommittedMessageActions`
and `CommittedMessageActions`. Their settings include Make repeatable, whose
eligibility remains with the Workflow authoring owner; disabling it also
retires that row's availability subscription. Disabling Pin hides add-pin
actions while retaining an existing pin's removable indicator. Pending-delivery
recovery retains its separate owner and is not controlled by these switches.

## SelectionList sections, cancellation, and stale fencing

`SelectionList` remains the single input/query/list/a11y owner; Universal
Search extends it narrowly:

- `resultFiltering: 'host' | 'provider'` (default `host`): sections whose
  canonical executor already ranked results (FTS, settings Fuse, files,
  commits, plugin providers) choose `provider` so the host matcher cannot
  drop a legitimate non-literal match. Static menu-like sections keep the
  canonical host matcher; no new fuzzy algorithm.
- `inputPlacement: 'top' | 'bottom'` (default `top`): the native host seats
  the same canonical input at the bottom; no second `TextInput` or query
  state.
- `resolverKey` carries the full target identity (Account scope, Home/server,
  machine, workspace root, plugin generation). A changed key discards
  in-flight work and prevents cross-mount cache replay; sensitive sections
  either use no cross-mount cache or an explicit search/auth-lifetime adapter
  cleared on logout/Account replacement.
- Per-section `AbortSignal` threads into machine RPC, workspace-file RPC, and
  the Action dispatcher; stale responses after query/target/generation/scope
  changes are dropped by sequence fencing.
- Unavailable sources render as a typed, non-activatable empty-hint section
  (`indexing`, offline, disabled, unsupported) — never as disabled fake rows
  and never as a global error. Raw scores from different providers are never
  compared or displayed as one ranking.

## Plugin search providers

Plugins declare `contributes.searchProviders` with a minimal descriptor
(`id` + Action reference); title, availability, execution target, and
currentness come from the referenced Action. A query is a present-user `ui`
invocation through the existing Action dispatch seam with strict canonical
query/result schemas (`PluginSearchQueryV1`, `PluginSearchResultV1` with
required `truncated`), an `AbortSignal`, and the incumbent
`executeAction | openSurface` activation union. Plugin update, disable,
uninstall, or generation retirement removes and fences rows and activation.
There is no `api.search.register()`, no second executor, no provider-owned
rendering, and no streaming/result-delta protocol. Triage supplies the first
query Action and descriptor over its existing matcher; the universal production
host now consumes that projected section. That query is a client-targeted
Action. Its host-owned ephemeral scope leases the same Account/plugin/immutable-
generation list window used by mounted Triage UI, so Search reuses a live
refresh instead of creating a second acquisition owner. Query cancellation
releases its lease promptly, while Account or generation retirement disposes
the shared value and refuses stale acquisition.

The host requests a positive integer page size and marks any rows omitted at
that requested size as truncated. Queries, row identities and display labels
do not inherit Composer-reference limits, and callers may request larger pages
than the host's default. The result commands retain their own boundary limits.

The command inside each result uses the canonical closed composable union in
`packages/protocol/src/plugins/ui/semanticCommands.ts`, including its launch-input
and whole-command byte limits. Live parsing and cold schema rehydration reject
the same malformed commands and return the same values. Instance keys use the
shared declarative string trim before their nonempty and UTF-8 byte checks;
JSON Schema validation checks this contract without mutating the input. Legal
sub-path spellings stay unchanged in result data; activation normalizes their
slashes through `normalizePluginUiSemanticCommandV1` before navigation.

`contributes.searchProviders` is distinct from `composerReferences`
(query → composer insertion); the composer dispatcher, its trigger grammar,
and its cancellation behavior are intentionally untouched.

## Intentional exclusions

No universal database or second transcript index; no server-side universal
aggregation endpoint (the source-specific Home endpoint is retained); no
global score ordering or cross-provider dedupe; no all-Home or
all-machine fanout; no plugin renderers, preview pane, or second command
registry; `commandPalette.open` persists with label **Open Search**, while
`search.textInFiles` opens the same surface with its content source selected;
no second search route (the standalone Memory Search
controller has been removed now that the universal route consumes its callers).

## Retained separate paths (not competing owners)

- `buildCommandPaletteCommands` — the command-section adapter under the
  universal surface.
- Composer autocomplete/`CommandMenu` and `composerReferences` — distinct
  caret-context pickers with deliberately different cancellation semantics.
- Settings catalog Fuse search, workspace file search, session-list metadata
  matching — domain-local matchers consumed by their adapters.
- Home and daemon transcript engines — distinct privacy/authority
  implementations behind one decision seam.
- CLI transcript search — a legitimate non-UI consumer of the same backend
  owners.
