# Happier Docs

This folder documents how Happier works internally, with a focus on protocol, backend architecture, deployment, and the CLI tool. Published user, operator, self-hoster, and public contributor documentation lives in `apps/docs/content/docs/**`. Start here for internal technical documentation.

## Index
- protocol.md: Wire protocol (WebSocket), payload formats, sequencing, and concurrency rules.
- pending-delivery.md: Durable pending-delivery vocabulary, ownership, compatibility, and receipt boundaries.
- agent-transition.md: Same-Session Agent transition — wire contract, divider, split cutover, attribution, feature gate, device-local native return, and compatibility. Unreleased.
- api.md: HTTP endpoints and authentication flows.
- encryption.md: Encryption boundaries, on-wire encoding, and session storage modes.
- feature-gating.md: Canonical feature catalog, payload, policy, and gate-consumption contracts.
- peer-mediation.md: Route decision, grants, transports and observability for device↔machine flows; the enablement contract and current reachability.
- compatibility.md: Released and live `remote-dev` predecessor baselines, mixed-version seams, rollout directions, and compatibility-path lifecycle.
- testing.md: Repository test lanes, placement rules, and e2e conventions.
- binary-runtime.md: Binary-safe runtime rules and bundled internal workspace packaging.
- backend-architecture.md: Internal backend structure, data flow, and key subsystems.
- deployment.md: How to deploy the backend and required infrastructure.
- cli-architecture.md: CLI and daemon architecture and how they interact with the server.
- ios-simulator-helper.md: iOS simulator helper architecture, trust chain, and the private-framework App Store / TOS posture.
- issue-triage.md: How the GitHub issue triage workflows are wired to maintainer tooling.

### Archived architecture snapshots

The following pre-runtime-unification matrices are retained only as historical migration context. They intentionally describe removed paths and the former use of “provider” for executable Agents; do not use them as current source maps or implementation guidance. Use `agents-catalog.md` for executable Agents and `providers.md` for model Providers.

- codex-feature-matrix.md: Archived Codex implementation/migration snapshot.
- claude-feature-matrix.md: Archived Claude implementation/migration snapshot.
- opencode-feature-matrix.md: Archived OpenCode implementation/migration snapshot.
- pi-feature-matrix.md: Archived PI implementation/migration snapshot.
- acp-provider-feature-matrix.md: Archived ACP Agent catalogization snapshot (historical filename).

## Conventions
- Paths and field names reflect the current implementation in `apps/server`.
- Examples are illustrative; the canonical source is the code.
