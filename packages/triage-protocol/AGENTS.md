# Triage protocol package instructions

`packages/plugins/triage` is the domain owner for this package's public source
ABI: versioned types, executable validator-neutral schemas, bounded JSON Schema
projections, the caller-bound source Action ABIs — `sources/administer-v1`, the
sole writer, and `sources/read-configured-v1`, its read half — contribution
declarations, and conformance fixtures. Keep host runtime, provider
implementation, registries, UI, credential materialization, scanning, and
persistence outside this package.

The public exports are the explicit root V1 barrel, `/v1`, `/testing/v1`,
the hosted-CI `/ci/v1` and `/ci/testing/v1`, and Releases `/releases/v1` and
`/releases/testing/v1` domain pairs; do not add default, current, latest, legacy, or compatibility
aliases. [Triage source protocol ownership](../../docs/triage-sources.md) is the
standing architecture reference; this package's declarations are the sole exact
field-layout artifact. Read an approved Triage plan/contract additionally when
executing its assigned work, not as a prerequisite for standing package rules.

CI and Releases remain protocol-only domains. Native clients, read retention,
runtime projections and UI belong to their respective implementation packages.
Reuse the incumbent diagnostics and paged-panel envelope; do not copy them into
a domain-specific failure or page owner. Each domain epoch follows the same
SDK protocol-evolution doctrine independently of package SemVer.

Only the browser-safe public SDK entry points allowlisted by
`packages/plugin-sdk/src/featureProtocolPackagePolicy.test.ts` may be imported.
Consume the shared CI and pull-request watch schemas through the SDK’s Channels
projection on `@happier-dev/plugin-sdk/protocol`. Re-export the exact shared CI
values so Triage and Channels both use the same parsers.
Never import `@happier-dev/protocol`, `zod`, a host internal, a provider SDK, or
a source plugin. Apply the repository [SDK protocol-evolution doctrine](../../docs/compatibility.md#sdk-protocol-evolution)
at the owning schema, without a second parser or handwritten JSON Schema.
