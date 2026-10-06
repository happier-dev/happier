# Plugin platform and SDK ownership

Bundled and installed plugins contribute through the same manifest, registration and projection contracts. The host owns installation, admission, currentness, invocation and cleanup; a plugin owns its integration's declarations and executable leaves. The SDK exposes that boundary without becoming another runtime or persistence owner.

This is the standing reference for **0.3 development source / Developer Preview authoring**. Source availability is distinct from registry publication and loaded-platform verification. Exact public exports and capability facts come from the package-owned generated API and capability reports, not a hand-maintained list in this page.

## Declaration, activation and projection

[`definePlugin`](../packages/plugin-sdk/src/definePlugin.ts) is the code-defined author path. It projects a portable manifest and compiles registration callbacks into the named `activate(api)` ABI declared in [`activation.ts`](../packages/plugin-sdk/src/activation.ts). Raw host-generated `contributes` is not an additional `definePlugin` author input.

The canonical manifest schema and normalizer remain Protocol/platform-owned. [`manifest/v2.ts`](../packages/protocol/src/plugins/manifest/v2.ts) admits runtime API version 1 and an **optional** non-wildcard `engines.happier` range. Host/runtime ABI admission and package SemVer are separate contracts; do not infer a host compatibility range from a package version or source build identity. See [protocol evolution](compatibility.md#sdk-protocol-evolution).

The host derives registration rights from the admitted manifest. [`registrationRightsHost.ts`](../apps/cli/src/plugins/runtime/api/registrationRightsHost.ts) wraps the SDK registration scope with occurrence currentness and diagnostics; a retired occurrence cannot register. The reload lifecycle owns the serving occurrence in [`runtimeSlots.ts`](../apps/cli/src/plugins/runtime/runtimeSlots.ts). A consumer does not reconstruct currentness from an id, callback or manifest snapshot.

In 0.3 development source, admitted targeted Actions use the existing contributor-materialization and target-occurrence checks in [`executeContributedAction.ts`](../apps/cli/src/plugins/runtime/invocation/actions/executeContributedAction.ts) before demanding activation, and repeat them after awaited bindings before starting the handler. A stale admitted occurrence returns its retirement result without demanding activation; the later fence still protects retirement during activation or binding.

Contribution-family membership and normalization are Protocol-owned. In development source, the CLI's [`projection/families.ts`](../apps/cli/src/plugins/projection/families.ts) asserts its descriptors against that catalog, adds current occurrence facts and validates each projected entry with the existing Protocol schema. The daemon omits an invalid entry and publishes a plugin-attributed diagnostic identifying its family and entry, while retaining healthy entries in the same projection. Agent catalog and UI registries consume that projection; a feature must not scan Actions, invent conventional ids or install a second registry to discover its contributors.

Catalog-scale Action, contribution-projection and Account-settings schemas in
development source use Protocol's internal
[`lazyZodSchema`](../packages/protocol/src/lazyZodSchema.ts) construction owner.
Referencing a definition or deriving another schema does not construct its
concrete validator until use; parsing and schema inspection still use the
existing Zod schema and validation rules. Nested JSON Schema traversal delegates
to the concrete schema through Zod's reference handling, preserving references through
optional and lazy wrappers. This is not a second parser or a public
SDK flavor change. The private neutral-to-Zod Action bridge uses Zod's native
lazy combinator because its contract is the base `ZodType`, including recursive
JSON Schema projection, rather than a concrete fluent schema type.
Persistence-only projections use the same internal definition lifetime at
[`json/storedReadSchema.ts`](../packages/protocol/src/json/storedReadSchema.ts).
Recursive derivation waits for the first read or schema inspection, retains
Core/Mini support and the existing known-field checks, and drops unknown stored
object fields. This reader is not request, Action, event or write admission.

An app page's optional shell column has the same destination as its page but a distinct physical mount and renderer binding. The CLI's [UI projection producer](../apps/cli/src/plugins/projection/registry/ui/projection.ts) admits that column binding through the existing Protocol destination normalizer. UI projection and the app-page catalog carry it unchanged; the surface mount reader rejects renderer or plugin identity mismatches rather than retargeting the page's binding.

The install registry's materialization map supplies exact execution-origin stamps
for daemon projections. A daemon-selected plugin's release-less Account
declaration supplies server currentness for Collections, webhooks and Events,
not install-registry projection authority. The runtime's current-materialization
getter retains that declaration identity for Account operations. Without an
install materialization, Plugin UI entries remain originless and use the existing
Administration machine selection; stamped entries still require exact per-plugin
origin selection.

The declarative `workflows` family uses the canonical Workflow definition schema. Bundled and installed contributions reach `workflow.definition.list` through the existing plugin catalog projection; the library, Work tab picker and composer consume that same read. Plugin workflows are read-only and can be duplicated into the user's library through the existing create path. A start names the qualified `plugin:<pluginId>/<localId>` reference and the observed plugin version; the Workflow admission owner resolves and freezes the definition in the accepted Run snapshot.

The [workflow contribution-family normalizer](../packages/protocol/src/plugins/contributions/workflows.ts)
qualifies plugin-local Action ids, including nested blocks and evaluators, through
the existing contribution identity owner. Explicit host and qualified Action ids
retain their meaning. The family runs `validateWorkflowDefinition` and refuses
invalid graphs with `plugin_workflow_invalid`, carrying the plugin, workflow and
canonical path-level issues. Reference availability stays at run admission;
normalization does not discard references to unavailable contributions or grant
the workflow additional Action authority.

The CLI reads the current serving occurrence from its contribution registry. The UI's Account Workflow Action owner reads the serving machine through the existing Account-scoped daemon projection cache and shares the same descriptor projection and reference resolver. A failed or retained projection is not a current plugin source; saved Account workflows remain readable without a serving machine. Closed Work menus do not subscribe to or load the detailed Workflow library.

## Public seam and authority

- Plugin leaves import public SDK entry points and their owning public feature protocol. They do not import host internals or private Protocol validators. SDK `*.public.ts` files and package `exports` maps own the exact public surface; generated reports are never hand-edited.
- Host services bind the invocation's admitted plugin, generation, scope and authority. Caller identity, selected credentials, Session ownership and machine routing cannot be supplied as renderer or Action input.
- A feature Action may accept an admitted source address for selection while deriving caller provenance from the host invocation. Triage's configured-source Actions allow authenticated host agent/MCP/CLI discovery and administration through that owner; a nested plugin call remains scoped to its own admitted source even if it claims a host origin surface.
- Actions own request/response and effects; Resources own reads and invalidation; Events carry facts. Keep their different cancellation and lifecycle semantics. [Actions](actions.md) owns invocation surfaces, placement and confirmation rules.
- The [runtime core](runtime-core.md) owns Session/turn admission and transcript/lifecycle state. [Providers](providers.md) owns model sources, connections and materialization. SDK projections do not transfer those domains to plugins.
- Trusted daemon and native plugin code is executable code. Managed services provide portable APIs, resource custody, cancellation and diagnostics; they are not a malicious-code sandbox. Real network, credential, present-user and OS permission boundaries still apply.
- Capability declarations, runtime registration and lifecycle must exist in the applicable realm. A daemon declaration does not establish browser or native support. Registry publication and a loaded invocation are separate evidence, not substitute availability authorities.

For collection-based plugin pages, the public Plugin UI `Collection` composes one headless model, item anatomy and detail renderer across presentations and containers. `Step`, controlled `Tabs` (including host-rendered strips) and `HappierDisclosure` belong to that public UI/presentation boundary, rather than feature-local replacements. See [Collection presentation](collection-presentation.md) and the [public author composition](../apps/docs/content/docs/plugins/ui/react-native.mdx).

The app shell supplies plugin-column physical focus eligibility through the existing presentation provider, using its dock visibility and peek focus facts. Hover previews may remain presented without receiving programmatic focus; deferred or exiting peek content cannot receive it. Columns explicitly do not publish semantic current UI context: that authority remains with the active page's existing owner.

### Entity drag sources and drop targets (0.3 development)

`definePlugin` declares `dragSources` and `dropTargets` through the existing contribution catalog. Each source has a declared JSON reference schema and a client execution reference; each target declares accepted built-in or qualified `plugin:<pluginId>/<localId>` kinds and an explicit host/contributed Action allowlist. `activate(api)` registers only admitted local ids through `api.dragSources.register` and `api.dropTargets.register`. These families have client occurrence rights, not daemon or Session runtime rights.

A source may select its own declared `composerAttachment` local id and register `toComposerAttachment(reference)`, returning the incumbent `ComposerAttachmentAuthorValueV1` or `null`. Composer admission validates the reference and current source registration, then matches the attachment declaration in the same occurrence of the mounted composer's composition. `composer.transaction.apply` accepts an optional exact `attachmentContributor` selection; the mounted owner derives authority and mints attachment identity through the existing revision-bound transaction core. The selection carries no generation, provenance or staged-media custody. Triage maps its actual entry/source-instance reference through its existing attachment builder; its resolver still reads the current entry at dispatch.

Protocol owns the [portable entity contracts](../packages/protocol/src/plugins/ui/entityDragDrop.ts) and [declaration admission](../packages/protocol/src/plugins/contributions/entityDragDrop.ts). The mounted UI's [treeDragDrop runtime](../apps/ui/sources/components/ui/treeDragDrop/entityDragDropRuntime.ts) owns carry, current geometry, target selection, release revalidation and cancellation. The plugin binding validates custom references and Action allowlists against the current occurrence; it supplies host-built identity for built-in references. A reference selects an item and grants neither access nor execution authority.

Public Plugin UI `DragSource` and `DropTarget`, declarative `dragSource`/`dropTarget` nodes, and SDK hosted DOM bindings join that same runtime. Authors supply declared local ids, JSON references and target-local input. The host supplies scope, measurements, currentness and caller provenance. Hosted methods `readEntityDragItem`, `updateEntityDragDrop` and `watchEntityDragDrop` are negotiated through the existing Host API; frame coordinates are converted at the host boundary. Retired or hidden mounts cannot begin an effect.

The portable item union is closed, including the development `work-board-widget` and `widget-area-instance` arms. Native WorkBoard sources build their qualified Board/instance reference from current membership; Project/plugin areas carry an exact `WidgetInstanceRefV1` whose surface matches the captured Home/Account. Widget-shaped JSON supplied as a plugin reference stays within the contributed `plugin` arm; it cannot manufacture a built-in reference or select its authority.

A target's synchronous `resolve` returns an allowed Action request with release preview, or a typed refusal with a reason. The preview declares `verb`, `target`, optional `consequence` and optional `glyph` from the closed `EntityDropPreviewV1` vocabulary. Core and plugin targets declare their marks through that same field; the shared outcome presenter never derives a mark from Action ids or inputs. An omitted mark retains the generic `add` presentation. Pending and settled feedback retain the released effect's declared mark; refusal chrome uses the refusal mark. A mark grants no effect authority. Hover performs no mutation. Completed release resolves again before the ordinary Action front door applies current admission and approval policy; a dispatched unknown result stays with that effect owner. Core and plugin sources use the same release preview, Organize grip, staged keyboard and chooser primitives. OS Files retain boundary-local acquisition handles and never enter serialized plugin references. See [Actions](actions.md#entity-drop-effects-development) and the [authoring guide](../apps/docs/content/docs/plugins/ui/react-native.mdx#entity-drag-and-drop-development).

The shared `HappierDragGrip` presentation accepts optional `revealed` pointer chrome. Omission retains visible chrome; `false` quiets only the glyph surface, not the host's mounted focus/gesture target or its geometry. Active and touch-density grips remain visible. Canvas work cards reveal this existing grip on hover, focus or an open Organize chooser; touch and widget grips retain discoverability. This presentation input changes no carry, measurement, release or effect authority.

Interactive grips use `HappierDragGripTrigger`, including the core `EntityDragGripTrigger` binding and hosted Plugin UI sources. It composes the shared pressable and grip chrome, carries domain-owned accessibility actions, and exposes the existing focus registration and keyboard-consumption seam. Gesture-only phone handles retain chrome-only `HappierDragGrip`; they do not create a second interactive trigger.

These are development / Developer Preview authoring contracts. Source tests and generated exports do not certify a published SDK or a loaded browser/native journey.

### Configured widgets (0.3 development)

Widget Views use the same contribution catalog and Surface Registry as other plugin UI. Their App/Session target is an executable data context, not a physical placement allowlist. Each configured instance has its own identity and closed field bindings, defined by [`widgets`](../packages/protocol/src/widgets/widgetInstanceV1.ts); field descriptors, predicates and options reuse the neutral [`inputs`](../packages/protocol/src/inputs/index.ts) owner. The shared [`WidgetSurface`](../apps/ui/sources/components/widgets/surface/WidgetSurface.tsx) body consumes that admission and the incumbent installed-surface controller. Host layouts retain their own frames and persistence.

A Session widget selects its exact Home-qualified Session through its declared input path. Following a host context and pinning a different Session are distinct intents. The selected Session supplies current access, policy, machine and projection; neither the physical Home/Session host nor launch-input routing fields grant authority. Missing, ambiguous, lost or denied targets remain repairable and never fall back to the visible Session.

While that exact Session's detail is hydrating, configured widgets consume the existing Session-route hydration lifecycle and show loading without offering input repair. A settled missing or denied target retains its refusal; an available target proceeds through the same access and runtime admission.

An installed widget whose plugin projection is still establishing also remains loading. A settled missing installed descriptor retains the host's supplied plugin-management action; loading does not offer that action.

The existing Summary, Plan, Changes and Local Services metadata/body owners project into that same catalog and admission path as native definitions, without fabricated plugin identities or a parallel creation registry. Configured copies retain independent bindings. Their native bodies use the selected Session's existing data/action owners; a configured Summary's work destination opens that Session's Agents view rather than borrowing the visible Session's local status popover.

Declared `optionsSourceId: 'sessions'` uses the neutral options resolver and returns qualified `{ serverId, sessionId }` choices from current Session discovery. Setup previews resolve the same declared bindings as saved instances without writing them. The surface's `onRepairInputs` callback exposes its typed unresolved binding outcome to the existing setup composition, without creating another input writer.

Widget Views can declare `resources` as qualified same-plugin Resource references at the existing manifest/Surface Registry owner. These references identify refresh dependencies, not permissions. The daemon projection retains each admitted Resource's actual `global`, `session` or `surface` scope; dynamic Resources have no fabricated packaged-file path. `widgets.instance.refresh` admits the current instance and resolved target, then awaits each declared Resource's existing store read. The store's `refresh()` returns the settled snapshot, including a truthful error or retirement outcome; stale last-known content does not make a failed refresh successful.

Native mounts, hosted read/watch bridges and this Action share the existing contextual Resource owner under the captured canonical Account and exact machine/occurrence/context. Declared global Resources share across physical hosts; Session Resources retain the selected Session identity. Final-consumer release or Account retirement disposes the store. Canceling an Action releases its wait rather than canceling another mount's shared read. Headless/client-only execution, missing declarations/scope or unavailable surface provenance returns typed unavailable, without child capability registries or current-UI routing. Native builtin definitions have no plugin Resource declaration; they retain their native data subscriptions/Retry and this Resource Refresh Action is unavailable for them.

Home layout and setup dismissals use one Account Artifact; shared Session instances use Board records and revisions; direct Companion instances remain viewer/device-local presentation preferences. The widget instance Action family delegates mutations to those owners. Personal Companion changes do not edit Board content. Viewer bindings consume only the viewer's own existing Connected Account purpose selection; there is no per-instance viewer override, Action or local selection setting. A widget declaration without correlation to an admitted existing purpose consumer fails closed; it does not guess another consumer or change a global binding. Pinned Connected Account references are allowed on personal surfaces only.

The declaration correlates a viewer field through `connectedAccountPurposeBindings: [{ path, purpose, consumer: { pluginId, localId } }]`. The consumer must identify an explicitly declared current Resource whose purpose advertises the permitted services. The existing purpose admission/materialization owner admits that Resource consumer and uses the viewer's own qualified purpose selection, including an admitted member of a selected group. Changing that selection uses the existing Connected Account preference and lifetime, and can affect other viewer bindings for the same qualified purpose; it is not an instance-only connection edit. Personal pinned references, by contrast, remain instance bindings. The exact target supplies current Resource and service-authentication declarations; a Session pin is resolved before its full credential binding, without granting execution from the pin. Missing connection is a typed Connect requirement; missing declaration or read authority remains unavailable/denied. Shared content retains viewer intent, not the selected private ref or credentials.

`widgets.instance.move` accepts `{ ref, toIndex }` for current-view widget-ordinal reordering, or `{ ref, to: { surface, tabId?, index } }` for owner-native mixed-content insertion. Board view changes use its existing layout owner. Cross-surface movement admits both authorities, adds through the destination and conditionally removes through the source; refused/unknown outcomes report observed owner state rather than promising a transaction across independent stores. Add retains the caller's instance id and returns the acknowledged qualified reference.

For a widget `select` field marked `connectedAccountOptions: true`, the existing
`action.options.resolve` widget-consumer dispatch returns credential-free pin
choices from the viewing Account's active qualified profiles, filtered by that
same declared Resource purpose's permitted services. A personal pin does not
require an existing purpose selection; a `viewer` binding still does, and a
missing selection remains Connect. Shared Board pins remain refused. The marker
cannot be combined with static options, `optionsSourceId` or `inputType`; these
constraints belong to the neutral field grammar, not a widget-specific options
registry or public host service.

These are development-source contracts, not release or loaded-platform certification. WorkBoard, Project/plugin-area layouts, reusable declarative definitions and setup/edit composition consume the same identities through their respective program owners. Home includes built-in visibility and setup dismissals in its layout Artifact. WorkBoard widget intents use its existing `work-board.v1` Artifact reducer/CAS writer alongside work references and smart sections, with one/two-card widths. Project/plugin areas share the [`widget-area-layout.v1` owner](../packages/protocol/src/widgets/widgetSurfaceArtifactV1.ts); changing page context does not create a new layout. Plugin areas use half/full widths; Project areas use order and a Plain default.

Reusable Account definitions use `widget-definition.v1` Artifacts through the existing mode-aware Artifact transports and the [definition owner](../packages/protocol/src/widgets/widgetDefinitionArtifactV1.ts). Definition Actions create, edit, duplicate, delete and copy admitted Session content into the Account library. Placements reference the Artifact and retain their own bindings; duplicating creates an independent definition. Deleting a definition retains unresolved placements for repair. `saveFromSession` copies rather than removes the Session item and makes its declared Session input configurable. An explicit shared Board add copies a private definition into the instance's inline definition before approval; the Board never receives the private Artifact pointer. The Board grammar rejects private Connected Account selections in copied definitions and bindings.

Declarative metric, table and single-series chart nodes use [typed data-source references](../packages/protocol/src/plugins/contributions/ui/declarativeDataV1.ts). They draw through one presentation owner, [`presentation/data/**`](../packages/plugin-ui/src/presentation/data/), which core's declarative renderer and the public `Metric`, `DataRows`, `DataTable` and `Chart` components share: tabular locale numbers, a proportion column as a share of its largest value, table columns dropped by measured width (`secondary` first, never the name) while every row stays and each row still reads every column to assistive technology, and a chart that is one labelled image naming every point. A live widget document keeps its last authorized content through refresh, a sleeping machine or a failed read, with one freshness line (as of, cause, Retry); `Post a snapshot` freezes exactly the frozen nodes on screen when the confirm opens ([`projectWidgetSnapshotPreviewV1`](../packages/protocol/src/sessions/board/declarative/snapshot.ts)). A Resource reference identifies a current declared Resource, not access authority; its scope, current occurrence and resolved input are admitted by the incumbent Resource owner. `widgets.snapshot.post` publishes the exact previewed inert document, as-of time and provenance through the existing Board item upsert. Snapshot content contains no live Resource, launch input or executable control. The Action never re-queries after approval. Definition edits/deletion, shared Board content upsert and snapshot publication use the existing consequential approval defaults and configurable waivers.

Metric comparisons project a typed value and authored label with explicit
`good`, `bad` or `neutral` meaning; numeric sign does not choose semantic color.
Rows and tables can project a boolean mark with separately authored true/false
labels and meanings. The same declared fields are validated against Resource
output and copied when freezing a snapshot, so comparison/mark presentation
does not copy undisplayed structured output.

Resource-only plugins do not need an unrelated View to supply app-scope widget data. The existing daemon projection stamps the Resource's actual execution origin and occurrence; the app union admits it only against Administration's exact selected origin and the matching enabled package occurrence. Older unstamped rows retain only their existing admitted-UI context, not independent app read authority. Demand and explicit Refresh use the Resource origin's own currentness: another current machine in the union cannot start reads on an offline origin. Retained authorized data may still display while reads are paused.

Client-targeted Actions receive the bounded [`PluginClientActionUi`](../packages/plugin-sdk/src/actions/contracts.ts) subset, not a mounted `SurfaceContext`. Its `context(options?)` returns only current `targetedContributions` for the Action's plugin (or `null`). `version()` and `selectActionInput(...)` reuse the canonical host method advertisement and selected-input admission/custody; `executeAction` and `openSurface` remain the effect seams. An Action gets no page, mount, layout or UI-selection owner from this capability.

Feature-specific caller contracts belong in their public feature package. For PRs & Issues, [`@happier-dev/triage-protocol/v1`](../packages/triage-protocol/src/v1/index.ts) publishes source detail-tab declarations and qualified fix-link Action schemas/references. Triage retains its private relationship writer and resolver; callers receive the owner-resolved read projection. These contracts add no Triage policy to the generic SDK or host. See [Triage source ownership](triage-sources.md).

Mounted target surfaces receive locale-resolved translation bundles from their admitted contributors through the existing `SurfaceContext.translations` projection. Contributor keys retain their authored namespaces; the mounted plugin's own bundle takes precedence on a collision, followed by framework-owned chrome. Unadmitted plugins' bundles are not included. Each bundle uses the same preferred-locale and English fallback owner.

Plugin authors operate on widgets through qualified `widgets.*` Actions and
embed declared native page areas through public plugin-ui `WidgetSurface`, or
declarative page areas through `widgetArea` nodes. Hosted HTML pages use the
ordinary widget Actions without embedding host areas. The SDK's
current-Session presentation types expose only the
[`author subset`](../packages/protocol/src/sessions/presentation/currentSessionPresentationV1.ts)
of the canonical presentation validator. Built-in, shared Board-item and pane
references can be arranged through reversible presentation intents. Direct
Companion instance records, instance input/rename intents and conditional
removal captures stay inside the host transport. They are not author DTOs or
an alternative widget mutation API.

### Typed input extensions (0.3 development)

The existing contribution catalog admits data-only [`inputTypes`](../packages/protocol/src/plugins/contributions/inputTypes.ts)
descriptors. A qualified type declares semantic identity and a normalized,
self-contained value schema, optionally referencing one declared options
Resource and an existing `ui.renderers` picker. `definePlugin` projects the
descriptor; `activate(api)` registers the referenced executable leaves through
their ordinary Resource/renderer rights. There is no input-type callback registry.

Actions, Workflow input adapters and widgets consume the neutral
[field owner](../packages/protocol/src/inputs/inputFields.ts) and
[options resolver](../packages/protocol/src/inputs/inputOptions.ts). An input
type owns its choices, so field-level static options or a competing source are
refused. Discovery admits the current consuming descriptor and grants before a
Resource read. The picker uses the incumbent ephemeral renderer mount and
[`invokeInputTypePicker`](../packages/protocol/src/inputs/inputTypePicker.ts):
schema/options validation also applies to its result, cancellation causes no
mutation, and an answer from a replaced occurrence is refused. Removed types
leave saved values available for repair rather than silently rewriting them.
See the generated [SDK surface](../apps/docs/content/docs/plugins/api/surface.mdx)
and [host Actions](../apps/docs/content/docs/plugins/api/host-actions.mdx) for the
exact public projection; source declarations alone do not prove publication or
loaded all-consumer validation.

The [production picker provider](../apps/ui/sources/components/sessions/actions/InputTypePickerHostProvider.tsx)
now connects Action fields, Workflow inputs, widget setup and native plugin
Forms to admitted projected picker mounts. It captures the actual Account and
machine/Session context, invokes the same picker validator and opens the
incumbent ephemeral-input presenter on demand. Source wiring is present;
focused integration checks and loaded all-consumer validation remain separate
evidence, and this documentation does not claim a completed live journey.

### Personal widget areas (0.3 development)

An `appPage` View declares named `widgetAreas` with a readable context schema.
Public plugin-ui `<WidgetSurface area="pinned" context={…} />` and declarative
`widgetArea` nodes reach the same [core area composition](../apps/ui/sources/components/widgets/area/WidgetArea.tsx)
through the mounted host port. The host derives captured Home/Account,
plugin/page/area identity, Artifact transport and access; author context is
validated data, never routing or authority. Gallery, Set up, Edit inputs,
frames and mutations reuse the Home/widget owners. Declarative area nodes
require a mounted plugin page and are excluded from Session Board documents
and transcript projection.

Native/declarative page ScrollAreas and the Project ItemList pass the incumbent
near-viewport admission to area cards. Offscreen executable bodies release
Resource read/watch demand while their frames retain measured room; reentry
mounts the current bound context. Route focus remains an additional admission
condition, not a substitute for viewport activity.

Area copies use the shared pointer grip, staged keyboard and Move-to chooser.
Current membership and anchors become requests to `widgets.instance.move`;
its incumbent surface ports own admission, approvals and persistence. Canonical
Artifact publication refreshes both mounted ends of a transfer. An injected
Project area binds preview and execution to its existing host movement owner;
that component seam neither grants authority nor supplies a Project Source.

Hosted HTML pages do not embed host widget areas: the plugin owns the whole
iframe. They manage widgets through ordinary `widgets.*` Actions, not a hosted
widget-area API, helper or renderer. Native and declarative page composition
remain the embedding surfaces. The [Project adapter](../apps/ui/sources/sync/domains/widgets/projectWidgetAreaContext.ts)
separately awaits lane 12's portable Project Source producer. It admits a
matching-Home exact checkout as checkout context, but refuses positive Project
layout operations with `widget_project_source_unavailable`; a Workspace ref
cannot substitute for a portable Source. Lane 12 owns final desktop-aside and
phone-below-checkout placement.

### External Session content search (0.3 development)

External Session source declarations opt into transcript search with
`contentSearch: true`. Consumers require that positive declaration before sending
`searchTarget: 'content'` to `sessions.external.candidates.list`; omission keeps
the existing metadata-search behavior. This matters with the 0.2 predecessor,
whose candidate-list reader can ignore an unknown search selector. The host
also refuses unsupported content scans rather than presenting metadata matches
as transcript results.

Content producers return decoded-text matches as `{ snippet, sourceItemId,
messageIndex }` and page-level `contentCoverage` (`complete`, `partial` or
`unsupported`). `messageIndex` is a zero-based presentation ordinal, not a
Session sequence number. Protocol owns strict admission of the match shape;
the host publishes these query-local facts without writing transcript text or
match snippets into the candidate metadata index.

The public External Sessions invocation supplies required
`ripgrep.run({ args, paths, signal? })`. The generation-bound host wrapper delegates
to the packaged ripgrep integration, combines cancellation with the invocation,
and uses that operation's existing byte budget. Plugins supply their source-owned
file set and decode native records; they do not resolve `rg` on PATH or import
the host integration. Empty paths do not scan the host working directory. This
is a development-source SDK contract, not a claim of released plugin or loaded
runtime availability. See the [SDK evolution contract](compatibility.md#sdk-protocol-evolution).

### Standalone Voice attempt policy (0.3 development)

Voice contribution declarations may carry an optional `mark`, projected identically
for installed and bundled providers. `VoiceServiceMarkSchema` and `VoiceServiceMark`
are public at `@happier-dev/plugin-sdk/voice`: `connected_service` names a known
Connected Service, `agent` names an Agent identity, and `icon` names a public Plugin
UI icon token (including `waveform`). These are decorative identity facts, never
credential, execution or Agent access. The service gallery and pipeline use one
renderer; first-party UI metadata has no separate mark privilege. OpenAI, xAI,
ElevenLabs and Codex declare their marks in the same public manifests.

Plugin UI's public `VoiceMarkArt` and labelled generic `StatusCell` are thin
requests through the incumbent same-realm presentation host. The mark supplies
explicit pose/size/theme/light/still facts, never attempt or energy inputs;
the private adapter selects presentation-only rendering on the one Brand
owner. `still` defaults true; false admits event-only pose transitions, not
ambient or microphone-driven motion. Status cells retain the host's motion,
reduced-motion and presentation rules. `SetupBlockTile` and `SetupBlockGrid`
delegate to the existing setup owners. `HappierSetupSteps` is the one ordered
composition over `HappierStep`, consumed by both the app and author `SetupSteps`.
Author `SelectionTiles` forwards the shared owner's useful geometry controls,
bare mark, badge, test identity and footer; the app no longer synthesizes mark
glyph tokens. Optional host bindings have explicit author fallbacks; they do
not add a wire capability or another renderer.

Public `TextField.dictation` composes `DictationButton` with the existing field,
binding capture admission to field editability. Authors may also use the public
button beside a custom controlled input. Both deliver editable text only and
leave insertion and submission with the author. The private host binding uses the incumbent
Dictation button, `useTextInputDictation` delivery/error adapter and
`useVoiceDictation` / `VoiceDictationController` engine. Session authoring uses
that same delivery adapter. An opaque mount-local control id is not a Session:
plugin fields explicitly pass null transcription Session context. Canonical
Dictation settings, language, permissions, capture admission and cancellation
apply independently of conversation selection. Host/tab visibility narrows
activity, and disable/unmount prevents late delivery. Live Voice subscriptions,
consent and attempt binding remain host-internal. No hosted-web capture or
second STT service is introduced.

Voice-callable plugin commands are ordinary Actions admitted on the `voice`
surface, discovered through `action.spec.search`/`action.spec.get` and dispatched
through `action.invoke`, or mounted semantic commands published with
`publishCurrentUiContext`. `VoiceClientToolDefinition` describes the sanitized,
attempt-bound host tools supplied to providers; it is not an author registration
owner, and effects still deliver canonical `tool_calls` through the Action barrier.
The client-local `ui.voice_global.*` conversation and Brief Action family is
consumed through the public typed `executeAction` Host API. Its microphone/Brief
approvals, captured attempt identities and typed unavailability are unchanged.
See [Actions](actions.md#client-local-voice-controls-development) and the
[published author guide](../apps/docs/content/docs/plugins/guides/voice.mdx).

The UI host composes the optional realtime `prepare.attemptPolicy` through the
Agents-owned Voice prompt composer. It includes guidance for the attempt's
admitted client tools, reply language, greeting preference, and Voice prompt-stack
blocks. The host retains that immutable policy through reconnect and releases it
with the attempt; it is not safe metadata. OpenAI and xAI translate it into native
session instructions alongside custom instructions captured for that attempt;
unrelated native configuration retains its existing preparation transitions. ElevenLabs maps
it to the SDK prompt and language overrides. OpenAI and xAI request an immediate
welcome only after the initial connection's session update, not on reconnect.
The shared attempt-policy owner carries an optional `welcome.text` for Right away,
resolved through the app translation owner in the admitted Reply in language.
Automatic or unsupported reply languages have no literal; the UI language is not
a substitute. ElevenLabs consumes the literal as its native `firstMessage`.
Shared preparation sets `firstMessage: ''` for Off and After I speak;
provisioning and actual-configuration admission require the corresponding
`first_message` override permission. A reused Agent missing it needs the existing
update action before credential minting. Without a literal, ElevenLabs sends an
empty first message alongside the attempt prompt and waits for the user; its
Greeting row explains this through the contribution's `immediateRequiresLiteral`
presentation fact. Local and model-driven realtime greetings retain their
reply-language instructions when a literal is unavailable.
Attached Agent realtime sessions do
not receive this standalone policy: their native Agent prompt scope remains the
authority. Omitting the optional input preserves existing plugin callers.

Standalone Local Agents admit the same reply-language and greeting preference
through `intentInput.voicePolicy`. The existing Voice launch config retains it
for recovery, and the shared Agents prompt owner consumes it on READY bootstrap,
first-user-turn seeding and replacement-runtime reseeding. READY is a warm-up,
so After I speak applies to the first user reply; a completed greeting is not
repeated when replaying retained conversation context. Recognition settings do
not supply reply instructions. Immediate Local welcome sends the same translated
literal through the existing `welcomeText` RPC input when available. Adopting an
existing run consumes its retained policy rather than newly edited preferences.

Recognition, reply instructions and output voice are distinct provider contracts;
do not publish a universal independent language control when a provider couples
them or leaves language session-owned. Conversation controls, search and direct
settings-route access consume the same page decision; independent Dictation is not
disabled by the conversation gate. Presence selection is device-local, and the
containers cannot choose an attempt's target or media lifecycle.

Registered STT transcription carries only an optional capture purpose, not a
client-selected language or provider configuration. Omitted purpose uses the
admitted Conversations configuration. For Dictation, the daemon reads the
independent language preference from the same Account snapshot and validates an
invocation-local override against the contribution's declared `language` field;
null uses that field's declared default. Contributions without that field retain
their engine-owned behavior. Neither path writes provider settings or aliases
reply language. Changing a captured Dictation language invalidates the existing
speech settings snapshot before its result can be published.

### Voice settings presentation (0.3 development)

Plugins own curated controls through the strict
`voice.provider-settings.v1` presentation in their existing Voice contribution.
The shared UI renderer consumes that declaration; provider-specific layout does
not require provider-id branches in the host. Settings schemas still own accepted
configuration and persistence. Presentation metadata does not admit arbitrary
configuration paths or loosen those schemas.

Numeric fields can declare optional `valueSuffix` and `fractionDigits` for their
display value. The shared renderer presents bounded `range` fields as sliders
with a Default reset; nullable resets retain the settings owner's unset value.
Formatting does not change stored units or the configuration accepted by Settings
Actions. Services own these facts in their contribution, not host id branches.

Optional `groups` arrange the declared top-level fields into sections. Each group
has a unique `id`, localized `titleKey`, optional `descriptionKey`, and
`fieldPaths`. When groups are present, every top-level presentation field must
appear exactly once, and unknown or repeated paths are rejected. At most one
group can set `includeCredentials: true`; without an explicit credential group,
the renderer puts credential controls in the first group. Omitting groups retains
the existing single-section presentation.

A `voice_catalog` field can declare `valueShape: 'string'` when its settings owner
stores a scalar voice ID. Omitting `valueShape`, or choosing `'selection'`, retains
the existing `{ kind: 'catalog' | 'custom', id }` representation. Catalog selection
and custom entry both pass through the provider's settings owner; the renderer
does not migrate stored configuration or infer the shape from a provider ID.
The `welcome` control presents the shared Greeting preference and uses its
canonical settings declaration rather than publishing a second provider field
for the same preference.

Optional `language` facts describe the service's actual conversation-language
contract. `automatic_recognition` keeps recognition automatic and admits the
independent reply preference; `independent_reply` admits only that preference,
without claiming how recognition works. `single_language` publishes the native
`supportedLanguageCodes` and couples listening and replies to one root choice.
The native leaf, UI and settings Actions share the same language normalization;
unset means the service default, not promised auto-detection. Omitted facts do
not imply that the service consumes a mutable language preference. No additional
language preference is persisted by this presentation metadata.

These are development author-contract additions, not opaque UI-only payloads:
the manifest serializes `settings.presentation`, and the Protocol reader checks
its nested strict schema. Current readers accept declarations without these
optional facts. Pre-addition strict development readers reject new declarations;
that reverse direction is not promised by the SDK direct cut. The inspected 0.2
predecessor uses host-owned Voice settings and has no plugin manifest reader for
this seam. These additions therefore do not introduce a host version floor,
rollback adapter, or persisted settings migration. Public plugin leaves consume
`resolveVoiceProviderLanguagePreference` through the existing SDK Voice export.

OpenAI Manual preparation marks the exact admitted session as requiring input
commit. The existing host turn-control owner submits that input and then the
provider-encoded response request on the same still-owned connection. Send is
separate from End Voice; automatic turn detection does not expose Send. Ending
the attempt during submission prevents its later response request. This same
turn-control entry point owns opt-in one-turn held input as well. Admission seals
and clears prior input before temporarily opening capture; release seals capture,
commits once and requests the response, then restores the capture owner's policy.
Cancel, release before admission, and a retired selection or connection cannot
commit. User Mute and lifecycle input suspensions remain separate policy facts;
applying either retires held admission, even when Mute was already applied.
Capability requires prepared Manual input, declared clear-input support, encoded
response controls and a concrete capture boundary. The host WebRTC microphone
supports that boundary; PCM/provider-managed capture does not advertise hold
without its own proven admission. A device-local default-off preference exposes
the composer's secondary press; tap and the keydown-only shortcut remain Start/End.
There is no second commit sender, capture owner or gesture-owned session state.

Identified client-tool calls enter the host's canonical Action barrier, which
owns authorization, approval, cancellation, replay custody and current privacy
redaction. Direct tool-definition callbacks remain read-only. The ElevenLabs
adapter associates its SDK's public incoming event with the matching callback
parameters, preserves the actual provider call ID, and settles each callback
only from a host result; it does not execute or cache effects. Approval origin
uses the connected attempt's captured Home/Session binding, not later navigation
or target selection. SDK-reported client-tool refusals return a safe error result
without ending Voice; terminal session, media and result-transport failures
still end the connection, and retired callbacks cannot re-enter the host.

Permission-request sharing supplies read-only context for speech, not approval
authority. A spoken yes/allow/deny cannot create a confirmation token or settle
a request. The existing permission UI owns that human decision, and End Voice
leaves the request pending. ElevenLabs still declares `effectCalls: 'none'` until
the loaded approval/effect-custody proof is complete; callback identity alone is
not permission to enable effects.

### Batch speech output (0.3 development)

Protocol's `voice/speechText.ts` owns semantic sentence and clause boundaries for
Kokoro synthesis, daemon synthesis and streamed Voice output. Token
punctuation in filenames, domains, URLs and times is not a sentence boundary.
The first useful streamed sentence can publish before the steady-state event
batch target; subsequent output remains coalesced under the existing event budget.
Accepted speech segments enter the ordered playback queue immediately; downstream
synthesis batches only to the selected provider's actual input limits. Local
Voice's `ttsChunkChars` preference is admitted once as the producer's latency
target, not a second semantic lookahead or provider ceiling.

Daemon output and the retained legacy-output translator consume the serialized
byte/event budget in `voice/outputEvents.ts`, reserving the repeated terminal
text and any incompleteness notice during admission. A clipped reply keeps its
accepted text and effects and publishes a final transcript notice; it does not
fail terminal ingestion after speech has already played.

Speech declarations distinguish `maxInputCharacters` from `maxInputUtf8Bytes`.
An endpoint may bind its character cap to a declared positive integer setting
with `maxInputCharactersSettingId`; the setting cannot exceed the declaration's
ceiling. `resolveVoiceSpeechSynthesisInputLimits` resolves that cap from the same
immutable settings snapshot used for synthesis. The UI batches whole and
incremental replies in order, and the daemon checks the effective cap before
calling the plugin. Cancellation prevents remaining batches and late playback.
Google Cloud declares its actual UTF-8 byte limit; OpenAI-compatible endpoint
settings default to OpenAI's character limit and allow a custom endpoint cap.

Fresh Local Voice settings select Device STT and Device TTS. Existing explicit
and predecessor selections remain unchanged. The existing device-readiness
owner determines whether capture is runnable or requires setup; empty compatible
endpoints are not selected as the fresh pipeline. Local-neural Auto follows the
platform execution policy, without an inert latency-demotion state.

### SCM filesystem authority (0.3 development)

SCM Action and RPC entry points share the host dispatcher. Worktree removal
authorizes the target with the host's filesystem policy and forwards the resolved
path. For worktree creation and prepared review workspaces, the host supplies
`context.assertFilesystemPathAuthorized`; the Git checkout materializer calls
it on each derived destination before creating a branch or checkout, including
the temporary sibling used for a populated destination before any scratch
cleanup. Review preparation checks those same mutation paths before fetching
the source tip or creating its branch, and checks an existing registered
checkout before reusing it. Reuse does not require permission for an unused
scratch sibling. This also checks symlinked destination ancestors. Repository backends
derive placement;
the host remains the filesystem-policy owner. Policy refusal returns
`INVALID_PATH` and does not mutate the rejected target.

The [SCM comparison contract](scm-diff-summary.md) keeps Git mutation and hosting
evidence at their contributed owners. Git's ordinary, stacked and accepted-plan
consumers share one writer and advertised capabilities; the public SCM backend
command seam carries its native ref-transaction acknowledgement. Shared private
index setup is a filesystem-only `cli-common` subpath, not a plugin UI dependency.
GitHub comparison evidence uses its existing configured-source Action and
validated continuations; display projections do not become authority or select
credentials. Missing backend/model capabilities fail closed rather than enabling
an id-based host fallback.

### Connected Account refresh and quota identity (0.3 development)

Manual authentication inputs are admitted against the service contribution's
field schemas by both the form and the daemon attempt owner, before provider
invocation or credential settlement. Anthropic declares its API-key shape in
the Claude plugin and verifies new keys with `GET /v1/models` through the
origin-scoped host HTTP service. Provider 401/403 responses reject the attempt;
transport failures and other unsuccessful responses leave verification
unavailable. Neither path stages a key or creates an account. Retry after a
terminal refusal opens a fresh editable form. Retained credentials remain
readable and materializable without imposing these new-input checks. This is
a development-source admission contract, not release or loaded-runtime proof.

Before a provider callback starts, the canonical Connected Account attempt owner
may re-admit a retired runtime occurrence through the current daemon registry.
Recovery requires the same qualified service, source custody, authentication mode
and configuration target/revision. Initial lazy activation may refresh admission
once from the published registry when the old occurrence proves it did not start
provider work. The invoker preserves that typed pre-entry result; retirement after
provider entry retains the existing uncertain-outcome recovery and never replays
the callback. UI, CLI and Agent Actions use this same daemon owner.

The Codex and Claude token-exchange owners classify HTTP 429 and unsuccessful
server responses as `outcomeUnknown`, preserving the host's retryable health
path. Authentication rejection still requires reconnecting. Codex stages a
replacement access token only when the response contains a fresh `access_token`
or `id_token`; retained identity and refresh metadata cannot establish a fresh
access token.

Codex Connected Account native materialization uses one access-only serializer
for launch/resume homes and hot-auth persistence. It writes
`auth_mode: "chatgptAuthTokens"`; the required `refresh_token` fields are empty,
not copies of host-held rotation material. Rematerialization replaces historical
native credentials rather than sharing `auth.json` or `accounts` from the user's
Codex home. The app-server runtime registers `account/login/start` with external
access tokens before opening or resuming a thread, including after client
recreation. Its refresh request handler delegates to the daemon's existing
Connected Service refresh coordinator and lease/revision checks. An app-server
that rejects external auth produces `codex_refresh_free_auth_unsupported`, not a
refresh-bearing fallback. Qualified launch selections and predecessor local
selections normalize at the same plugin boundary; refresh-wire selections remain
local. Connected Account ACP launches also return that typed unsupported code:
the current ACP composer has no host-managed token-refresh bridge. Personal
native login and API-key ACP launches are unchanged. App-server Execution Runs
without a refresh callback likewise cannot open a Connected Account thread.
Claude's native OAuth file already contains access material, expiry and
scopes only. These are 0.3 development contracts, not a claim about older shipped
native materializations or already-running sessions.

Connected Account quota limits carry optional `providerLimitId` separately from
their window `id`. The strict host result owner validates and preserves that
family, and the quota projector uses it for pool allowance selection. Omitting
it retains id-based selection. Pre-turn pool probes use the same credential
eligibility predicate as candidate selection. Known-unusable members need no
quota probe and count as resolved; missing targets and failed probes still make
the group observation incomplete.

Targeted feature composition uses public `defineContributionProtocol` / `defineContributionPoint` values and typed handles. A feature protocol keeps explicit versioned exports, validator-neutral schemas and source-neutral DTOs; it excludes host runtime, provider clients, credentials and persistence. The SDK's [`featureProtocolPackagePolicy.test.ts`](../packages/plugin-sdk/src/featureProtocolPackagePolicy.test.ts) owns the allowed dependency classification. [Triage sources](triage-sources.md) is one current consumer.

### Capture viewing and Session images (0.3 development)

Manifest-owned `captureSources` register through the same activation rights and
occurrence lifecycle as other executable contributions. The existing daemon
capture registry owns exact sources and retirement; replacement aborts viewers
of the old occurrence. The mounted UI binds a typed reference to its own plugin,
machine, server and lifetime. Plugin authors never choose a transport address.
Viewing another plugin's source is refused. Each host-source viewing requires
the existing `capture.view` Action's blocking approval, unless the user has
waived that approval for this plugin in the existing Actions settings document.
A plugin's own declared source needs no additional viewing consent. Viewing
does not transfer input or takeover authority.

For stored images, the mount retains exact Session-media references returned by
successful delivered Actions. Public `{sessionId,mediaId}` references resolve
only against that custody; they are not paths or independent capabilities. The
daemon rechecks the current plugin occurrence and the selected/required
`sessions` HostAccess read scope through the same canonical Session-scope
predicate used by the Session service. The Account mode must agree with the
media representation before bytes are disclosed. The existing linked-Session
UI scope is intentionally not an image-read authority. Thumbnail ingress
accepts strict file-backed native image artifact references,
including those in Session-event and contributed Action results. Producer
identity is not another permission gate: the daemon's existing artifact
verifier confines reads to the authenticated Session's exact bucket and real
path, then verifies size, digest and image encoding. Generated-media publisher
status/items are a distinct shape, not a native artifact reference. The app player and
thumbnail are bindings over Plugin UI's shared presentation; transport,
decoding, media verification and approval remain host-owned. These are source
contracts, not evidence of package publication or a loaded-platform pass.

Artifact preview cards, HTML reading frames, public-link cards and revision
lists likewise have one presentation owner under Plugin UI's `/presentation`
entrypoint. App bindings supply localized text, typography, theme facts and
typed rendering leaves. Artifact loading, authenticated publication, fragment
secret custody, audit reads and revision restoration stay with their existing
host owners. The shared HTML frame owns geometry and loading/error presentation,
not sandbox admission: the app retains isolated-URL validation, credentialless
web framing and private native WebView/navigation policy. These are 0.3
development source contracts, not evidence of publication or live visual parity.

Notification channel authors must account for the development sender signature's
[optional-category migration](compatibility.md#notification-channel-sender-source-migration-development)
when upgrading a category-dependent sender; the plugin send service and host
Activity path have distinct category contracts.

## GitHub checks observation (development source)

The `scm-github` plugin extends its existing Automation observation owner with
pull-request checks completed, failed and passed Events. Setup binds an exact
repository, pull-request number, chosen head SHA and `all`/`required` selection.
The current GraphQL rollup uses GitHub's `isRequired(pullRequestNumber:)` evidence
for both check runs and commit statuses; it walks every page before deciding.
See GitHub's [Checks](https://docs.github.com/en/graphql/reference/checks) and
[Commits](https://docs.github.com/en/graphql/reference/commits) contracts.
No checks is explicit, not success. Completion may include failed or neutral
checks; passed requires every selected check to pass. A moved head supersedes
the observation instead of accepting green checks for another commit.

Acquisition uses the plugin's existing credential-bound API client, cycle-local
request coalescer and checkpointed-pull observer. Its current snapshot is stored
in the existing Automation checkpoint Collection; this is state recovery, not
a claim of complete check-event history. The first observation establishes a
baseline without retroactive trigger admission. The declared history-gap reset
Action reports no history gap for this state source.

The plugin's `wait/pull-request-checks-v1` Action accepts that admitted source's
opaque checkpoint row id, `checks_complete`/`checks_passed`, and an optional
observation deadline. It reads, subscribes to Collection invalidation, re-reads
and parks without provider requests or recurring reads. Cancellation/deadline
ends only the observation. It rechecks current source authority before matching.
The development-source generic `wait` connects this leaf through its admitted
Action declaration. A `plugin_source` target carries the existing checkpoint
id; `{kind:'plugin', actionLocalId:'wait/pull-request-checks-v1',
condition:'checks_passed'}` selects its declared predicate. The host uses the
existing contributed-Action invoker and exact Action grant admission, not a
GitHub-specific dispatcher or conventional-id discovery. The leaf admits CLI,
MCP, Agent and plugin surfaces. Publication and loaded-runtime validation are
not established by source tests; passive plugin watching remains unsupported.

## Linked Session Work presentation (0.3 development)

The mounted UI host's `readSession`/`watchSession` contract includes a required
closed `workStatus: { bucket, tone, word }` projection beside the closed Session
awareness facts and pending permissions. The canonical
[`pluginSurfaceSessionState.ts`](../apps/ui/sources/components/plugins/surfaces/pluginSurfaceSessionState.ts)
producer reuses `sessionWorkStatusFactsFromStatus` and `resolveWorkStatusTone`.
Those owners preserve report-aware settlement and offline priority; a plugin
does not classify host Session facts independently. Existing watches digest the
complete snapshot, so reports-only Work changes invalidate the same subscription.

The shared Plugin UI Work presentation owns the status treatment, including
`HAPPIER_WORK_STATUS_SEMANTIC_TONE` for status labels and badges. Plugins may
retain domain story copy while consuming the host bucket and tone. This is a
development source-contract extension, not a released API or a persisted-data
migration. See [linked Session authoring](../apps/docs/content/docs/plugins/ui/index.mdx#linked-session-state-and-permission-answers).

## Generated ownership

The canonical Workflow schema types both authored input and parsed output as
`WorkflowDefinitionV1`, including inline Workflow and Session trigger inputs
and triggers at Session birth. The Action DTO generator derives that contract
directly; its neutral SDK support projection closes recursive block types in
their input or output context, preserving the canonical JSON projection.
The external-author fixture in
`packages/plugin-sdk/fixtures/authoring-inference/workflowTriggers.ts` checks
valid definitions and rejects unknown block kinds. This changes development
source typing without changing the trigger runtime validator.

The CLI publisher [`generateBundledPluginEntries.ts`](../apps/cli/scripts/build-owned/generateBundledPluginEntries.ts) owns bundled semantic/catalog/daemon projections. The UI publisher [`generateBundledPluginUiArtifacts.mjs`](../apps/ui/scripts/generateBundledPluginUiArtifacts.mjs) owns app-preseed UI byte inventories. They are different products, not competing publishers. Change their inputs or producer, never an emitted projection; do not add handwritten Agent/Provider lists beside generated facts.

Bundled prompt-library adapter descriptors are projected as data. The Claude
predecessor message-metadata bridge binds the Protocol-owned writer to defaults
projected from the plugin's existing settings contribution. These host projections
do not import executable plugin packages; excluding a failed optional plugin
omits its descriptors and compatibility binding in the same publication.

Public author toolchain facts have one strict carrier, [`PublicToolchainCompatibilityV1`](../packages/protocol/src/plugins/publicToolchainCompatibilityV1.ts). Authoring/scaffold consumers use its package and runtime facts rather than inventing a second compatibility table. Feature validation uses current source, ordinary package checks and the loaded development runtime. Packaging, registry publication and exact release-byte checks remain release-owned.

In 0.3 development, daemon preparation evaluates a code-defined plugin once and
passes that canonical manifest to the managed UI compiler through a temporary
manifest input. The author root needs no emitted `plugin.json`; artifact paths
still resolve against that root. Cold-manifest builds keep their existing input.
Installed catalog and runtime discovery consume the same validated manifest
projection committed with each accepted development candidate, rather than
parsing or re-evaluating its source entrypoint. Until a new candidate is accepted,
discovery retains the accepted declarations; a missing projection fails closed.
JSON-manifest and managed-artifact discovery retain the canonical JSON reader.
The change service logs failures locally before projecting their redacted public
diagnostics, retaining filesystem paths while removing credentials. Managed
dependency preparation may reclaim an empty workspace file or one whose first
line identifies Happier's transient configuration; author-owned configurations
remain protected.

Prepublication dependency preparation uses a content-addressed file override
for the complete SDK package closure. Repeated preparations reuse its pnpm
virtual-store identity; the transient workspace config selects pnpm's native
immediate orphan pruning when the closure changes. Both temporary package roots
and the workspace config are released after preparation. Published registry
resolution keeps its existing policy.

The shared authoring source observer excludes that marker-owned configuration
and remembers the last attempted input signatures separately from the adopted
baseline. A retained or failed candidate therefore waits for a real input edit
or an explicit reload, while its unadopted dependency changes remain part of the
next candidate. Preparation output events cannot replay an unchanged candidate.

## Related

[Runtime core](runtime-core.md), [Agent catalog](agents-catalog.md), [Providers](providers.md), [Actions](actions.md), [feature gating](feature-gating.md), [encryption](encryption.md), [binary runtime](binary-runtime.md), [Collection presentation](collection-presentation.md), [surface states](surface-states.md).
