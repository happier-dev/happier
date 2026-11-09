# File editor

The File page edits the file on its selected Machine. The client owns the open
buffer and device-local draft; the Machine owns the file bytes. A Save crosses
that boundary with the hash of the bytes the person last saw.

This page describes the unreleased 0.3 editor contract. The state hook, conflict
projection and compact draft reader are present in development source with
composed owner-level test coverage. The loaded-runtime journey through guarded
writes, Markdown, Actions and rendered surfaces still needs integrated validation
before treating the complete workflow as available. This is not a released-client
or completed live-validation claim.

## Owners

- `apps/ui/sources/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorState.ts`
  owns the edit session, base, draft, save and conflict decisions. The File page
  consumes its model and owns page chrome; it does not infer another status.
  `workspaceFileEditorConflict.ts` supplies its pure conflict projection and
  `workspaceFileEditorDraft.ts` owns the Account-qualified draft reader.
- `apps/ui/sources/components/ui/code/editor/CodeEditor.tsx` selects the platform
  surface. `codeEditorTypes.ts` owns the single `CodeEditorHandle` contract for
  commands, reveal, history, selections and layered decorations.
  `editorDocumentHistory.ts` supplies the compact inverse-edit history held by
  the document buffer. Monaco, CodeMirror and Rich Markdown delegate Undo/Redo
  to that instance when supplied; standalone engine consumers retain their
  existing engine history. A standalone Markdown field owns one document
  history across its Raw/Rich surfaces.
  Native CodeMirror flushes its pending `docChanged` publication before replying
  to `requestDoc` with a snapshot. Its incremental inline-suggestion mirror is
  not itself a buffer publication: a confirmed flush must first deliver pending
  typing to the shared buffer and history. Repeated flushes without new typing
  do not republish that change.
- `CodeEditorWithFind.tsx` in the same folder owns editor Find composition.
  `apps/ui/sources/components/ui/markdown/editor/useMarkdownEditMode.ts` owns
  Raw/Rich mode and flush-before-switch; `MarkdownCodeEditorField` consumes it.
- `apps/ui/sources/utils/navigation/runGuardedNavigation.ts` owns departure
  decisions. File tabs register their dirty guard there and use the same guard
  for close, including keyboard and middle-click close.
- `apps/ui/sources/sync/ops/workspaceFileSystem/fileReadWrite.ts` owns client
  write routing. The existing filesystem Action and upload finalizer reach the
  Machine's one guarded replacement owner, described below.

Review hunks come from the Protocol hunk engine; Keep/Discard and their content
keys belong to the review owner. Diagnostics and blame use named decoration
layers on the same handle. They do not create another editor or buffer store.

### Markdown mode availability

Reading Markdown uses the File header's Preview / Source choices. Editing uses
the shared field's Raw / Rich menu at the upper right of the editor. That menu
is offered only for the `markdown` language while the existing
`files.markdownRichEditor` preference is enabled. This retained experimental
preference is off by default and requires the Features page's experiments
switch; the File page does not override that policy. Document eligibility may
disable Rich with a reason while Raw remains available. Raw Find is owned by
`CodeEditorWithFind`, not a separate Markdown search implementation.

## Syntax highlighting

In 0.3 development, `filesDiffSyntaxHighlightingMode` defaults to `advanced`
at the Protocol Account catalog in
`packages/protocol/src/account/settings/accountSettings.ts`. The UI Settings
parser and Source Control settings screen consume that owner. Missing values
use the default; explicit `off`, `simple` and `advanced` values retain their
meaning, including 0.2-written preferences. No stored Account value is migrated.

`resolveCodeLinesSyntaxHighlightingMode` keeps advanced tokenization web-only
and falls back to simple on native or when the advanced feature is disabled.
The existing `filesDiffTokenizationMaxBytes`, `filesDiffTokenizationMaxLines`
and `filesDiffTokenizationMaxLineLength` preferences still govern highlighting;
`evaluateCodeHighlightingBudget` protects code blocks and
`resolveEffectiveSyntaxHighlighting` protects code-line views. Over-budget
content remains readable without adding another size limit.

## PDF raster backing (0.3 development)

The shared `components/ui/media/pdf/pdfZoom.ts` sizes raster backing separately
from page layout and selectable text. It follows pinned pdf.js 6.4.299's private
`AppOptions` defaults in `pdfjs-dist/web/pdf_viewer.mjs`: `maxCanvasPixels` is
2^25 on desktop or 5,242,880 on iOS/Android, with `maxCanvasDim` 32767.
Those options are not exported by this build. Web and the generated native
WebView consume this same sizing owner; visible-page disposal remains with
`pdfCanvasViewer.ts`. Zoom presets and page geometry do not change.

## Editing intelligence (0.3 development)

`CodeEditorHandle.setLanguageIntelligence` binds the mounted editor to the existing
language-intelligence controller. `monacoLanguageIntelligence.ts` and
`codeMirrorLanguageIntelligence.ts` translate its query results into their engine's
completion, signature, hint, highlighting and selection APIs. They do not open
another Machine connection, synchronize another document or start a server.
Completion requests contain positions and context; the controller's held-document
sync carries text changes. An incompatible engine edit aborts pending work and
late results cannot enter the changed buffer.

Completion snippets and additional edits use the engine's buffer transaction and
undo history. In Edit, Format, Format selection and Organize imports edit only the
buffer, using the shared semantic edit-set transform for validation. In View and
Changes, the File menu opens the existing edit-set review through the same Action
preview and apply operations agents use. Cancel leaves disk untouched; apply sends
only the reviewed, hash-guarded files. Range formatting uses current-file selection
endpoints, including UTF-16 offsets across syntax spans; removed diff text is refused.
Saving stays
with the existing hash-guarded writer. The Account setting
`filesEditorFormatOnSave` is off by default; an enabled Save awaits the editor's
format operation before reading the bytes it will write. Explicit conflict
replacement retains its reviewed comparison instead of formatting it again.

`filesEditorInlayHints` selects `off`, `parameters` or `all` (initial default
`off`); `filesEditorSemanticHighlighting` defaults to `true`. The adapters request
range hints and semantic tokens only for the engine's visible range and retain
syntax highlighting as the baseline. Capabilities and trigger characters come
from the server initialization result, through the controller.

View consumes that same controller and preference at its visible-line projection.
Semantic spans overlay the syntax baseline without replacing Find or diagnostic
paint; viewport changes, text changes and retirement discard pending results.
View and Edit accept servers offering native ranges or full tokens with delta support.
For a server without native ranges, `apps/cli/src/lsp/serverSession.ts` acquires a
full baseline on first visible demand, retains it with the held document, and
applies subsequent deltas using the server's result id. It returns only tokens
inside the requested viewport. Cancelled or superseded responses cannot replace
that baseline; closing the document or restarting the server discards it. Native
range-capable servers keep their range requests. This follows the
[LSP 3.17 semantic token contract](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_semanticTokens).

The bundled TypeScript language plugin declares server-side inlay preferences
under the native server's requested `js/ts`, `typescript` and `javascript`
configuration sections. Advertising `inlayHintProvider` alone does not enable
hint production. The generic session owner sends these declared settings at
startup; the editor preference still owns whether hints are requested and
whether only parameter hints are displayed. This does not enable Account hints
by default or add TypeScript policy to the generic adapters.

Monaco's public reference provider and native Peek References action retain
cross-file results. Its disposable preview models
read through the File owner: a mounted file supplies its current draft; an unopened
file uses the canonical file preview reader, classification and budget. A new peek
or editor disposal releases those models, and edits cancel pending preview reads.
Opening a result uses the existing File opener, with the captured Home/Account
lifetime checked before reading or navigation. Card type-definition and
implementation actions target the displayed inspected token; keys and menu actions
retain caret intent.
The Account semantic-highlighting preference explicitly configures Monaco's
coloring option; standalone themes otherwise disable semantic coloring even
when a range provider is registered. A document's capabilities still control
provider registration, not the global Account coloring preference.

The native WebView uses its existing chunked bridge for query, cancellation and
result envelopes. `getSignatureHelp` and `subscribeSignatureHelp` expose parameter
data to the phone's existing editor chrome. The CodeMirror bundle is produced and
checked only by `tools/codemirror/buildCodeMirrorWebViewBundle.mjs`; changing the
adapter requires regeneration. Phone chrome composition, loaded-server journeys
and typing latency still need the integrated acceptance pass; source-level tests
do not establish their live availability.

## AI suggestion preferences and usage (0.3 development)

The Account catalog owns `filesEditorAiSuggestionsV1` in
`packages/protocol/src/account/settings/accountSettings.ts`. Suggestions are
off by default. The policy retains one exact Provider connection and model,
automatic or on-request delivery, a Fast / Normal / Relaxed pause preference,
excluded path patterns and disabled language ids. The shared policy decision
in `filesEditorAiSuggestionsV1.ts` is consumed by both the client controller and
the Machine before credentials or outgoing inference. The default exclusions
cover `.env*`, secrets directories and `secrets.*` files. Patterns use `/` paths
with `*`, `**` and `?`; Machine paths normalize either separator style.

`FileEditorAiSuggestionSettings` renders through the existing Source control
settings shell and portable `settings.set` field bindings. Provider/model
choices use the existing connection catalogs, source visibility preferences and
declared inline-completion operation facts. They do not fabricate a coding
Agent or require its tool capabilities. A model without a usable declared
context and output allowance remains unavailable; nothing selects another
source, downloads a model or enables billing automatically.

Content-free request and quality counters use the existing device KV adapter
through `sync/domains/state/filePaneUiState.ts`, with one record per Home/Account
for the current local calendar day. Recently opened files use `recentWorkspaceFilesState`
at `recentWorkspaceFilesKey({serverId, accountId}, workspaceCacheKey)`, with an exact-key
subscription. These frequently changing records are outside the settings document;
the AI suggestion policy remains an Account setting. The settings row labels the counter scope as **On this device
today**. Observed latency totals/counts and Provider-reported token and cost facts are retained when supplied;
missing cost is not estimated. These counters do not contain source, paths,
prompts or suggestions and do not enable telemetry or training collection.
`AiSuggestionStatus` renders the controller's quiet off, sign-in, rate-limit or
model-unavailable reason and links back to these settings. Whole-page and live
model validation belong to the integrated AI suggestion delivery.

### Next-edit suggestions

The separate `nextEditEnabled` preference defaults to false. The Account's
`filesEditorAiSuggestionsV1.modelId` selects ghost text; nullable `nextEditModelId`
selects next edit on the same connection. Eligibility is operation-specific:
ghost text requires `inlineCompletion`, and next edit requires `nextEdit`.
A null next-edit choice uses the inline-selected model only if that exact model
declares next-edit support and admits its budget. An explicit unavailable choice
never falls back to another model or source. Each Automatic pause, or explicit
On-request trigger, first asks the eligible inline model for ghost text. A
displayable insertion ends that pause. Only an empty/no-op or invalid inline
answer lets the same pause continue with the eligible next-edit model; a
next-edit-only setup goes directly to that operation. Keystrokes, caret moves
and the existing cancellation triggers cancel the active request and its
continuation. Both phases reuse one debounce and one physical request slot,
without speculative prefetch. The shared controller
owns recent changes to the active buffer and uses the same scheduler and physical
request slot as ghost text. Its `nextEditSuggestions` external store exposes a
validated candidate, then a preview after the first Tab jump. A second Tab repeats
policy, source, captured text/version and range validation before invoking the
engine's single undo transaction. The engine never saves from this operation.
The existing editor-context stream supplies IME, selection and completion-list
facts; the language-server list retains Tab while open.

`ai.nextEdit` carries chronological recent edits and an explicit whole-file target.
This reaches related call sites far from the caret. The declared model context
budget governs how much recent history fits; the target is admitted in full or
the request is declined. No other files or repository history are included.
The selected dedicated rewrite-window codec returns replacement data. The Protocol
decoder diffs the original window against that replacement, first by line and then
within changed lines, and emits only the changed spans in source order. Unchanged
lines between related renames are not part of the preview or transaction. Its wire
decoder rejects an incomplete generation, and the shared Protocol validator
rejects invalid framing, stale text/version, out-of-file or overlapping ranges
and split UTF-16 scalars; valid no-ops disappear. CRLF and replacement whitespace
are preserved.

Rendering is engine-local and policy-free. Monaco (`surfaces/monacoNextEdit.ts`)
and the CodeMirror factory (`bridge/codeMirrorInlineSuggestions.ts`, drawn from the
native host's projection) both draw `ready` as an ink mark at each edit's range
with a Tab hint at the caret line, and `preview` as the Replace word marks (removed
struck, added beside it) with Tab/Esc hints. Both share
`formatCodeEditorNextEditCss`. Tab and the phone key row's Accept/Dismiss commands
reach `nextEditSuggestions.tab`/`dismiss`; Escape dismisses. Apply is one
`isolateHistory`/`pushUndoStop` transaction bracketed by the surface's pending-change
flush, so the document history records it as one step. The file page passes
`nextEditKeys: false` on phones, where the key row replaces the hints, and a
footer leaf announces offered and previewed edits through
`announceAccessibilityMessage`. The real-model desktop/phone journey remains at the
integrated UI boundary.

## State and rendering locality

The edit session holds the base text/hash, its BOM fact, the draft, a
single-flight save, a refusal and one recoverable set-aside draft. The live text
stays in refs and a subscribable text store; page-level state changes when dirty
or lifecycle state changes, rather than on every keystroke. `liveValue` exposes
`get()` and `subscribe()` to Markdown eligibility and language intelligence.
The existing intelligence controller uses that draft only while Edit is selected;
View and Changes project the saved text shown by their reading body into the same
controller and `@` outline. Switching this coordinate basis resynchronizes its
versioned document without replacing the draft. Markers for unacknowledged text
are removed before synchronization waits, and late older-version diagnostics
cannot restore them. The unsaved flag still follows
the retained editor, so disk-based agent Actions continue to refuse dirty files.

`editorStatus` is derived as `clean`, `dirty`, `saving` or `conflict`. A conflict
requires a changed disk hash and draft text different from disk. When disk equals
the draft, the base is adopted; when disk returns to the base hash, the conflict
clears. A clean buffer reseeds from a refreshed disk version. A dirty buffer is
never silently overwritten by refresh.

Save keeps the edit session open. A successful write advances the base to the
text actually sent and its returned hash; text typed during the write remains
dirty. The loader receives that version before refresh so an older read cannot
be presented as an external write. The write slot and Save result settle at
the write receipt, including guarded Use mine and Undo writes. Display refresh
runs independently through the loader's abort/request-identity owner. A new
explicit Save or opt-in autosave can write newer bytes while that read is
pending; concurrent writes remain single-flight. Saved is a short presentation state, not
another persistence state. Autosave remains opt-in and is suspended by a
conflict or refusal; reconnection alone does not save.

Acknowledged Save, Discard/Restore and Replace/Undo results notify the same
mounted saved-byte loader through `workspaceFileAcknowledgements.ts`. The
notification is qualified by Home, Account, Machine and canonical file path;
it carries the writer's returned hash, not inferred text. The loader invalidates
older reads and reuse, records the own-write hash before refreshing, and defers
hidden-page reads until the page is active. A failed read retains the last
useful content with stale freshness; a dirty editor remains untouched. This
notification holds no file bytes, history or watcher, and adds no per-feature
refresh policy. A known-text Save still publishes its exact acknowledged text
immediately through that loader.

The focused details group's active editor owns the save keyboard command.
Retained editors in other groups must not handle that command. The mounted
editor Action owner uses the same hook operations, without opening a new editor.

## Drafts and departure

The canonical draft record is
`{ accountId, isEditingFile, editorOriginalHash, editorText }`. It contains no
copy of the original file. Readers qualify by Account, ignore unknown fields
and reject records without the original-hash field; writers emit only this shape.
Pane tab state persists as keyed records through the existing device KV adapter
(`persistentUiState` / `filePaneUiState`), not the settings document. Recent-file
history uses that same adapter, qualified by Home, Account and workspace address;
unqualified development records are not assigned to the next Account that reads
them. Refused device writes to optional Recent or AI-suggestion usage records
are diagnosed without interrupting file viewing or suggestion requests.
The original-text draft shape is an undeployed 0.3 intermediate, not a legacy
format requiring a second reader.

Dirtying a preview tab pins it. Switching to View or Changes leaves its draft
session and undo history open. Raw/Rich switches flush the current value and
consume the same history, including edits to Markdown frontmatter. The history
is in memory for the document lifetime; it is not a persisted crash-recovery
guarantee. Closing a dirty tab goes through the shared Save / Discard / Keep
editing decision; a failed Save keeps the tab and draft. The unsaved-file-path
projection reads persisted tab state, so other-group and unmounted tabs count.
The compact draft module has no second module cache; tab-move/remount continuity
must be verified against the existing pane-state persistence owner.

Project-manifest authoring has a separate edit-session lifecycle: Back unmounts
its editor, so `projectManifestEditorModel.ts` retains its dirty draft and known
base in memory, qualified by Account and checkout. It consumes the compact draft
reader only for its optional persisted input and never persists original bytes.
It does not cache or decide file-pane draft state.

A held complete text read, or a restored draft with its original hash, remains
editable while the Machine is unreachable. With neither, there is no offline
file content to edit. Saving still attempts the Machine write and keeps the
draft on failure. The existing checkout reachability owner supplies retry and
reconnection facts; the editor adds no second poller or retry policy. A device
storage failure must be visible while the in-memory buffer remains editable.
The pane persistence owner reports asynchronous device-write failures through
`persistenceFailed`; the editor projects that into its dirty-draft warning. Only
storage-adapter write errors are caught, not serialization errors. The existing
next successful pane write clears the warning; there is no new retry loop.

## Guarded writes and byte identity

The write corridor is `workspaceWriteFile` →
`daemon.filesystem.writeFile` → `writeFileForRpc` (inline bytes), or the existing
upload finalizer (larger bytes), → `commitGuardedFileReplace` →
`writeFileAtomically`. Executor-side Discard, Restore and Replace consume that
same guarded replacement owner directly. No consumer owns a parallel writer.

Multi-file replacement and normalized language-server edit sets first prepare
all targets, including raw-byte hashes, text edits and move destinations. A
known stale or invalid target refuses the whole set before a file or held
buffer changes. Each publication still rechecks through the guarded writer;
this admission check does not make separate file commits transactional.
Cancellation or an external write during publication can leave completed-file
receipts, whose inverse edits remain available for guarded Undo. Undo reads
receipts in reverse time order, including repeated edits to the same path.

The expectation is omitted for an unconditional write, `null` for a file that
must be absent, or a SHA-256 hex hash for the existing raw bytes. Guard failures
are `hash_mismatch`, `expected_file_missing` and `expected_file_absent`. Client
write results classify conflicts, approval, reachability, unsupported operations
and other failures once; the editor branches on that typed classification.

The guarded replacement contract extends the existing atomic writer: stage a
sibling file, preserve permission bits, fsync, and recheck the destination hash
immediately before each rename attempt, including the existing Windows retries.
Existing symlink destinations update their resolved target. Upload staging may
cross devices before the sibling is committed; replacing the destination must
not fall back to an in-place copy. This is optimistic concurrency: the final
check and rename are separate operations, not a lock against every possible
foreign writer. Ownership preservation is not promised.

An untouched added-file Discard uses `source: {kind:'absent'}` at this same
expectation owner. It checks the raw-byte hash immediately before atomic unlink
and returns `hash:null` for guarded recreation by Undo. Deleting a symlink removes
its directory entry; writing bytes through a symlink updates its target.

An unguarded upload with `overwrite:false` retains the existing exclusive-create
operation, which cannot replace a pre-existing file. Guarded creation with
`expectedHash:null` uses the guarded replacement owner. Cross-device staging
failures retain a transfer session only while its original staged source still
exists; a failed final rename returns `file_replace_failed` and removes its
temporary sibling without copying over the destination.

Both client and Machine hash raw bytes before text decoding. Complete valid
UTF-8 text can seed a saveable buffer; binary, truncated, failed or lossy-decoded
content cannot. A UTF-8 BOM is remembered and restored on Save. LF and CRLF files
keep their ending style; mixed endings normalize to the dominant style with a
quiet note before Save. Shared byte fixtures protect the hash basis.

Encoding metadata belongs to the editor's base (`Base.encoding`), not a mutable
draft intent. The editor offers no encoding or BOM control: Save preserves the
base format, and draft Discard restores text only. A draft whose only difference
is BOM metadata is therefore not a reachable user state. The persisted draft
keeps its four fields; no encoding field or second metadata owner is needed.

The inline size threshold chooses the transfer path, not editing eligibility.
Larger guarded saves carry the same `expectedHash` through upload finalization.
The removed editor-size setting imposes no replacement cap. Existing read and
transfer bounds still apply, and a partial preview is not an editable document.
`filesEditorBridgeMaxChunkBytes` remains solely the native CodeMirror bridge's
transport chunk size.

## Conflict resolution and Undo

Compare uses the page body and the shared DiffViewer hunk contract, with disk on
the old side and the draft on the new side. Use mine writes against the hash of
the disk version shown; it does not bypass the guard. Use theirs adopts disk and
retains one set-aside draft in memory. Per-place choices merge into the draft;
after every place is decided, its base becomes the shown disk version and Save
uses that hash. Automatic resolution of places touched only on disk requires
the in-memory base; after reload, Compare asks at every place.

Unrelated read-only comparisons, such as project-manifest conflict inspection,
use `components/ui/code/diff/TextComparisonModal.tsx`. That presentation wrapper
receives two snapshots and caller-owned subtitle copy. It neither resolves a
file-editor conflict nor owns a draft; the File page's comparison stays inline.

Use mine Undo writes the displaced version back guarded by the just-written
hash. Use theirs Undo restores the set-aside draft and derives the conflict
again. `PresentationNotice.sticky` supplies the shared dismissible Undo notice:
it has no timed window and retires on the next relevant edit/save/Compare/review
action, explicit dismissal or replacement. It is not a second draft history.

## Actions and plugin boundary

`daemon.filesystem.writeFile` retains the danger default for automated callers;
its present-user UI default is direct. That default holds on the Machine too:
the receiving executor reads Home's signed Account admission of that exact press
(`isHomeAdmittedPresentUserHostInvocation`) instead of re-applying the danger
floor, so a person's own Save never lands in the Inbox. Session, Workflow,
terminal and public-API origins keep their policy. Per-Action settings still
govern explicit approval choices. An explicit Ask is reviewed over the editor
through `useInPlaceApprovalReview`, and approval-required saves use the existing
approval continuation and advance their base only after the write succeeds. An
editor that returns after the approved write reconciles its draft from the disk
read, so no stale unsaved state remains.

`file.editor.save` and `file.editor.resolve` address an already mounted editor
in its qualified scope, optionally by tab. Save reports saved, clean, conflict
or unavailable; Resolve reports resolved or unavailable. Automated calls use
ordinary approval admission. These Actions do not create a buffer, load a file
or choose a different Machine when the owner is absent. See [Actions](actions.md).

No editor contribution family is added. Installed plugins retain the existing
openable-content viewers and read-only diff surface; an open editing draft keeps
the host editor in control. Plugin Actions consume the existing host Action
boundary. See [plugin platform](plugin-platform.md).
