# Triage Source Target (held conformance fixture)

This held conformance fixture exercises a target-side descriptor and
embedded-renderer protocol shape. It is a specialist source fixture rather
than a starter template. The public roles remain target-owned: this fixture
stops at declaration and observation, without selecting a contributor, owning
a renderer, creating a destination, or mounting UI.

The paired contributor is `../triage-source-contributor`. Both examples import
the same versioned feature-protocol fixture through its public-like `/v1`
subpath; neither package imports the other plugin or host-private schema.

The fixture is source-only while SDK publication is pending. Its standalone
build and pack commands are intentionally deferred: the normal example
`tsconfig.json` cannot resolve the unpublished `/v1` package. The aggregate
source-mapped SDK fixture is the runnable conformance verification.
