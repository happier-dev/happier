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

Provider data must never mutate the daemon's global `process.env`. Agent adapters materialize provider settings into the existing scoped child-spawn environment/configuration choke point.

Custom-provider forms do not support arbitrary query-parameter credentials or inline bearer tokens. Rich cloud authentication such as AWS Bedrock signing, Google Vertex credentials, Azure Entra, and command-produced tokens requires explicit typed transports and is outside the V1 custom-provider contract.

Endpoint validation rejects credentials in URLs, unsafe metadata destinations, ambiguous encodings, unsafe redirects, and oversized responses. Redirects are revalidated hop by hop, and credentials are not forwarded across an origin change. DNS is resolved on the daemon for probes, but the spawned Agent may resolve independently; endpoint-bound machine grants remain the authorization boundary for local/private endpoints.

## Account scope and machine grants

Public provider connections can be enabled account-wide. Loopback and private-network endpoints are machine-scoped by default because `localhost` and RFC1918 addresses identify different services on different machines.

Locality is derived by the endpoint-safety owner, not selected by the user. A machine grant binds:

- `providerConnectionId`;
- `machineId`;
- a normalized endpoint fingerprint;
- grant metadata/revision.

Changing a local endpoint invalidates the previous grant. The daemon must refuse before secret resolution with an actionable error when the grant is absent or stale. A connection definition may sync across devices; authorization to use a local endpoint does not silently transfer to another machine.

Health, detected processes, discovered model catalogs, and model load state are machine-local runtime observations. They are not synced as account truth.

## Local discovery and process ownership

Local discovery extends the daemon's canonical local-services inventory. A provider contribution may supply a bounded declarative detector using executable basenames and argv tokens. Plugins do not receive raw process inventories, arbitrary callbacks, or regex execution over every process.

A process match creates only a **candidate**. Availability requires a provider-owned GET probe, such as Ollama `/api/tags` or LM Studio `/v1/models`/native model endpoints. Generic `HEAD /` success is not evidence that the expected provider is present.

Runtime observations are scoped to the machine and exact provider connection, and are additionally bound to endpoint-template/catalog identity plus the relevant authorization fingerprints. Model-load state binds to the exact `catalogObservationId`. A PID-bearing inventory id is provenance only, so a process restart cannot become connection identity or authorize stale catalog state.

Happier distinguishes:

- **adopted processes**, started by the user or another app, which Happier may observe but never stop or restart;
- **owned processes**, started through Happier's managed-local-service path, which may be supervised according to that subsystem's lifecycle contract.

Installed-but-stopped detection and managed start are separate capabilities. Managed start additionally requires the `localServices.managed` feature; discovery alone never grants process ownership.

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

## Session lifecycle

At launch, Happier persists the structured model selection plus exact non-secret resolution metadata: connection revision, chosen protocol, `compatibilityFingerprint`, `bindingSecurityFingerprint`, and the materialization kind. It does not persist a transient compatibility status, a derived materialization fingerprint, or credentials in session metadata.

Agent plugins own model-switch policy. A same-session switch may be permitted only when the adapter can apply the new provider/model safely. Otherwise the UI offers restart/fork semantics. Resume and fork re-resolve the exact stored connection and refuse actionably when it was deleted, disabled, changed incompatibly, or lost its required grant/secret.

Deleting a connection creates a tombstone. Existing running child processes are not retroactively rewritten, but new spawn, resume, fork, probe, or model-switch operations must not resolve the deleted connection. Secret access is revoked for future operations.

## Feature gates

Provider surfaces use the canonical feature system:

- `providers` gates first-class provider settings, registry, and resolution;
- `providers.localDiscovery` depends on `providers` and `localServices.inventory`;
- `providers.localModelManagement` depends on `providers`;
- starting or supervising a local model service also requires `localServices.managed`.

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
2. Declare stable identity, endpoint templates, wire protocols, capability facts, credential transports, and catalog sources.
3. For local providers, add only bounded declarative detection facts and a provider-specific availability probe.
4. Add explicit compatibility overrides only for verified pair-specific quirks.
5. Add a legacy-profile migration descriptor only when a deterministic built-in legacy profile exists.
6. Export the contribution through the plugin's generated contribution descriptor path; never register it by filesystem scanning or host-core branching.
7. Test schema invariants, endpoint safety, compatibility, catalog merging, connection identity, secret/grant refusal ordering, and any real external integration behind an opt-in lane.

Third-party plugins use the same `contributes.providers` family. Built-ins receive no privileged host path.

External third-party Provider authoring is experimental until a packed plugin completes the generic install, trust, projection, runtime-use, reload/update, collision, and uninstall graduation suite. This does not make bundled Providers or in-app custom Provider connections experimental.

## Validation map

Provider tests are distributed by owner:

- protocol schemas, settings, migrations, selection, compatibility, and catalog merge: `packages/protocol/src/providers/**/*.test.ts`;
- daemon resolution, probing, discovery, materialization, catalog projection, and lifecycle: `apps/cli/src/providers/**/*.test.ts`;
- provider UI/settings/picker behavior: `apps/ui/sources/providers/**/*.test.ts(x)` and provider-focused UI E2E;
- built-in facts: `packages/plugins/<providerId>/src/provider/contribution.test.ts`;
- real end-to-end flows: `packages/tests/suites/core-e2e/**` and `packages/tests/suites/ui-e2e/**`, gated with the canonical provider feature ids.

Tests mock only system boundaries. Security-sensitive refusal tests must prove that failing enablement, grant, compatibility, or endpoint checks happen before secret lookup and network/process activity. See [Testing](./testing.md).
