# Providers

Providers are model sources such as OpenRouter, DeepSeek, Z.AI, Ollama, or LM Studio. They are separate from **Agents**, the executable coding tools such as Claude Code, Codex, OpenCode, Gemini, and Pi.

This distinction is a product and architecture invariant:

- an **Agent** owns executable behavior, session lifecycle, authentication to its native CLI, and the protocols it can consume;
- a **Provider contribution** describes a model source supplied by a plugin;
- a **Provider connection** is an account-owned configuration of that source, including endpoint overrides and credential bindings;
- a **Profile** is an optional launch preset. Profiles do not own provider endpoints, provider credentials, or provider model catalogs.

See [Agents catalog](./agents-catalog.md) for executable-agent ownership.

## User experience

Users manage model sources under **Settings → Providers**. A provider connection may be a built-in plugin contribution or a custom OpenAI-/Anthropic-compatible connection.

The normal flow is:

1. Open **Settings → Providers**.
2. Enable a built-in provider or add a custom provider connection.
3. Bind an API key through Saved Secrets when the provider requires one.
4. Test the connection on the machine that will run the session.
5. Select one of the provider's models from the grouped model picker for a compatible Agent.

Provider setup is intentionally separate from session launch. Once configured, users choose a model rather than repeatedly choosing or re-entering a provider.

Local providers are machine-aware. A detected Ollama or LM Studio service appears for the machine on which it is running; its models are offered only when that target machine is authorized and available. A local/private endpoint must be enabled per machine before Happier resolves its secret or sends it network traffic.

The CLI mirrors the same ownership:

- `happier agents ...` manages executable Agents and their runtimes;
- `happier providers ...` manages model-provider connections, probing, and catalogs.

## Identity model

### Provider contributions

`ProviderContributionV1` is plugin-owned, declarative, and immutable at runtime. It contains provider facts:

- stable contribution id and display metadata;
- endpoint templates and their wire protocols;
- public, non-secret headers;
- credential requirements and permitted transports;
- static and/or probed model catalog declarations;
- compatibility capabilities and explicit overrides;
- safe local-process detection descriptors for local providers;
- optional legacy-profile migration descriptors.

The canonical schema is `packages/protocol/src/providers/contributions/v1.ts`. First-party contributions live in `packages/plugins/<providerId>/src/provider/contribution.ts` and are projected through the same plugin contribution registry used by third-party plugins. Built-in providers must not bypass this path.

### Provider connections

`ProviderConnectionV1` is user-owned account configuration. A contribution can have multiple connections—for example, personal and work OpenRouter accounts or two Azure deployments. A connection contains:

- a stable `providerConnectionId`;
- a contribution reference or a fully typed custom-provider template;
- a display name and default/named role;
- account-wide or per-machine endpoint overrides;
- a monotonic revision and timestamps.

Credentials, enablement, machine grants, visibility choices, and manual models are settings owned alongside connections, not fields smuggled into the contribution. The canonical schemas live under `packages/protocol/src/providers/connections/**` and `packages/protocol/src/providers/settings/**`.

Persisted selections, favorites, drafts, session metadata, fork/resume state, and model-switch requests must use `SessionModelSelectionV1`. A provider model is identified by the exact tuple:

```text
{ agentTargetKey, providerConnectionId, modelId }
```

Native models use the same shape with `providerConnectionId: null`. Never infer a connection from a model id, concatenate provider/model ids into a wire id, or silently fall back to a native model when a connection is stale or unavailable.

When a caller names a model id but omits the connection, the Session itself completes the tuple: an active Session from the Provider binding actually applied to its running runner, an inactive Session from its persisted canonical intent. That completion has three outcomes, not two. Absent state means native. Valid state means the connection it names. State that is **present but unreadable** means unknown, and the operation is refused with `model_selection_session_provider_state_unreadable` before any transition RPC, metadata CAS, or prompt admission — a corrupted binding or intent is never reported as an explicit native selection.

## Protocol and capability matchmaking

Providers declare the protocols their endpoints speak. Agents declare accepted protocols and a provider-binding adapter in their plugin-owned runtime. The host computes compatibility; it does not contain provider-by-agent special cases.

Protocol intersection is necessary but not sufficient. Compatibility also accounts for the minimum behaviors an Agent needs:

- streaming;
- tool-call round trips;
- stateful Responses continuation where required;
- reasoning controls.

The compatibility result is `verified`, `experimental`, or `incompatible`:

- **verified** bindings may be used normally;
- **experimental** bindings require an explicit per-Agent confirmation and remain visibly badged;
- **incompatible** bindings are not selectable.

Provider plugins may declare narrow compatibility overrides for known endpoint quirks. Generic host code must not branch on provider ids.

Codex integrations use the OpenAI Responses protocol unless a separately tested adapter is introduced. Emitted Codex `model_providers` fields are allowlisted for the verified Codex version; unsupported or newly documented fields are never emitted accidentally.

## Credentials and endpoint safety

Version 1 supports unauthenticated and API-key credentials. Raw secrets remain in Saved Secrets and are resolved by the daemon only after all non-secret checks pass. Plugins receive credential descriptors/materialization inputs, not unrestricted access to the secret store.

The spawn/probe order is security-sensitive:

1. resolve feature gates, the exact connection, and the target machine; reject tombstoned or missing definitions;
2. realize endpoint templates/overrides, resolve DNS/locality, and derive the endpoint and binding-security fingerprints;
3. verify Agent/protocol/capability compatibility and select the credential transport/materialization kind;
4. validate the exact account/machine grant or short-lived authorization ticket against the realized fingerprints;
5. resolve the Saved Secret as late as possible;
6. materialize the credential into the scoped child environment/config;
7. revalidate the resolution immediately before use;
8. atomically commit the prepared binding and spawn or probe.

The endpoint/security fingerprints must exist before an endpoint-bound grant can be validated. No path may authorize by connection id alone and derive the endpoint afterwards.

Session admission runs that whole sequence before it does any irreversible setup work. Daemon and foreground admission both reach the complete Provider decision — feature gate, Agent/target compatibility, malformed settings, a changed binding, the cold catalog rejection, and the `agent.resolvePrerequisites` hook — before the requested workspace is created, runner bootstrap material is written, or the Agent Session is opened. A prerequisite hook therefore receives the requested workspace path as a value and must not assume that directory already exists on disk.

Provider data must never mutate the daemon's global `process.env`. Agent adapters materialize provider settings into the existing scoped child-spawn environment/configuration choke point.

Custom-provider forms do not support arbitrary query-parameter credentials or inline bearer tokens. Rich cloud authentication such as AWS Bedrock signing, Google Vertex credentials, Azure Entra, and command-produced tokens requires explicit typed transports and is outside the V1 custom-provider contract.

Endpoint validation rejects credentials in URLs, unsafe metadata destinations, ambiguous encodings, unsafe redirects, and oversized responses. Redirects are revalidated hop by hop, and credentials are not forwarded across an origin change. DNS is resolved on the daemon for probes, but the spawned Agent may resolve independently; endpoint-bound machine grants remain the authorization boundary for local/private endpoints.

A catalog probe is bounded end to end, not per hop: one wall budget covers pre-dispatch resolution, request establishment and the complete response body across every redirect, and one idle budget bounds the gap between body chunks. Both apply identically to a public endpoint and to a Provider the daemon supervises — a managed probe reaches its service through that service's own supervised request handle, so a response that returns headers and never finishes its body cannot hold a Provider probe slot.

## Account scope and machine grants

Public provider connections can be enabled account-wide. Loopback and private-network endpoints are machine-scoped by default because `localhost` and RFC1918 addresses identify different services on different machines.

Locality is derived by the endpoint-safety owner, not selected by the user. A machine grant binds:

- `providerConnectionId`;
- `machineId`;
- a normalized endpoint fingerprint;
- grant metadata/revision.

Changing a local endpoint invalidates the previous grant. The daemon must refuse before secret resolution with an actionable error when the grant is absent or stale. A connection definition may sync across devices; authorization to use a local endpoint does not silently transfer to another machine.

Revoking a machine removes that machine's grants, endpoint overrides, and machine secret bindings from Provider settings. Revocation can remove the last reachable machine, so this cleanup runs in the client against encrypted Account Settings rather than through the CLI Provider settings owner. Both writers consume the same mutation-basis decision: a Provider subtree this build cannot fully parse — a future version, or a malformed record — is left byte-for-byte unchanged and the cleanup is reported pending. The recovering reader used for display must never become the basis for a rewrite, or unparsed connections, grants, overrides, bindings, defaults, and visibility state are silently replaced by normalized defaults.

Health, detected processes, discovered model catalogs, and model load state are machine-local runtime observations. They are not synced as account truth.

## Local discovery and process ownership

Local discovery extends the daemon's canonical local-services inventory. A provider contribution may supply a bounded declarative detector using executable basenames and argv tokens. Plugins do not receive raw process inventories, arbitrary callbacks, or regex execution over every process.

A process match creates only a **candidate**. Availability requires a provider-owned GET probe, such as Ollama `/api/tags` or LM Studio `/v1/models`/native model endpoints. Generic `HEAD /` success is not evidence that the expected provider is present.

Runtime observations are scoped to the machine and exact provider connection, and are additionally bound to endpoint-template/catalog identity plus the relevant authorization fingerprints. Model-load state binds to the exact `catalogObservationId`. A PID-bearing inventory id is provenance only, so a process restart cannot become connection identity or authorize stale catalog state.

Happier distinguishes:

- **adopted processes**, started by the user or another app, which Happier may observe but never stop or restart;
- **owned processes**, started through the Provider managed-runtime service, which may be supervised according to that owner’s lifecycle contract.

Installed-but-stopped detection and managed start are separate capabilities. Provider managed start is authorized by the Provider feature and connection policy; it does not depend on the Local Services UI gate or daemon inventory snapshot. Discovery alone never grants process ownership.

### Managed subscription-backed gateways

Managed subscription-backed routing is experimental and explicit. Upstream policy or enforcement can change and may make the route stop working. Happier surfaces an upstream policy or authentication rejection as an ordinary failure and does not conceal it, manufacture entitlement, or silently fall back to another credential.

This product-risk posture is not a legal-compliance determination. It does not authorize request cloaking, prompt replacement for client impersonation, identity confusion, tracking-identity disguise, or other enforcement-evasion behavior. Managed gateways remain fail closed, and their security, privacy, credential-handling, platform, and correctness gates still apply.

## Model catalogs, visibility, and stale references

The canonical model catalog merges sources in this order:

1. user-entered manual model metadata;
2. verified static plugin metadata;
3. external catalog metadata;
4. live probe observations;
5. unknown metadata, which remains unknown rather than guessed.

The merger preserves provenance. A model that disappears from a current probe leaves normal picker results but remains renderable when referenced by a favorite, draft, or historical session. Missing definitions and tombstoned connections produce explicit stale states and actionable errors; they never trigger a native fallback.

Model visibility has one owner, keyed by structured model reference:

- native models can be hidden per Agent;
- provider models can be hidden per Agent or for all Agents using that connection;
- an intentional all-hidden state remains an honest empty state with **Show hidden** and **Reset visibility** actions.

Visibility affects discovery in the picker, not the validity of an already-running session.

Large catalogs must use the app's virtualized option-list path. OpenRouter-scale catalogs must not render hundreds of model rows through a direct `.map()` of pressables.

Catalog and health refresh is demand-driven. Enabling a connection, a semantic connection-detail or model-picker read, an explicit Test/Refresh, or an eligible read of expired cached data may schedule work through the canonical Provider probe scheduler. Cache expiry makes that read schedule a refresh; it does not create a timer, background crawler, lease, or global refresh budget. The scheduler owns single-flight execution, concurrency, retry/backoff, and freshness. UI and plugin code must not add a second polling path.

A model-picker read waits for the demand it schedules only when a connection is **cold**: it has no catalog observation yet and would therefore contribute no row at all. Answering that read immediately would be a silently empty picker with nothing to follow it, because the projection response is the only completion signal the client has. A connection that already holds an observation—even an empty, stale, or failed one—renders from that observation and keeps its refresh advisory, so an unreachable endpoint never blocks a later read. Waiting does not change work ownership: the demand still goes to the one probe scheduler, which keeps its single-flight execution, admission concurrency, typed local-capacity refusal, and failure backoff. Demand the scheduler refuses for capacity is left for a later read; no caller retains a second queue for it.

## Session lifecycle

At launch, Happier persists the structured model selection plus exact non-secret resolution metadata: connection revision, chosen protocol, `compatibilityFingerprint`, `bindingSecurityFingerprint`, and the materialization kind. It does not persist a transient compatibility status, a derived materialization fingerprint, or credentials in session metadata.

Agent plugins own model-switch policy. A same-session switch may be permitted only when the adapter can apply the new provider/model safely. Otherwise the UI offers restart/fork semantics. Resume and fork re-resolve the exact stored connection and refuse actionably when it was deleted, disabled, changed incompatibly, or lost its required grant/secret.

Deleting a connection creates a tombstone. Existing running child processes are not retroactively rewritten, but new spawn, resume, fork, probe, or model-switch operations must not resolve the deleted connection. Secret access is revoked for future operations.

## Feature gates

Provider surfaces use the canonical feature system:

- `providers` gates first-class provider settings, registry, and resolution;
- `providers.localDiscovery` depends on `providers` and `localServices.inventory`;
- `providers.localModelManagement` depends on `providers`;
- `localServices.managed` gates the daemon Local Services UI product (inventory launch actions, previews, and related controls), not Provider managed-runtime start or supervision.

Dependencies are declared in `packages/protocol/src/features/catalog.ts` and applied centrally. Missing or malformed server bits fail closed before settings, secrets, network, or processes are touched. See [Feature gating](./feature-gating.md).

## Migration and retained compatibility

The migration from overloaded launch profiles is versioned and atomic through account-settings compare-and-swap updates.

- legacy DeepSeek, Z.AI, and OpenAI routing profiles migrate to provider connections;
- Anthropic, Codex, and Gemini machine-login placeholders collapse to **Default Environment**;
- Azure OpenAI remains a legacy V1 launch profile until its richer endpoint/auth model has a dedicated typed provider contract;
- Gemini API-key and Vertex profiles remain Agent-auth configurations, not generic model-provider connections;
- ambiguous user-created routing profiles remain visible and enter a guided migration flow rather than being guessed or deleted.

Migration descriptors are plugin-owned provider facts. New writes use provider connections; compatibility readers are boundary-owned and narrowly preserve the deployed legacy shapes.

## Adding a provider plugin

1. Create `packages/plugins/<providerId>/src/provider/contribution.ts` and a schema-validation test.
2. Declare stable identity, endpoint templates, wire protocols, capability facts, credential transports, and catalog sources. A wire protocol is the rendezvous key between this Provider's endpoint and an Agent's `acceptsProtocols`; both sides are contributed, so declaring a protocol Happier does not bundle is ordinary — the host matches the two declarations and never interprets the value.
3. Keep an ordinary Provider descriptor-only. For a local descriptor-only Provider, add only bounded declarative detection facts and a provider-specific availability probe. A command-output catalog fallback names its own output format the same way an HTTP catalog probe does, and the declaring plugin implements it with the same registered parser.
4. When the Provider owns a supervised local runtime, declare its single cold `managedRuntime` facet and register exactly one matching runtime with `api.providers.register(localId, runtime)`.
5. When the Provider's catalog endpoint answers in a wire format Happier does not bundle, name that format in the catalog probe's `parser` and register its implementation with `api.providers.registerCatalogParser(localId, format, parse)`. Happier bundles `openai-models`, `anthropic-models`, `ollama-tags`, and `lmstudio-native-models`; every other declared format is implemented by the declaring plugin, and a format with no reachable implementation fails the probe with `provider_contribution_unavailable` rather than being read by another Provider's parser. Set the probe's `reportsModelLoadState` when the format carries per-model load state, which is what makes model loading available — not whether the host bundles the format.
6. Register every arm the contribution declares. Activation validates the complete declared-vs-registered composite: a Provider that declares a managed runtime and a contributed catalog format must register both, and registering a managed runtime or catalog format the contribution does not declare is refused. A partial registration fails activation instead of silently publishing the half that registered.
7. Add explicit compatibility overrides only for verified pair-specific quirks.
8. Add a legacy-profile migration descriptor only when a deterministic built-in legacy profile exists.
9. Export the contribution through the plugin's generated contribution descriptor path; never register it by filesystem scanning or host-core branching.
10. Test schema invariants, registration correspondence where applicable, endpoint safety, compatibility, catalog merging, connection identity, secret/grant refusal ordering, and any real external integration behind an opt-in lane.

Third-party plugins use the same `contributes.providers` family. Built-ins receive no privileged host path, and the bundled vocabularies below name what the host already implements rather than what a plugin may contribute (the two exceptions that are still closed are listed after them):

- **wire protocols** — `anthropic`, `openai-chat`, `openai-responses`, and `ollama-native` are the protocols Happier bundles an implementation for. Any other protocol id is contributable by a Provider plugin and an Agent plugin together;
- **catalog formats** — `openai-models`, `anthropic-models`, `ollama-tags`, and `lmstudio-native-models` are the HTTP catalog formats Happier bundles, and `ollama-list-table` is the bundled command-output format. Any other format is declared and implemented by the contributing plugin;
- **credential transports** — a plugin declares an HTTP header or query parameter of any validated name in `raw`, `bearer`, or `{secret}`-template form. The five `credentialStyle` presets and three protocol presets in the in-app *custom provider* form are a person-facing authoring vocabulary for endpoints with no plugin behind them, not a plugin ceiling.

Two optional declarations still carry a bundled-only vocabulary. Both are narrow, both are recorded here so an author is never surprised by them, and both name the condition that reopens them:

- **local-readiness shortcut** — `discovery.presenceCheck.parser` accepts `exit-zero-running` or `lms-status-json`. `exit-zero-running` is the general mechanism and is available identically to every Provider plugin, while `lms-status-json` exists for one CLI whose exit code is not a readiness signal. It only refines a discovery status label (`app_running_server_off` versus `installed_not_running`); readiness itself is decided by the required, open-format `availabilityProbe`. Replace the pair with a declarative success criterion if a plugin needs a readiness signal that neither an exit code nor an availability probe can express.
- **model loading** — `modelLoad.request` accepts only `json-model-id-v1` and `modelLoad.confirmation` only `refresh-catalog-load-state`, so a local Provider whose load API takes a different request shape cannot declare model loading today. Everything around it is already open: the endpoint protocol, the catalog format, and the `reportsModelLoadState` fact that makes loading *available* are all contributable. Open the request vocabulary the same way catalog formats were opened — a plugin-registered load requester keyed by the declaring plugin's own id — when a Provider needs a load call the bundled shape cannot express.

`packages/plugins/*/src/provider/verification/*.json` is a first-party review record asserted at build time, not a runtime capability: an external Provider declares the same `compatibilityOverrides` evidence inline and is not subject to that assertion.

External third-party Provider authoring is experimental until a packed plugin completes the generic install, trust, projection, runtime-use, reload/update, collision, and uninstall graduation suite. This does not make bundled Providers or in-app custom Provider connections experimental.

## Validation map

Provider tests are distributed by owner:

- protocol schemas, settings, migrations, selection, compatibility, and catalog merge: `packages/protocol/src/providers/**/*.test.ts`;
- daemon resolution, probing, discovery, materialization, catalog projection, and lifecycle: `apps/cli/src/providers/**/*.test.ts`;
- provider UI/settings/picker behavior: `apps/ui/sources/providers/**/*.test.ts(x)` and provider-focused UI E2E;
- built-in facts: `packages/plugins/<providerId>/src/provider/contribution.test.ts`;
- real end-to-end flows: `packages/tests/suites/core-e2e/**` and `packages/tests/suites/ui-e2e/**`, gated with the canonical provider feature ids.

Tests mock only system boundaries. Security-sensitive refusal tests must prove that failing enablement, grant, compatibility, or endpoint checks happen before secret lookup and network/process activity. See [Testing](./testing.md).
