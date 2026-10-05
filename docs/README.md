# Happier Docs

This folder documents how Happier works internally, with a focus on protocol, backend architecture, deployment, and the CLI tool. Published user, operator, self-hoster, and public contributor documentation lives in `apps/docs/content/docs/**`. Start here for internal technical documentation.

## Index
- protocol.md: Wire protocol (WebSocket), payload formats, sequencing, and concurrency rules.
- pending-delivery.md: Durable pending-delivery vocabulary, ownership, compatibility, and receipt boundaries.
- agent-transition.md: Same-Session Agent transition — wire contract, divider, split cutover, attribution, feature gate, device-local native return, and compatibility. Unreleased.
- api.md: HTTP endpoints and authentication flows.
- actions.md: The Actions platform — the spec registry, host-stamped authority/placement/transport, the Q/M/H classes, approval routing, and the CLI result contract.
- encryption.md: Encryption boundaries, on-wire encoding, and session storage modes.
- feature-gating.md: Canonical feature catalog, payload, policy, and gate-consumption contracts.
- peer-mediation.md: Route decision, grants, transports and observability for device↔machine flows; the enablement contract and current reachability.
- compatibility.md: Released and live `../0.2` predecessor baselines, mixed-version seams, rollout directions, and compatibility-path lifecycle.
- testing.md: Repository test lanes, placement rules, and e2e conventions.
- binary-runtime.md: Binary-safe runtime rules and bundled internal workspace packaging.
- backend-architecture.md: Internal backend structure, data flow, and key subsystems.
- search.md: Universal Search and Commands — owners, data flow, target scoping, feature vs capability roles, privacy/storage, plugin provider seam, and intentional exclusions.
- session-collaboration.md: Session access evaluation and `effectiveAccess.v=1`, direct/Team/Group grants, recipient key delivery, read state, Follow, awareness, and discussion provenance.
- teams.md: Team identity, lifecycle, capabilities, closed policy, Team-owned branding, directory paging, and invalidation.
- teams-membership-and-groups.md: Team membership lifetime, flat Groups, the contribution union, Session-history horizons, and the external-fact seam.
- teams-invitations.md: Team invitation intent, token custody, admission paths, and the one membership admission owner.
- enterprise-identity.md: Managed identity providers, the provider catalog and OAuth security binding, WorkOS/OIDC/GitHub identity, Team identity connections, and directory provisioning.
- deployment.md: How to deploy the backend and required infrastructure.
- cli-architecture.md: CLI and daemon architecture and how they interact with the server.
- [runtime-core.md](runtime-core.md): Host-owned Session/turn lifecycle, native Agent seam and shared Execution Run adapters (0.3 development).
- [plugin-platform.md](plugin-platform.md): Manifest, activation, currentness, projection and public SDK ownership (0.3 development).
- [collection-presentation.md](collection-presentation.md): Shared Collection model, presentation engine and responsive detail ownership (0.3 development).
- [surface-states.md](surface-states.md): Container-sized state composition, retained content and recovery presentation (0.3 development).
- [triage-sources.md](triage-sources.md): Versioned Triage source ABI, feature-package boundary and caller-bound source administration (0.3 development).
- [scm-diff-summary.md](scm-diff-summary.md): Captured SCM comparisons, progressive outputs, editable machine results, personal marks, retained generators, review narration and accepted commit application (unreleased 0.3 development).
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
