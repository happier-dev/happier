# Channels protocol package instructions

Channels core is the domain owner for this package's public business protocol:
versioned types, executable schemas, bounded JSON Schema projections,
contribution declarations, and conformance fixtures. Keep host runtime,
provider implementation, registry, UI, credential materialization, polling, and
persistence outside this package.

The only public exports are the explicit root V1 barrel, `/v1`, and
`/testing/v1`; do not add default, current, latest, legacy, or compatibility
aliases. Apply the repository [SDK protocol-evolution doctrine](../../docs/compatibility.md#sdk-protocol-evolution)
at the owning schema, without a second parser or handwritten JSON Schema. That
doctrine is normative; this package guidance does not reproduce it.
