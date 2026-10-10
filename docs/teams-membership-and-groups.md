# Team membership, flat Groups, and Session-history horizons

A `TeamMembership` is one person's membership lifetime in one Team. A `TeamGroup` is a flat
named targeting set inside that Team. Together they answer four questions and no others:

- is this Account currently a member of this Team, in which role and status;
- does this Account belong to this Group;
- from what point may a Team- or Group-derived Session grant apply;
- who currently owns lifecycle changes for this membership — a native manager or one exact
  enterprise directory.

They are deliberately **not** an access evaluator. Which Sessions a member may read is
Session access's decision, whether they can decrypt one is key delivery's, and whether a
Session is personally relevant is the personal-state owner's. Team administration
authorizes Team governance and nothing else.

See also [Team lifecycle, policy, and branding](teams.md) and
[Team invitations and membership admission](teams-invitations.md).

> **Status (0.3 development source).** Persistence, the membership and Group services, the
> capability projections,
> the history-horizon owner, the external-fact seam, the Account-erasure precondition, and
> the HTTP transports are implemented and registered on the API surface behind the `teams`
> feature gate, and the directory reconciler applies its projections through the
> external-fact seam. Exact-Home roster, member-detail, Group-list, Group-detail, and mutation
> surfaces are present in the development client. This source status does not establish
> release availability or completed web/iOS/Android loaded-runtime validation.

## Canonical owners

| Decision or fact | Owner |
|---|---|
| Membership lifetime, role, status, horizon | `apps/server/sources/app/teams/memberships/membershipService.ts` (`admitTeamMemberInTx`) |
| Authorized member administration | `apps/server/sources/app/teams/memberships/memberAdministration.ts` |
| One actor's current Team authority | `apps/server/sources/app/teams/actorContext.ts` |
| Team role → capability mapping, and per-member capabilities | `apps/server/sources/app/teams/memberships/capabilities.ts` |
| Structural effective membership | `apps/server/sources/app/teams/memberships/effectiveMembership.ts` |
| History intent → persisted horizon | `apps/server/sources/app/teams/memberships/sessionHistory.ts` |
| Team-ownership precondition for Account erasure | `apps/server/sources/app/teams/memberships/erasurePrecondition.ts` |
| External (directory) fact application | `apps/server/sources/app/teams/memberships/externalFacts.ts` |
| Group lifecycle, roster authority, metadata ownership | `apps/server/sources/app/teams/groups/groupService.ts` |
| Effective Group membership as a contribution union | `apps/server/sources/app/teams/groups/groupContributions.ts` |
| Group membership resolution by public address | `apps/server/sources/app/teams/groups/effectiveGroupMembership.ts` |
| Transaction clock for every horizon | `readTransactionDatabaseTime` |
| Invalidation | `apps/server/sources/app/teams/teamChanges.ts` |
| Wire contracts | `packages/protocol/src/teams/membership.ts`, `group.ts` |

Every route, invitation acceptance, Team creation, and directory adapter reaches these
services. Nothing else writes `TeamMembership`, `TeamGroupMembership`, or a contribution row.

## Membership lifetime

`TeamMembership.id` is a real immutable lifetime identity, not a convenience key.

- Exactly one current membership exists per `(teamId, accountId)`.
- Role changes and reversible suspension preserve the id, the role's history, and the
  horizon.
- Removal ends the lifetime. Group memberships, their external contributions, and
  membership-lifetime resource grants cascade from the deleted row.
- Rejoining creates a **new** id and a new horizon, which is what makes it impossible for a
  removed person to resurrect old member-specific grants by being re-added.
- Provider Account replacement moves only `TeamMembership.accountId`. The id, role, status,
  and horizon stay, so Group rows, contributions, and downstream grants stay attached.

`TeamMembershipStatus` is `active | suspended` only. Absence means removal; `invited`
belongs to an invitation; `disabled` is the Home Account lifecycle's separate meaning; and
decryptability is a key-delivery projection, never a membership state.

### Self-removal

`teams.members.leave` accepts only `{ v: 1, teamId }`. The shared
`removeTeamMemberForActorInTx` transaction resolves the acting Account's own lifetime
and performs the same access reconciliation, credential revocation, cascades and
Team AccountChange publication as manager removal. No membership status or second
removal writer is introduced.

`resolveTeamLeaveDecision` supplies both the `TeamCapabilitiesV1.leave` projection
and transaction admission. An active Account may end its own active or suspended
native membership without manager authority. Directory-owned lifetimes return
`managed_by_directory`; the final structurally active owner of an unarchived Team
receives `team_owner_transfer_required`. An archived Team may be left after its
resource access has stopped. Team credential qualification still applies.

Both manager removal and leave write the typed `teams.members.remove` detail through
the existing Home audit writer in the removal transaction, targeting the subject
Account. Its summary names the Team and ended lifetime; leave has actor = subject.
No-op retries write no event. Session Agent and CLI exposure, dangerous approval
policy and MCP=false come from the same Home-family Action row owner as remove.

The own Members entry and non-manager Overview share one confirmation and deferred
approval continuation. Successful immediate or approved execution refreshes the
exact Home's Team and member directories before returning to Settings → Teams.

### Structural effective membership

One predicate, consumed rather than rebuilt:

```text
Account.status == active AND TeamMembership.status == active AND Team.archivedAt == null
```

Group membership adds `TeamGroupMembership exists AND TeamGroup.archivedAt == null`.

This is *structural* membership. It is not proof that a request satisfies a configured Team
authentication requirement; that decision belongs to the identity lane and is composed by
the Session-access evaluator, never re-implemented here.

## Capabilities

Two projections, because they answer two different questions:

- `TeamCapabilitiesV1` — what may this viewer do in this Team at all.
- `TeamMembershipCapabilitiesV1` — what may this viewer do to *this specific member*.

The per-member projection exists because none of its answers is derivable from a role
string, and a client that tried would become a second authority for the same decision:

- an archived Team suppresses every membership mutation while retaining every row;
- an admin may not touch an owner at all — every mutation whose current or resulting role is
  `owner` requires `manageOwners`, even while another owner remains;
- ordinary administration may not strand the final structurally active owner, so that
  member's role, suspend, and remove controls are withdrawn rather than offered and refused;
- a directory-owned lifetime is native read-only for suspend, reactivate, and remove. Role
  stays native, because no external role is mapped automatically;
- Home `manageAllTeams` is not membership authority. Its one membership power is promoting
  an existing active non-guest member — never the caller — and only while the Team has no
  active owner.

Both projections render and precheck. Every mutation re-decides from the same facts inside
its own serializable transaction.

### Owner invariants

Routine mutations preserve at least one structurally active owner: active Account, active
membership, `owner` role. Neither Team archive, authentication freshness, nor envelope
readiness belongs in that predicate.

Security offboarding is deliberately different. Suspending or retiring an Account revokes
access even when that person is a Team's last owner, and the Team simply derives an
owner-required state. Retaining unsafe access to preserve an invariant would be the wrong
trade, and there is no `ownerRequired` column, emergency membership, or ghost-owner access.

Recovery is the narrow Home power described above, exercised through the ordinary
`teams.members.role.set` mutation. It grants no transcript, key, or Group authority.

### Account erasure

`assertTeamOwnershipAllowsAccountErasureInTx` is the one Team-ownership question erasure
asks. The existing erasure owner composes it before destructive blob work and again in the
final deletion transaction, exactly as it composes the Home-ownership check.

For each **retained** owner membership of the target — regardless of the target's own
lifecycle state, because an erasure retry arrives with the Account already terminally
retired:

- another structurally active owner remains → allowed;
- otherwise the Team is archived, or has no other structurally active member → allowed, and
  the Team may remain ownerless with its rows and derived recovery state intact;
- otherwise → `team_owner_transfer_required`, refused before any irreversible work.

A guest counts as a member for this question: an ownerless staffed Team is still a Team with
someone in it.

## Session-history horizons

The Protocol owns one closed input vocabulary, `SessionHistoryAccess`, and persistence
stores only the normalized result:

| Intent | Persisted `sessionAccessStartsAt` | Meaning |
|---|---|---|
| `all_existing` | `null` | no lower horizon |
| `from_membership` | the activation timestamp | only grants effective after this membership began |

Storing both an enum and a cutoff would create two values that can disagree, so only the
cutoff is stored and the enum is projected back from it. The raw cutoff is never published:
comparing it with a grant's immutable `effectiveAt` is Session access's exclusive decision,
and a tie fails closed there.

Rules that hold across every admission path:

- the horizon is minted exactly once, when canonical membership becomes active — never from
  an invitation's creation time, an external directory timestamp, or an identity's
  eligibility time;
- `activationNow` always comes from the deciding transaction's **database** clock, read after
  the admission checks. A process clock on a skewed replica would mint a cutoff that
  disagrees with the grant timestamps it is later compared against, and a value captured
  before a retry would not belong to the committing attempt;
- role changes, suspension, and reactivation preserve it; removal and rejoin mint a new one;
- Team and Group horizons are independent facts. A Team horizon constrains Team grants; a
  Group horizon constrains that Group's grants;
- a replayed admission never widens a retained horizon, and neither does a second Group
  contribution.

The horizon is immutable within one membership lifetime. A later one-way "include existing
Sessions" upgrade is a product decision with its own UX contract, not a field edit.

## Flat Groups

A Group has a name, an optional description, an archive state, and a roster. There is no
nesting, no Group role, no per-Group policy, no allow/deny precedence, no persisted
"Everyone" Group, and no Group-as-context. The Team principal already denotes active
non-guest members; a Group is exactly the narrower audience.

- Names reuse the shared Team display-name owner. The stored `nameKey` adds only the case
  fold that in-Team uniqueness requires, and it is a uniqueness key only — nothing routes,
  links, or authorizes through it. An archived Group still holds its name.
- Archive stops Group-derived access immediately while retaining every membership row and
  horizon; restore re-enables exactly the retained grants that are still valid.
- A Group membership can exist only for an Account that belongs to the same Team, enforced
  by composite foreign keys on all three database providers rather than by a copied Boolean.
- `memberCount` and the roster page both come from the effective-row relation, never from
  the sum of contributions, so a person supplied by three sources is one member.

### The contribution union

Effective Group membership is a plain set union of one optional native contribution and any
number of exact directory contributions. Because it is a union, there is no source
precedence, no overwrite, and no deny rule.

`applyTeamGroupContributionInTx` is the single owner of that union, used by both native and
external writers:

- the **first** contribution creates the effective row and mints its horizon;
- later contributions join the existing row and never widen or reset the retained horizon;
- removing one contribution removes only that contribution;
- the membership ends only when the **last** contribution disappears, and the row is deleted
  rather than left empty — a zero-contribution row would still grant access with nothing
  justifying it.

Outcomes are reported truthfully. `contribution_removed` is not `removed`: when a directory
still contributes, the person keeps Group access and the roster must say so instead of
claiming a removal that did not happen.

`TeamExternalGroupBinding` maps one exact external Group to one native Group. Its composite
foreign keys prove that a contribution targets the Group its binding actually maps, and the
restricting foreign key means source removal must pass through the revocation service rather
than a database cascade.

At most one `directory_created` binding may target a Group; that binding owns the Group's
**metadata** lifecycle. Roster contribution stays additive and independent, so a
directory-created Group is still natively editable as a roster, and a native-target Group
keeps native archive authority even while external sources contribute members.

## The external-fact seam

Four adapters in `memberships/externalFacts.ts` are the only way an enterprise directory
changes native authorization. They take the caller's existing transaction; the caller
prepares complete evidence outside it and applies the whole set inside one transaction, so
an initial import or a source revocation is never observable as partially committed access.

| Adapter | Contract |
|---|---|
| `applyExternalTeamMembershipInTx` | Activate, suspend, reactivate, or remove the lifetime **this source owns**. A native or differently-sourced membership is reported as `managed_elsewhere` with its id and left untouched; an offboarding observation for it is `unchanged`. `management_conflict` is kept for a corrupt binding — an identity whose manager pointer names somebody else's row. Directory activation always admits at `member`. |
| `applyExternalGroupContributionInTx` | Add or remove one exact contribution, after validating the binding against both its Team and its Group. |
| `applyExternalManagedGroupInTx` | Archive, restore, or rename a Group a `directory_created` binding owns. A contributing binding is refused. |
| `revokeExternalSourceFactsInTx` | Remove every native fact one source owns, atomically, returning only once they are all ineffective. |

Source ownership is proved from the source's own row and its provisioned identity, never
from a caller-asserted Team or a connection id. External state is provenance; only the
native row authorizes.

Revocation's Group-metadata disposition is **retain native**: of the three permitted
dispositions it is the only non-destructive one, so a Group keeps its roster and horizons
and simply becomes natively managed. Archiving somebody's live Group as a side effect of
removing a source is a policy decision this adapter has no authority to make.

If the removed source also owns the containing Team membership, confirmed removal ends that
lifetime and its Group rows cascade — including other sources' contributions. A Group source
cannot keep somebody in a Team it does not manage; keeping the person requires an explicit
management transfer before removal.

### Current callers

The seam is consumed, not dormant. `directoryProjectionRepository.ts` applies a completed
projection through `applyExternalTeamMembershipInTx` for every bound identity, then
`applyExternalManagedGroupInTx` and `applyExternalGroupContributionInTx` per binding —
adding contributions for the currently projected members and removing the ones that
disappeared. `directorySourceAdministration.ts` calls `revokeExternalSourceFactsInTx` when
an administrator removes a source.

The reconciler deliberately does not treat `managed_elsewhere` as a failure: a native or
differently-managed membership is left exactly as it is, which is the no-seizure rule seen
from the caller's side, and the source's own Group contributions are still materialized
against that membership. Two directories may therefore contribute to one Group roster for
one person while exactly one of them — or native administration — owns the Team lifetime.
It does raise a projection invariant error for `management_conflict` and when a source,
binding, or Group target it just read has disappeared, because those are corrupt or torn
reads rather than policy outcomes.

### Management transfer

`teams.members.management.set` is the deliberate conversion in both directions. Binding
requires an exact provisioned identity in that source already resolving to this Account and
not already owning another membership; without one there is nothing to manage through, which
is a conflict rather than a permission problem. The lifetime, role, status, and horizon are
preserved throughout — only which owner may change them moves.

`identity_connection` is admissible as a *projection* of who manages a lifetime but not as a
conversion target: the connection-to-membership binding that would record it belongs to the
identity lane's OIDC admission owner and does not exist yet.

## Transports

All paths are POST, behind the `teams` feature gate, registered in
`apps/server/sources/app/api/api.ts`.

| Path | Intent |
|---|---|
| `/v1/teams/members/list` | Roster page, filtered by `all \| owners_admins \| members \| guests \| suspended`, optionally narrowed by a bounded `query` |
| `/v1/teams/members/get` | One member's detail |
| `/v1/teams/members/add` | Direct add of an exactly identified Account |
| `/v1/teams/members/role/set` | Role change, including owner promotion and recovery |
| `/v1/teams/members/suspend` · `/reactivate` | Reversible status |
| `/v1/teams/members/remove` | End the lifetime |
| `/v1/teams/members/management/set` | Native ↔ directory conversion |
| `/v1/teams/groups/list` · `/get` · `/create` · `/update` · `/archive` · `/restore` | Group lifecycle |
| `/v1/teams/groups/members/list` · `/add` · `/remove` | Native Group roster |

Routes authenticate, parse the strict protocol input, call one canonical service, and map
its typed result to HTTP through the shared `teamErrorHttpStatusV1` mapping. They contain no
role comparison, owner rule, management branch, or history decision.

Pages use bounded opaque keyset cursors bound to the exact query that produced them: the
roster orders by `(createdAt, id)`, Groups by `(nameKey, id)`, and the Group roster by
`(createdAt, teamMembershipId)`. A cursor minted for another filter, roster query, Group, or
archive scope is rejected rather than silently restarting at page one.

The roster's optional `query` is a bounded lookup, not a filter language: it matches the
Account id exactly and the same name and username fields the Home's own Account search
matches, through the one `buildAccountTextPrefixFilter` owner. It exists because narrowing
only the pages a reader already holds reports a member on a later page as absent.

Direct add carries an Account id, never a search term. Account discovery is the Home
governance picker's authorized projection; managing one Team never confers a Home-wide
lookup.

## Encrypted access for existing Sessions

Membership admission and Session decryptability are separate decisions. A Team or Group
member can become an authorized Session recipient while the member's encrypted access is
still pending, requires Account encryption setup, or needs repair. Membership is not rolled
back while that work is incomplete.

The member-detail surface uses the one Lane 06 preparation resource for both Team and Group
members:

```text
GET   /v2/teams/:teamId/members/:teamMembershipId/sessions/data-key/envelopes
PATCH /v2/teams/:teamId/members/:teamMembershipId/sessions/data-key/envelopes

GET   /v2/teams/:teamId/groups/:groupId/members/:accountId/sessions/data-key/envelopes
PATCH /v2/teams/:teamId/groups/:groupId/members/:accountId/sessions/data-key/envelopes
```

The Home returns only Sessions the authenticated manager can already read and manage, and
the client prepares missing recipient envelopes from the existing Session data key. The
resource never exposes inaccessible Session identities, creates a Team or Group key, or
turns envelope presence into access. Each page is bounded and resumable from the canonical
membership horizon and effective Session access; app termination simply leaves the next
explicit preparation pass to the member detail surface.

Group member detail carries the Group id and Account id into the shared Team member route,
so Group history uses the Group membership horizon rather than silently falling back to the
Team membership resource. A prepared tuple still does not bypass current Session access.

## Realtime

Membership and Group mutations publish through the existing Account-change wake
(`publishTeamChangedInTx`) and clients reload the canonical HTTP projection. There is no
Team change kind, socket room, roster push stream, or second cursor.

## Action and client entry points

`teams.members.*` and `teams.groups.*` are declared in the shared Actions catalog. Their
Action rows remain thin protocol/front-door bindings to the same domain routes and services;
they do not introduce another membership or authorization owner. The UI member and Group
surfaces use those rows for mutations and the nested encrypted-access resources above for
history preparation.

## Explicitly rejected

- A universal principal/membership/authorization table, generic role inheritance, or custom
  roles.
- A membership or source event ledger, membership generations, or a version column.
- Per-member Session grant fanout, per-message history cutoffs, or key epochs.
- A mutable history horizon workflow.
- A Home-global sequence or ordering service; equality denies safely.
- A directory-specific membership table, a generic opaque source registry, or a
  Group-source precedence/deny engine.
- Nested Groups, Group roles, policy inheritance, or a persisted "Everyone" Group.
- A durable history-preparation job or progress row.
- Per-member read, relevance, or Follow initialization: membership provisioning writes no
  personal state at all.
