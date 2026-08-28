# Triage Source Contributor (external-author held conformance fixture)

This external-author held conformance fixture exercises a contributor-side descriptor and
embedded-renderer protocol shape. It is a specialist source fixture rather than
a starter template. It binds the target's public `detail` role to its local
renderer chain and its `inspect` role to a local Action, without creating a
target-owned destination or a second renderer registry.

The paired target is `../triage-source-target`. Both examples import the same
versioned feature-protocol fixture through its public-like `/v1` subpath rather
than importing target implementation code or recreating the protocol schema.

The fixture proves the public Developer Preview source contract while SDK and
feature-protocol publication remain pending. Its standalone build and pack
commands are intentionally deferred: the normal example `tsconfig.json` cannot
resolve the unpublished `/v1` package. The aggregate source-mapped SDK fixture
is the runnable conformance verification; loaded-platform and release
availability remain separate evidence.
