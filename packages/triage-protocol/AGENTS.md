# Triage protocol package instructions

`packages/plugins/triage` is the domain owner for this package's public source
ABI: versioned types, executable validator-neutral schemas, bounded JSON Schema
projections, the one caller-bound source-administration Action ABI, contribution
declarations, and conformance fixtures. Keep host runtime, provider
implementation, registries, UI, credential materialization, scanning, and
persistence outside this package.

The only public exports are the explicit root V1 barrel, `/v1`, and
`/testing/v1`; do not add default, current, latest, legacy, or compatibility
aliases. `.project/plans/2026-08-12-triage/CONTRACT.md` is the normative source
contract; this package's declarations are the sole exact field-layout artifact.

Only the browser-safe public SDK entry points allowlisted by
`packages/plugin-sdk/src/featureProtocolPackagePolicy.test.ts` may be imported.
Never import `@happier-dev/protocol`, `zod`, a host internal, a provider SDK, or
a source plugin. Apply the repository [SDK protocol-evolution doctrine](../../docs/compatibility.md#sdk-protocol-evolution)
at the owning schema, without a second parser or handwritten JSON Schema.
