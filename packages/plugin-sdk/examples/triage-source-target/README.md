# Triage Source Target

This advanced external-author example exercises a target-side
descriptor and embedded-renderer protocol shape against the canonical Triage
source contract (`@happier-dev/triage-protocol/v1`, protocol
`happier.triage/sources`). It is a specialist source example rather than a
starter template. The public roles remain target-owned: this package stops at
declaration and observation, without selecting a contributor, owning a
renderer, creating a destination, or mounting UI.

The paired contributor is `../triage-source-contributor`. Both examples import
the canonical versioned protocol through its public `/v1` subpath; neither
package imports the other plugin or host-private schema.

Build, typecheck, test, and pack this package through the normal managed
source-author commands; the declared `@happier-dev/triage-protocol` dependency
resolves through the running CLI's prepublication closure:

```sh
happier plugins dev typecheck .
happier plugins dev build .
happier plugins test .
happier plugins pack .
```

This proves the public Developer Preview source-contract authoring surface
while SDK and protocol publication remain pending. The aggregate
source-mapped SDK fixture stays the authoring-inference verification, and
loaded-platform and release availability remain separate evidence recorded by
the capability matrix.
