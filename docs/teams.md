# Team lifecycle, policy, and branding

A `Team` is one Home's canonical human collaboration unit. It supplies identity, lifecycle,
restrained branding, and a small closed policy set. It is deliberately **not** an access
evaluator: which Sessions a member may read is Session access's decision, whether they can
decrypt one is key delivery's, and whether a Session is personally relevant is the personal
state owner's. Team administration authorizes Team governance and nothing else.

See also [Session collaboration: access, key delivery, personal state](session-collaboration.md)
for the evaluator that answers those Session questions,
[Team membership, flat Groups, and Session-history horizons](teams-membership-and-groups.md),
[Team invitations and membership admission](teams-invitations.md), and
[Enterprise identity](enterprise-identity.md) for managed identity providers, Team identity
connections, and directory provisioning.

> **Status (0.3 development source).** Team persistence, lifecycle, policy, branding,
> directory, exact-Home HTTP clients, and administration surfaces are implemented behind
> the `teams` feature gate. Narrowed Team authentication policy has server-side catalog
> applicability checks, stale-edit comparison, credential qualification, typed recovery
> failures, and a dedicated client editor. The enterprise-identity owner produces the
> canonical provisioned/JIT admission-mode applicability decision, consumed by Team policy
> mutations. Source presence is not release availability or evidence that the complete
> web/iOS/Android flow has passed its loaded-runtime gate.

## Canonical owners

| Decision or fact | Owner |
|---|---|
| Team identity, name, description, archived state | `apps/server/sources/app/teams/lifecycle.ts` |
| Team policy | `apps/server/sources/app/teams/policy.ts` |
| Team branding bytes, custody, and reference | `apps/server/sources/app/teams/logo.ts` |
| Image decode bounds, fit, re-encode, thumbhash | `apps/server/sources/storage/blob/processImage.ts` |
| Directory visibility, ordering, and paging | `apps/server/sources/app/teams/queries.ts` |
| One actor's Team, Account, membership and capabilities | `apps/server/sources/app/teams/actorContext.ts` |
| A viewer's read-oriented collapse of that context | `apps/server/sources/app/teams/viewer.ts` |
| Team role → capability mapping | `apps/server/sources/app/teams/memberships/capabilities.ts` |
| Whether Teams may be created on this Home | `HomeGovernancePolicy.teamCreationPolicy` |
| Managed GitHub App registration and installation lifecycle | `apps/server/sources/app/integrations/github/githubManagedAppLifecycle.ts` |
| Managed GitHub identity runtime and directory reads | `apps/server/sources/app/integrations/github/githubManagedIdentityProvider.ts` and `githubManagedDirectory.ts` |
| Membership, roles, history horizons | `admitTeamMemberInTx` and the membership owner |
| Who a new share may name (every shareable resource) | `apps/server/sources/app/teams/shareEligibility.ts` |
| Invalidation | `apps/server/sources/app/teams/teamChanges.ts` |
| Wire contracts | `packages/protocol/src/teams/` |

Every route, provisioning adapter, and operator adapter calls these services. Nothing else
writes a `Team` row.

In 0.3 development source, the existing Team summary also carries `directoryMembership`
for viewers who can read the Team's authentication facts. It is `null` when no directory
source manages membership; otherwise it contains only the provider display name and a
coarse `syncing`, `healthy`, or `needs_attention` state. Multiple sources form one name
line and the most urgent state. The directory projection owns the attempt and freshness
decisions. Source and connection ids, schedules, counts, errors and setup data stay in
the manager-only directory projection. An older server may omit this fact; the UI then
shows unknown rather than claiming there is no directory.

The development summary's `counts` includes active `groups` and `archivedGroups`,
read together by `readTeamSummaryCountsInTx` and disclosed under the same
`viewRoster` qualification as the Group lists. The Groups page offers its archived
sequence only when the summary reports an archived count above zero; opening it
still performs the existing separate paginated read. Older summaries may omit
`archivedGroups`, which does not establish that an archived sequence exists.

Home administrators who can read a Team receive the existing coarse membership
totals even when they are not Team members: `counts.members` includes active and
suspended memberships, and `counts.suspendedMembers` is the suspended subset.
The Home-admin directory can therefore show active membership using their
difference, without a second count or a roster read. This does not grant a Team
role or roster access. Without `viewRoster`, `counts.groups` and
`counts.archivedGroups` are `null`; waiting invitations retain their separate
Team-manager qualification. A denied or inactive viewer receives no counts.

## Brokered Provider credentials

In 0.3 development source, an authorized Team member can use a brokered Provider
credential held by another Account on the same Home. The member's Machine presents the
Home-signed Team resource/consumer grant over the native Machine carrier to the
custodian's Machine. The hub binds the signed custodian, target Machine and
EndpointId to itself and the initiator EndpointId to the authenticated peer;
the initiator Account need not equal the custodian Account. Home remains the
resource, membership and consumer-currentness authority, and the source
credential stays with its custodian.

The same development resource update Action accepts a custodian-only
`replacement.custodian` containing the source, disclosure ceiling and broker
placement. Omitted manager-owned fields retain their stored values; a custodian
without management authority need not read or repeat hidden policy, audience or
limits. Explicit changes to those fields still require Team management authority.
The existing revision guard, credential qualification and disclosure narrowing
rules apply. Full replacements and legacy patches remain accepted. An older
server that requires the full replacement rejects a custodian-only input without
changing the resource; clients surface that operation's failure rather than
filling hidden fields with presentation defaults.

The initiator may be a foreign-owned Machine on which the recipient has current
Machine Use admission and the exact Session/AccessKey binding. The Machine grant
owner maps the stored `view` level to Use; broker admission does not require an
Admin grant or create a separate execution grant. Presence and endpoint facts
come from that Machine's actual custodian, while the signed initiator Account
remains the recipient. Open, refresh, model disclosure and request admission
recheck current authority; a retained AccessKey cannot preserve a revoked grant.
The broker still requires distinct initiator and target Machine/endpoint
identities, including for co-hosted daemons, and refuses self-custodian Team use.

The development New Session catalog qualifies entitled model reads with the selected
Agent's admitted Provider applications. Generic resource discovery and each application
retain separate snapshots under the same Home/Account/Team loader; changing Agents
cannot reuse another application's model rows. The snapshot loader gathers ready
demand once per Account/application before asynchronous Action admission and drains
one shared discovery page sequence, while the server qualifies every Team independently.
Each set-shaped page retains the original `teams.credentials.entitled.list` Action's
settings, approval and provenance admission, including one Ask-first request for the
whole Team set. In 0.3 development source, Team reads retain their original invocation
through the shared Action approval waiter: approval delivers the result to the current
caller, while denial or cancellation preserves the exact non-retryable refusal.
Recorded `approval_stale` refusals retain their validated reasons, including
`credential_expired`; expiry remains owned by the approval authority. The
catalog loader still owns demand currentness; a late result cannot revive a catalog
after its final observer leaves, and application sets remain separate. A Home that
does not serve discovery returns the existing unsupported condition. Finite exact-resource
probes keep their own per-Team page walk. Model controls come from the exact
source descriptor through the shared picker, including Team rows. Catalog visibility
and reasoning choices do not bypass native Team preflight refusal, worker compatibility
checks, or experimental-model confirmation.
An answered picker choice survives a retryable unknown catalog-read failure while
the snapshot remains stale and its error stays visible to consumers. A Home-unreachable
outcome, authoritative refusal, explicit invalidation or observer gap withdraws
selection; a reconnect revalidates through the existing catalog loader. Retaining
a picker choice grants no launch authority.
After worker confirmation, New Session checks the selected model's exact current
Team resource and the Agent's declared Provider authentication isolation. A binding
that replaces the Agent's native authentication satisfies credential readiness
without asking the recipient to sign in natively. Installation and current-resource
checks still apply. Standalone native catalog/configuration probes have no Session
authority and retain their Team credential refusal.
Experimental-model approval details request the same Agent-qualified entitled
catalog, matching its existing opaque confirmation source to show the resource and
Team names. Generic discovery may have no model rows; approval display never reads
the custodian's private Provider catalog.
The active Team model choice is scoped to that Agent and clears when the Agent
changes. Editing its controls does not save its backing model id as a native
Account remembered choice; an explicit native or Account model selection clears
the Team source before applying the new selection.

Team and Account broker consumers share the endpoint-discovery owner described
in [Providers](providers.md). Development source preserves the custodian's closed
Provider refusal code through catalog policy, source selection and endpoint
discovery; it does not substitute `resource_unavailable` for a known source
failure. Native upstream usage-limit responses retain their original status and
body. Source Account identifiers and private error context stay with the custodian.
In development source, the recipient revalidates
the Team catalog, its own compatibility consent and the first fresh Home grant
before acquiring the native connection. The carrier rechecks that grant after
dial, sends endpoint discovery as its first stream, then revalidates before
publishing the binding. Slow Home reads therefore do not hold an unused
connection past native's pre-application custody window.
For a failed Team launch, read the recipient's
`[ProviderBroker] Endpoint discovery refused` record for the closed cause,
discovery duration and grant-refresh outcome, then the custodian's
`[ProviderBroker] Machine stream admission refused` record for the admission
class. `broker_refresh_refused` identifies a Home refresh refusal before native
can reduce it to a socket close. A socket close with an accepted refresh still
needs hub/transport evidence; a long daemon-service request alone does not
identify the layer that waited. A close with `refreshOutcome: not_requested`
occurred before the fresh-grant callback and needs recipient transport evidence;
it does not establish a custodian admission refusal.
These diagnostics describe development source,
not proof that a particular loaded daemon or cross-Account live replay passed.

## Identity

`Team.id` is opaque and immutable. Names are presentation:

- duplicate names are permitted, within a Home and across Homes;
- there is no slug, name key, alias table, redirect, or reserved-name list;
- stored names are normalized for display only — NFC, collapsed internal whitespace,
  trimmed — by `normalizeTeamNameV1`, which never folds case, because a normalized name
  must not become a uniqueness key;
- a rename changes nothing about routing, links, or visual identity.

The visual accent and monogram derive deterministically from the Team ID at the shared
avatar renderer. No accent is persisted and none derives from the name.

One server database is one Home, so the server API uses bare `teamId`. Only the multi-Home
client qualifies it as `{ serverId, teamId }`.

### Managed GitHub identity

The development branch can register a GitHub App for a Home or Team and bind verified
organization installations to managed identity-provider instances. One registration owns
the App identity and write-only credentials; one installation owns the exact GitHub
organization, installation id, observed permissions and verification state. A Team may use
its own registration or an eligible Home registration, but every consumer resolves through
the same registration and installation lifecycle.

Authorization has one owner for both kinds. A Home-owned registration asks the Home
governance authority for `manageAuthentication`. A Team-owned registration is that Team's
identity administration, so it goes through `authorizeTeamIdentityAdministrationInTx` — the
same membership, capability and credential-qualification decision the Team's OIDC providers,
connections and directory sources already use. A restricted Team therefore holds its own App
exactly as it holds every other identity surface: an administrator whose current credential
does not satisfy the Team's accepted policy cannot list, create, edit, verify or remove it.

GitHub's setup and verification returns are browser redirects that carry no Happier
credential, so the manifest attempt and its installation continuation persist the
authentication facts the server stamped on the initiating request, and the finalizer re-runs
the same authorization with them before anything is written. It re-decides rather than
replaying a stored answer: a Team that stops accepting the administrator's credential between
starting and finishing stops the flow.

GitHub.com setup has a manifest-assisted path. The server authorizes the administrator,
creates a one-time state bound to the requested Home or Team, returns the GitHub manifest
setup URL, and consumes that URL once to render a server-owned form that posts the manifest
to GitHub. The shared callback converts GitHub's one-time code and stores the returned private
key and client secret encrypted. GitHub Enterprise Server uses the manual path:
the administrator supplies the App identifiers and credentials after creating the App on
the approved enterprise origin. List responses expose credential health booleans, never the
credential values.

An installation does not become usable because an administrator typed its id. Verification
starts a fresh OAuth proof with the registered App, checks the returned GitHub user, and uses
an installation token to prove that user administers the exact organization. The callback is
bound to the actor, owner, registration revision, security revision, installation revision,
network-policy fingerprint, installation id, and organization id. A changed fact makes the
attempt fail closed. Successful verification records the observed organization identity,
permissions, repository selection, suspension state, and events.

Installation administration separates current access requirements from prospective setup and
repair requirements. `requirements` includes enabled Home identity providers, enabled Team
providers with an enabled connection, and directory sources that are not paused.
`prospectiveRequirements` also includes disabled provider drafts and paused directory sources,
so administrators can see the grants needed before enabling or resuming them. Both use the same
consumer requirement union as readiness checks; neither projection grants access. The optional
prospective field is absent on older development servers, where clients retain the older
undifferentiated display.

Managed identity and directory consumers require a verified, unsuspended installation, a
verified registration, current credentials, the required organization-member permission,
and an eligible Home/Team owner. The identity-provider instance is then the public selection
unit; callers do not select a raw registration or reconstruct readiness. User OAuth for that
instance uses its own exact callback path, `/v1/oauth/<provider-instance-id>/callback`, which
must be added to the GitHub App after the instance is bound.

Both owners administer their registrations through one composition. Home Administration ·
Policies and Team Settings · Authentication contribute the same GitHub Apps list, detail, and
editor with a different owner and different destinations, so manifest-assisted setup, manual
GitHub Enterprise Server setup, secret rotation, installation verification, and installation
removal read identically wherever the App is owned. A Team keeps its own list under
Authentication because a registration exists before any installation is verified: without it
a Team administrator would see the provider reported as setup-unavailable with nowhere to
finish it. Team-owned registrations live at
`/settings/teams/:serverId/:teamId/authentication/github-apps/:registrationId`, and
manifest setup returns there rather than to the Authentication overview.

The managed App currently serves identity and organization-directory consumers. A managed
repository-provider consumer has not landed on the development branch, so registration or
installation verification must not make repository access appear available.

## Capabilities

The server returns `TeamCapabilitiesV1` with every Team projection and clients render it.
A client never reconstructs a capability from a role, and a projection is never a substitute
for the authorization the mutation itself performs: every mutation re-reads the actor's
Account status, Home authority, Team membership, and the Team's archived state inside its
transaction after ordered Account admission. In development source, Team creation,
archive/restore, direct member addition, credential-resource creation, and credential
withdrawal (resource deletion, external-key revocation, limit removal, and direct-material
withdrawal) use exclusive admission of their complete Account audience before authority
reads and run at ReadCommitted isolation. Withdrawal includes a departed custodian in
that audience and rereads resource identity after the Team lock. The existing
audience rechecks and resource-specific locks preserve their mutation invariants while
unrelated Account publications cannot repeatedly invalidate a Serializable snapshot.

Role alone never makes every boolean true. An inactive Account, a suspended membership, or
an archived Team each withdraw capabilities the role would otherwise imply.

Home `owner`/`admin` authority (`manageAllTeams`) grants Team **governance only** —
visibility, metadata, and archive/restore. It does not create membership and does not grant
`manageMembers`, `managePolicy`, `manageInvitations`, `manageGroups`, or any content access.

### Guest

`guest` is an active, rostered member that receives no Team-principal or Team-default
eligibility and no governance capability. Only a direct Account grant or an explicit Group
grant authorizes a guest. `isTeamPrincipalRoleV1` is the single predicate expressing that
exclusion; downstream access and entitlement owners consume it rather than respelling it.
The admission history-horizon choice is hidden for `guest` for the same reason — offering it
would promise access the role does not carry.

## Lifecycle

### Creation

`teams.create` commits the Team and its initial owner **atomically**. A failure to admit the
owner rolls the whole transaction back, so an ownerless Team cannot exist.

- Home policy decides who may create: `self_service`, `managed_only` (owner/admin), or
  `disabled`. The database and Personal Home default is `managed_only`.
- `home.governance.eligibility.get` is the member-facing answer. Besides `teamsEnabled`,
  `createTeam` and `createTeamForChosenAccount`, it gives an **active** Account the creation
  policy class (`teamCreationPolicy`), the active owners' then administrators' display labels
  (`administratorNames`: names only, never ids or emails) and `showTeams`, whether this viewer
  is offered the Teams destination. An Account that is not active gets none of the three. They
  are optional on the wire: a client treats their absence (an older Home) as "Teams shown" and
  names the refusing Home instead of its administrators. This relaxation of the minimum
  eligibility contract is a 2026-09-26 user ruling (`apps/server/sources/app/home/governance/homeGovernanceService.ts`).
- `teamsVisibleToMembers` ("Show Teams to members", Home administration → Policies) is part of
  the same revision-guarded Home policy document and authorized like the creation policy
  (owners and admins). It defaults to on, and a Home that never stored it shows Teams. When it
  is off, a member who belongs to no Team is not shown Teams. Members of a Team always are,
  and administrators are unless creation is `disabled`: with creation off, only Accounts that
  belong to a Team see the destination. Changing it wakes every active Account, and Team
  membership changes wake the eligibility answer too.
- Under managed creation an authorized Home administrator **must** name the
  `initialOwnerAccountId` — omitting it is `invalid_team_input`, because a Team created for
  somebody else must not silently make the administrator its owner. Naming themselves stays
  legal. The administrator does **not** become a member; ordinary self-service creation may
  only make the creator the owner and keeps the creator fallback when the field is omitted.
- The initial owner's membership carries no history cutoff. A new Team has no prior
  Sessions, so a horizon would be a fiction.
- `requestKey` is the caller's retry identity, recorded through the existing repeat-key
  facility scoped to actor and operation. A retry returns the same Team; the same key with a
  different payload is `team_conflict` rather than a second Team or a silent overwrite.

### Archive and restore

`archivedAt` is the one lifecycle state beyond active. There is no hard deletion and no
second soft-delete state.

Archiving:

- hides the Team from active directories (archived Teams are a separate page, not a flag);
- retains the Team, its logo, policies, memberships, Groups, and downstream references;
- in the 0.3 development Machine Preset contract, projects Team-owned Presets as
  archived and prevents new Create/Apply selection; explicitly archiving an
  already inherited archive is an unchanged success, not a separate retirement;
- revokes outstanding invitations in the same transaction — a link that survived archive
  would readmit people to a Team nobody is administering;
- blocks metadata, policy, branding, and membership mutations except restore;
- makes Team- and Group-derived access ineffective at each downstream evaluator;
- does not erase received plaintext or claim cryptographic revocation.

Restoring re-enables the retained facts prospectively. It does not resurrect revoked
invitations, recreate removed members, or rotate keys.

Archiving an archived Team and restoring an active one are unchanged answers that still
re-check authorization, so a repeat cannot be used to learn anything a first call would not
have disclosed.

## Policy

Four closed enums, a nullable accepted-authentication document, and nullable managed Session defaults, each with a named downstream consumer:

| Field | Meaning | Enforced by |
|---|---|---|
| `sessionCreationPolicy` | initial/required Team audience intent for new Team-context Sessions | Session access owner |
| `externalSharingPolicy` | may only narrow external sharing | Session access owner |
| `defaultSessionHistoryAccess` | default admission history intent | membership owner mints the actual horizon |
| `admissionMode` | membership admission intent | invitation/provisioning owners |
| `authenticationPolicy` | inherited or explicitly accepted authentication references | auth-entry and Team access owners |
| `managedDefaults` | Team and Group authoring defaults, without granting resource access | shared managed-defaults resolver and each Session field owner |

There is no rules bag, condition language, Group access-policy override, allow/deny precedence, per-role
permission matrix, or policy revision counter. Resource domains keep their own policies:
credentials, Machines, automations, and repositories do not add fields here merely because
they belong to a Team.

Policy is prospective. A change never rewrites existing Session grants and never rewrites a
membership horizon that was minted once at activation. A mixed patch is authorized field by
field before anything is written and commits wholly or not at all.

### Managed Session defaults

In 0.3 development source, one nullable JSON column stores the strict `ManagedDefaultsV1`
document `{ team, groups: { [teamGroupId]: defaults } }`. The shared schema and per-field
precedence owner are `packages/protocol/src/teams/managedDefaults.ts`. Values cover placement,
Agent permission intent, model selection, and qualified connected-service purposes. New
Session reads the member-qualified context through `useManagedSessionDefaults`. Without a primary
Team context, a draft shared with one Team (directly or through its Groups) reads that Team's
defaults; sharing with several Teams does not choose one by grant order. Its placement,
permission, model, and connected-service owners submit deliberate choices to the shared resolver
at decision time. Defaults update from the existing Team push subscription. A Team model retains
its full V2 selection when the personal V1 carrier cannot represent it; that projection does not
authorize falling back to a personal model. Managed presets still require the existing configurator's
reviewed creation draft before launch.

Saved New Session drafts retain authored choices rather than resolved managed values, so reopening
an untouched draft reads current defaults and a policy lock preserves the person's underlying choice.
A target picked in a draft or supplied by a route, deep link or exact-target seed is explicit,
and remains explicit when that draft is restored. The draft-local `placementExplicit` marker
records that intent. An explicit permission Default uses `permissionModeExplicit` in the same
local supplement, while explicit model Automatic retains the existing `modelSelection: null`.
The permission writer saves the underlying authored mode, keeping untouched Team defaults
eligible for later updates. Older drafts without the permission marker keep their previous
implicit-Default behavior. Carried-over remembered placement, including older drafts without the
marker, ranks below Group, Team and Home defaults; without a managed default, the remembered
target remains selected.

The existing `teams.policy.set` replaces the document under `manageSettings`, or applies a
scoped `managedGroupDefaults` change under existing Team/Group management authority. Omission
preserves the document; `null` clears it. Point and directory projections expose only a
member's applicable Group defaults unless that viewer holds the existing management
authority. Denied Team readers receive no defaults. Malformed storage projects no defaults
and `managedDefaultsStatus: 'repair_required'` for repair through the same writer.

The person path is "Defaults for members" in Team settings (Team layer) and on the Group page
(that Group's layer): `components/settings/teams/defaults/TeamMemberDefaultsSection.tsx`. It reuses
New Session's Machine dropdown, permission options, exact-model picker and connected-account
purpose chooser (Team resources only, since a Team default is chosen for other people), and saves
through the same `teams.policy.set` Action; `memberDefaults.ts` builds the Team replacement or Group
patch. Group disagreement shown there is read from `resolveManagedSessionDefaults`. Machine choices
reuse New Session's preset reader and selectable-offer projection, including Team pool-backed
creation presets. Only saved presets can be defaults; one-off configurations are excluded. The menu
loads presets while open, and a closed field reads only its selected preset for its name. Selecting
a preset stores its existing Home/preset identity without acquiring a Machine; an unavailable stored
target remains in place until explicitly changed or cleared.

Defaults preselect choices without copying them into Account settings. Locked policy values
outrank explicit choices; otherwise precedence is explicit choice, deliberate member defaults, agreeing Group,
Team, Home, then unlocked policy. Disagreeing Groups fall through per field/purpose. Only the
[organization policy file](organization-policy.md#session-defaults) locks controls. Existing
Team-change push and member-qualified Team snapshots supply updates; no additional polling
or defaults storage is introduced by the precedence resolver. Home defaults are stored in
`HomeGovernancePolicy.sessionDefaults` and projected in Team policy as `homeDefaults`;
machine policy remains a separate source.

The receiving daemon's `session.spawn_new` admission fills unset permission, model and
qualified connected-service facets through that same resolver. It reads the acting Account's
saved settings and member-qualified Team/Group or Home projection; requester credentials and
catalogs stay bound to that Account. New Session keeps its preview resolution and sends those
values as explicit choices. The existing configuration snapshot carries an explicit Automatic
model as `model.value: null`; it remains explicit at admission. Persisted defaults do not gain
nullable model entries.

Every spawn request already names an exact execution target, so placement is explicit at this
boundary. A conflicting locked policy placement returns `permission_denied`; admission never
redirects the selected daemon or creates a preset. Unlocked placement defaults remain part of
selection before that exact-target request. File-policy locks retain their machine-local owner.

Home, Team and Group Machine defaults share one eligibility owner: saving requires
the Machine to be usable by every active member receiving that layer. In unreleased
0.3, a refused save returns `managed_default_machine_not_member_usable` through the
policy route and Action. The defaults editor asks the administrator to share the
Machine with the members or choose another. Sharing with the administrator alone
does not establish member access. If access later changes, New Session falls back
to a Machine in the member's own usable inventory.

### Accepted authentication

`Team.authenticationPolicy` is a nullable column whose meaning is `null` = inherit the
Home's applicable accepted authentication, non-null = one strict versioned explicit
selection.

The canonical inherit/restricted selector codec is owned by the enterprise identity lane and
**imported, never forked**: `TeamAuthenticationPolicyV1Schema`,
`TeamAcceptedAuthenticationV1Schema`, and `normalizeTeamAuthenticationPolicyV1` in
`packages/protocol/src/auth/entry.ts`. Selectors are `{ kind: 'home_method', methodId }` or
`{ kind: 'team_connection', connectionId }`; a restricted selection must be non-empty and
free of duplicates.

Implemented in the 0.3 development source:

- the strict Protocol codec rejects empty, duplicate, malformed, and unbounded connection
  references, and its normalizer gives selectors a stable tagged-id order;
- `teams.policy.set` accepts the field — omitted leaves it unchanged, while `null` or
  `{ mode: 'inherit' }` stores database null so inheritance has one representation;
- identity narrowing requires `manageAuthentication` while the Session-policy fields require
  `managePolicy`, authorized before anything is written, so a permitted Session-default edit
  can never clear an authentication narrowing;
- `TeamPolicyV1` projects the stored value, and changes publish the ordinary invalidation.
- auth entry applies inherited or restricted policy through the shared resolver; malformed
  stored policy fails closed;
- the shared static resolver preserves every configured choice, marks exact current choices
  usable or unavailable, and answers whether removing one reference would leave another usable
  OR alternative;
- `setTeamPolicyInTx` resolves Home methods and Team connections inside the deciding
  transaction, rejects unusable references with `team_authentication_policy_unavailable`,
  rejects an out-of-date prior value with `team_authentication_policy_conflict`, and requires
  current credential evidence both against an existing narrowing and against a replacement;
- the narrow Home administrator owner-recovery operation remains separate from ordinary Team
  policy mutation.

The Team authentication destination includes the narrowed-policy selector/editor. It preserves
the administrator's draft across a stale comparison, requires deliberate acknowledgement of
the refreshed comparison basis before resubmission, and writes only through `teams.policy.set`.
The editor offers Team-owned enabled connections and preserves already-selected Home methods
without inventing a second Home-method catalog. Teams are on by default
(`HAPPIER_FEATURE_TEAMS__ENABLED=0` is the operator opt-out); the composed loaded-runtime
journey is a release check owned by release automation and human QA, separate from the Home
feature decision.

In 0.3 development source, `resolveTeamAdmissionModeApplicabilityInTx` in
`apps/server/sources/app/teams/identity/teamAdmissionModeApplicability.ts` produces the
canonical provisioned/JIT availability decision. Provisioned admission requires completed
directory evidence allowed by Home policy. JIT requires Home policy permission and an enabled,
connected Team identity connection with an available OAuth runtime. The Team policy owner
consumes that typed result and rejects an unavailable mode with
`team_authentication_policy_unavailable`; it does not parse provider evidence or infer support
from connection rows locally. The producer's presence does not certify the remaining mounted
consumer and loaded-runtime journeys.

## Live Session presence

The 0.3 development source projects who is currently viewing a readable Session through the
existing user-scoped Socket.IO connection. This is ephemeral collaboration state, not durable
activity or attention:

- each mounted Session surface contributes to one Home-qualified visible-Session replacement;
- the server re-resolves current Session access for each socket's exact credential before it
  deduplicates multiple qualified tabs or devices into one Account viewer;
- snapshots contain only the canonical safe Account summary and the current typing boolean;
- typing requires current `submitAgentInput` authority, expires on the server-owned lease, and
  is cleared on replacement, disconnect, or lost authority;
- the current authorized snapshot is complete. Protocol does not impose a viewer or visible-
  Session count derived from Engine.IO's inbound byte limit.

Committed Team authentication-policy, accepted-connection, provider-security, and provider-
availability changes invalidate only Sessions whose Team or Group grants depend on the affected
Team. The ordinary Session projection is refreshed and the presence service rechecks each live
socket's exact credential before Account-level deduplication. This is an authentication-context
transition, not structural access loss: it does not delete grants, Follow preferences, read state,
drafts, recipient keys, or other personal Session state.

Missing, stale, unsupported, or disconnected evidence is unknown. Clients may retain a previous
observation as explicitly stale context, but they do not turn generic Account or Session activity
into online/offline claims, and a missing snapshot never means “nobody is here.” A live viewer or
typing transition does not write read state, unread state, Follow policy, My Work, Activity,
badges, or notifications.

Memory-adapter rooms are valid only for a single API process. A clustered Home must use the
Redis Streams Socket.IO adapter described in [deployment](deployment.md#socketio-redis-cluster-transport)
so room discovery, exact-socket eviction, typing, and replacement snapshots cross API replicas.
This section describes current development architecture; the required loaded web/native and
two-node policy-loss journeys are not yet established as stable or preview availability.

## Branding

The UI contract is the shared `ImageRef`; the storage contract is Team-owned.

- The submitted payload is inline base64 with a declared MIME type. PNG and JPEG only —
  the accepted set the image processor already supports. A payload whose bytes do not match
  its declared type is rejected rather than quietly re-labelled.
- Two independent bounds protect two different resources: 8 MiB of decoded source bytes
  (realistic native-picker output) and 16,777,216 source pixels, which is the decoder's
  64 MiB raw-RGBA working set. Only the pixel bound stops a decompression bomb, which is
  small on the wire and enormous in memory. The route narrows the shared HTTP body ceiling
  to one maximal payload plus its envelope.
- The published object is always **re-encoded** from decoded pixels at a deterministic
  512 px square centre-crop, never upscaled. Re-encoding is also the security property: an
  unrelated payload appended to a valid image is not carried forward, and the returned
  dimensions, MIME type, extension, and thumbhash describe the published bytes.
- Objects live under `public/teams/<teamId>/logo/`. The path is derived from the
  authenticated Team, never accepted from a caller, and deletion refuses any path outside
  that prefix.
- Metadata is the `Team.logo` column — `{ path, width, height, thumbhash }`. The public URL
  is resolved at projection time from the current blob backend, exactly as Account avatars
  resolve it.

Custody is why this is not `uploadImage`: an Account-owned `UploadedFile` row is deleted
with its uploader during Account erasure, which would strip a company's branding when an
employee leaves. A Team logo has no `UploadedFile` row and no uploader-owned path, so
erasure cannot select it.

Replacement commits the new reference first and then deletes exactly the reference it
displaced, read inside the committing transaction — so concurrent replacements can only
delete the object they actually superseded. A refused or failed commit deletes only the
candidate it just uploaded and never touches the current logo. Blob deletion is best-effort
and idempotent; there is no cleanup queue.

Archive retains the logo, so restore needs no re-upload.

## Share eligibility

In 0.3 development source, one rule decides who a new share may name, for every shareable
resource: Sessions, Machines, Artifacts (including Project documents), Discussions,
Saved Secrets and Project Source audiences. The subject must be an accepted friend, an
active co-member of a current Team the sharer belongs to, or a Team or Group of a Team the
sharer belongs to. `shareEligibility.ts` decides it inside each writer's transaction;
resource writers consume its verdict and keep their own wire codes (Sessions keep the
`session_access_` prefix). The collaboration people directory projects the same Account
predicate, so share pickers offer only eligible people.

The rule admits new shares only. An existing grant keeps working and stays removable after
the friendship or membership ends, and nothing sweeps it; Team-derived grants still follow
live membership. Writers that know the existing grant (Sessions, Machines, Artifacts,
Discussions, Project Source audiences) also keep it editable. Saved Secrets replace their
whole audience, so a retained Account that is no longer eligible must be removed before
that audience can be changed. Resource-specific authority (who may manage a resource's grants,
Team settings authority for Project Source Team audiences, recipient encryption readiness)
is separate and unchanged.

## Directory

One Home-local page ordered by `(normalized name, teamId)`.

- `scope: 'member'` lists the viewer's readable Team summaries. A suspended native
  membership remains discoverable for self-leave. When Team authentication qualifies,
  `leave` is its only membership capability; without independent Home authority it has
  no summary counts or roster/content access. A suspended source-managed
  membership with neither Team visibility nor self-leave is withheld.
- `scope: 'administered'` is an explicit request reserved to Home `manageAllTeams`. It does
  not widen the member directory and does not confer membership.
- `archived` selects the active or archived page. They are separate queries, which keeps one
  stable ordering per page sequence. The Teams destination observes the archived sequence only
  while **Show archived** is open; offering that control does not read the archive.
- The cursor is opaque, bound to the exact scope and archive filter that produced it, and
  applied **after** visibility and archive predicates. A forged or replayed cursor is a
  position, never an authority, and a cursor from a different query is rejected with a typed
  error rather than silently restarting at page one.
- Duplicate names remain correctly ordered and complete because the immutable ID breaks
  ties.
- Cursors advance over scanned membership rows, including withheld summaries. A page may
  therefore contain no items and still carry a `nextCursor` to continue the directory scan.

An unreadable Team and an absent one produce the same answer, so Team existence cannot be
probed. Team summaries never enumerate other Home Accounts.

## Realtime

Mutations publish `AccountChange` with `kind: 'account'` and entity ID `teams`, and clients
reload the canonical HTTP projection. The audience is every current reader of the state that
changed:

- the Team's **current membership**, whose directory rows, capabilities, and Team detail
  change;
- every **active Home `owner`/`admin`**, because `manageAllTeams` gives them the Home-level
  administered Team directory. Creating, renaming, archiving, or restoring any Team changes
  that list even though no administrator is a member, so an already-mounted administrator
  directory would otherwise stay stale. Refetch-on-view is not a substitute for invalidating
  a live projection;
- any **other Account the mutation affects**, such as the initial owner of a Team created for
  somebody else.

The administrator set is the same bounded audience the Home-governance publisher already
wakes, so this is a fanout over two reader sets rather than a Home-wide broadcast. Inactive
Accounts are excluded: they hold no authority and therefore have no administered directory to
invalidate. The three sources overlap freely, and because `markAccountChanged` allocates a
cursor by incrementing `Account.seq` once per call, the audience is a set — one mutation
advances any one Account's sequence exactly once.

Every Team mutation shares this audience, including the membership, invitation, and
directory-source owners that call the same publisher. A wake is a cursor bump plus a refetch
of the canonical projection, so one audience is preferred over asking each caller to decide
who reads what.

There is no Team `ChangeKind`, socket room, roster push stream, event log, polling timer, or
hint schema. Older clients keep their existing broad `account` refresh and still advance
their cursor safely.

## Transports

All POST, all behind the single `teams` feature gate. A missing or malformed feature bit
fails closed.

| Path | Intent |
|---|---|
| `/v1/teams/list` | directory page for a scope and archive filter |
| `/v1/teams/get` | one Team summary |
| `/v1/teams/create` | create Team plus initial owner, retry-safe |
| `/v1/teams/update` | name and description |
| `/v1/teams/policy/set` | closed policy patch, whole-or-nothing |
| `/v1/teams/logo/set` | publish branding from inline bytes |
| `/v1/teams/logo/remove` | clear branding |
| `/v1/teams/archive` | archive, revoking outstanding invitations |
| `/v1/teams/restore` | restore |

Routes authenticate, parse the strict protocol input, call one canonical service, and map
the typed domain result to HTTP. They hold no role comparison, archive rule, membership
transition, or downstream resource decision.

Errors use one shared code enum and one status mapping: input `400`, denied `403`,
absent or unreadable `404`, conflicting or archived `409`.

## Explicitly rejected

Global or Home-local name uniqueness; slugs, redirects, aliases, name reservation; custom
roles or role inheritance; generic RBAC/FGA; nested Groups or deny precedence; Team-specific
token issuance; Team-owned Session access or encryption; retrospective policy migrations;
hard Team deletion; stored or custom accent colors; custom Team CSS or HTML branding; a Team
event store, audit platform, socket room protocol, or generic cursor/filter framework.
