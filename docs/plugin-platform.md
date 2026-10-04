# Plugin platform and SDK ownership

Bundled and installed plugins contribute through the same manifest, registration and projection contracts. The host owns installation, admission, currentness, invocation and cleanup; a plugin owns its integration's declarations and executable leaves. The SDK exposes that boundary without becoming another runtime or persistence owner.

This is the standing reference for **0.3 development source / Developer Preview authoring**. Source availability is distinct from registry publication and loaded-platform verification. Exact public exports and capability facts come from the package-owned generated API and capability reports, not a hand-maintained list in this page.

## Declaration, activation and projection

[`definePlugin`](../packages/plugin-sdk/src/definePlugin.ts) is the code-defined author path. It projects a portable manifest and compiles registration callbacks into the named `activate(api)` ABI declared in [`activation.ts`](../packages/plugin-sdk/src/activation.ts). Raw host-generated `contributes` is not an additional `definePlugin` author input.

The canonical manifest schema and normalizer remain Protocol/platform-owned. [`manifest/v2.ts`](../packages/protocol/src/plugins/manifest/v2.ts) admits runtime API version 1 and an **optional** non-wildcard `engines.happier` range. Host/runtime ABI admission and package SemVer are separate contracts; do not infer a host compatibility range from a package version or source build identity. See [protocol evolution](compatibility.md#sdk-protocol-evolution).

The host derives registration rights from the admitted manifest. [`registrationRightsHost.ts`](../apps/cli/src/plugins/runtime/api/registrationRightsHost.ts) wraps the SDK registration scope with occurrence currentness and diagnostics; a retired occurrence cannot register. The reload lifecycle owns the serving occurrence in [`runtimeSlots.ts`](../apps/cli/src/plugins/runtime/runtimeSlots.ts). A consumer does not reconstruct currentness from an id, callback or manifest snapshot.

Contribution-family membership and normalization are Protocol-owned. The CLI's [`projection/families.ts`](../apps/cli/src/plugins/projection/families.ts) asserts its descriptors against that catalog and adds current occurrence facts. Agent catalog and UI registries consume that projection; a feature must not scan Actions, invent conventional ids or install a second registry to discover its contributors.

The declarative `workflows` family uses the canonical Workflow definition schema. Bundled and installed contributions reach `workflow.definition.list` through the existing plugin catalog projection; the library, Work tab picker and composer consume that same read. Plugin workflows are read-only and can be duplicated into the user's library through the existing create path. A start names the qualified `plugin:<pluginId>/<localId>` reference and the observed plugin version; the Workflow admission owner resolves and freezes the definition in the accepted Run snapshot.

The CLI reads the current serving occurrence from its contribution registry. The UI's Account Workflow Action owner reads the serving machine through the existing Account-scoped daemon projection cache and shares the same descriptor projection and reference resolver. A failed or retained projection is not a current plugin source; saved Account workflows remain readable without a serving machine. Closed Work menus do not subscribe to or load the detailed Workflow library.

## Public seam and authority

- Plugin leaves import public SDK entry points and their owning public feature protocol. They do not import host internals or private Protocol validators. SDK `*.public.ts` files and package `exports` maps own the exact public surface; generated reports are never hand-edited.
- Host services bind the invocation's admitted plugin, generation, scope and authority. Caller identity, selected credentials, Session ownership and machine routing cannot be supplied as renderer or Action input.
- Actions own request/response and effects; Resources own reads and invalidation; Events carry facts. Keep their different cancellation and lifecycle semantics. [Actions](actions.md) owns invocation surfaces, placement and confirmation rules.
- The [runtime core](runtime-core.md) owns Session/turn admission and transcript/lifecycle state. [Providers](providers.md) owns model sources, connections and materialization. SDK projections do not transfer those domains to plugins.
- Trusted daemon and native plugin code is executable code. Managed services provide portable APIs, resource custody, cancellation and diagnostics; they are not a malicious-code sandbox. Real network, credential, present-user and OS permission boundaries still apply.
- Capability declarations, runtime registration and lifecycle must exist in the applicable realm. A daemon declaration does not establish browser or native support. Registry publication and a loaded invocation are separate evidence, not substitute availability authorities.

### Standalone Voice attempt policy (0.3 development)

The UI host composes the optional realtime `prepare.attemptPolicy` through the
Agents-owned Voice prompt composer. It includes guidance for the attempt's
admitted client tools, reply language, greeting preference, and Voice prompt-stack
blocks. The host retains that immutable policy through reconnect and releases it
with the attempt; it is not safe metadata. OpenAI and xAI translate it into native
session instructions alongside custom instructions captured for that attempt;
unrelated native configuration retains its existing preparation transitions. ElevenLabs maps
it to the SDK prompt and language overrides. OpenAI and xAI request an immediate
welcome only after the initial connection's session update, not on reconnect.
ElevenLabs' [literal first-message setting](https://elevenlabs.io/docs/eleven-agents/libraries/react) is separate from generated-turn prompt
policy. The current prompt/language overrides do not control a reused Agent's
literal first message, so they establish neither immediate greeting nor startup
speech suppression for disabled/on-first-turn greeting modes. That native
first-message/override/provisioning decision remains unresolved in this development slice.
Attached Agent realtime sessions do
not receive this standalone policy: their native Agent prompt scope remains the
authority. Omitting the optional input preserves existing plugin callers.

OpenAI Manual preparation marks the exact admitted session as requiring input
commit. The existing host turn-control owner submits that input and then the
provider-encoded response request on the same still-owned connection. Send is
separate from End Voice; automatic turn detection does not expose Send. Ending
the attempt during submission prevents its later response request. This same
turn-control entry point is available to push-to-talk consumers; it does not
create another capture or session owner.

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

### Batch speech output (0.3 development)

Protocol's `voice/speechText.ts` owns semantic sentence and clause boundaries for
UI chunking, Kokoro synthesis, daemon synthesis and streamed Voice output. Token
punctuation in filenames, domains, URLs and times is not a sentence boundary.
The first useful streamed sentence can publish before the steady-state event
batch target; subsequent output remains coalesced under the existing event budget.

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

The Codex and Claude token-exchange owners classify HTTP 429 and unsuccessful
server responses as `outcomeUnknown`, preserving the host's retryable health
path. Authentication rejection still requires reconnecting. Codex stages a
replacement access token only when the response contains a fresh `access_token`
or `id_token`; retained identity and refresh metadata cannot establish a fresh
access token.

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

## Generated ownership

The Action DTO generator preserves the canonical `WorkflowDefinitionV1` in
inline Workflow and Session trigger add/update inputs. Its neutral SDK support
projection closes the recursive block types; the validator's erased Zod input
does not become an author-facing `unknown`. The external-author fixture in
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

## Related

[Runtime core](runtime-core.md), [Agent catalog](agents-catalog.md), [Providers](providers.md), [Actions](actions.md), [feature gating](feature-gating.md), [encryption](encryption.md), [binary runtime](binary-runtime.md), [Collection presentation](collection-presentation.md), [surface states](surface-states.md).
