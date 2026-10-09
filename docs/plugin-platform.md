# Plugin platform and SDK ownership

Bundled and installed plugins contribute through the same manifest, registration and projection contracts. The host owns installation, admission, currentness, invocation and cleanup; a plugin owns its integration's declarations and executable leaves. The SDK exposes that boundary without becoming another runtime or persistence owner.

This is the standing reference for **0.3 development source / Developer Preview authoring**. Source availability is distinct from registry publication and loaded-platform verification. Exact public exports and capability facts come from the package-owned generated API and capability reports, not a hand-maintained list in this page.

## Declaration, activation and projection

[`definePlugin`](../packages/plugin-sdk/src/definePlugin.ts) is the code-defined author path. It projects a portable manifest and compiles registration callbacks into the named `activate(api)` ABI declared in [`activation.ts`](../packages/plugin-sdk/src/activation.ts). Raw host-generated `contributes` is not an additional `definePlugin` author input.

The canonical manifest schema and normalizer remain Protocol/platform-owned. [`manifest/v2.ts`](../packages/protocol/src/plugins/manifest/v2.ts) admits runtime API version 1 and an **optional** non-wildcard `engines.happier` range. Host/runtime ABI admission and package SemVer are separate contracts; do not infer a host compatibility range from a package version or source build identity. See [protocol evolution](compatibility.md#sdk-protocol-evolution).

The host derives registration rights from the admitted manifest. [`registrationRightsHost.ts`](../apps/cli/src/plugins/runtime/api/registrationRightsHost.ts) wraps the SDK registration scope with occurrence currentness and diagnostics; a retired occurrence cannot register. The reload lifecycle owns the serving occurrence in [`runtimeSlots.ts`](../apps/cli/src/plugins/runtime/runtimeSlots.ts). A consumer does not reconstruct currentness from an id, callback or manifest snapshot.

In 0.3 development source, on-demand Agent catalog acquisition projects the
selected Agent through the runtime registry's existing activation/currentness
owner. It shares the Agent projection used during whole-registry assembly, but
does not rebuild other contribution families or re-admit their portable schemas
for each lookup. No separate catalog or cross-occurrence cache is introduced.

In 0.3 development source, roster Actions read `selection: 'agents'` through
the existing contribution-projection describe RPC. The same leased registry
and Agent projector supply `agentsById`, while UI feature fetches, assets,
translation bundles and unrelated contribution families are skipped. Omitting
the selection retains the full display catalog; its UI readers request their
display locale. The response envelope and Agent metadata remain unchanged.

In 0.3 development source, admitted targeted Actions use the existing contributor-materialization and target-occurrence checks in [`executeContributedAction.ts`](../apps/cli/src/plugins/runtime/invocation/actions/executeContributedAction.ts) before demanding activation, after activation settles (including failure), and after awaited bindings before starting the handler. A stale admitted occurrence returns its retirement result without demanding activation; retirement during activation takes precedence over activation-failed or handler-missing errors, and no handler starts.

Contribution-family membership and normalization are Protocol-owned. In development source, the CLI's [`projection/families.ts`](../apps/cli/src/plugins/projection/families.ts) asserts its descriptors against that catalog, adds current occurrence facts and validates each projected entry with the existing Protocol schema. The daemon omits an invalid entry and publishes a plugin-attributed diagnostic identifying its family and entry, while retaining healthy entries in the same projection. Agent catalog and UI registries consume that projection; a feature must not scan Actions, invent conventional ids or install a second registry to discover its contributors.

The development-only `machineProvisioners` family declares native launch and resource schemas and same-plugin daemon Action roles through its [Protocol owner](../packages/protocol/src/plugins/contributions/machineProvisioners.ts). Discovery reads descriptors without importing provisioner leaves; selected or retained contribution demand activates only the needed leaf through the existing `activate(api)` Action ABI. Roles receive raw declared launch choices or resource values, and options receive the provider-declared query value. The host retains qualified resource references, controller and occurrence identity, current-row custody and captured credentials separately. Effectful roles require that private admission; ordinary contributed Action calls cannot supply it. Retained reads may use the same row custody, while initial checks and options can pin a private captured-account lease without inventing a managed row. Native enrollment accepts buffered argv/private-stdin execution through the same ordinary enrollment recipe; live output is optional. Buffered pairing uses the existing auth request, controller approval and auth wait producers, not another installer or enrollment authority. Only the selected guest process receives any invocation-private output observer and inherited task budget; captured preflight processes do not.

In current 0.3 development source, the shared configurator consumes the options Action's explicit `inputHints.fields` and current occurrence-pinned input schema through the existing Action form owner. A schema alone does not declare rendered fields. Editable selector paths must match the executable launch paths so retained recipes can revalidate through that same options role; the UI does not guess native wrappers or merge launch fragments. Selected native prices retain every line in the canonical configuration facts' `prices` vector, including optional localized labels, exact amount, currency, unit, source and observation time. The shared receipt renders that vector without adding totals, currency conversion or guessed monthly rates. Missing native declarations remain unavailable rather than implying UI support.

The same development declaration can bind `nativeDurationInput:{path,unit}` to one ordinary numeric field in its existing options Action. Units are milliseconds or seconds; the field's schema and editor remain owned by that Action. Canonical manifest admission requires the field in every input arm with one identical numeric schema and exactly one numeric hint. This lets the shared Ends owner use that real field without guessing native names or adding a second lifetime input. The binding is not an observed expiry timestamp. Modal declares `timeoutMs` in milliseconds; loaded single-editor UI behavior remains subject to the shared configurator's integration check.

Fly's development options query accepts known inactive app/volume draft fields retained by the generic form. Its schema-owned candidate codec selects only the active fields and validates the complete result through the unchanged closed executable launch schema. Unknown draft fields remain rejected; an incomplete active branch supplies discovery choices, not an executable launch. Neither the form nor the options role rewrites the saved recipe or grants acquisition before revalidation.

Private native exec carries the containing task's `timeoutMs` unchanged; `null` means no timeout, not a leaf-selected fallback. The host supplies that budget under current retained-row custody. Modal forwards a finite budget to its native exec API and omits the native timeout for `null`.

Each declared credential purpose uses the existing qualified Connected Account owner. The launch's `credentials` array selects one Account per distinct purpose; BYOC can therefore select its cloud and Cua Accounts without a composite connection. Before durable acquisition submission, the controller captures each selection's configuration revision. The managed row retains those individual bases with the first submitted allocation; replay cannot replace them. Subsequent native admission checks each configuration rather than a rotating bearer-token revision, so changing a selected coordinator cannot redirect an old resource. An already-issued acquisition can still report its validated paid identity for cleanup after configuration withdrawal, without authorizing another native effect. Configuration bases are retained-row state, not public launch choices or receipt fields.

The development `machines.provisioners.list` Action publishes its exact controller and each current provisioner's `credentialPurposes`, qualified by the contribution and occurrence. These come from the acquire Action's declared Connected Account purposes, matching the existing save/acquire admission owner. Each purpose carries labelled exact Account choices from the qualified Connected Account form-choice owner. Listing neither opens credentials nor activates native leaves; occurrence retirement during choice loading refuses the result. Missing selection facts are unavailable, never inferred from saved credentials or general Account inventory. Later native roles revalidate their captured selections against their own declarations without disclosing private authorization scopes in this catalog. This is a source contract; mounted selection and loaded-runtime verification remain separate.

Development managed Move is admitted through the reviewed destination installation, not a network round trip through an offline retained controller. The destination still belongs to the resource custodian and must admit the current recipe and credential selections; the server preserves revision checks, retained resource identity and outstanding native-effect custody. The UI can discover the current policy parent through an available qualified controller and offers Move from admitted cloud billing while destination checks decide reachability. Other retained native operations continue through the current controller.

A provisioner may declare `bootstrapCredential:{kind:'native-token'}` when its native guest transport needs a retained resource-specific token. The existing bootstrap SavedSecret owner creates it before submission and reopens the same reference for retry; SSH credentials keep their existing default. The invocation's private `services.machineProvisioners.materializeBootstrapCredential({kind:'bytes'|'file'})` port selects only that admitted resource's credential, never a plugin-supplied Account or secret reference. Byte and protected-file leases are invocation-owned and disposable. No private token is added to a launch, receipt, resource, or Action input. This is a development source contract, not a claim of released provider availability.

Managed bootstrap requires a fresh minimum-version Settings read. The canonical SavedSecret importer owns source compare-and-swap and exact readback; its own acknowledged Settings-version advance does not retire Account identity, mode/key or controller custody. Retained resource revision and access are still admitted through the SavedSecret catalog on each private material demand.

Native tools requiring a fixed SSH-key path can use the same implicit credential through `withBootstrapCredentialFile({ relativePath }, callback)`. The protected, plugin-scoped file owner delivers the private key and derived `.pub` file under its existing generic file lock, awaits the callback's native reader, and removes only those files, preserving native claim and recovery state. A queued invocation reopens the retained credential after acquiring custody; cleanup retries use that same lock. Invocation completion joins unawaited callbacks, and only the existing validated paid-result completion path can preserve an acquisition result despite reported cleanup failure. This is temporary delivery, not another secret store. If a dead host's lock is reclaimed while an orphan native reader survives, its operation may fail; uncertainty proceeds through ordinary reconciliation/recovery rather than a new native-reader custody protocol.

Safe checks may return an optional prerequisite `repairAction` containing a qualified Action reference and JSON invocation input. The host validates that reference and input against the current Action catalog without activating or running the repair. The fact is descriptive, not installation authority: an explicit repair uses the ordinary Action front door and its current approval and execution policy. A missing system tool does not imply a managed installer exists.

Native options may disclose optional `nativeFacts` with labelled size, image and location identities. A size can include observed CPU cores, memory bytes and disk bytes; omitted dimensions and measurements remain unknown. An explicit `monthlyCapStatus: 'none'` reports a native absence of a monthly cap; `unknown` or omission never becomes a cap inferred from a monthly rate. These facts do not replace the strict raw launch selectors or become acquisition authority. The shared reviewed-configuration builder snapshots supplied native facts for later receipt presentation. Retention declarations separately expose optional `finiteOnly`: omission is unknown, and neither native expiry nor the absence of power operations supplies that fact. Policy qualification remains at the sole retention resolver.

Provisioners that return pending acquisition handles declare an optional `reconciliation` hook with a closed native-operation schema and a safe same-plugin daemon Action. The public `defineMachineProvisionerReconciliationSchemas` constructor consumes the launch schema and supplies a strict input union: the retained native handle, or the original managed-row/request correlation with its declared launch. The shared acquire/reconcile result validates pending handles and eventual bound resources. The same constructor supplies the destroy input for either a bound resource or proven-owned partial attachments identified by the retained native handle. Ordinary resource inspection remains unchanged. Reconciliation requires private retained-row custody and performs read-only lookup; it cannot repeat acquisition. Without the hook, strict acquire writes cannot emit pending, while retained generic row data remains readable for unavailable/manual recovery.

Cancellation still revokes process IO and current effect authority. Once an admitted native acquire has actually entered its handler, the host privately retains its validated settlement so the original creation can record paid identity for cleanup. This grants no bootstrap or stale start authority; ordinary Actions and read-only reconciliation keep their existing cancellation behavior.

After a confirmed native rebuild, the managed enrollment owner retains the previous Machine as `replacementEnrollment` until the current native identity proves its replacement enrollment. Ordinary registration, including unique-insert rejoin, cannot bypass that same active, unarchived row's proof requirement or substitute a valid proof from another managed row. The binding owner consumes the retained reference when exact enrollment succeeds. Manual Retire ends managed enrollment authority without deleting the native resource, ordinary Machine or retained recovery history; it does not permanently block ordinary registration.

The public machine-provisioner author surface also prepares [persistence-only launch, resource and optional native-operation readers](../packages/protocol/src/plugins/contributions/machineProvisionerStoredSchemas.ts). Preparation demands the existing portable-schema compiler; cold discovery does not load it. The shared stored projection drops unknown nested fields and then re-admits known values through the declared typed schema. These read-only hooks cannot be supplied as Action input or result schemas: acquisition, report and canonical writes retain strict admission and declared normalization.

An acquire invocation can receive the host-populated managed-row id as a native naming/correlation tag beside its raw launch value. That tag grants no authority, does not select another resource or leaf, and promises no native exactly-once behavior; the private admitted-row custody remains authoritative.

An SSH bootstrap invocation may also receive the public key derived from that row's retained bootstrap credential. A leaf can install this public key through its qualified native setup path and return the existing credential reference with observed host-key evidence. The private key never becomes launch, resource, preset or native command-argument data. Lume uses the managed-row id for its unique VM name and inspects the recorded storage before Stop/Delete. Cua local leaves share one native adapter: private stdin is uploaded into a private guest directory, executed through the exact local sandbox and deleted. Unconfirmed cleanup fails the operation; cancellation can prevent further host-admitted native effects and must not be reported as confirmed cleanup.

Hetzner and DigitalOcean development leaves use the admitted managed-row id for
native naming and recovery correlation, and inject only that row's public SSH
key. The daemon-only SDK `machine-provisioners/ssh` adapter observes the key using
the declared system tool and the existing known-host parser. The host's SSH task
compares the observed evidence and owns the Trust/Replace-host-key prompt,
known-host persistence, binary installation and ordinary enrollment. Key
observation is not trust approval. Cloud API requests use the Action's captured
Connected Account purpose through host HTTP, rather than reselecting an account
or accessing a plugin-owned secret.

Fly's development leaf declares native buffered exec/file roles through this same
family. Its native JSON stdin channel accepts UTF-8; unrepresentable byte input
is refused, while file upload preserves arbitrary bytes. Acquisition uses the
selected image, defaulting to Ubuntu, with a volume mounted at the declared guest
home. The native bootstrap carrier supplies that home and Happier state directory
to the incumbent binary installer and ordinary enrollment recipe. After enrollment,
the same admitted exec role accepts an explicit process-config request to set Fly's
boot command to the installed foreground daemon. This confirms configuration,
not daemon connectivity; a failed update can be retried on the already enrolled
Machine without another installation or pairing. Stop resets rootfs while the
volume retains home, Happier state and workspace. Fly, Hetzner and DigitalOcean retain uncertain purchases as
declared pending native correlations. The shared source reconciler invokes their
read-only reconciliation role to bind the same resource; it never buys again.
When a declared reconciliation hook supports retained-row lookup, an unknown
allocation without a native handle can be inspected using its original
managed-row/request correlation and launch. Missing or ambiguous evidence stays
unknown/manual; it is never another acquisition attempt. Pending cleanup may
confirm absence only when all exact proven-owned attachments are absent, not
merely when no eventual Machine can be found. Provider-specific lookup and
cleanup remain leaf responsibilities. These source contracts do not establish
released cloud support.

In development source, Account erasure, Saved Secret removal, credential deletion,
Account plugin-data erasure and Account plugin-intent disable consult the same
[retained-row read owner](../apps/server/sources/app/machines/managed/managedRead.ts).
Review includes archived and unavailable resources whose allocation is `may-exist`
or `bound`, with native recovery references, controller identity and observed
cost/cleanup facts rather than captured secrets. Every retained credential
purpose participates in this preflight; matching several purposes still projects
one dependency per managed row. Explicit manual responsibility
binds the reviewed intent revision and material allocation, resource, native
operation and recovery facts; observation-only updates do not invalidate it.
Unknown cleanup never establishes that a resource is absent or free. Emergency
credential deletion remains an exact authenticated local credential CAS, without
requiring provider availability or claiming a remote revoke. A changed native
identity during Account blob deletion stops final erasure after access has been
revoked; the existing independently authorized Home administrator owns retry.
The shared development Delete Action also discloses its current captured Machine
reference census on early acceptance and terminal semantic results. Known Board,
Profile, pool and committed-assignment references stay unchanged; partial coverage
is explicit and does not prohibit an explicitly reviewed native Delete. Account
plugin-data erasure settles its Data arm before removing plugin Secret bindings,
using the original captured Home and Account for both arms. A review or unknown
Data outcome preserves those bindings, and retired Accounts cannot disclose late
native review facts.
These are source-owner contracts, not evidence of a completed client approval
flow or loaded-runtime qualification.

In 0.3 development source, the daemon's existing plugin-registry invalidation
bridge advances `daemonState.contributionRegistryProjectionRevision`. The machine
store publishes that change through its existing projection-invalidation
subscription. Workspace, transfer and local-service state updates retain the
revision, so they do not trigger another full projection read. Daemon replacement,
reconnect, Account or locale changes and explicit invalidation still revalidate.
Retained Machine state without the optional revision uses the existing broader
daemon-state-version signal until the current daemon publishes its revision.
The projection build cache remains generation- and client-context-owned;
`web:domIframe` is a browser capability, not evidence of a mounted plugin iframe.

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

In 0.3 development source, native surface loading awaits the Artifact loader's
outcome. Acquisition can await persistent storage before the daemon byte RPC,
then verify and materialize those bytes; the renderer does not impose that
RPC's deadline on the whole composition. Actual loader failures retain Retry,
and retired mounts or Artifact identities cannot adopt late results. A pending
load is not evidence of a plugin crash or of an unknown Action outcome.

The install registry's materialization map supplies exact execution-origin stamps
for daemon projections. A daemon-selected plugin's release-less Account
declaration supplies server currentness for Collections, webhooks and Events,
not install-registry projection authority. The runtime's current-materialization
getter retains that declaration identity for Account operations. Without an
install materialization, Plugin UI entries remain originless and use the existing
Administration machine selection; stamped entries still require exact per-plugin
origin selection.

In 0.3 development source (not yet released), a populated release-less Collection
upgrade uses the existing portable-release preparation and promotion owners.
Availability's `collectionWriters.claim` can return exact incumbent declarations
and manifest-bound target bindings with `prepare:true`, without moving intent.
The daemon loads the declaring module through the canonical activation loader
and passes its exported `collectionMigrations` to Account Data's existing
candidate executor. Data stages against source revisions; `transitionIntentTx`
re-censuses and atomically promotes those rows with the writer. Empty Collections
still advance immediately; failed preparation retains rows and the incumbent
writer. Same-version/different-digest claims remain refused, lagging claims
cannot lower versions, and portable Account release selections still outrank
daemon claims. This adds neither a migration registry nor a second executor.

For originless Plugin UI in 0.3 development source, the shared `plugins.home`
selection initializes from a live online machine in the signed-in Account's
Home. It remembers that exact choice on this device, so bundled destinations
can appear before the person opens Plugins. Existing choices remain selected
while offline; another machine is not elected on each presence update. If no
machine can be resolved, Plugins retains its header selector and explains how
to choose a machine. This default does not change stamped execution-origin
authority or imply an Account-wide daemon catalog.

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

Development Connected Account manual modes may have no credential fields when
they select existing native setup through configuration. Cua's native setup path
is Account configuration with reconnect-on-change, not a rotating credential:
the captured configuration revision prevents it from redirecting retained
resources. BYOC's separately selected cloud and Cua references must identify the
same existing native setup; Fleet instead uses its configured gateway and a
resource-specific private token.

- Plugin leaves import public SDK entry points and their owning public feature protocol. They do not import host internals or private Protocol validators. SDK `*.public.ts` files and package `exports` maps own the exact public surface; generated reports are never hand-edited.
- Host services bind the invocation's admitted plugin, generation, scope and authority. Caller identity, selected credentials, Session ownership and machine routing cannot be supplied as renderer or Action input.
- A feature Action may accept an admitted source address for selection while deriving caller provenance from the host invocation. Triage's configured-source Actions allow authenticated host agent/MCP/CLI discovery and administration through that owner; a nested plugin call remains scoped to its own admitted source even if it claims a host origin surface.
- Actions own request/response and effects; Resources own reads and invalidation; Events carry facts. Keep their different cancellation and lifecycle semantics. [Actions](actions.md) owns invocation surfaces, placement and confirmation rules.
- The [runtime core](runtime-core.md) owns Session/turn admission and transcript/lifecycle state. [Providers](providers.md) owns model sources, connections and materialization. SDK projections do not transfer those domains to plugins.
- Trusted daemon and native plugin code is executable code. Managed services provide portable APIs, resource custody, cancellation and diagnostics; they are not a malicious-code sandbox. Real network, credential, present-user and OS permission boundaries still apply.
- Capability declarations, runtime registration and lifecycle must exist in the applicable realm. A daemon declaration does not establish browser or native support. Registry publication and a loaded invocation are separate evidence, not substitute availability authorities.

For collection-based plugin pages, the public Plugin UI `Collection` composes one headless model, item anatomy and detail renderer across presentations and containers. `Step`, controlled `Tabs` (including host-rendered strips) and `HappierDisclosure` belong to that public UI/presentation boundary, rather than feature-local replacements. See [Collection presentation](collection-presentation.md) and the [public author composition](../apps/docs/content/docs/plugins/ui/react-native.mdx).

In 0.3 development source, public `WidgetFrame` and the core widget adapter share the same frame and controlled `disclosure` contract. Collapse belongs to the current viewer; it keeps the body mounted and hidden without changing widget layout, input or Resource identity. Public `/presentation` also owns tree keyboard/focus semantics (`HappierTreeNode` and `useHappierTreeInteraction`), using explicit parent keys rather than filesystem path spelling. Filesystem trees translate their domain rows into that owner.

Measured `FrameRect` placement and `resolveFloatingFrameRect` share companion geometry with core. Callers supply available space and measured avoid rectangles; the result reports when no non-overlapping placement fits so the domain can use its dock composition. Pointer listeners, native gestures and measurements remain host adapters. These foundations do not create a viewer registry or assert that every capture/viewer shell is integrated.

Public `/presentation` exports `FloatingFrame` / `FloatingFrameProps`: one controlled neutral frame (`floating`, `expanded`, `docked`, `closed`) with a controls band and one body. It owns only geometry and shell mode: drag, velocity and release use the shared companion interaction owner, settling uses `resolveFloatingFrameRect` and asks to dock when nothing fits, arrow keys snap corners and the grip resizes with the body's aspect. `moveInput` decides whether the body or only the controls band and grip move it; the host decides that from its own control facts. The platform pointer boundary comes from the `pointer` prop or the presentation host's `companionPointer`; without one the frame moves by keyboard and menu only. It has no target, Session, network or trust props. In 0.3 development source the Session viewer is its first consumer: it frames the retained Computer or Browser body, publishes its settled rectangle to the shell's measured Voice/pet geometry and moves the reading column aside on snap. Development-only until 0.3 ships.

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

Widget Views can declare `resources` as qualified same-plugin Resource references at the existing manifest/Surface Registry owner. These references identify refresh dependencies, not permissions. The daemon projection retains each admitted Resource's actual `global`, `session` or `surface` scope; dynamic Resources have no fabricated packaged-file path. `widgets.item.refresh` admits the current instance and resolved target, then awaits each declared Resource's existing store read. The store's `refresh()` returns the settled snapshot, including a truthful error or retirement outcome; stale last-known content does not make a failed refresh successful.

Native mounts, hosted read/watch bridges and this Action share the existing contextual Resource owner under the captured canonical Account and exact machine/occurrence/context. Declared global Resources share across physical hosts; Session Resources retain the selected Session identity. Final-consumer release or Account retirement disposes the store. Canceling an Action releases its wait rather than canceling another mount's shared read. Headless/client-only execution, missing declarations/scope or unavailable surface provenance returns typed unavailable, without child capability registries or current-UI routing. Native builtin definitions have no plugin Resource declaration; they retain their native data subscriptions/Retry and this Resource Refresh Action is unavailable for them.

Home layout and setup dismissals use one Account Artifact; shared Session instances use Board records and revisions; direct Companion instances remain viewer/device-local presentation preferences. The widget instance Action family delegates mutations to those owners. Personal Companion changes do not edit Board content. Viewer bindings consume only the viewer's own existing Connected Account purpose selection; there is no per-instance viewer override, Action or local selection setting. A widget declaration without correlation to an admitted existing purpose consumer fails closed; it does not guess another consumer or change a global binding. Pinned Connected Account references are allowed on personal surfaces only.

The declaration correlates a viewer field through `connectedAccountPurposeBindings: [{ path, purpose, consumer: { pluginId, localId } }]`. The consumer must identify an explicitly declared current Resource whose purpose advertises the permitted services. The existing purpose admission/materialization owner admits that Resource consumer and uses the viewer's own qualified purpose selection, including an admitted member of a selected group. Changing that selection uses the existing Connected Account preference and lifetime, and can affect other viewer bindings for the same qualified purpose; it is not an instance-only connection edit. Personal pinned references, by contrast, remain instance bindings. The exact target supplies current Resource and service-authentication declarations; a Session pin is resolved before its full credential binding, without granting execution from the pin. Missing connection is a typed Connect requirement; missing declaration or read authority remains unavailable/denied. Shared content retains viewer intent, not the selected private ref or credentials.

`widgets.item.move` accepts `{ ref, toIndex, area? }` for current-view widget-ordinal reordering, or `{ ref, to: { surface, tabId?, area?, index } }` for owner-native insertion. Project `area` selects main or aside within the same dashboard document; it does not create another Artifact. Board view changes use its existing layout owner. Cross-surface movement admits both authorities, adds through the destination and conditionally removes through the source; refused/unknown outcomes report observed owner state rather than promising a transaction across independent stores. Add retains the caller's instance id and returns the acknowledged qualified reference.

For a widget `select` field marked `connectedAccountOptions: true`, the existing
`action.options.resolve` widget-consumer dispatch returns credential-free pin
choices from the viewing Account's active qualified profiles, filtered by that
same declared Resource purpose's permitted services. A personal pin does not
require an existing purpose selection. A declared, admitted `viewer` binding can
be saved before the author chooses a connection; evaluating it still requires
that viewer's selection, and a missing selection remains Connect. Shared pins remain refused. The marker
cannot be combined with static options, `optionsSourceId` or `inputType`; these
constraints belong to the neutral field grammar, not a widget-specific options
registry or public host service.

These are development-source contracts, not release or loaded-platform certification. WorkBoard, Project/plugin-area layouts, reusable declarative definitions and setup/edit composition consume the same identities through their respective program owners. Home includes built-in visibility and setup dismissals in its layout Artifact. WorkBoard widget intents use its existing `work-board.v1` Artifact reducer/CAS writer alongside work references and smart sections. Project/plugin areas share the [`widget-area-layout.v1` owner](../packages/protocol/src/widgets/widgetSurfaceArtifactV1.ts); changing page context does not create a new layout. Project areas use order and a Plain default.

Each Project dashboard has one layout Artifact containing both main and aside.
The omitted dashboard id retains the default identity; named documents add their
own id to the stable private Project key, qualified by Home and owning Account.
The existing Artifact header inventory supplies names and owner-only scalar
ordering, without reading inactive bodies or creating an inventory store. The
default cannot be deleted; named rename, reorder and delete operate on their
selected document and expected revision. Missing default content is a render-only
state, distinct from a persisted empty document.

The default Overview's builtin placements come from
`builtinWidgetDescriptorV1#projectOverviewDefaultPlacementsV1`, shared by the
Artifact owner and the UI projection. Reading a missing default writes nothing;
its first explicit layout or dashboard metadata edit materializes that whole
default layout through the existing Artifact writer. Present empty documents
never restore defaults.
The Project Overview adapter reads the selected document once for both areas.
On phones it merges their current heads while preserving each saved area's
order, without a persisted phone layout. Controlled frame disclosure is
viewer-local for editors and view recipients alike; README starts collapsed
and toggling it sends no layout Action.

#### Layout groups and saved fragments (unreleased 0.3)

[`widgetLayoutItemV1`](../packages/protocol/src/widgets/widgetLayoutItemV1.ts)
owns one `widget | group` union and placement reducer shared by Home and area
layouts. Persisted `items` include widget children inside groups; ids are unique
across top-level items and all children, and groups cannot nest. WorkBoards,
Session Board and direct Companion do not admit groups. The host-owned
`corePage` surface uses the same area Artifact transport, rather than a page-local
store; its consumers remain responsible for mounting their page.

Groups default to Card with hairline dividers. Their width is `half | full`;
[`resolveWidgetGroupWidthFitV1`](../packages/protocol/src/widgets/widgetPresentationV1.ts)
reports both choices and the child blocking an unavailable width. Placement
admission reuses that result. Children retain their own saved frames; the
approved rendering contract projects them as Plain inside the group. Ungroup preserves the children, and
moving out restores their saved frame; removing the last child dissolves the
group. Group removal removes its children explicitly through the same reducer.

Group bindings compose at the existing
[input resolver](../packages/protocol/src/widgets/widgetActionInputResolverV1.ts):
a following child reads group context before surface context, while a pinned
child retains its own value. Viewer intent continues through the existing
purpose-selection owner. A group conveys values, never access, and each child
still passes exact-target, input and read-authority admission.

[`widget-layout-fragment.v1`](../packages/protocol/src/widgets/widgetLayoutFragmentArtifactV1.ts)
stores reusable group options, declared inputs, provenance and each child's
definition reference or inline definition, bindings and size through the
mode-aware Account Artifact transport. Stored readers tolerate additive fields;
new writes remain strict. Capture removes physical placement ids and areas.
Instantiation allocates fresh group and child ids, and `widgets.group.add`
applies one atomic `group_add` intent. These are copies: a fragment update does
not change an existing group or introduce a live link to its saved source.
Children that reference a reusable widget definition retain that definition's
normal reference semantics. The
[Artifact kind policy](../packages/protocol/src/artifacts/artifactSharingV1.ts)
keeps fragments out of the generic document browser, people sharing and public
links; their port admits only the owning Account's library.

Area presets are host-supplied named `items`, not caller-selected authority.
The default Project Overview uses that preset contract; core pages may supply
their own matching preset. Reading missing content renders defaults without a
write. The first explicit edit persists the defaults plus the edit through the
existing CAS writer. Preset state compares current items with the host defaults.
Reset replaces the items immediately and returns the prior layout with its
acknowledged revision; Undo refuses if that revision has since changed. These
owner-level contracts do not certify the loaded controls or visual acceptance.

An attached shared dashboard binds the owner's exact Artifact, while the actor
remains the viewing Account. Current Artifact access and key readiness admit
each read or write; view access cannot edit and retirement never creates a
personal replacement. Source membership and independent Artifact grants are
separate authorities. Dashboard and WorkBoard sharing delegate private-selection
and inline Resource-literal checks to the same
[widget privacy owner](../packages/protocol/src/widgets/widgetSharedInputAdmissionV1.ts)
as Session Board. Private definition references on dashboards and WorkBoards
retain unavailable placeholders rather than granting definition access.
Generic key-holding WorkBoard edits and retained-body restores enforce that
same content policy before encryption and CAS; changing the candidate header's
kind does not bypass the current document's policy. Personal writes remain
personal, and safe shared writes retain their existing Artifact owner.
In 0.3 development source, audience admission combines actual people grants and
access with `publicAudience` from the authenticated exact Artifact read, independently
of the feature-gated public-link management list. `retained` means shared exposure;
`none` rules out only public exposure. Missing or unfamiliar values normalize to
`unknown`, never private.
Publication expiry or deletion ends that audience; an exhausted issuance limit
or disabled public-sharing feature is not proof that retained links were deleted.
An unavailable audience read stays unavailable, rather than becoming a personal
write admission. Content already proven safe for either audience needs no
privacy-specific audience lookup.
Shared widget writes consume admitted sharing facts through the canonical
configurable Action approval policy. Selective input set/reset intents merge or
remove exact paths against the writer's current bindings, preserving unrelated
concurrent choices; omitted paths retain whole-set/whole-reset behavior.

The [widget presentation owner](../packages/protocol/src/widgets/widgetPresentationV1.ts) defines semantic size names, deterministic order and surface-specific width × height footprints. Definitions, builtin descriptors and plugin widget Views declare `sizeDeclaration: { sizes, defaultSize }`; the default must belong to the nonempty, unique declared set. Protocol resolves the declaration against the surface-supported set once, in canonical size order. `widgets.catalog.list` exposes each entry's resulting `presentation.sizes` and optional `presentation.defaultSize`; a supported declared default wins, otherwise the first admitted size is used.

Home, plugin areas and WorkBoards consume those footprints through their existing layout reducers. Session Board resolves them into its existing native width and item-height owners, including Auto height; it has no second saved-height writer. Existing custom native width/height combinations keep their actual footprint and omit a semantic size when no named rectangle matches. Project aside and Companion remain linear and carry no size operand. Native layout owners retain pixel geometry and responsive reflow: narrowing to a phone changes rendered spans without rewriting saved size intent. Cross-surface moves preserve an admitted size or normalize to the destination's declared/supported default.

`widgets.item.size.set` accepts `{ ref, size }` through the existing instance Action dispatch; it replaces the undeployed width-only Action in place. `widgets.item.add` accepts the chosen `size` in the same atomic Add intent. More than one admitted grid size opens the existing setup step for selection/preview even for inputless or fully bound widgets; zero/one size or a linear surface retains the existing direct Add path when inputs are ready. Setup, Customize, frame menus and bracket-key stepping consume the same choices through the shared public [`WidgetSizePicker`](../packages/plugin-ui/src/presentation/layout/WidgetSizePicker.tsx) and canonical Actions. Resolved size and measured geometry reach native and declarative bodies through the existing presentation/RenderContext seam; they describe composition space, never data identity or execution authority. Bodies can adapt compact versus richer content, while an absent compact renderer retains the existing framed full-view fallback.

Reusable Account definitions use `widget-definition.v1` Artifacts through the existing mode-aware Artifact transports and the [definition owner](../packages/protocol/src/widgets/widgetDefinitionArtifactV1.ts). Definition Actions create, edit, duplicate, delete and copy admitted Session content into the Account library. Placements reference the Artifact and retain their own bindings; duplicating creates an independent definition. Deleting a definition retains unresolved placements for repair. `saveFromSession` copies rather than removes the Session item and makes its declared Session input configurable. An explicit shared Session Board add copies a private definition into the instance's inline definition before approval; the Session Board never receives the private Artifact pointer. Its grammar rejects private Connected Account selections in copied definitions and bindings.

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
validated data, never routing or authority. The Add surface
(`components/widgets/add/WidgetAddSurface.tsx`), Edit inputs, frames and
mutations reuse the Home/widget owners. Declarative area nodes
require a mounted plugin page and are excluded from Session Board documents
and transcript projection.

Native/declarative page ScrollAreas and the Project ItemList pass the incumbent
near-viewport admission to area cards. Offscreen executable bodies release
Resource read/watch demand while their frames retain measured room; reentry
mounts the current bound context. Route focus remains an additional admission
condition, not a substitute for viewport activity.

Area copies use the shared pointer grip, staged keyboard and Move-to chooser.
Current membership and anchors become requests to `widgets.item.move`;
its incumbent surface ports own admission, approvals and persistence. Canonical
Artifact publication refreshes both mounted ends of a transfer. An injected
Project area binds preview and execution to its existing host movement owner;
that component seam neither grants authority nor supplies a Project Source.

Hosted HTML pages do not embed host widget areas: the plugin owns the whole
iframe. They manage widgets through ordinary `widgets.*` Actions, not a hosted
widget-area API, helper or renderer. Native and declarative page composition
remain the embedding surfaces. The [Project adapter](../apps/ui/sources/sync/domains/widgets/projectWidgetAreaContext.ts)
provides stable personal Project identity independently of its optional portable
Source input. A matching-Home exact checkout supplies checkout context; it does
not stand in for a Source or grant plugin access. Source-free layouts remain
usable. In 0.3 development, the existing Source controller reads the accepted
ref's provenance with the captured viewer's same-Home Account authority and
refreshes on the incumbent Home wake. Authorized current Source metadata fills
only the portable project slot; missing, revoked or retired reads leave that
slot unavailable without replacing the exact checkout or disabling personal
layouts. Provenance revision is not an eligibility gate. The Project shell owns desktop and phone
composition of the same acknowledged document.

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

The External Sessions surface inherits caller cancellation and any caller deadline;
the host does not add a shorter auxiliary-operation cutoff. Serialized-result
budgets are optional for source and identity resolution, and required for paged
candidate/transcript reads. Explicit caller paging budgets are preserved rather
than clipped to a second host ceiling. Wire and persisted-data schemas still own
their declared limits.

SDK inventory paging retains one snapshot per live query demand. `list` returns
an opaque, serializable, single-use `nextCursor`; every successor belongs to
the same demand. `closeList(cursor)` releases that demand using any cursor it
issued, including a consumed cursor, and cancels a pending continuation.
Consumers close abandoned queries in their cleanup path. Exhaustion, caller
cancellation and source retirement also release retained pages. Opening another
query does not evict a live continuation. The runner uses the same owner through
its serializable daemon service operation; no callable continuation crosses RPC.
This is an approved unreleased 0.3 SDK source-contract cut. Authors must update
and rebuild list consumers to close pagination they stop before exhaustion.

Configured-source admission isolates malformed source data and malformed
connected-profile identifiers as typed source refusals. Valid sources, including
other sources for the same Agent, remain available; the owning plugin receives a
non-blocking `plugin_external_session_source_refused` diagnostic. Host-integrity
failures such as an unreadable Account, undeclared source kinds or duplicate
Agent-scoped source identities still make the whole configured-source service
unavailable. This is current 0.3 development-source behavior, not loaded-runtime
or released availability evidence.

This required-to-optional invocation-bound change is an unreleased 0.3 SDK
source-contract cut. External Session authors must update and rebuild callbacks
that assumed every request carried a deadline or serialized-result budget;
no synthetic deadline or byte ceiling is supplied for those older assumptions.

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
In development, the shared attempt-policy owner carries an optional `welcome.text`
for Right away or After I speak. A selected welcome Doc is read afresh through the
captured Home/Account's qualified Artifact reader; its markdown remains byte-exact,
including whitespace, and an unavailable selection refuses preparation. Without a
selected Doc, the app translation owner resolves the default in the admitted Reply
in language and names the exact bound target; deliberate global mode uses the
ordinary global default. Automatic or unsupported reply languages have no default
literal; the UI language is not a substitute. The prompt carries an After I speak
literal on the first user reply, without requesting an immediate greeting.
ElevenLabs consumes a Right away literal as its native `firstMessage`.
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
authority. In development, each native start prepares the current bound Voice
stack through the shared Account → target Profile → Project/Source → Session
reader and conversational Role formatter. Codex receives those admitted facts
through additive developer context before its unchanged V3 realtime start;
this does not replace the Agent's operational instructions or add prompt,
initial-item, model or output-voice start fields. Session Memory Off is consumed
by the existing Agent base-prompt and tool-availability owners: automatic recall
guidance and memory writes are withdrawn without disabling explicit memory reads.
Native Voice does not introduce a separate operational prompt or tool
policy. The SDK's optional
`systemAppendBlocks` input is host-private, not a public RPC override. Missing
required content or a retired target refuses native admission; a later start
can reread current content. Omitting the optional input preserves existing
plugin callers.

Standalone Local Agents admit the same reply-language and greeting preference
through `intentInput.voicePolicy`. The existing Voice launch config retains it
for recovery, and the shared Agents prompt owner consumes it on READY bootstrap,
first-user-turn seeding and replacement-runtime reseeding. READY is a warm-up,
so After I speak applies to the first user reply; a completed greeting is not
repeated when replaying retained conversation context. Recognition settings do
not supply reply instructions. Immediate Local welcome sends the same admitted
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

Development Session voice preferences use that same declared field and provider
schema. The qualified contribution and exact setting path identify one voice
override; catalog/custom/string values keep their native shape. The shared
resolver rejects unrelated settings and a preference for another contribution
instead of silently changing provider or credentials. An admitted current-attempt
voice label belongs to the host snapshot, not to a later catalog lookup or saved
preference. Unknown application remains null. Providers retain their actual
preparation/application boundary; this contract does not promise universal
mid-conversation updates or completed bound-instruction integration.

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

Protocol's output-event owner packs those semantic segments into the existing
speech-event wire envelope without discarding the remaining text. The daemon
producer and legacy client adapter share that packing policy; only the canonical
turn-output budget marks the reply incomplete.

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

Entry-history backends may declare the optional `read.historyEntries` operation
and its handler-backed capability through the existing SCM contribution. The
public SDK projects the strict Protocol request/result; registration and the
host dispatcher enforce the same operation as the `scm.history.entries` Action
and SCM RPC. Absence means unsupported, not a host branch on the backend id.
See [demanded entry history](scm-diff-summary.md#demanded-entry-history-unreleased-03)
for captured-HEAD, literal-path and unavailable-history semantics.

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

### Machine-native GitHub credentials (0.3 development)

GitHub's Connected Service declares `authentication.native: { systemTool: 'gh' }`.
This is the existing native source, not a new credential kind or account store.
An authorized consumer requests `materialize(purpose, request, { nativeService })`
through the ordinary Connected Account purpose owner. Only an unbound purpose
can use that service: an explicit account selection, including an unavailable
or invalid selection, takes precedence and never silently falls back to `gh`.
Resolution reads do not erase that intent; only explicit clear/reselection or
removal of the declared purpose contracts it. Scope or credential failure still
refuses disclosure.
The host validates the qualified service, declared scope and current invocation
before materialization and rechecks binding intent before disclosure.

The executing daemon resolves `gh` through its canonical dependency owner and
runs `gh auth token --hostname <host>` with cancellation. GitHub's API origin
maps to `github.com`; an admitted Enterprise origin retains its host. Tokens are
ephemeral HTTP authorization material, not Connected Account records or synced
configuration. They must not enter logs, events, diagnostics or plugin storage.
Unavailable authentication produces a typed failure with the remedy to sign in
with the GitHub CLI on that machine.

Action declarations can pair an account selection `path` with
`nativeServicePath`; the canonical extractor admits exactly one credential
selection. Triage's shared settings and administration Action persist only the
native service identity. Source and review metadata retain that identity rather
than inventing an account id. See [Triage source ownership](triage-sources.md).

### Connected Account refresh and quota identity (0.3 development)

Native credential resolution, Session authentication switching, daemon bootstrap
and refresh read through the qualified established credential owner and V4
transport. That owner validates the exact account reference, revision semantics
and persisted Account mode before opening content. It still decodes retained
0.2 credential payloads; that data compatibility does not authorize a current
client to select scalar V2/V3 HTTP transport. Missing or uncertain V4 capability
evidence refuses negotiated operations instead of selecting an older wire path.

The refresh coordinator treats plugin-reported access-token expiry as recoverable,
not as evidence that the user must reconnect. Scheduled refresh uses that status
even when the qualified profile has no legacy credential-kind or expiry projection,
then rotates through the existing exact-revision lease and credential CAS. Expiry
alone does not latch `needs_reauth`; an explicit reconnect-required or rejected
result still does. Provider or transport outcomes that remain uncertain stay retryable. CLI `--auth cs:`
selection resolves account identity and leaves credential admission to this owner.

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

The canonical Connected Account attempt owner retains the admitted authentication
runtime, mode and configuration basis through cleanup. Manual submission, OAuth
completion and device polling use the runtime and mode selected at attempt admission;
publishing a replacement afterward cannot send captured inputs to its changed callbacks.
Initial lazy activation resolves the current daemon registry when the old occurrence
proves it did not start provider work. Entered callbacks keep their registry lease
until completion even if local cancellation closes the attempt. Exact configuration and
credential checks still protect settlement, and uncertain provider effects retain
their existing reconciliation. UI, CLI and Agent Actions use this same daemon owner.
Manual attempts have no fixed host count or lifetime ceiling. Waiting OAuth and
device challenges follow the provider's expiry; entered effects and prepared
settlements retain their exact recovery custody rather than expiring on a host timer.
Local cancellation is authoritative immediately; the best-effort provider cancellation
callback follows the invocation lifetime without a separate host timeout.
Terminal replies remain readable for lost-reply recovery until the consumer closes
the attempt through the existing cancellation command. The setup controller closes
that demand after connection, when retry replaces a finished form, or when the user
discards the flow. A terminal retry refreshes the daemon's description before
starting the next attempt, so a changed form is presented rather than reused.
The interactive CLI journey acknowledges its consumed terminal
reply too, while lost replies and uncertain effects retain their resumable custody.
Closure releases terminal retention without a host count or timer.

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
native login and API-key ACP launches are unchanged. The canonical detached
app-server Run host provides bounded native-home reads and a Run-scoped refresh
callback through its materialization control channel. It shares the Session
host's refresh core and daemon authority, but carries no Session identity.
The daemon settles refresh only after updating the exact native home; Codex
decodes the access material through its existing host-bounded file reader.
Callback-less app-server hosts still cannot open a Connected Account thread.
Claude's native OAuth file contains access material, expiry, scopes and any
existing nonsecret subscription type/rate-limit tier, never a refresh token.
Those plan facts survive historical credential normalization and host-managed
refresh; native and Connected Account quota probes use one Claude plan resolver.
These are 0.3 development contracts, not a claim about older shipped
native materializations or already-running sessions.

Connected Account quota results may carry a provider-declared `planLabel`.
The host snapshots the trusted SDK result and preserves it in the canonical
usage projection; external wire and persistence readers retain their schemas. An absent
plan is not inferred from limit sizes. Connected Services identity presentation
uses an assigned name, provider name or email, then a service-account label;
provider/internal ids are never automatic primary names. Historical id-valued
display names stay readable as a short secondary disambiguator when no human
fact exists. Codex's credential owner projects available name/email claims
from its existing id token during connect, status and refresh.

Connected Account quota limits carry optional `providerLimitId` separately from
their window `id`. The host result snapshot preserves that
family, and the quota projector uses it for pool allowance selection. Omitting
it retains id-based selection. Pre-turn pool probes use the same credential
eligibility predicate as candidate selection. Known-unusable members need no
quota probe and count as resolved; missing targets and failed probes still make
the group observation incomplete.

The daemon quota coordinator has no implicit operation deadline.
`HAPPIER_CONNECTED_SERVICES_QUOTAS_FETCH_TIMEOUT_MS` opts into an explicit deadline;
operations already carrying a caller signal follow that containing operation's cancellation.
The daemon quota coordinator retains the latest in-band observation through retryable transport
failures using the shared scheduler's backoff; it has no implicit pending-age or
retry-count cutoff. `HAPPIER_CONNECTED_SERVICES_QUOTA_IN_BAND_MAX_CONSECUTIVE_FAILURES`
opts into a retry budget. Non-retryable failures retain same-material suppression.
Same-account fanout indexes exact identity by the session binding lifecycle and
group generation, not a guessed age. Production fanout re-probes live identity;
an exact account mismatch always vetoes an indexed candidate.
The persisted-identity fallback uses the canonical session and qualified credential
readers without a shorter local deadline; unavailable or unfenced proof stays suppressed.

Targeted feature composition uses public `defineContributionProtocol` / `defineContributionPoint` values and typed handles. A feature protocol keeps explicit versioned exports, validator-neutral schemas and source-neutral DTOs; it excludes host runtime, provider clients, credentials and persistence. The SDK's [`featureProtocolPackagePolicy.test.ts`](../packages/plugin-sdk/src/featureProtocolPackagePolicy.test.ts) owns the allowed dependency classification. [Triage sources](triage-sources.md) is one current consumer.

### Project-native definitions (0.3 development source)

`definePlugin({ projectNativeAdapters: { localId: { declaration, runtime } } })`
projects one manifest family with contained file names and the implemented
`detect`, `resolveCommand`, `produceEnvironment` and/or `nativeServiceLifecycle`
roles. The ordinary `activate(api)` registration must match those declared
roles. Saved native commands and environment selections retain the qualified
plugin/local contribution reference; an installed occurrence is resolved at use,
not persisted into the project file.

Passive detection receives readonly contained file contents and produces strict
definition references, coverage and diagnostics. It receives no execution,
credential or mutation service. Command and environment callbacks receive the
existing admitted `PluginInvocationContext` for managed-tool/native IO and
produce managed-tool references, arguments, cwd and review inputs. Environment
production returns the complete environment, not a patch; the host retains
tool resolution, secret materialization, effect review, final authorization and
process custody. Native service lifecycle uses the existing managed-services
contract rather than another supervisor.

A resolved native command can return `nativeInstance` using the existing
managed-services `{adapter, nativeResourceId}` shape. The selected adapter must
declare and register `nativeServiceLifecycle`, and the identity must match that
selected contribution. Only service usage accepts the witness; finite script
or setup resolution refuses it. The service owner captures the exact lifecycle
from that same lease and passes the instance to existing native supervision.
This witness identifies the resource; it is not a stopped/readiness fact and
does not turn launcher exit into native resource settlement.

In the development SDK, `ManagedServices.supervise` accepts an owned spawn with
`endpoint: { kind: 'none' }`. Its snapshot can be `running` with no URL: the host
does not allocate a port, invent HTTP health or publish a preview address.
Declared command health remains available; without health or reported native
readiness, `waitUntilHealthy` returns typed unavailable. HTTP requests require
an observed, validated endpoint. Existing HTTP spawn and attach modes retain
their endpoint and health contracts.

The native mode names a qualified adapter and exact `nativeResourceId`, alongside
the starter launch. Inspection reports native phase, readiness and an optional
loopback endpoint independently of the starter's exit. Native lifecycle is
daemon-owned; the Session runner custody bridge refuses native supervision with
typed unavailable instead of encoding an unsupported transport arm. Unsupported
Stop, accepted-only Stop without definitive inspection, and unknown or incomplete
termination retain custody. The public handle reports these failures through
typed errors rather than returning `stopped`: unsupported native Stop reports
`plugin_managed_service_unavailable`, while accepted-only or incomplete Stop
without a definitive stopped observation reports
`plugin_managed_server_termination_incomplete`. Local Services controls preserve
that distinction in their result and audit `reasonCode`; see
[runtime custody](runtime-core.md#managed-service-custody-03-development).

Host consumers call the selected lease's `resolveCommand(request, options?)`
and `produceEnvironment(request, options?)`, not the author callbacks directly.
The incumbent invocation owner binds the exact occurrence, source custody,
manifest HostAccess, admitted Project workspace and invocation lifetime, then
settles that lifetime after the awaited result. Only passive detection remains
on the lease's runtime view. The incumbent managed-service admission captures
`captureNativeServiceLifecycle(instance)` while that occurrence is current.
Inspection remains currentness-checked; Stop retains only that exact adapter
and native resource after retirement so the existing supervisor can settle it.
Retirement cannot admit a new service or transfer the captured Stop capability
to another native instance.

The existing lifecycle manager demand-activates the selected contribution and
checks admission/currentness after activation and awaited results. Removed or
retired occurrences refuse invocation without rewriting saved references or
falling back to a built-in adapter. `environmentApplied` identifies the exact
environment selection already applied by native command semantics, including
its configuration path; executable names are not activation evidence. These
are development-source contracts, not released availability or proof of a
completed final-launch journey.

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

Native Computer sources use the same Machine capture registry, Session selection
and control owner as the shared Browser/Computer viewer. A provisioned graphical
guest is an ordinary enrolled Machine; its provider cannot grant viewing or input,
select a display, wake the guest from a passive viewer, or supply a second viewer
transport. The source owner validates the exact window/display identity and
capture geometry before input. Source removal or current access refusal retires
the UI's selected source and control projection; opening a privacy settings page
does not grant either OS permission.

Capture and input readiness are independent current native facts. On macOS these
correspond to Screen Recording and Accessibility. A fresh `computer.targets.list`
answer supplies their observed state; unknown grants refuse the affected
operation. Whole-display selection remains explicit and the existing configurable
approval presents its consequence: other visible apps and notifications are
included. Registration, target-schema membership and native archive availability
are not evidence of a usable screen. The current pinned native contract qualifies
only the logical primary display; it does not supply arbitrary physical-monitor
identity or verified confidential field delivery. Native secure fill therefore
retains `field_verification_unsupported` until that producer is qualified. See
[binary runtime](binary-runtime.md) and [Computer Actions](actions.md) for the
development native support and admission contract.

For stored images, public `StoredImageRefV1` carries the canonical native
Session-image reference, including required file facts. References may survive
surface remounts or be handed to another plugin; Action-result delivery and
mount-local membership do not grant or restrict image access. The daemon
rechecks the current caller plugin occurrence and the selected/required
`sessions` HostAccess read scope through the same canonical Session-scope
predicate used by the Session service. The Account mode must agree with the
media representation before bytes are disclosed. The existing linked-Session
UI scope is intentionally not an image-read authority. Thumbnail ingress
accepts strict file-backed native image artifact references,
including those in Session-event and contributed Action results. The mounted
host and component preserve cancellation and reject retired disclosures. Producer
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

The optional `agent: { agentId, displayName, brand?: { pluginId } }` comes from
the existing Session presentation identity reader and Agent catalog projection.
The host reuses Account-scoped cached machine contributions and the canonical
cold catalog loader for installed Agents, with the generated
bundled Agent contribution identity as the built-in package reference. An
unidentified Session has no `agent`; an Agent with no known package has no
`brand`. Neither path selects a default Agent or borrows a backing Agent's logo.
Plugins draw `brand.pluginId` through public `BrandMark`, not a host registry.
The host brand adapter reuses canonical Agent artwork for exact generated
bundled package identities without PNG brands; declared packaged bytes retain
precedence. Public package targets never infer backing-Agent artwork.
`watchSession` also invalidates on the linked machine's contribution changes.

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
Selecting a development source enters that preparation directly. The ordinary
installation review owns approval of the evaluated candidate and its declared
access; there is no separate permission to evaluate trusted plugin code.
Pending decisions remain until an explicit decision, handoff or shutdown
retires them; settled rejoin results remain for the daemon lifetime. Candidate
cleanup is awaited through that lifecycle and reports failures without a shorter
phase timeout. Activation and retirement likewise inherit explicit containing
deadlines when supplied; absent a deadline, trusted asynchronous work is awaited.
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
