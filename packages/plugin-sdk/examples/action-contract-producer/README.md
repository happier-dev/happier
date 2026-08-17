# Cross-plugin Contribution Target

This copyable plugin owns the `document-reviewers` contribution point. It
imports the versioned `triage-sources` feature protocol, which declares the
source descriptor, required `review` Action role, and required detail surface.
The paired contributor imports that same feature-owned value. Neither plugin
recreates the protocol or imports the other plugin's implementation. The target
has no contributor registry, runtime callback, or Action lookup.

It also shows the public browser and request-policy declarations: a browser
target, a browser Action bound to this plugin's canonical Action, and a
`requestInterceptors` declaration scoped to the document-review API origin.
Request interception is trusted installation-wide policy and is reviewed from
its declared origins and methods; it does not require a `network.intercept`
HostAccess declaration.
The handler returns the request unchanged; the host remains the only fetch and
policy-chain owner, and plugins cannot use this path to rewrite bodies or inject
provider authentication.

The paired contributor is `../action-contract-consumer`. The
`fixtures/external-targeted-packages/` proof, rather than this ordinary author
example, owns the specialized independently installed SDK-copy contract.

Build and pack this plugin with the normal author commands:

```sh
happier plugins author build .
happier plugins pack .
```
