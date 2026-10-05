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
universal modal or native route, `/search` renders the same controller, and the
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
| Route and presentation | `/search` (`UNIVERSAL_SEARCH_ROUTE`); `transparentModal` on iOS/Android, ordinary router presentation on web/desktop |
| Native keyboard geometry | `UniversalSearchNativeHost` + `universalSearchNativeGeometry` over the existing keyboard-aware screen, scrim, and safe-area owners |
| Session-list search | stable `SessionListSearchChrome` plus `sessionListSearchGroups` and `useSessionListMemorySearchAugmentation`; session rows only, with a `Search everything for …` escalation into universal Search |
| Home transcript execution | Lane 07 Home search route/service (explicit target, feature admission, capability readiness) |
| Daemon transcript execution | daemon memory owner (explicit server + machine, Unicode tokenizer, archived policy, removal/reconciliation) |
| Files / commits / settings / sessions / projects | existing workspace-file search, SCM owner, resolved settings catalog (Fuse), synchronized projections/catalogs — adapters only |
| Text in files | `workspaceFileContentSearch` through `machineWorkspaceFileSearch` and the daemon `workspaceFileSearch` handler; no persistent content index |
| In-surface Find | shared `packages/plugin-ui/src/presentation/find/` presentation and display-text matcher; ephemeral transcript, review and file models; editor/terminal engine adapters |
| External conversation content | `sessions.external.candidates.list` with `searchTarget: 'content'` → `candidateQuery.ts` → Claude/Codex plugin codecs; shared `openExternalSessionCandidate.ts` for browser and Search activation |
| Next | session-core pending age comparator/selector, `activity/source/buildPendingNavigationFromSource.ts`, `nextPendingRequest.ts` and `navigateToPendingRequest.ts`; mounted `NextPendingNavigationHost` |
| Plugin declarations and execution | `contributes.searchProviders` in the contribution catalog + the existing Action dispatcher (`executeAction | openSurface`) |
| Feature admission | `packages/protocol/src/features/catalog.ts` via `useMemorySearchProvider`; see `feature-gating.md` |

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

Scope is Search-local, contextual, and exclusive, never a fanout. Opening the
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
- Daemon memory search targets the explicitly selected usable machine
  (`resolveDaemonMemorySearchTarget`), never `machines[0]`, never all
  machines.
- Files target the exact current workspace; commit search additionally stays
  within that workspace's current Git branch or current Sapling parent set.
  With no workspace present the section is omitted rather than pointed at an
  arbitrary one.
- Sessions/projects/settings read local synchronized projections; plugin
  providers target currently admitted plugin Actions.

There is no automatic all-Home or all-machine aggregation and no server-side
**universal aggregation** endpoint. Plaintext Personal Home transcript search
does have its own authenticated, feature-gated `POST /v1/home/search` endpoint;
it is one source-specific executor, not a general search coordinator.

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
  ids at query time; ACL/share state is not copied into the index. Each hit is
  message-granular, but its shared `summary` field contains a match-centered
  snippet rendered from pristine message text (or the complete text when it
  already fits), not a guarantee that the full message is returned. Storage
  policy admission uses the canonical enum/parser.
- Daemon memory indexes decrypted transcripts on the machine that owns them
  (light summary shards / deep chunks, optional local or remote embeddings).
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
fence. It groups hits by file, with line
numbers and context. UTF-8 offsets become one-based UTF-16 columns at the
daemon boundary. Unsorted parallel ripgrep returns one page, closing at a file
boundary under the existing machine transport payload ceiling. An early stop
returns `hasMore: true` and partial coverage; Search shows “Refine your search”.
There is no continuation cursor. Skipped non-text or oversized file records also
leave coverage partial rather than claiming an exhaustive search. Invalid patterns,
offline transport and older daemons produce distinct states, not empty matches.

Both workspace trees and the path browser now use `useWorkspaceFileQuery` over
the canonical `workspaceFileSearch` owner. That owner distinguishes incomplete
source `corpusTruncated` from displayed-page `hasMore`, and carries glob-query
cancellation. Source integration and focused owner checks do not substitute for
the lane's remaining package and loaded-runtime validation.

`sessionFileDeepLink.ts` owns typed file-anchor parsing and serialization for
standalone links, session panes and project routes. Search parses a final
positive `path:line[:column]` without splitting Windows drive prefixes or
literal path colons. Anchors travel in navigation state; the Search query and
options travel only through the destination-owned in-memory file Find seed,
never a URL or persisted tab resource. The Find viewer consumer is a separate
surface owner (`FileViewerFindSurface` or the editor's native Find adapter).
It consumes the seed after mounting and selects the addressed match; seed
transport alone does not prove the composed loaded Search-to-Find journey.

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
preferences. Code-line landing and decoration remain `CodeLinesViewCore`'s
responsibility. Pierre selects the Happier renderer while Find is open when
its virtualizer cannot reveal the target; the saved renderer preference stays
unchanged.

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

History extends the existing external candidate corridor with explicit
`searchTarget: 'content'`; `searchMode: 'full'` still means fuller metadata.
The Search row starts work only on activation, and the External sessions
browser's **Titles | Conversations** selector requires an explicit Search
submission in Conversations mode. Source admission requires a positive
advertised `contentSearch` capability. Claude Code and Codex rollout files
are searched on the selected machine via host-provided packaged ripgrep and
codec re-matching of decoded transcript text. No transcript body is written
into the persistent metadata index and no content index is created. Codex
app-server-only threads have no searchable file corpus; unsupported sources,
older daemons, interrupted scans and partial coverage are stated explicitly.
There is no automatic machine fanout or keystroke-triggered body scan.

Both History entry points use `openExternalSessionCandidate`, preserving the
existing link/open guards without implicit materialize or takeover. Landing
maps `sourceItemId` through `makeExternalSessionHistoricalImportLocalId`,
then uses the transcript jump host and ephemeral Find seed. Source ordinals
are never treated as Happier sequence numbers. If the target cannot resolve,
Find can still open on the query. Query/options remain in memory, outside
URLs, settings and logs.

## Next and client Actions (0.3 development)

Next uses summary-only candidate admission and distinct-other-session counts;
it reads pending detail on invocation and selects by the session-core age
comparator, with unknown creation times after known times. It routes to the
exact Home/session address, revalidates access and pending state, and focuses
the primary answer through existing prompt/permission landing owners. It
does not resume a session or answer a request. Header, post-answer composer
and phone count pills all invoke the same mounted navigation port. Failed
delivery, unread items and broad Inbox/operational badges remain separate.
Integrated cold confirmation/grant and loaded-runtime evidence is still in
progress; source presence is not a blanket verification claim.

`ui.find`, `ui.prompts.picker.open` and `session.pending.next` are
client-placed display/navigation Actions. Current UI adapters reach mounted
surfaces; their agent/MCP exposure is discoverable-only where declared.
The platform does not yet deliver agent/MCP calls to a mounted client, and
an absent adapter returns typed unavailable/no-mounted/no-eligible results.
Registration is not remote UI parity. The generated published
[Actions catalog](../apps/docs/content/docs/plugins/api/host-actions.mdx)
owns exact schemas and declared surfaces; do not maintain a second catalog.

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
