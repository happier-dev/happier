# Enterprise identity: managed providers, Team connections, and directory provisioning

Happier lets a Home operator and, where Home policy permits, a Team administrator configure
enterprise sign-in and managed membership **without** creating a second authentication or
authorization system. Every path in this document ends in the same place:

```text
WorkOS / OIDC / GitHub identity or directory evidence
→ the existing provider and OAuth runtime
→ an ordinary Home Account + AccountIdentity
→ native TeamMembership / TeamGroupMembership mutations
→ the ordinary resource capability evaluators
```

External systems **attest**. They never authorize a Session, credential, Machine, Group, or any
other Happier resource. A WorkOS role, an OIDC `groups` claim, a GitHub organization membership,
and an email domain are all evidence — none of them is a grant.

See also [Team lifecycle, policy, and branding](teams.md),
[Team membership, flat Groups, and Session-history horizons](teams-membership-and-groups.md),
[Team invitations and membership admission](teams-invitations.md), the HTTP surface in
[api.md](api.md), and the deployment ceiling in [deployment.md](deployment.md).

> **Status.** This is 0.3 development source. It is not in a released Happier version. The
> provider catalog, identity lifecycle, managed provider instances, Team identity connections,
> WorkOS SSO administration, managed GitHub App identity, the directory projection, and native
> directory activation are implemented and registered; Team-scoped surfaces sit behind the
> `teams` server feature bit. Remaining completion gates are listed under
> [Open completion gates](#open-completion-gates). Do not describe any of this as shipped.

## Canonical owners

| Decision or fact | Owner |
|---|---|
| Live provider resolution for OAuth, identity, eligibility, and presentation | `apps/server/sources/app/auth/providers/identityProviderCatalog.ts` |
| Built-in and deployment provider composition (one snapshot, no registry) | `apps/server/sources/app/auth/providers/providerModules.ts` |
| Synchronous `/v1/features` provider projection | `apps/server/sources/app/auth/providers/deploymentProviderFeatures.ts` |
| `AccountIdentity` row lifecycle, collision, transaction, and publication | `apps/server/sources/app/auth/providers/accountIdentityLifecycle.ts` |
| Managed provider instance persistence and revisions | `apps/server/sources/app/auth/providers/managed/identityProviderInstanceLifecycle.ts` |
| Managed provider secret custody | `apps/server/sources/app/auth/providers/managed/identityProviderSecretCipher.ts` |
| Managed OIDC outbound network policy | `apps/server/sources/app/auth/providers/managed/managedIdentityNetworkPolicy.ts` |
| Home administration of managed providers | `apps/server/sources/app/home/governance/homeManagedIdentityProviders.ts` |
| Which provider kinds a Team may use | `HomeGovernancePolicy.teamProviders` via `resolveTeamProviderKindPolicy` |
| Home/Team ↔ provider connection identity and lifecycle | `apps/server/sources/app/teams/identity/teamIdentityConnectionLifecycle.ts` |
| Team identity administration authority | `apps/server/sources/app/teams/identity/teamIdentityAdministrationAuthority.ts` |
| WorkOS platform credentials and client construction | `apps/server/sources/app/integrations/workos/workosPlatform.ts` |
| WorkOS organization, Admin Portal, and SSO connection calls | `apps/server/sources/app/integrations/workos/workosAdministrationAdapter.ts` |
| Shared Home/Team WorkOS administration flow | `apps/server/sources/app/teams/identity/teamWorkosAdministration.ts` |
| GitHub App registration and installation lifecycle | `apps/server/sources/app/integrations/github/githubManagedAppLifecycle.ts` |
| Directory source lifecycle, cursors, and claims | `apps/server/sources/app/teams/directory/directorySourceService.ts` |
| Directory projection writes and native activation | `apps/server/sources/app/teams/directory/directoryProjectionRepository.ts` |
| Directory sync worker | `apps/server/sources/app/teams/directory/runtime/worker.ts` |
| Native membership and Group contribution adapters | `apps/server/sources/app/teams/memberships/externalFacts.ts` |
| Contextual authentication entry projection | `apps/server/sources/app/auth/entry/resolveAuthEntry.ts` |
| Wire contracts | `packages/protocol/src/identity/`, `packages/protocol/src/auth/entry.ts`, `packages/protocol/src/teams/` |

Nothing else writes an `AccountIdentity` row, resolves a provider runtime, or mutates native
membership from external evidence.

## Three separate promises

The most common way to get enterprise identity wrong is to treat one integration as three
capabilities. Happier keeps them apart, and the UI labels them apart:

- **Identity** — this person proved who they are through your IdP. Produces an
  `AccountIdentity` row and an ordinary Home credential. Nothing else.
- **Directory** — Happier holds a projection of your IdP's people and Groups, and reconciles
  native membership and Group contributions from it on a schedule.
- **Repository** — a GitHub App may also grant repository access. That is the Connected
  Service owner's contract, not identity's.

One GitHub App registration can serve all three consumers, but each consumer is bound
explicitly and receives only its purpose-scoped operation. An installation being verified for
identity does not make repository access available, and today it cannot: see
[Open completion gates](#open-completion-gates).

## The provider catalog

There is one catalog and no runtime registry. `providerModules.ts` composes a **deployment
snapshot** — the built-in GitHub module plus every valid file/environment OIDC instance —
recomputed from current configuration rather than cached. Malformed, duplicate, or
reserved-id OIDC entries are excluded individually; one bad entry no longer discards the rest.
A malformed whole document disables the configured OIDC source while built-in GitHub stays
available.

`identityProviderCatalog.ts` is the live lookup for OAuth start, callback, finalization,
eligibility refresh, linked-provider presentation, and connection tests. It composes three
sources:

| Source | Where it comes from | Has a database row |
|---|---|---|
| `built_in` | the GitHub module compiled into the server | no |
| `deployment` | `AUTH_PROVIDERS_CONFIG_PATH` / `AUTH_PROVIDERS_CONFIG_JSON` | no |
| `managed` | `IdentityProviderInstance` rows | yes |

Because built-in and deployment providers deliberately have no row, there is no foreign key
from `AccountIdentity.provider` to the managed provider table. Removal performs an
in-transaction blocker check instead.

The synchronous `/v1/features` projection cannot call the asynchronous catalog, so
`deploymentProviderFeatures.ts` reads the same deployment snapshot. `/v1/features` stays
synchronous and deployment-global; it never answers a Home, Team, or invitation question.

### Provider references and the OAuth security binding

Every catalog lookup returns an opaque `ProviderReference`: normalized id, source, an opaque
`runtimeFingerprint`, and the exact `home` or `team` context it was resolved in. Callers copy
the fingerprint unchanged and compare it for equality; nobody parses it.

The fingerprint covers security-relevant configuration — for managed OIDC it includes the
effective network policy, and for a connection-bound provider it includes the exact Home or
Team connection revision. An OAuth attempt stores that reference in its `securityBinding` alongside the exact
connection id and revision and the canonical purpose, and the same binding is carried
unchanged through every pending variant. The binding's typed `admission` slot carries the exact
Team-admission reference when the initiating flow requires one and remains null for flows that do
not. Callback and finalization compare that value with the pending continuation before any
identity or membership mutation, then re-resolve and compare:

- provider gone → `auth_provider_unavailable`;
- any component differs → `auth_provider_configuration_changed`;
- neither path executes against the newly resolved provider, and neither performs a partial
  identity or admission mutation.

Presentation-only edits — `displayName`, `ui` hints — do not change the fingerprint and do not
invalidate an in-flight attempt. That distinction is the point: a security edit fences OAuth,
a cosmetic edit does not.

`securityBinding` is optional in the persisted attempt and pending schemas, because a server
process can be replaced while its own earlier attempt rows are still within their TTL.
`hasInvalidOAuthSecurityBinding` exists so a **malformed** new binding is never mistaken for a
legitimately absent one.

Current authenticated CONNECT starts use `credential_adoption_v1`: callback creates a pending
continuation, and authenticated finalization owns the identity mutation. An older in-TTL
CONNECT attempt without that marker ends at `invalid_state` and requires a restart instead of
linking at callback; this does not imply mixed 0.2/0.3 component support.

## Managed provider instances

An `IdentityProviderInstance` is the durable managed provider: immutable server-generated
lowercase id (the namespace that lands in `AccountIdentity.provider`), owner (`home` or a
`team`), closed per-kind configuration, enabled state, `revision`, `securityRevision`, and the
last successful test observation.

Three kinds exist as Home policy values — `oidc`, `workos_sso`, `github_app_identity` — but
they are not created the same way. The public managed-provider administration surface
(`identity.providers.*`) creates and edits **OIDC** instances, for a `home` or a `team` owner;
the WorkOS and GitHub App instances are created as a side effect of their own setup flows,
which own the external tenant evidence those kinds require.

Administration is authorized at two levels:

- **Home** — `manageAuthentication` on the Home governance authority. The Home owns runtime
  availability, secret custody, callback origins, network boundaries, and which provider kinds
  Teams may use at all.
- **Team** — `manageAuthentication` on the Team actor context, *plus* the Home's provider-kind
  policy allowing that kind. A Team administrator can narrow their own connection; they can
  never widen Home policy.

`authorizeTeamIdentityAdministrationInTx` layers credential-specific qualification over the
ordinary structural Team capability. A currently qualifying credential may administer a
restricted policy; an unqualified credential receives `team_authentication_required`, and an
unavailable or unreadable policy receives `team_authentication_policy_unavailable`. The explicit
Home-owner recovery context is the only structural exception. Ordinary Team administration never
falls back to inherited policy.

Removal is preflighted, not attempted-and-hoped: the preflight reports `identityCount`,
`connectionCount`, and the affected Account ids, and the removal itself re-checks blockers in
its own transaction. There is no check-then-delete race and no destructive cascade across
Accounts, personal work, or other Teams.

### Secret custody

Managed provider secrets are write-only. They are encrypted through the existing server
operational encryption with a domain-separated path —
`storage / identity_provider_instance / <id> / <kind> / secrets / v1` — decrypted only for the
selected runtime, and never returned by any read. A list response carries
`secret: { configured: boolean }` and nothing else.

Two consequences worth stating plainly for operators: these secrets are readable by the Home
(they are operational, not end-to-end encrypted), and they are derived from
`HANDY_MASTER_SECRET`. A lost or rotated master secret makes them unreadable, which surfaces
as `provider_secret_unreadable` and fails the affected provider closed.

### Non-mutating connection test

`identity.providers.test.*` and `teams.identity.connections.test.*` share one result owner,
`app/api/routes/connect/oauthExternal/identityConnectionTestResult.ts`. The OAuth callback's
`identity_connection_test` branch writes one opaque, expiring `RepeatKey` row bound to the
initiating Account and the exact `OAuthSecurityBinding`; consuming it deletes it, so a result
cannot be replayed. Nothing about the test writes an Account, identity, membership, or Group.

The callback also asks the provider leaf for sanitized evidence through
`OAuthFlowProvider.describeIdentityTest`, and
`identityConnectionTestDiagnostics.ts` translates that into the shared strict
`IdentityConnectionTestDiagnosticsV1` protocol shape:

- claim **presence** only — `subjectPresent`, `loginAvailable`, `emailAvailable`,
  `emailVerified`. The subject, login, and email values themselves are never returned.
- `groups: { state, count }`, where `count` exists only for a `complete` observation. An
  `absent` or `incomplete` observation reports `null` rather than inventing a number.
- `eligibility` from the same `evaluateOidcEligibility` owner sign-in admission uses, so the
  administrator sees exactly which configured rule denied a sign-in.
- `mappedGroups` — the native Groups this **exact** Team connection's
  `TeamExternalGroupBinding` rows would contribute to, matched through
  `selectMatchingExternalGroupIds`, the same comparison
  `prepareIdentityConnectionGroupRefresh` uses at sign-in. A provider-scope test, another
  connection's bindings, another Team's bindings, and any non-`complete` observation all map
  nothing. The shared UI keeps that distinction: a provider-scope test omits the mapping row
  entirely, and a connection whose observation was absent or incomplete reads *not evaluated*
  rather than *no mapping matched*.

Diagnostics are optional on both the persisted result and the two consume responses: a
provider that does not implement `describeIdentityTest` produces none, and a result written
before diagnostics existed still parses. Ineligibility stays diagnostic — it is reported, and
it never becomes an authentication or membership mutation.

## Contextual authentication entry

`POST /v1/auth/entry` is the one contextual projection that replaces reconstructing Home,
Team, and invitation choices from `/v1/features`. It is public, stateless, `no-store`, and
grants no authority: every executable start route resolves its method and provider again.

Three request scopes are implemented:

| Scope | Request | Ready state |
|---|---|---|
| `home` | `{ v: 1, scope: { kind: 'home' } }`, optional `purpose: 'account_service'` | `ready` with Home `authenticate` rows |
| `team` | `{ v: 1, scope: { kind: 'team', teamId } }` | `admission_required` with safe Team name/logo plus Team- and Home-origin rows |
| `invitation` | `{ v: 1, scope: { kind: 'invitation', token } }` | `admission_required` with the invitation's Team branding plus Team- and Home-origin rows |

Team and invitation scopes require the `teams` server feature bit. Every unavailable Team or
invitation — disabled feature, unknown, archived, terminal, unreadable policy, oversized
projection — collapses to the same `unavailable` / `entry_not_available` answer, so the
endpoint cannot be used to probe which Teams or tokens exist.

Team-scope projection includes a Team-origin `connect` row for each `connected` identity
connection whose provider instance currently resolves as enabled and configured. A restricted
Team policy filters both Home methods and Team connections to the exact usable choices it
names. Invitation scope uses the same exact connection and provider-descriptor projection,
while preserving the invitation's own admission context and feature gate. A restricted
invitation policy therefore exposes only its currently usable named Home methods and Team
connections; it never widens to inherit when a reference is unavailable.

The complete encoded response is bounded by the shared pre-auth metadata budget. A projection
that would exceed it returns a terminal unavailable state rather than a silently truncated
list of methods.

### Authenticated Team continuation

The route stays public, but it optionally authenticates the caller through the canonical
bearer verification and login-eligibility owner
(`apps/server/sources/app/api/utils/verifyRequestPrincipal.ts`), which the authenticating
Fastify decorator consumes as well — there is one verifier, not a public-route copy. Only an
ordinary present-user credential reaches the projection; API tokens, Account Directory
credentials, invalid credentials, and ineligible Accounts are anonymous.

With a verified Account, Team scope reads that Account's current membership through Lane 01's
`resolveTeamActorContextInTx` and its `isEffectiveTeamMembership` predicate. An effective
member of an **inherited-policy** Team receives `already_member` with the single methodless
`continue` control; everyone else — non-members, suspended memberships, disabled Accounts,
members of a different Team — receives the ordinary `admission_required` projection, so the
answer discloses nothing an anonymous caller could not already see.

A **restricted** policy continues an effective member only when the verified credential carries
server-produced evidence matching one currently usable accepted method or Team connection.
Without matching evidence it remains `admission_required`, preserving the allowed alternatives;
the request cannot supply or alter evidence.

The same credential-specific decision is used by protected Team operations after their native
membership or resource owner has established entitlement. It returns `satisfied`,
`authentication_required` with the currently accepted alternatives, or `unavailable`; a policy,
provider, connection, catalog, or evidence-currentness read failure never falls back to inherited
access. The decision is deliberately credential-specific rather than Account-global. An explicit
`account_automation` credential can therefore qualify when its own Home-issued evidence is current,
but pairing, a daemon login, an Account identity row, or the latest conversational author cannot
lend evidence to another credential.

### Admission is a separate decision

Accepted authentication answers how this credential proved identity. It does not select how a new
member enters a Team. The Team's exact `admissionMode` independently selects one of three paths:

- `invite_only` consumes an exact current invitation;
- `provisioned` consumes an exact unbound provisioned identity from a complete directory
  observation; and
- `jit` consumes the exact current provider/connection evidence approved for just-in-time entry.

Existing membership is handled separately from all three. OAuth success is evidence for the
selected path, never a generic admission grant. Fresh-Account creation, identity/email/key effects,
pending OAuth state, invitation consumption, and membership admission commit together or have no
effect; a stale mode or mismatched admission reference returns the typed restart/admission result.

## WorkOS

The Home deployment owns the WorkOS platform credentials, `WORKOS_API_KEY` and
`WORKOS_CLIENT_ID`. Home Administration · Sign-in platforms · WorkOS owns their setup;
Sign-in providers owns the company connection. A Team never stores an API key; it stores
exact WorkOS object references.
Missing both credentials is `not_configured`, exactly one is `partial_configuration`, and an
unusable pair is `invalid_configuration` — all surface as `workos_platform_unavailable`
rather than a partially working integration.

Home company sign-in and Team sign-in use one connection lifecycle, administration service,
and WorkOS runtime. A null `TeamIdentityConnection.teamId` is the Home scope and must bind a
Home-owned provider (`IdentityProviderInstance.ownerTeamId` null); a non-null scope binds only
the matching Team-owned provider. Home bindings cannot become Team directory sources.
Home owners mutate the company binding, while Home administrators can read the connection
facts permitted by the governance projection.

> **AM-13 status:** Home company sign-in is only partially implemented. The scope migration
> and policy/domain boundary work do not yet establish usable administration, OAuth, or UI
> flows. The Home behavior below is the approved target; its implementation and validation
> gates remain open.

Setup is deliberately staged, with the same setup, Test, and Admin Portal presentation for
both scopes:

1. **Create the connection.** `createTeamWorkosConnection` requires Team
   `manageAuthentication`, Home policy allowing `workos_sso`, and an available platform. It is
   idempotent by construction: an existing WorkOS connection for that Team is returned rather
   than duplicated, and more than one existing connection or provider instance is a
   `identity_connection_conflict` instead of a guess. The connection starts with both
   `organizationId` and `connectionId` null.
2. **Open the Admin Portal.** The organization is resolved by an external id derived from the
   Home server identity and Team id — `happier:<homeServerIdentityId>:team:<teamId>` — looked
   up first, then created with an idempotency key, with a 409 falling back to another lookup.
   The organization id is persisted under the connection's expected revision. The portal link
   is generated only after current permission, verified to be HTTPS, returned once, and never
   persisted. WorkOS documents these links as short-lived and non-revocable, which is exactly
   why Happier does not store one.
3. **Bind the SSO connection.** `reconcile` lists that organization's connections, fetches
   each one, and keeps only `active` candidates. Zero candidates records a `setting_up`
   observation; several return `selection_required` with the candidates rather than choosing;
   exactly one is recorded as `connected`. An administrator can also name one explicitly, and
   `getSsoConnection` re-verifies that the connection actually belongs to the bound
   organization — a mismatch is `workos_organization_mismatch`, never a fallback to name or
   domain matching.

At sign-in, the WorkOS OAuth adapter requires PKCE `S256`, authorizes against the exact bound
`connection`, and validates the returned profile against **both** the expected organization and
connection before it becomes identity evidence. The Profile id is the Account identity key.
Roles, Groups, and domains carried in a WorkOS profile authorize nothing.

Home company sign-in does not admit someone to a Team or grant a Home role. A fresh Account
requires explicit Home `self_service` admission, the company provider being permitted, and the
effective Account-mode policy and deployment locks. Keyed company signup does not depend on
the separate anonymous-signup switch; Plain signup retains the OAuth keyless deployment
ceilings. `closed` and `invitation_only` do not become JIT admission. Existing Accounts link
through an explicit authenticated flow, never by matching an email address.

Domain routing reads current verified domains from the exact bound WorkOS Organization and
selects only its current connection. An unverified, ambiguous, stale, or unavailable routing
result does not silently choose another provider. Test sign-in checks the current binding and
profile without creating or linking an Account. Disablement stops new sign-ins without
discarding existing identities, and removal retains the ordinary sole-login protections.

SSO alone does not remove people who leave a company. Home directory synchronization,
offboarding, IdP role grants, and Teams derived from groups are not part of Home company
sign-in; Team directory behavior remains separately scoped.

## Managed OIDC

Managed OIDC reuses the existing OIDC provider and OAuth core through a configuration-backed
factory, with one strict claim normalizer and one bounded outbound transport for discovery,
JWKS, token, refresh, and UserInfo.

The network boundary is the part operators need to understand, and it has a separate ceiling
from deployment-configured OIDC. It is documented for operators on the
[OIDC page](../apps/docs/content/docs/self-hosting/auth-oidc.mdx) and for deployments under
[Managed identity networking](deployment.md#managed-identity-networking-03-development). In
short: file and environment providers stay deployment-trusted and keep their existing reach;
database-managed providers default to public HTTPS on port 443, and only an explicitly enabled
deployment lets a Home administrator permit exact private hostnames, CIDRs, and ports. A Team
administrator selects from Home policy and cannot widen it. Changing the effective policy
changes the runtime fingerprint, so an older in-flight attempt cannot complete against it.

Home Administration · Policies edits that Home-owned allowlist through the same
revision-guarded `home.policy.set` document as the rest of Home governance. The section is
present only where the deployment could ever permit private endpoints: on a cloud or shared
Home there is no toggle to show, because there is no setting an administrator could reach.
`HomeGovernanceProjectionV1.identityServices` carries that deployment ceiling together with
whether the WorkOS platform is configured, partially configured, or absent. Both facts are
resolved from the owners that enforce them — `resolveWorkosPlatformRuntimeMetadata` and
`deploymentAllowsPrivateIdentityNetwork` — so the surface cannot disagree with the runtime,
and neither credentials nor environment variable names travel to the client. The field is
optional on the wire: a Home that does not report it renders no deployment section rather than
a guessed answer.

Configuration is a closed document: issuer, client id, scopes that must include `openid`, an
explicit claim mapping for login/email/groups, four allowlist arrays, a bounded HTTP timeout,
and non-security UI hints. The issuer is immutable after creation
(`identity_provider_issuer_immutable`) — changing an issuer is a new provider, not an edit,
because existing identity rows are namespaced by the provider id.

Deployment, managed-provider, and Team-connection allowlists share the same comparison-key
normalization: trim and lowercase users and Groups, and also remove one leading `@` from
email-domain entries. The OIDC `sub` remains an exact opaque identifier. An email-domain rule
requires a verified email that parses through the canonical mailbox owner; a malformed optional
profile email does not independently reject a subject when no domain rule is configured.
After a fresh same-subject authentication satisfies the current rules, the existing identity
link intent records eligibility as eligible and clears a previous offboarding denial. It does
not transfer or recreate the identity, and failed authentication cannot clear that denial.

OIDC claim Group mapping refreshes only the member who is signing in. It is not directory
synchronization, and the product labels the two separately.

## GitHub App identity

Home- and Team-owned GitHub App registrations, manifest-assisted setup on GitHub.com, manual
setup for GitHub Enterprise Server, and installation verification are described in
[Managed GitHub identity](teams.md#managed-github-identity); the operator-facing walkthrough is
on the [GitHub auth page](../apps/docs/content/docs/self-hosting/auth-github.mdx). Two facts
matter here because they are identity-domain contracts rather than Team-lifecycle ones:

- The App user token proves exact user identity during the live callback and is then
  discarded. Durable eligibility, directory, and repository operations use purpose-narrowed
  installation tokens. No identity token is copied into Connected Accounts.
- The verification callback binds the actor, owner, registration revision, security revision,
  installation revision, network-policy fingerprint, installation id, and organization id. Any
  changed fact fails the attempt closed.

## Directory provisioning and reconciliation

A `TeamDirectorySource` has its own lifecycle, independent of the identity connection that may
share a provider with it. Lane-owned projection tables — `TeamProvisionedIdentity`,
`TeamDirectoryGroup`, `TeamDirectoryGroupMember` — hold external observations. They are never
authorization, and no placeholder Account is ever created for a directory person.

### Projection, then native effects

External fetches happen outside transactions. Every bounded page crosses a source/run
compare-and-swap before it can become staged evidence, so a stale run cannot write into a
newer one. Only after the whole projection finalizes does `applyNativeDirectoryFactsInTx` call
the native adapters in `memberships/externalFacts.ts`:

- `applyExternalTeamMembershipInTx` for the one membership this source manages;
- `applyExternalManagedGroupInTx` for Group metadata belonging to an exact binding;
- `applyExternalGroupContributionInTx` for that binding's contribution to the effective Group
  roster, computed as a desired set versus the surviving contributions;
- `revokeExternalSourceFactsInTx` when the source is removed.

The native-effect transaction rechecks the current WorkOS provider instance. Disabling that
provider prevents new directory materialization without revoking already committed native
access. The Team SSO connection's enabled state is independent of directory provisioning.

Group membership is a **union** of an optional native contribution and any number of exact
external-binding contributions. Removing one contribution preserves the others and preserves
the existing effective-membership horizon. Membership, by contrast, has one management owner
per lifetime; transfers are explicit Lane 01 operations through member administration, and a
reconciler never seizes an independently native membership.

When management moves away from a directory identity, that same transaction withdraws only
the source's Group contributions that become ineligible because the released identity is
suspended. Active-identity contributions, native contributions, and other-source contributions
remain; surviving effective memberships retain their access horizons.

An unmapped external Group grants nothing. Binding is by immutable external id — Happier never
adopts a native `TeamGroup` because its name happens to match.

Directory Group list projections report `memberCount`, distinct `boundAccountCount`, and
`unboundPeopleCount` from the external Group roster. All three are `null` until a full
observation exists and while the source is not active or a reconcile run is incomplete.
These are roster binding counts, not exact native grant/removal counts: native membership
eligibility and surviving contributions still determine the effects of a mapping change.

A directory person's `accountBinding.teamMembershipId` links to the bound Account's actual
same-Team membership, including independently native or differently managed memberships.
This read projection does not change the provisioned identity's stored management pointer
or claim ownership of that membership.

### Freshness, the worker, and Sync now

One worker, one renewable global lock (`server.enterprise-identity.sync`, 90 s TTL, renewed
before each projection write), one 60 s pass interval. The lock reduces duplicate upstream
load; correctness comes from the transactional cursor and run compare-and-swap, so an expired
lease cannot corrupt state. There is no job table, event ledger, webhook receiver, per-source
lease, or second manual-sync worker.

The ratified targets are code constants in `directorySourceProjection.ts`:

| Target | Value |
|---|---|
| `WORKOS_DIRECTORY_SYNC_TARGET_MS` | 5 minutes |
| `GITHUB_DIRECTORY_SYNC_TARGET_MS` | 30 minutes |
| `DIRECTORY_FULL_RECONCILE_TARGET_MS` | 24 hours |
| Failure retry backoff | 30 s, 2 min, 10 min — or the upstream `Retry-After` when it is shorter, clamped to the sync target |

A source reports `fresh` until twice the applicable target has passed since `lastSuccessAt`,
then `stale`; a paused source reports `unknown` rather than decaying. These timestamps measure **Happier's
successful observation**, not upstream IdP consistency: WorkOS's own Google Directory Sync
polls on its own schedule, so a fresh Happier observation of a lagging upstream is still a
lagging directory. A completed empty poll is a successful observation and updates
`lastSuccessAt` without manufacturing cursor movement.

`Sync now` persists and coalesces work for that worker and returns requested/coalesced state.
It never promises immediate completion.

### WorkOS ordered events

Incremental sync uses the WorkOS Events API in ascending order, filtered by the exact
organization, with an opaque `after` cursor held per source. Event ids are bookmarks processed
in returned API order; a source may redundantly observe sibling directory events, grants
nothing for them, and advances past them so they cannot poison the stream.

Initial import and full repair record a start boundary, import complete paginated people,
Groups, and Group memberships into the projection only, replay events from the boundary,
advance the cursor with compare-and-swap, and only then apply the complete projection to
native facts. An incomplete import or repair cannot create positive native authorization —
`directory_snapshot_incomplete` — and existing committed native access stays available while a
repair is failing. Absence becomes destructive only after every required page completes under
the same run.

`dsync.deleted` revokes the whole source; WorkOS does not emit one event per object, and
Happier does not wait for one.

## Transports

All authenticated unless noted, all thin over the services above. Home-level identity
administration is not behind the `teams` gate; the Team-scoped surfaces are.

| Path | Intent | Gate |
|---|---|---|
| `POST /v1/auth/entry` | contextual entry projection (public, `no-store`, rate limited) | none; Team/invitation scopes need `teams` |
| `POST /v1/identity/providers/{list,create,update,validate,enable,disable,remove}` | managed OIDC administration for a `home` or `team` owner | see below |
| `POST /v1/identity/providers/secret/replace` | write-only secret rotation | see below |
| `POST /v1/identity/providers/test/{start,consume}` | non-mutating provider test | see below |
| `POST /v1/identity/providers/remove/preflight` | exact blockers and affected Accounts before removal | see below |
| `POST /v1/identity/github-apps/{list,create,update,verify-installation,remove}` | GitHub App registration and installation lifecycle | Home or Team authority for the named owner |
| `POST /v1/identity/github-apps/manifest-setup/start` | one-time manifest setup URL | Home or Team authority for the named owner |
| `GET /v1/identity/github-apps/manifest-setup/submit` | single-use, unauthenticated handoff page that posts the manifest to GitHub; `410` once consumed | one-time handle |
| `POST /v1/teams/identity/connections/{list,create,settings/update,enable,disable,remove}` | Team connection lifecycle | `teams` + Team `manageAuthentication` |
| `POST /v1/teams/identity/connections/remove/preflight` | exact blockers and impact before removal | `teams` + Team `manageAuthentication` |
| `POST /v1/teams/identity/connections/test/{start,consume}` | non-mutating connection test | `teams` + Team `manageAuthentication` |
| `POST /v1/teams/identity/workos/admin-portal-link/create` | ephemeral Admin Portal link, `no-store` | `teams` + Team `manageAuthentication` |
| `POST /v1/teams/identity/workos/{connection/create,connection/set,reconcile}` | WorkOS organization and SSO connection binding | `teams` + Team `manageAuthentication` |
| `GET/POST/DELETE /v1/teams/:teamId/directory-sources…` | directory source lifecycle, people, groups, sync, pause/resume, removal impact | `teams` + Team authority |
| `GET/PUT/DELETE /v1/teams/:teamId/external-group-bindings…` | external Group → native Group mapping | `teams` + Team authority |

The `identity.providers.*` surface takes an explicit `owner`, defaulting to `home`. A `home`
owner requires Home `manageAuthentication`. A `team` owner requires Team
`manageAuthentication` *and* Home policy allowing the `oidc` kind — so the same routes serve
both scopes without a second administration surface, and a Team can never create a provider
kind the Home has not permitted.

### Public Actions

The five bounded browser-handoff operations are registered through the shared public Action
catalog rather than a Lane 03 executor:

- `identity.providers.test.start` and `identity.providers.test.consume`;
- `teams.identity.connections.test.start` and
  `teams.identity.connections.test.consume`; and
- `teams.identity.workos.adminPortalLink.create`.

Their generated public reference is
[Host Actions](../apps/docs/content/docs/plugins/api/host-actions.mdx). All five admit
`account_automation` callers on their declared UI, Agent, CLI, and API surfaces, but exposure is
not authority. Each explicit domain route still authenticates the actual principal, checks the
exact Home or Team capability and current Team qualification, validates the current provider or
connection revision, and applies the shared Action approval policy. A browser-capable host may
open the returned URL; a headless caller receives the same typed short-lived handle/result. Test
and portal output is one-time or expiring, no-store, and redacted from logs, transcripts, and
approval summaries. The matching consume result, not a returned URL, establishes completion.

Trusted installed plugins use that same public Action ABI and domain routes; they do not receive
a plugin-only authority path. For an external PAT request, the Home admits one
purpose-separated authorization bound to the originating Account principal and credential, exact
public Action, request id, target Machine, Home identity, and request-envelope digest. The selected
trusted daemon proves its Machine identity over each exact downstream request's method, path,
body, effect Action when one applies, and authorization. The same parent authorization can cover
the bounded preparatory reads and writes required by that admitted public Action; it is not a
bearer for unrelated domain calls. The Home then rechecks the original PAT's currentness,
qualification, policy, and domain capability. The daemon's ordinary Account bearer is not
substituted and cannot lend its qualification to the PAT; the PAT likewise cannot borrow another
daemon or retarget the
admitted invocation. A durable approval records the same exact origin and signed Action input, so
resume cannot widen it. Missing, mismatched, replayed, expired, or revoked facts fail before
mutation.

This exact-invocation path exists only in 0.3 development source. Focused Protocol, daemon adapter,
and server integration coverage is implementation evidence; the cross-runtime loaded journey and
the broader CLI/package gates remain completion requirements.

## Plain first-password enrollment custody

For a Plain Account's first password, Account Security prepares the salted target credential and
canonical mutation digest locally, then obtains a proof purpose-bound to
`account_password_enrollment`, the exact Account, Home, normalized email, provider, pending record,
and digest. The server reconstructs the digest when applying the existing Account Security Action.

The mounted UI process owns exactly one such ceremony. Its exact prepared target credential,
canonical mutation digest, and provider-bound external proof live only in process memory.
`TokenStorage`, browser `localStorage`, and native secure storage reject
`accountPasswordEnrollment`; none may encode or persist that member or its credential, digest,
proof, pending, or continuation bytes. They also never enter URLs, synced settings, logs, or
telemetry.

The OAuth callback claims the exact Account, Home, provider, pending value, and `requestDigest`
once. That claimed ceremony may survive in memory only while navigating from the callback route
back to the originating Settings screen. Its `returnTo` carries the exact target Home `serverId`.
Reload, replay, expiry, cancellation, abandonment, or any substitution requires a fresh salted
preparation and proof. mTLS instead completes directly in the same process with no callback
continuation. For an E2EE proof audience, the client uses `resolveHomeAuthenticationTarget` and
binds the stable `serverIdentityId` plus `canonicalServerUrl`, never a device-local alias or a
transport endpoint.

## Failure and recovery

| Situation | Behavior |
|---|---|
| Provider missing, disabled, malformed, wrong-context, or security-revision changed | consume the stale attempt, present restart, mutate nothing |
| Wrong WorkOS organization or connection | deny; no email, domain, or name fallback |
| Wrong GitHub App, installation, or organization | deny; the bound facts must all match |
| Existing Account with an unlinked external identity | authenticate through an existing method, then connect explicitly; never auto-link by email |
| Directory API unavailable | retain last-known native state, show the stale or error state, retry through the same worker |
| Incomplete directory evidence | never removes access |
| Mapping absent | the external Group grants nothing |
| Provider secret unreadable | that provider fails closed; other providers are unaffected |
| Team stored authentication policy unreadable | Team identity administration and Team entry fail closed |
| Provider or connection removal | exact blockers and an impact preview first |
| Directory source removal | revokes only that source's facts; never deletes an Account |

Home-level lockout recovery is deliberately **not** an identity-domain feature. A Home whose
only owner is gone is recovered with the deployment-local `--claim-home-owner` command
described in the published
[Home owner setup and recovery](../apps/docs/content/docs/self-hosting/home-owner.mdx) guide.
A restricted Team authentication policy can be saved only after catalog applicability, current
external tests, prior-value compare-and-swap, and the editor's own qualifying credential have all
passed. A later policy change must first qualify against the policy currently protecting the
Team; failure leaves the prior document unchanged rather than silently recovering to inherit.

## Open completion gates

These are current source completion gaps, not planning intentions. The exact WorkOS/GitHub
sign-in-time provisioned-identity writers and restricted Team-policy validation/qualification
path are now present; their focused tests are source evidence, while the loaded journeys below
remain open.

- **The Team sign-in Settings producer is incomplete.** The public route and return helpers are
  mounted, but Team Authentication does not yet expose the required bearer-free member sign-in
  row with Open, Copy, and QR affordances.
- **WorkOS return continuity is partial.** Portal and test returns reach the mounted screens,
  but the initiating connection row does not yet own the full checking/completion/expiry state,
  focus restoration, and scroll continuity required by the interaction contract.
- **Managed GitHub repository access is absent.** The registration and installation owner is
  ready to be consumed by reference, but the Connected Service grant producer has not landed.
  The public consumer fails closed rather than treating an internal installation id as
  authorization.
- **External-PAT Action propagation still needs its loaded integration gate.** The five public
  Action specs, generated SDK/plugin projection, exact-invocation authorization, trusted-daemon
  Machine proof, explicit domain routes, and mounted UI return paths are present in development
  source. Focused tests do not replace the cross-runtime loaded journey or package gates.
- **Composed and live validation is open.** Package-level server, UI, and CLI gates,
  retained-data migration deploy, MySQL execution, and loaded-runtime QA for the WorkOS, OIDC,
  and GitHub flows have not been completed for this domain.

## Explicitly rejected

Recorded so they are not reintroduced as "obvious" improvements: a WorkOS-side Happier
account; a Team token, cookie, or password store; a Team OAuth callback; a second provider
registry, OAuth runtime, identity writer, or UI provider store; raw external role, Group, or
domain authorization; a generic IAM/FGA policy language or claim-mapper DSL; provider
configuration history or a cache-invalidation bus; a universal directory adapter ABI; WorkOS
webhooks, an event or receipt ledger, a queue, exactly-once delivery, per-source leases, or a
feed router; placeholder Accounts; Team or Group key hierarchies; live claim fetching on
resource requests; friendly Team slugs; and custom authentication HTML, CSS, or themes.

## Compatibility

See [Enterprise identity and directory provisioning](compatibility.md#enterprise-identity-and-directory-provisioning-03-development)
for the activation sequence, the supported and unsupported directions, and the exact
compatibility readers this domain retains.
