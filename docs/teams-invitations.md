# Team invitations and membership admission

A Team invitation is an offer to create one canonical `TeamMembership`. It is not a Home
credential, a Team-scoped login, a placeholder Account or membership, a directory record,
a Session grant, or a generic bearer-capability framework.

Every membership entry path — manager direct add, invitation acceptance, and directory
admission — ends at the same membership admission owner. Only that owner writes
`TeamMembership`.

See also [Team membership, flat Groups, and Session-history horizons](teams-membership-and-groups.md)
for that owner's lifecycle, capability, horizon, and Group contracts.

> **Status (0.3 development source).** The invitation domain, token codec, lifecycle owner,
> authorized manager operations, acceptance, email-bound delivery, HTTP transports, explicit-
> Home join surface, and invitation-qualified native Account provisioning are implemented.
> External Team authorization also carries a server-held invitation reference into Team OAuth
> admission. The current link carrier remains an unbounded JSON serialization rather than the
> canonical bounded Homes codec required for the final cross-device contract. Source presence
> is not release availability or completed loaded-runtime validation. See
> [Remaining integration boundary](#remaining-integration-boundary).

## Canonical owners

| Decision or fact | Owner |
|---|---|
| Invitation intent, digest, role, history choice, expiry, terminal timestamps | `apps/server/sources/app/teams/invitations/invitationLifecycle.ts` |
| Token mint and digest | `apps/server/sources/app/teams/invitations/token.ts` |
| Manager-visible projection and bearer confinement | `apps/server/sources/app/teams/invitations/project.ts` |
| Who may invite, list, revoke, reissue | `resolveTeamMembershipCapabilities` (`manageInvitations`) |
| Acceptance orchestration | `apps/server/sources/app/teams/invitations/accept.ts` |
| Membership creation and history horizon | `admitTeamMemberInTx` |
| Transaction clock for expiry and horizon | `readTransactionDatabaseTime` |
| Email normalization | `normalizeVerifiedEmail` (protocol, Account/email lane) |
| Verified-mailbox ownership | `accountOwnsVerifiedMailboxInTx` (`apps/server/sources/app/auth/verifiedMailboxEvidence.ts`) |
| Mail transport, rendering, readiness | `AuthEmailDelivery` / `isAuthEmailDeliveryReady` (Account/email lane) |
| Join-screen Home identity and link target | `apps/server/sources/app/teams/invitations/joinScreenHome.ts` |
| Current explicit-Home carrier producer/parser | `joinScreenHome.ts` / `teamJoinTarget.ts` (temporary development path; bounded Homes codec remains open) |
| Wire contracts | `packages/protocol/src/teams/invitation.ts` |
| Typed refusals and their HTTP statuses | `packages/protocol/src/teams/errors.ts` |

## Token

One versionless opaque format: 43 characters from the server's existing cryptographic
alphanumeric alphabet (`[A-Za-z0-9]{43}`, ≈256 bits), minted through
`createRandomAlphanumeric`. Only `SHA-256(UTF-8 token)` is persisted, as 32 bytes under a
unique index; lookup is by digest.

The raw bearer is returned **exactly once**:

- a transferable invitation returns it to the authorized manager as a join link;
- an email-bound invitation passes it only to the delivery boundary and returns
  `joinUrl: null` to the manager;
- an egress-restricted automated caller receives neither.

There is no token vault and no raw-token recovery. A lost or redacted create response is
answered by explicit **reissue**, which mints a new bearer and invalidates the old one.
Malformed input fails closed before it can be digested and probed against stored rows.

## State

State is derived from timestamps in this precedence; no status column exists.

```text
acceptedAt != null  → accepted
revokedAt  != null  → revoked
expiresAt  <= now   → expired
otherwise           → active
```

Acceptance stays authoritative over a later revocation: the membership it produced is
real, so the row must not be redescribed. The exact expiry instant is expired, not active.
`deriveTeamInvitationStateV1` is shared by server projections and clients so a row cannot
mean two different things on the two sides.

Lifetime is seven days from creation (`TEAM_INVITATION_TTL_MS`), one code-owned constant.
Reissue mints a fresh seven-day invitation. There is no per-invitation TTL control and no
cleanup scheduler; expiry is enforced at reads and writes, and terminal rows are retained
as governance provenance.

In development 0.3, manager-visible rows publish `finishedAt`: acceptance time,
revocation time, or expiry time, following the same state precedence. Active rows
publish `null`. Accepted rows also project the accepting Account through the
shared neutral Account display-profile owner; the Members display-name owner
formats that person in the client. Older rows may omit either field. The client
never substitutes creation or expiry time for an unknown acceptance or revocation
instant. Revocation currently stores no actor, so its row carries no invented
manager identity.

## Conditional writes

Every transition is a conditional write whose affected-row count decides the winner, so
concurrent acceptance, revocation, reissue, and Team archive need no lock or advisory
counter:

| Operation | Condition | Result |
|---|---|---|
| `revokeTeamInvitationInTx` | matching Team, not accepted, not revoked | `revoked` / `unchanged` |
| `revokeActiveTeamInvitationsForTeamInTx` | Team, not accepted, not revoked | count |
| `consumeTeamInvitationForAcceptanceInTx` | not accepted, not revoked, `expiresAt > now` | `true` / `false` |
| `reissueTeamInvitationInTx` | conditional revoke, then copy intent | `{ previous, replacement }` / `unchanged` |

The Team id is part of the revoke condition, so a manager of one Team can never revoke
another Team's invitation by id.

Reissue copies role and history from the **stored row**, never from caller input, so a
reissue cannot silently escalate the offer.

The recipient is copied too unless the caller replaces it. `recipientEmail: null` is
**Retry** — the same offer to the same person — and preserves the stored constraint; a
value is **Change email** and replaces it. This matters because dropping the constraint on
Retry would silently widen an invitation meant for one mailbox into one anybody signed
into the Home could accept, which is not what a Retry button asks for. There is
deliberately no input that converts an email-bound invitation into a transferable one:
that widening would need its own explicit intent.

## Retry identity

`create` and `reissue` carry a `requestKey`, so a lost HTTP response cannot mint or retire
a second bearer. Both use the existing repeat-key facility — the same one the Team and
Group create owners use — scoped to the operation, the actor, and the Home-local target:

```text
teams.invitations.create:<actorAccountId>:<teamId>:<requestKey>
teams.invitations.reissue:<actorAccountId>:<teamId>:<invitationId>:<requestKey>
```

The recorded value is a **payload digest and a row id, never a token**. A retry therefore
recovers *which invitation exists* and answers with `joinUrl: null`; the secret it cannot
recover is exactly why that answer directs the manager to explicit reissue. The same key
carrying a different payload is `team_conflict`, not a silent second invitation and not a
silent overwrite of the first. Keys are actor-scoped, so two managers who generate the
same key never collide. The window is 24 hours: it protects one lost response, not a
durable operation history. A replayed create delivers no mail — re-sending there would be
the hidden repeated delivery that explicit reissue exists to replace.

This is that existing facility scoped to two operations. It is not a general Action
ledger, not a receipt framework, and emphatically not a bearer store.

## Acceptance

`acceptTeamInvitationInTx` runs in one transaction. The check order is a product contract:

1. unusable bearer, inactive Account, and archived Team are answered before anything is
   consumed;
2. an **existing member is answered before the terminal checks**, so a colleague who
   already belongs cannot burn a still-transferable link;
3. the conditional consume runs and the database picks the single winner;
4. `admitTeamMemberInTx` creates the membership and mints the history horizon from the
   same transaction clock;
5. a failed admission throws, rolling the consume back.

There is never a consumed invitation without a membership, nor a membership without a
consumed invitation. If the consume loses a race, the row is re-read once so the caller
receives the real terminal reason instead of a guess.

The inviter's current role is deliberately **not** rechecked. Revocation and archive are
the explicit lifecycle controls; failing a valid link because the inviter changed teams
would be an undocumented dependency on an unrelated organizational change.

Email-bound invitations ask the Account/email lane, inside the same transaction, whether
the accepting Account owns the exact normalized address. Explicit acceptance may attach
that exact invited mailbox through the Account/email owner in the same transaction.
Fresh native provisioning instead rejects a different normalized submitted mailbox with
`email_mismatch`, without consuming the invitation or writing Account facts.

Structural admission and protected Team authentication are separate. A valid invitation
may admit an Account through a Home-allowed method even when that credential cannot
satisfy the Team's authentication policy. Protected Team operations still enforce that
policy; admission never manufactures qualification evidence.

### Typed outcomes

`joined`, `already_member`, `not_found`, `expired`, `revoked`, `used`, `team_archived`,
`account_inactive`, `email_mismatch`, `feature_unavailable`. These are not collapsed into a
generic error: each is a user-recoverable state with one useful next action. `joined` and
`already_member` return the Team so the client can offer **Open Team** without a second
lookup.

In unreleased 0.3, unauthenticated preview keeps unknown and malformed bearers generic.
For a known bearer, its existing `unavailable` outcome may carry an optional typed
`reason`: `expired`, `revoked`, `used`, `team_archived`, or `teams_disabled`. The join
surface reuses acceptance’s terminal copy and fresh-link repair, or the Home’s Teams
settings repair when disabled. It discloses no additional invitation or Account identity.
Matching Protocol, server, and UI source reload together; older strict development
readers reject the additional field. There is no released compatibility adapter.

## Preview

Preview never consumes and never mutates: opening a link — including by a mail-security
scanner — cannot join a Team. Acceptance always requires an authenticated, explicit
request.

It discloses only the Home identity, the Team identity and branding, the offered role and
history scope, expiry and current state, and a masked recipient. It omits the roster,
provider bindings, the raw and digested token, and internal actor identity.

An authenticated `auth/entry` request can resolve the same bounded preview from an opaque
post-authentication continuation. The existing continuation owner checks the exact Account,
Team and expiry before the invitation owner rechecks the offer. Reading it consumes
nothing; another Account receives only an unavailable result. The continuation remains
Account-bound and is not an Account-switch or transferable invitation capability.

Team accent is derived from the opaque Team id, never persisted, so a rename cannot change
a Team's colour. The Home storage disclosure is `null` when the Home publishes no storage
policy: the join screen then shows no disclosure rather than asserting a mode it cannot
substantiate.

## Join link and redaction

```text
<configured application origin>/join/<token>?target=<Homes explicit-target carrier>&targetBinding=<bearer-derived binding>
```

`buildTeamJoinUrl` is a thin wrapper over the Homes-owned carrier: it neither encodes nor
parses the descriptor. The application origin is a renderer, never the Home authority; an
origin carrying credentials, a query, or a fragment is refused.

For a Home the device has not saved, the builder derives a domain-separated HMAC-SHA256
key from the invitation token and authenticates the exact opaque `target` value. The join
route requires the canonical unpadded-base64url binding before it parses the target,
probes an endpoint, adopts a Home, or sends preview, authentication, or acceptance data.
A missing, malformed, or mismatched binding makes a descriptor/unknown-Home development
link invalid and it must be reissued; there is no legacy reader for that unreleased
acquisition shape. A binding-less identity-only link can resolve only to one already-saved
Home profile and cannot supply or adopt an endpoint.

This is target integrity within a deliberately transferable bearer. Anyone holding the
complete token can recompute the binding, so it is not a signed Home identity. Comparing
the identity later observed from the Home with the descriptor is a consistency check
before bearer disclosure, not independent cryptographic authentication of that Home.

The bearer stays in the **path** precisely so the shared capability redactor,
`redactPublicShareCapabilityUrl`, templates it in server request logs, Fastify errors,
Sentry, and client navigation logging while preserving the nonsecret `?target=` for
operators. API calls keep the bearer out of URLs entirely by sending it in a POST body.

## Transports

All POST, behind the `teams` feature gate, thin over one canonical service:

| Path | Intent |
|---|---|
| `/v1/teams/invitations/create` | create; returns the bearer once |
| `/v1/teams/invitations/list` | retained rows including terminal provenance |
| `/v1/teams/invitations/revoke` | same-state safe |
| `/v1/teams/invitations/reissue` | invalidate old bearer, mint replacement |
| `/v1/team-invitations/preview` | public pre-auth, read-only |
| `/v1/team-invitations/accept` | authenticated, explicit |

Routes authenticate, parse strict protocol input, call the service, and map typed results
to HTTP. They hold no role comparison, invitation consumption, or membership decision.

Refusals speak the one shared Team error vocabulary (`TeamErrorCodeV1`) through its one
status mapping (`teamErrorHttpStatusV1`), so a domain result cannot mean two different
things depending on which path produced it:

| Code | Status | Meaning |
|---|---|---|
| `team_forbidden` | 403 | the actor may not do this |
| `team_not_found` | 404 | absent or unreadable — never distinguished |
| `invitation_not_found` | 404 | not this Team's invitation, or absent |
| `team_archived` | 409 | the Team withdraws mutations |
| `invitation_not_active` | 409 | already accepted, revoked, or expired |
| `invitation_email_unavailable` | 409 | this Home cannot send mail or render a link |
| `invalid_team_input` | 400 | the address the normalization owner refused |

`registerApiRoutes` composes the family with four injected owners: the join-link target,
the join-screen Home identity, the verified-mailbox ownership query, and the mail boundary
with its readiness projection. The route family owns none of them.

The client transport (`requestHomeDomain`) reads both the Home-governance and Team code
vocabularies, so a Team surface receives the exact code rather than a bare status.

## Email delivery

An email-bound invitation is refused before anything is written when this Home cannot
deliver it — mail unconfigured, or no application origin to render a link at
(`invitation_email_unavailable`). Refusing beats creating a row nobody can deliver, and it
is what keeps the transferable link the honest alternative the UI offers instead.

The address is normalized by the Account/email owner (`normalizeVerifiedEmail`); the
invitation stores only that normalized value, which is the exact value acceptance later
compares. An address that owner refuses is `invalid_team_input`.

`deliverTeamInvitationEmail` is the one internal hand-off: after the invitation commits and
outside any transaction, the raw bearer travels from the create transaction straight to the
mail boundary and is never returned to the manager, logged, or retained. The invitation
names no inviter — the inviter is not the Home owner and this Home publishes no
authoritative relationship.

`lastEmailDeliveryStatus` and `lastEmailDeliveryAttemptAt` are the entire reloadable
delivery history, written by the mail boundary after the invitation transaction commits.

- `null` means no recorded result. After a crash it does **not** prove no provider
  received the mail; it stays honestly unknown.
- `sent` means the mail boundary accepted submission, never inbox delivery.
- The writer addresses one exact invitation id, so a slow delivery for a bearer that has
  since been reissued can never mark its replacement sent.

There is no `pending` state, attempt table, retry ledger, queue, or counter. Retry is
explicit reissue, not hidden repeated delivery of a recoverable secret.

## Compatibility

Schema and routes are additive with no released Team predecessor. Released `0.2.11`
clients on a new server keep their existing Account, auth, and Session behavior and never
see Team invitations. A new client on an old server hides Team administration through the
`teams` feature bit; a directly opened join link shows update-required for that exact
Home. A missing feature bit alone is not proof of an old binary. No dual reader, dual
writer, legacy shim, or public-share conversion exists.

The join surface uses the exact Home's canonical `teams` feature decision to explain
an unreadable contextual entry. Only explicit unsupported-endpoint evidence produces
the update explanation; malformed entry/preview data is not an old-binary signal.
The contextual entry remains the authority for authentication choices and admission:
a capable cached feature projection cannot override its refusal.

## Remaining integration boundary

- **Bounded explicit-Home carrier.** `resolveTeamJoinLinkTarget` now reads the authenticated
  `HomeConnectionDescriptorV1` publication and emits a descriptor-form `HomeTargetInput` as
  JSON in `?target=`. The Team link builder binds that opaque value to the invitation bearer,
  and the join route verifies the binding before `resolvePortableHomeLinkTarget` parses it through
  `parseHomeTargetInput`, resolves a saved identity when one exists, and otherwise lets the
  join surface adopt the descriptor before it sends the bearer. Failure to publish a
  descriptor fails link rendering closed.

  This is a consumed development path, but it is not yet the final Homes-owned carrier
  contract: the server and client directly serialize/parse JSON, there is no shared bounded
  encode/decode owner, and neither the carrier nor the rendered URL has a documented size
  ceiling or oversized-QR fallback. Those constraints must land at the Homes link owner;
  invitation code must continue to treat the carrier as opaque.
- **Home display name.** `displayName` is the host of the Home's configured canonical
  address, or `null` when it has none. It becomes the Homes presentation projection's value
  once that projection exists; the join screen never substitutes the application origin or
  the inviter for it.
- **Home storage disclosure.** `storageMode` is `encrypted` under `required_e2ee`, `plain`
  under `plaintext_only`, and `null` when the Home admits both — a Home with no single mode
  discloses nothing rather than presenting its current default as a guarantee.
- **Invitation-qualified Account provisioning.** `resolveEffectiveHomeAuthMethodsInTx`
  accepts the bounded `{ kind: 'team_invitation' }` admission evidence, and invitation auth
  entry projects Home-allowed methods independently of protected Team qualification. Native provisioning
  re-resolves the invitation, verifies any recipient mailbox constraint, creates the Account,
  and accepts the invitation in the same transaction. Fresh invitation key-challenge
  finalization also consumes the challenge and creates the ordinary token inside that
  transaction; refusal leaves the one-time proof and invitation usable for retry.
  External Team authorization stores a
  server-held invitation reference and the Team OAuth admission owner consumes it. Ordinary
  closed-Home provisioning remains unavailable; the bearer changes only this exact admission.
- **Resend abuse controls.** Owned by the central authentication rate-limit catalog. The
  mail path adds no second fixed cooldown or hidden retry schedule.

Team archive already revokes outstanding invitations: the Team lifecycle owner calls
`revokeActiveTeamInvitationsForTeamInTx` inside its archive transaction, and restore does
not resurrect them.
