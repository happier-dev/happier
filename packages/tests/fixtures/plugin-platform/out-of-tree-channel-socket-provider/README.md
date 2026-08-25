# External-style Channel socket provider fixture

This fixture is intentionally kept under `packages/tests/fixtures` but is
authored as an out-of-tree package. Its runtime imports only the published
`@happier-dev/plugin-sdk` package and the Channels-owned
`@happier-dev/channels-protocol` package. It does not import Protocol, CLI,
server, UI, or the Channels feature implementation.

The fixture proves the public provider seam rather than a first-party provider
implementation: setup and connection-test/resolve/stop/deliver Actions, a
transient generic Action form, a packaged generic brand asset, a dynamic
status Resource, host-vended WebSocket delivery, and delivery reconciliation
are exercised by the source runtime test. Reconciliation returns the explicit
ambiguous outcome rather than replaying a delivery. Setup's pairing-code field
is transient and is never retained as provider state or sent by delivery.
Every provider Action requires the host-stamped Channels core caller, rather
than trusting Action input or a fixture-local identity.

Installing this package is one whole-package **Install & Trust** decision.
The fixture is trusted plugin code, not a sandbox: its public schemas and
host-stamped identities establish interoperability and currentness, but do not
contain the package or authorize it to invent a second host authority.

The fixture contributes exactly one `happier.channels/providers` binding. Its
`fixture/*` Action ids are deliberately provider-local rather than Channels
magic ids; the binding supplies their meaning. It derives each role-owned
result schema, surface, and danger level from the public Channels contribution
declaration. Only the credentialless socket setup input is fixture-defined.
There is no `ConversationProvider` runtime abstraction, local provider
registry, Action scan, or private Protocol import to make the example work.

The socket observer treats the Channels core's caller-scoped list/read Actions
as its only reconciliation authority on activation, periodic repair, and an
exact post-stop reread. It opens a host-vended WebSocket for each current
enabled socket snapshot, sends the core-derived shared-content demand in its
subscription, forwards valid observations to the core ingress Action, and
reports current-epoch stop/history facts through the core fact Action. The
status Resource is ordinary UI state, never reconciliation authority; the
fixture has no local registry, unqualified Resource lookup, or core/Data
producer substitute.

The managed source-development journey loads the daemon entrypoint and exercises
host trust/update/LKG/remove, live TLS WebSocket observation, and the composed
Channels lifecycle gates on the existing development stack.

`npm run test:public` is the fixture-local static/import boundary check. Feature
QA uses the repository's current source projections and managed development
lifecycle; it does not create or install local release archives. Official
publication availability is established only by the release workflow after
publication and is not a feature-completion gate.
