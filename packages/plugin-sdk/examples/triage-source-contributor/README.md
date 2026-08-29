# Triage Source Contributor

This advanced external-author example exercises a contributor-side
descriptor and embedded-renderer protocol shape against the canonical Triage
source contract (`@happier-dev/triage-protocol/v1`, protocol
`happier.triage/sources`). It is a specialist source example rather than a
starter template. It binds the target's public `detail` role to its local
renderer chain and the required `listInstances`, `scan` and `get` roles to
local Actions, without creating a target-owned destination or a second
renderer registry.

The paired target is `../triage-source-target`. Both examples import the
canonical versioned protocol through its public `/v1` subpath rather than
importing target implementation code or recreating the protocol schema.

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
