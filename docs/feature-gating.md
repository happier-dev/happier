# Feature Gating

Happier uses one canonical feature gating system. New code must use it instead of ad-hoc env checks, direct payload poking, or feature-specific inference logic.

## Canonical sources

- Feature catalog: `packages/protocol/src/features/catalog.ts`.
- Feature decision primitives: `packages/protocol/src/features/featureDecisionEngine.ts`, `packages/protocol/src/features/decision.ts`.
- Server enabled-bit helpers: `packages/protocol/src/features/serverEnabledBit.ts`.
- `/v1/features` payload schema: `packages/protocol/src/features/payload/featuresResponseSchema.ts`.

## Payload contract

- `features` is the only location for gates.
- Gates are booleans under `features.<featureId path>.enabled`.
- `capabilities` may contain configuration, details, diagnostics, or explanations, but clients must not use it as a gate.
- Treat missing or malformed server enabled bits as disabled. Call-site checks must be `readServerEnabledBit(payload, featureId) === true`, never `!== false`.

## Dependencies

- Dependencies are declared only in the protocol feature catalog.
- Enforce dependencies through `applyFeatureDependencies(...)`.
- Do not duplicate dependency logic at call sites.

### Provider feature dependencies

The first-class model-provider program uses these canonical ids:

- `providers` — Provider settings, registry projection, connection resolution, and Provider UI/CLI surfaces;
- `providers.localDiscovery` — local process/listener candidate discovery; depends on `providers` and `localServices.inventory`;
- `providers.localModelManagement` — local model load/unload management; depends on `providers`.

Starting or supervising a local Provider process is a separate operation and also requires `localServices.managed`. Discovery never implies process ownership or permission to manage an adopted process.

Provider gates are enforced before reading Provider settings, resolving Saved Secrets, probing the network, or starting processes. Missing gates and unmet dependencies fail closed; callers must not reconstruct these dependencies from capabilities or process state.

## Build policy

Global allow/deny policy lives in protocol:

- `packages/protocol/src/features/buildPolicy.ts`
- `packages/protocol/src/features/embeddedFeaturePolicy.ts`

Inputs come from:

- `HAPPIER_BUILD_FEATURES_ALLOW`
- `HAPPIER_BUILD_FEATURES_DENY`
- `HAPPIER_FEATURE_POLICY_ENV`
- `HAPPIER_EMBEDDED_POLICY_ENV`

Server assembly of `/v1/features` applies build-policy denies centrally in `apps/server/sources/app/features/catalog/resolveServerFeaturePayload.ts`. Route handlers must not re-evaluate build policy ad hoc.

## Default enablement for experimental UI toggles

For features intended to be user-opt-in via UI Experimental Features toggles:

- Server-represented gates should generally default to allow so the UI can display the toggle.
- Client/UI policy should default to disabled so users explicitly opt in.
- Prefer build-policy denies for builds where a feature must be removed or hard-disabled.
- Security/compliance-sensitive features may default fail-closed on the server; document and test that exception.

## Server rules

- `/v1/features` assembly is centralized in `resolveServerFeaturePayload.ts`.
- Route gating should use `apps/server/sources/app/features/catalog/serverFeatureGate.ts`:
  - `createServerFeatureGatePreHandler(featureId)`
  - `createServerFeatureGatedRouteApp(app, featureId)`
- Do not add per-route env-only bypasses for server-represented features.

## CLI rules

- Resolve feature decisions through `apps/cli/src/features/featureDecisionService.ts` and owned helpers.
- CLI local policy belongs in `apps/cli/src/features/featureLocalPolicy.ts`.
- For server-represented features, no server snapshot is fail-closed/unknown.

## UI rules

- Resolve feature decisions through `apps/ui/sources/sync/domains/features/featureDecisionRuntime.ts`.
- Rare direct server-bit reads must use `readServerEnabledBit(snapshot.features, featureId) === true`.
- Prefer `FeatureDecision.state` over raw booleans.
- UI design/copy for feature-gated surfaces still follows UI token, text-scaling, and translation rules in `apps/ui/AGENTS.md`.

## Feature-scoped tests

Feature-scoped tests include `.feat.<featureId>.` in the filename, for example:

```text
something.feat.connectedServices.quotas.slow.e2e.test.ts
```

Vitest excludes denied feature tests using `scripts/testing/featureTestGating.ts` with dependency closure. Use `HAPPIER_TEST_FEATURES_DENY` in addition to `HAPPIER_BUILD_FEATURES_DENY` when a feature's tests must be disabled in CI without changing embedded policy.
