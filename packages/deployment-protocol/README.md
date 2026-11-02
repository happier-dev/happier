# `@happier-dev/deployment-protocol`

The versioned contract for Happier Deployments. The CLI, server and UI use it, and
so do the deployment, backup and template plugins (`deploy-cloudflare`,
`deploy-vercel`, `deployment-neon`, `deployment-supabase`,
`deployment-templates`, `backup-destinations`).

It contains the v1 schemas and types for deployments, targets, environments,
operations, artifacts, details and stored content. It also holds the secret
contracts for machine secret grants and environment secret launch admission, and
shared test fixtures under `testing`.

The optional private Environment `template` leaf records pinned template
provenance and data/export hints without duplicating Compose or secret bindings.
Its strict metadata-CAS input is separate from ordinary Environment edits;
runtime writers remain in their existing host/server owners. This is current
development source, not a claim that the template journey is released.

The private Environment `ownServer.serviceExports` leaf declares unique export
keys, Compose service/container ports, URI schemes and public, private-network or
loopback exposure. Private exports name the exact observed network identity;
parsing does not prove native reachability or firewall enforcement. Reloads do
not invent exports. These are development-source contracts, not a claim that
cross-Machine reference resolution is released or implemented by this package.

It does not contain a runtime, controller, persistence or provider
implementation. The read controller and projection live in
`@happier-dev/deployments`.
