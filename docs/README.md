# Happier Docs

This folder documents how Happier works internally, with a focus on protocol, backend architecture, deployment, and the CLI tool. Published user, operator, self-hoster, and public contributor documentation lives in `apps/docs/content/docs/**`. Start here for internal technical documentation.

## Index
- protocol.md: Wire protocol (WebSocket), payload formats, sequencing, and concurrency rules.
- api.md: HTTP endpoints and authentication flows.
- encryption.md: Encryption boundaries, on-wire encoding, and session storage modes.
- feature-gating.md: Canonical feature catalog, payload, policy, and gate-consumption contracts.
- compatibility.md: Released/predecessor baselines, mixed-version seams, rollout directions, and compatibility-path lifecycle.
- pending-delivery.md: Pending queue ownership, Pending Delivery Attempt V1 vocabulary, admission, authorization, and compatibility boundaries.
- testing.md: Repository test lanes, placement rules, and e2e conventions.
- binary-runtime.md: Binary-safe runtime rules and bundled internal workspace packaging.
- backend-architecture.md: Internal backend structure, data flow, and key subsystems.
- deployment.md: How to deploy the backend and required infrastructure.
- cli-architecture.md: CLI and daemon architecture and how they interact with the server.
- codex-feature-matrix.md: Low-level Codex implementation matrix and unified-architecture migration notes.
- claude-feature-matrix.md: Low-level Claude implementation matrix and unified-architecture migration notes.
- opencode-feature-matrix.md: Low-level OpenCode implementation matrix and unified-architecture migration notes.
- pi-feature-matrix.md: Low-level PI implementation matrix and unified-architecture migration notes.
- acp-provider-feature-matrix.md: Low-level ACP-provider matrix and catalog migration notes.
- issue-triage.md: How the GitHub issue triage workflows are wired to maintainer tooling.

## Conventions
- Paths and field names reflect the current implementation in `apps/server`.
- Examples are illustrative; the canonical source is the code.
