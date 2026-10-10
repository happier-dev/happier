import {
    AUTH_ENTRY_RESPONSE_MAX_UTF8_BYTES_V1,
    AuthEntryProjectionV1Schema,
    type AuthEntryProjectionV1,
    type AuthEntryProviderPresentationV1,
    type AuthEntryProviderUnavailableReasonV1,
    type AuthEntryRequestV1,
    type TeamEntryUnavailableReasonV1,
    type TeamInvitationPreviewV1,
} from '@happier-dev/protocol';
import { normalizeAuthMethodId, readServerEnabledBit } from '@happier-dev/protocol';
import { normalizeVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';
import type { AuthTokenAuthenticationEvidenceV1 } from '@happier-dev/protocol';

import {
    resolveEffectiveHomeAuthMethods,
    resolveEffectiveHomeAuthMethodsInTx,
    type EffectiveHomeAuthMethodsResult,
} from '@/app/auth/methods/effectiveHomeAuthMethods';
import { listProviderDescriptorsInTx } from '@/app/auth/providers/identityProviderCatalog';
import { resolveAuthFeature } from '@/app/features/authFeature';
import { resolveFeaturesFromEnv } from '@/app/features/registry';
import {
    resolveTeamInvitationAuthEntryContextInTx,
    resolveTeamInvitationAuthEntryReferenceContextInTx,
    previewTeamInvitationByReferenceInTx,
    type TeamInvitationAuthEntryContext,
} from '@/app/teams/invitations/invitationService';
import { readTeamInvitationPostAuthContinuationInTx } from '@/app/teams/invitations/postAuthContinuation';
import { resolveTeamAuthEntryContextInTx, type TeamAuthEntryContext } from '@/app/teams/authEntryContext';
import {
    qualifyTeamOperationAuthenticationInTx,
    resolveTeamActorContextInTx,
} from '@/app/teams/actorContext';
import { isEffectiveTeamMembership } from '@/app/teams/memberships/effectiveMembership';
import { listTeamIdentityConnectionsInTx } from '@/app/teams/identity/teamIdentityConnectionLifecycle';
import {
    isDirectorySourceCompletedEvidenceAllowedInTx,
    resolveDirectorySourceProviderKind,
} from '@/app/teams/directory/directorySourcePolicy';
import { inTx } from '@/storage/inTx';
import { isAuthEmailDeliveryReady } from '@/app/auth/email/resolveAuthEmailDelivery';
import {
    ACCOUNT_DISPLAY_PROFILE_SELECT,
    projectAccountDisplayProfileV1,
} from '@/app/account/profile/accountDisplayProfile';
import { resolveJoinScreenHomeIdentity } from '@/app/teams/invitations/joinScreenHome';
import type { JoinScreenHomeIdentity } from '@/app/teams/invitations/invitationService';
import { readNativeAuthOneTimeOperation } from '@/app/auth/email/nativeAuthOneTimeOperations';
import { resolvePublicSignupProvisioningActionMode } from '@/app/integrations/publicUrl/publicSignupProvisioningPolicy';
import { createWorkosAdministrationAdapter } from '@/app/integrations/workos/workosAdministrationAdapter';
import { resolveWorkosPlatformConfig } from '@/app/integrations/workos/workosPlatform';
import type { Tx } from '@/storage/inTx';

import {
    resolveTeamAuthenticationPolicyInTx,
    type ResolvedTeamAuthenticationPolicyInTx,
} from './resolveTeamAuthenticationPolicy';

/**
 * The verified caller, when the request carried an ordinary present-user Home
 * credential. It is supplied only by the route's canonical verification owner;
 * an absent, invalid, ineligible or restricted credential simply omits it and
 * the projection stays anonymous.
 */
export type AuthEntryPrincipal = Readonly<{
    accountId: string;
    authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
}>;

type ResolveAuthEntryContext = Readonly<{
    env: NodeJS.ProcessEnv;
    emailDeliveryReady?: boolean;
    principal?: AuthEntryPrincipal | null;
    /**
     * The requesting address as the route attributes it. The public-signup
     * provisioning restriction is decided per address, so a caller that cannot
     * attribute one publishes the unrestricted catalog, as every finalizer
     * still enforces the restriction on its own request.
     */
    requestIp?: unknown;
}>;

/** What the Home-method action projection needs to know about the request. */
type HomeActionRequestContext = Readonly<{
    env: NodeJS.ProcessEnv;
    principal: AuthEntryPrincipal | null;
    requestIp?: unknown;
    /** Whether a password-reset link can be mailed now; said on the password sign-in action. */
    emailDeliveryReady?: boolean;
}>;

/**
 * Why the three answers are distinct: only a member can be admitted by signing
 * in again, so a `member_unqualified` visitor is offered the Team's accepted
 * methods, while a `non_member` of a directory-provisioned Team can be admitted
 * only by proving the Team provider identity its directory person is bound by.
 */
type TeamMembershipAdmissionState = 'admitted' | 'member_unqualified' | 'non_member';

async function resolveEffectiveTeamMemberInTx(
    tx: Parameters<typeof resolveTeamActorContextInTx>[0],
    input: Readonly<{
        teamId: string;
        principal: AuthEntryPrincipal | null;
    }>,
) {
    if (input.principal === null) return null;
    const actor = await resolveTeamActorContextInTx(tx, {
        teamId: input.teamId,
        actorAccountId: input.principal.accountId,
    });
    if (!actor?.membership || !isEffectiveTeamMembership({
        accountStatus: actor.accountStatus,
        membershipStatus: actor.membership.status,
        teamArchivedAt: actor.team.archivedAt,
    })) return null;
    return actor;
}

async function resolveTeamMembershipAdmissionInTx(
    tx: Parameters<typeof resolveTeamActorContextInTx>[0],
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        teamId: string;
        principal: AuthEntryPrincipal | null;
    }>,
): Promise<TeamMembershipAdmissionState> {
    const actor = await resolveEffectiveTeamMemberInTx(tx, input);
    if (!actor || !input.principal) return 'non_member';
    const qualification = await qualifyTeamOperationAuthenticationInTx(tx, {
        context: actor,
        env: input.env,
        authenticationEvidence: input.principal.authenticationEvidence,
        authenticationAuthority: 'present_user',
    });
    return qualification.ok ? 'admitted' : 'member_unqualified';
}

async function resolveAuthenticatedAccountPresentationInTx(
    tx: Parameters<typeof resolveTeamActorContextInTx>[0],
    principal: AuthEntryPrincipal | null,
) {
    if (principal === null) return null;
    const account = await tx.account.findUnique({
        where: { id: principal.accountId },
        select: ACCOUNT_DISPLAY_PROFILE_SELECT,
    });
    return account ? projectAccountDisplayProfileV1(account) : null;
}

const AUTH_ENTRY_UTF8_ENCODER = new TextEncoder();

export function projectUnavailableHomeAuthEntry(
    reason: 'not_account_service' | 'authentication_policy_unavailable',
): AuthEntryProjectionV1 {
    return AuthEntryProjectionV1Schema.parse({
        v: 1,
        state: 'unavailable',
        scope: { kind: 'home' },
        reason,
        autoRedirect: null,
    });
}

/**
 * Why a Team or invitation destination is unavailable, said only as far as the
 * request has earned. `entry_not_available` is the non-enumerating default and
 * is passed explicitly at every site that must stay opaque; a named reason is
 * only chosen where the request already proved it may see this destination, so
 * naming it discloses nothing the ordinary admission page would not.
 */
function unavailableInvitationProjection(reason: TeamEntryUnavailableReasonV1): AuthEntryProjectionV1 {
    return AuthEntryProjectionV1Schema.parse({
        v: 1,
        state: 'unavailable',
        scope: { kind: 'invitation' },
        reason,
        autoRedirect: null,
    });
}

function unavailableTeamProjection(reason: TeamEntryUnavailableReasonV1): AuthEntryProjectionV1 {
    return AuthEntryProjectionV1Schema.parse({
        v: 1,
        state: 'unavailable',
        scope: { kind: 'team' },
        reason,
        autoRedirect: null,
    });
}

/**
 * Whether the Team's current authentication policy offers any way in. A restricted
 * policy with no currently usable accepted reference is unavailable rather than an
 * admission page with no actions. A successful provider test (activation
 * readiness) is the policy writer's precondition, enforced at policy save; it is
 * not a member-entry gate, so an untested accepted choice still shows here.
 */
function hasUsableTeamAuthentication(policy: ResolvedTeamAuthenticationPolicyInTx): boolean {
    return policy.resolution.status === 'inherit'
        || (policy.resolution.status === 'restricted'
            && policy.resolution.choices.some((choice) => choice.availability === 'usable'));
}

/**
 * The reason a visitor who is already signed in to this Home may be told when a
 * Team refuses entry for its authentication policy alone.
 *
 * A `provisioned` Team takes its membership from a directory; with no usable
 * accepted choice there is no Team provider identity this visitor could prove to
 * bind their directory person, so `directory_delayed` is the truthful answer and
 * telling them to use a different method would send them round a loop.
 * Otherwise a `restricted` policy with no currently usable choice is the Team
 * insisting on a sign-in this visitor cannot use — exactly what `sso_required`
 * says. An anonymous visitor has proved nothing, and an unresolved policy is not
 * a statement about the visitor at all, so both keep the opaque default.
 */
function teamEntryPolicyRefusalReason(
    policy: ResolvedTeamAuthenticationPolicyInTx,
    principal: AuthEntryPrincipal | null,
    admissionMode?: TeamAuthEntryContext['admissionMode'],
): TeamEntryUnavailableReasonV1 {
    if (principal === null) return 'entry_not_available';
    if (admissionMode === 'provisioned') return 'directory_delayed';
    return policy.resolution.status === 'restricted' ? 'sso_required' : 'entry_not_available';
}

function defaultMethodDisplayName(id: string): string {
    return id
        .split(/[_-]+/u)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

/**
 * The one mapping from a provider's safe descriptor to its auth-entry
 * presentation (teams-lane-03/01 §10.2), shared by the Home and Team
 * projectors so neither can drop a field the other carries.
 */
function projectAuthEntryProviderPresentation(input: Readonly<{
    displayName: string;
    ui: Readonly<{ iconHint?: string | null; connectButtonColor?: string | null; supportsProfileBadge?: boolean }> | undefined;
    providerKind: AuthEntryProviderPresentationV1['providerKind'];
}>): AuthEntryProviderPresentationV1 {
    const { ui } = input;
    return {
        displayName: input.displayName,
        ...(ui?.iconHint ? { iconHint: ui.iconHint } : {}),
        ...(input.providerKind ? { providerKind: input.providerKind } : {}),
        ...(ui?.connectButtonColor ? { connectButtonColor: ui.connectButtonColor } : {}),
        ...(ui?.supportsProfileBadge !== undefined ? { supportsProfileBadge: ui.supportsProfileBadge } : {}),
    };
}

function projectHomeAuthenticationActions(
    homeMethods: Extract<EffectiveHomeAuthMethodsResult, { status: 'ready' }>,
    request: HomeActionRequestContext,
    allowedIds?: ReadonlySet<string>,
) {
    return homeMethods.decisions.flatMap((decision) => {
        const methodId = normalizeAuthMethodId(decision.id);
        if (!methodId || (allowedIds && !allowedIds.has(methodId))) return [];
        const ui = decision.ui;
        // Native methods have no provider kind, colour or badge.
        const presentation = projectAuthEntryProviderPresentation({
            displayName: ui?.displayName ?? defaultMethodDisplayName(methodId),
            ui,
            providerKind: ui?.providerKind,
        });
        return decision.actions.flatMap((action) => {
            if (!action.enabled) return [];
            // `connect` attaches a method to the caller's existing Account; a
            // request without a principal has nothing to attach it to, and its
            // only completion lives in the signed-in Account Security flow.
            if (action.id === 'connect' && request.principal === null) return [];
            const mode = action.id === 'provision'
                && request.requestIp !== undefined
                ? resolvePublicSignupProvisioningActionMode({
                    env: request.env,
                    requestIp: request.requestIp,
                    methodId,
                    mode: action.mode,
                }) : action.mode;
            if (mode === null) return [];
            const recommendedProvisionMode = mode !== action.mode
                ? mode === 'keyed' ? 'e2ee' as const : 'plain' as const
                : decision.recommendedProvisionMode;
            return [{
                kind: 'authenticate' as const,
                methodId,
                action: action.id,
                mode,
                origin: 'home' as const,
                // The effective-method owner already resolved the Home's
                // recommended protection for a new Account (deployment default
                // narrowed by the Home governance document). Carrying it with the
                // provision action is what stops a chooser from inventing its own
                // default out of the permitted set; `login`/`connect` act on an
                // Account that already has a stored mode, so they state nothing.
                ...(action.id === 'provision' && recommendedProvisionMode
                    ? { recommendedProvisionMode }
                    : {}),
                // The reset request route mails a link exactly when password sign-in is enabled
                // and mail delivery is ready; the sign-in action says so, so no client offers a
                // "Forgot password?" whose link could never arrive.
                ...(methodId === 'email_password' && action.id === 'login' && request.emailDeliveryReady === true
                    ? { passwordReset: 'email' as const }
                    : {}),
                presentation,
            }];
        });
    });
}

function projectHomeAuthEntryProjection(
    homeMethods: Extract<EffectiveHomeAuthMethodsResult, { status: 'ready' }>,
    request: HomeActionRequestContext,
    allowAutoRedirect: boolean,
): AuthEntryProjectionV1 {
    const env = request.env;
    const actions = projectHomeAuthenticationActions(homeMethods, request);
    const compatibilityAutoRedirect = allowAutoRedirect
        ? resolveAuthFeature(env).capabilities?.auth?.ui?.autoRedirect
        : undefined;
    const autoRedirectMethodId = compatibilityAutoRedirect?.enabled === true
        ? normalizeAuthMethodId(String(compatibilityAutoRedirect.providerId ?? ''))
        : '';
    const autoRedirectAction = autoRedirectMethodId
        ? actions.find((action) => action.methodId === autoRedirectMethodId
            && action.action === 'provision'
            && (action.mode === 'keyed' || action.mode === 'either'))
            ?? actions.find((action) => action.methodId === autoRedirectMethodId
                && action.action === 'login'
                && (action.mode === 'keyless' || action.mode === 'either'))
            ?? actions.find((action) => action.methodId === autoRedirectMethodId
                && (action.action === 'login' || action.action === 'provision'))
        : undefined;
    const projection = {
        v: 1,
        state: 'ready',
        scope: { kind: 'home' },
        actions,
        ...(homeMethods.signInService ? { signInService: homeMethods.signInService } : {}),
        autoRedirect: autoRedirectAction
            ? {
                methodId: autoRedirectAction.methodId,
                action: autoRedirectAction.action,
                mode: autoRedirectAction.mode,
            }
            : null,
    } as const;
    if (AUTH_ENTRY_UTF8_ENCODER.encode(JSON.stringify(projection)).byteLength
        > AUTH_ENTRY_RESPONSE_MAX_UTF8_BYTES_V1) {
        return projectUnavailableHomeAuthEntry('authentication_policy_unavailable');
    }
    return AuthEntryProjectionV1Schema.parse(projection);
}

/** An email hint narrows choices; it never proves identity or admits an Account. */
async function resolveHomeCompanyChoicesByEmail(
    email: string,
    env: NodeJS.ProcessEnv,
    emailDeliveryReady: boolean,
    homeMethods: Extract<EffectiveHomeAuthMethodsResult, { status: 'ready' }>,
): Promise<EffectiveHomeAuthMethodsResult> {
    const mailbox = normalizeVerifiedEmail(email);
    if (!mailbox) return { status: 'unavailable' };
    const domain = mailbox.normalizedEmail.slice(mailbox.normalizedEmail.lastIndexOf('@') + 1);
    const publishedIds = new Set(homeMethods.decisions
        .filter((decision) => decision.ui?.providerKind === 'workos_sso'
            && decision.actions.some((action) => action.enabled))
        .map((decision) => decision.id));
    const connections = await inTx(async (tx) =>
        (await listTeamIdentityConnectionsInTx(tx, { teamId: null }))
            .filter((connection) => connection.state === 'connected'
                && connection.providerKind === 'workos_sso'
                && connection.externalReference.kind === 'workos_sso'
                && connection.externalReference.organizationId !== null
                && connection.externalReference.connectionId !== null
                && publishedIds.has(connection.providerInstanceId)));
    if (connections.length === 0) return { status: 'unavailable' };
    const platform = resolveWorkosPlatformConfig(env);
    if (!platform.available) return { status: 'unavailable' };
    const adapter = createWorkosAdministrationAdapter(platform.client);
    try {
        const matching = await Promise.all(connections.map(async (connection) => {
            const reference = connection.externalReference;
            if (reference.kind !== 'workos_sso' || reference.organizationId === null) return null;
            const domains = await adapter.getVerifiedOrganizationDomains(reference.organizationId);
            return domains.includes(domain) ? connection : null;
        }));
        const matches = matching.filter((connection) => connection !== null);
        if (matches.length === 0) return { status: 'unavailable' };
        return await inTx(async (tx) => {
            const current = await listTeamIdentityConnectionsInTx(tx, { teamId: null });
            for (const connection of connections) {
                const latest = current.find((candidate) => candidate.id === connection.id);
                if (!latest || latest.state !== 'connected'
                    || latest.revision !== connection.revision
                    || latest.providerInstanceId !== connection.providerInstanceId
                    || latest.externalReference.kind !== 'workos_sso'
                    || connection.externalReference.kind !== 'workos_sso'
                    || latest.externalReference.organizationId !== connection.externalReference.organizationId
                    || latest.externalReference.connectionId !== connection.externalReference.connectionId) {
                    return { status: 'unavailable' };
                }
            }
            const effective = await resolveEffectiveHomeAuthMethodsInTx(tx, { env, emailDeliveryReady });
            if (effective.status !== 'ready') return effective;
            const matchedIds = new Set(matches.map((connection) => connection.providerInstanceId));
            const decisions = effective.decisions.filter((decision) => matchedIds.has(decision.id));
            if (!decisions.some((decision) => decision.actions.some((action) => action.enabled))) {
                return { status: 'unavailable' };
            }
            return { ...effective, decisions };
        });
    } catch {
        // Failed verification is not a default/first-match route.
        return { status: 'unavailable' };
    }
}

type TeamConnectionAuthenticateActionV1 = Readonly<{
    kind: 'authenticate';
    methodId: string;
    action: 'connect';
    mode: 'either';
    origin: 'team';
    presentation: AuthEntryProviderPresentationV1;
}>;

type TeamConnectionUnavailableActionV1 = Readonly<{
    kind: 'provider_unavailable';
    methodId: string;
    origin: 'team';
    presentation: AuthEntryProviderPresentationV1;
    reason: AuthEntryProviderUnavailableReasonV1;
}>;

/**
 * The one projector of a Team's identity connections into public auth-entry
 * choices, shared by the Team and invitation scopes (teams-lane-03/01 §10.2).
 *
 * Each choice carries the catalog descriptor's safe presentation: provider kind,
 * display name, icon hint, connect-button colour and profile-badge support. A
 * connection the Team's restricted policy accepts but that cannot run right now
 * is shown with its safe reason (TA-R17 "provider unavailable"), never dropped.
 *
 * `directoryBindingOnly` serves a signed-in non-member of a directory-provisioned
 * Team (§8.1, TA-R19): the only proof that can admit them is a Team provider
 * identity the exact directory binder (inside the provider's `connectInTx`)
 * matches to an imported person. So only a connection that carries a directory
 * source whose completed facts are currently admissible is offered; the binder
 * and the connect finalizer still make every admission decision themselves.
 */
async function projectTeamConnectionActionsInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        teamId: string;
        policy: ResolvedTeamAuthenticationPolicyInTx;
        directoryBindingOnly: boolean;
    }>,
): Promise<Readonly<{
    available: readonly TeamConnectionAuthenticateActionV1[];
    unavailable: readonly TeamConnectionUnavailableActionV1[];
}>> {
    const resolution = input.policy.resolution;
    const usableConnectionIds = !input.directoryBindingOnly && resolution.status === 'restricted'
        ? new Set(resolution.choices.flatMap((choice) =>
            choice.availability === 'usable' && choice.reference.kind === 'team_connection'
                ? [choice.reference.connectionId]
                : []))
        : undefined;
    const acceptedConnectionIds = !input.directoryBindingOnly && resolution.status === 'restricted'
        ? new Set(resolution.choices.flatMap((choice) =>
            choice.reference.kind === 'team_connection' ? [choice.reference.connectionId] : []))
        : undefined;
    const [connections, descriptors] = await Promise.all([
        listTeamIdentityConnectionsInTx(tx, { teamId: input.teamId }),
        listProviderDescriptorsInTx(tx, input.env, { kind: 'team', teamId: input.teamId }),
    ]);
    const directorySources = input.directoryBindingOnly
        ? await tx.teamDirectorySource.findMany({
            where: { teamId: input.teamId },
            select: { id: true, kind: true, state: true, activeReconcileRunId: true, teamIdentityConnectionId: true },
        })
        : [];
    const bindingSources: typeof directorySources = [];
    for (const source of directorySources) {
        if (await isDirectorySourceCompletedEvidenceAllowedInTx(tx, source)) bindingSources.push(source);
    }
    const canBindDirectoryPerson = (connection: (typeof connections)[number]): boolean =>
        bindingSources.some((source) => source.kind === 'workos_directory'
            ? source.teamIdentityConnectionId === connection.id
            : resolveDirectorySourceProviderKind(source.kind) === connection.providerKind);
    const descriptorByProviderId = new Map(descriptors.map((descriptor) => [
        normalizeAuthMethodId(descriptor.reference.id),
        descriptor,
    ]));
    const available: TeamConnectionAuthenticateActionV1[] = [];
    const unavailable: TeamConnectionUnavailableActionV1[] = [];
    for (const connection of connections) {
        if (input.directoryBindingOnly && !canBindDirectoryPerson(connection)) continue;
        const methodId = normalizeAuthMethodId(connection.providerInstanceId);
        const provider = descriptorByProviderId.get(methodId);
        const ui = provider?.descriptor.ui;
        const presentation = projectAuthEntryProviderPresentation({
            displayName: ui?.displayName ?? connection.providerDisplayName,
            ui,
            providerKind: connection.providerKind,
        });
        const runnable = connection.state === 'connected'
            && provider !== undefined
            && provider.descriptor.enabled === true
            && provider.descriptor.configured === true;
        if (runnable && (!usableConnectionIds || usableConnectionIds.has(connection.id))) {
            available.push({
                kind: 'authenticate',
                methodId: provider.reference.id,
                action: 'connect',
                mode: 'either',
                origin: 'team',
                presentation,
            });
            continue;
        }
        if (!acceptedConnectionIds?.has(connection.id) || !methodId) continue;
        unavailable.push({
            kind: 'provider_unavailable',
            methodId,
            origin: 'team',
            presentation,
            reason: connection.state === 'disabled'
                ? 'provider_disabled'
                : connection.state === 'setting_up'
                    ? 'provider_setup_incomplete'
                    : 'provider_unavailable',
        });
    }
    return { available, unavailable };
}

async function resolveTeamAuthEntry(
    teamId: string,
    request: HomeActionRequestContext & Readonly<{ emailDeliveryReady: boolean }>,
    home: JoinScreenHomeIdentity,
): Promise<AuthEntryProjectionV1> {
    const { env, principal, emailDeliveryReady } = request;
    return await inTx(async (tx) => {
        const teamContext = await resolveTeamAuthEntryContextInTx(tx, { teamId });
        if (teamContext === null) return unavailableTeamProjection('entry_not_available');
        const [policy, homeMethods] = await Promise.all([
            resolveTeamAuthenticationPolicyInTx(tx, {
                env,
                teamId,
                policy: teamContext.authenticationPolicy,
                emailDeliveryReady,
            }),
            resolveEffectiveHomeAuthMethodsInTx(tx, { env, emailDeliveryReady }),
        ]);
        if (!hasUsableTeamAuthentication(policy)) {
            return unavailableTeamProjection(
                teamEntryPolicyRefusalReason(policy, principal, teamContext.admissionMode),
            );
        }

        const account = await resolveAuthenticatedAccountPresentationInTx(tx, principal);

        // A caller who is already an effective member may continue when the current
        // credential proves the Team's accepted authentication context. Inherited
        // policy accepts any ordinary Home credential; restricted policy requires
        // one current evidence item matching a usable accepted reference.
        const admission = await resolveTeamMembershipAdmissionInTx(tx, {
            env,
            teamId,
            principal,
        });
        if (admission === 'admitted') {
            return AuthEntryProjectionV1Schema.parse({
                v: 1,
                state: 'already_member',
                scope: { kind: 'team' },
                home,
                account,
                team: teamContext.team,
                actions: [{ kind: 'continue' }],
                autoRedirect: null,
            });
        }
        // A `provisioned` Team's roster comes from its directory. A signed-in
        // Account that is not yet a member may still be the directory person who
        // was imported before it existed: proving the Team provider identity
        // through the authenticated connect flow lets the existing exact binder
        // (inside that provider's `connectInTx`) bind it, and the finalizer then
        // admits only what the directory proves (teams-lane-03/02 §8.1, TA-R19).
        // Home methods can never bind a directory person, so they are not offered
        // here. Only when no connection carries an admissible directory source
        // (none yet, still initializing, paused or failing) is waiting for the
        // directory the truthful answer. A member whose credential merely failed
        // to qualify keeps the ordinary actions below.
        const provisionedNonMember = admission === 'non_member'
            && principal !== null
            && teamContext.admissionMode === 'provisioned';
        if (homeMethods.status !== 'ready') return unavailableTeamProjection('entry_not_available');

        const allowedHomeMethodIds = policy.resolution.status === 'restricted'
            ? new Set(policy.resolution.choices.flatMap((choice) =>
                choice.availability === 'usable' && choice.reference.kind === 'home_method'
                    ? [normalizeAuthMethodId(choice.reference.methodId)]
                    : []))
            : undefined;
        const homeActions = provisionedNonMember
            ? []
            : projectHomeAuthenticationActions(homeMethods, request, allowedHomeMethodIds);
        const { available: teamActions, unavailable: unavailableTeamChoices } = await projectTeamConnectionActionsInTx(tx, {
            env,
            teamId,
            policy,
            directoryBindingOnly: provisionedNonMember,
        });
        if (provisionedNonMember && teamActions.length === 0) {
            return unavailableTeamProjection('directory_delayed');
        }
        const projection = {
            v: 1,
            state: 'admission_required',
            scope: { kind: 'team' },
            home,
            ...(account ? { account } : {}),
            team: teamContext.team,
            // A visitor who already proved an Account and is still not admitted
            // is signed in as the wrong one. Offering another Account is the
            // only remedy the Home can name, and it discloses nothing: the
            // caller already knows which Account they presented. An anonymous
            // visitor gets no such offer, so this cannot become an oracle.
            actions: [
                ...teamActions,
                ...unavailableTeamChoices,
                ...homeActions,
                ...(principal !== null ? [{ kind: 'switch_account' as const }] : []),
            ],
            ...(homeMethods.signInService ? { signInService: homeMethods.signInService } : {}),
            autoRedirect: null,
        } as const;
        if (AUTH_ENTRY_UTF8_ENCODER.encode(JSON.stringify(projection)).byteLength
            > AUTH_ENTRY_RESPONSE_MAX_UTF8_BYTES_V1) return unavailableTeamProjection('entry_not_available');
        return AuthEntryProjectionV1Schema.parse(projection);
    });
}

async function resolveInvitationAuthEntryInTx(
    tx: Tx,
    invitation: TeamInvitationAuthEntryContext,
    env: NodeJS.ProcessEnv,
    emailDeliveryReady: boolean,
    principal: AuthEntryPrincipal | null,
    home: JoinScreenHomeIdentity,
    preview?: TeamInvitationPreviewV1,
): Promise<AuthEntryProjectionV1> {
    const admission = { kind: 'team_invitation' as const };
    const [policy, homeMethods] = await Promise.all([
        resolveTeamAuthenticationPolicyInTx(tx, {
            env,
            teamId: invitation.team.teamId,
            policy: invitation.authenticationPolicy,
            admission,
            emailDeliveryReady,
        }),
        resolveEffectiveHomeAuthMethodsInTx(tx, {
            env,
            emailDeliveryReady,
            admission,
        }),
    ]);
    const account = await resolveAuthenticatedAccountPresentationInTx(tx, principal);

    if (await resolveEffectiveTeamMemberInTx(tx, {
        teamId: invitation.team.teamId,
        principal,
    })) {
        return AuthEntryProjectionV1Schema.parse({
            v: 1,
            state: 'already_member',
            scope: { kind: 'invitation' },
            home,
            account,
            team: invitation.team,
            actions: [{ kind: 'continue' }],
            autoRedirect: null,
        });
    }
    if (homeMethods.status !== 'ready') return unavailableInvitationProjection('entry_not_available');

    const currentAccountRecipientStatus = principal && invitation.recipientEmailNormalized
        ? await tx.accountEmail.findUnique({
            where: {
                accountId_normalizedEmail: {
                    accountId: principal.accountId,
                    normalizedEmail: invitation.recipientEmailNormalized,
                },
            },
            select: { accountId: true },
        }).then((mailbox) => mailbox ? 'already_verified' as const : 'verification_required' as const)
        : undefined;

    // Invitation admission is exempt from the public-signup restriction in every
    // finalizer, so the invitation projection carries no requesting address.
    const homeActions = projectHomeAuthenticationActions(homeMethods, { env, principal, emailDeliveryReady });
    const connectionActions = await projectTeamConnectionActionsInTx(tx, {
        env,
        teamId: invitation.team.teamId,
        policy,
        directoryBindingOnly: false,
    });
    const projection = {
        v: 1,
        state: 'admission_required',
        scope: { kind: 'invitation' },
        home,
        ...(account ? { account } : {}),
        team: invitation.team,
        invitationEmailVerificationRequired: invitation.recipientEmailNormalized === null,
        ...(preview ? { preview } : {}),
        actions: [
            ...connectionActions.available,
            ...connectionActions.unavailable,
            ...homeActions,
            ...(currentAccountRecipientStatus === 'verification_required'
                ? [{ kind: 'switch_account' as const }]
                : []),
        ],
        ...(currentAccountRecipientStatus ? { currentAccountRecipientStatus } : {}),
        ...(homeMethods.signInService ? { signInService: homeMethods.signInService } : {}),
        autoRedirect: null,
    } as const;
    if (AUTH_ENTRY_UTF8_ENCODER.encode(JSON.stringify(projection)).byteLength
        > AUTH_ENTRY_RESPONSE_MAX_UTF8_BYTES_V1) return unavailableInvitationProjection('entry_not_available');
    return AuthEntryProjectionV1Schema.parse(projection);
}

async function resolveInvitationAuthEntry(
    scope: Extract<AuthEntryRequestV1['scope'], { kind: 'invitation' }>,
    env: NodeJS.ProcessEnv,
    emailDeliveryReady: boolean,
    principal: AuthEntryPrincipal | null,
    home: JoinScreenHomeIdentity,
): Promise<AuthEntryProjectionV1> {
    return await inTx(async (tx) => {
        const held = 'continuation' in scope && principal
            ? await readTeamInvitationPostAuthContinuationInTx(tx, {
                continuation: scope.continuation, accountId: principal.accountId,
            })
            : null;
        if ('continuation' in scope && !held) return unavailableInvitationProjection('invitation_unavailable');
        const invitation = 'token' in scope
            ? await resolveTeamInvitationAuthEntryContextInTx(tx, { token: scope.token })
            : held && await resolveTeamInvitationAuthEntryReferenceContextInTx(tx, held.stored);
        const preview = held
            ? await previewTeamInvitationByReferenceInTx(tx, { ...held.stored, home })
            : null;
        if (held && !preview) return unavailableInvitationProjection('invitation_unavailable');
        // The bearer is the proof of visibility here: naming a spent, revoked or
        // unknown invitation tells a holder what to do next and names no Team.
        return invitation
            ? await resolveInvitationAuthEntryInTx(tx, invitation, env, emailDeliveryReady, principal, home, preview ?? undefined)
            : unavailableInvitationProjection('invitation_unavailable');
    });
}

/**
 * The public auth-entry projection is deliberately stateless. Every executable start route
 * resolves its method/provider again; this response grants no provider or admission authority.
 */
export async function resolveAuthEntry(
    input: AuthEntryRequestV1,
    context: ResolveAuthEntryContext = { env: process.env },
): Promise<AuthEntryProjectionV1> {
    // Reuse the Home feature-composition owner for the service policy/capability relationship.
    // The auth-entry method rows below remain live catalog projections rather than feature rows.
    const homeFeatures = resolveFeaturesFromEnv(context.env);
    if (input.scope.kind === 'team') {
        if (readServerEnabledBit(homeFeatures, 'teams') !== true) return unavailableTeamProjection('entry_not_available');
        const home = await resolveJoinScreenHomeIdentity(context.env);
        return await resolveTeamAuthEntry(input.scope.teamId, {
            env: context.env,
            principal: context.principal ?? null,
            emailDeliveryReady: context.emailDeliveryReady ?? await isAuthEmailDeliveryReady({ env: context.env }),
            ...(context.requestIp === undefined ? {} : { requestIp: context.requestIp }),
        }, home);
    }
    if (input.scope.kind === 'home' && input.purpose === 'account_service'
        && homeFeatures.capabilities.accountDirectory?.homeDirectory !== true) {
        return projectUnavailableHomeAuthEntry('not_account_service');
    }
    if (input.scope.kind === 'invitation') {
        if (readServerEnabledBit(homeFeatures, 'teams') !== true) {
            return unavailableInvitationProjection('entry_not_available');
        }
        const home = await resolveJoinScreenHomeIdentity(context.env);
        return await resolveInvitationAuthEntry(
            input.scope,
            context.env,
            context.emailDeliveryReady ?? await isAuthEmailDeliveryReady({ env: context.env }),
            context.principal ?? null,
            home,
        );
    }
    if (input.scope.kind === 'native_email_verification') {
        const verificationToken = input.scope.token;
        const home = await resolveJoinScreenHomeIdentity(context.env);
        return await inTx(async (tx) => {
            const operation = await readNativeAuthOneTimeOperation(tx, {
                purpose: 'verify_native_email',
                token: verificationToken,
            });
            if (operation?.purpose !== 'verify_native_email') return unavailableInvitationProjection('entry_not_available');
            if (operation.consumer.kind === 'team_invitation') {
                if (readServerEnabledBit(homeFeatures, 'teams') !== true) return unavailableInvitationProjection('entry_not_available');
                const invitation = await resolveTeamInvitationAuthEntryReferenceContextInTx(tx, operation.consumer);
                return invitation
                    ? await resolveInvitationAuthEntryInTx(
                        tx,
                        invitation,
                        context.env,
                        context.emailDeliveryReady ?? await isAuthEmailDeliveryReady({ env: context.env }),
                        context.principal ?? null,
                        home,
                    )
                    : unavailableInvitationProjection('invitation_unavailable');
            }
            if (operation.consumer.kind !== 'fresh_account') return unavailableInvitationProjection('entry_not_available');
            const homeMethods = await resolveEffectiveHomeAuthMethodsInTx(tx, {
                env: context.env,
                emailDeliveryReady: context.emailDeliveryReady ?? await isAuthEmailDeliveryReady({ env: context.env }),
            });
            if (homeMethods.status !== 'ready') return projectUnavailableHomeAuthEntry('authentication_policy_unavailable');
            return projectHomeAuthEntryProjection(homeMethods, {
                env: context.env,
                principal: context.principal ?? null,
                ...(context.requestIp === undefined ? {} : { requestIp: context.requestIp }),
                emailDeliveryReady: context.emailDeliveryReady ?? await isAuthEmailDeliveryReady({ env: context.env }),
            }, false);
        });
    }
    const emailDeliveryReady = context.emailDeliveryReady ?? await isAuthEmailDeliveryReady({ env: context.env });
    let homeMethods = await resolveEffectiveHomeAuthMethods({
        env: context.env,
        emailDeliveryReady,
    });
    if (homeMethods.status !== 'ready') {
        return projectUnavailableHomeAuthEntry('authentication_policy_unavailable');
    }
    const email = input.scope.kind === 'home' ? input.email : undefined;
    if (email !== undefined) {
        homeMethods = await resolveHomeCompanyChoicesByEmail(email, context.env, emailDeliveryReady, homeMethods);
        if (homeMethods.status !== 'ready') return projectUnavailableHomeAuthEntry('entry_not_available');
    }
    return projectHomeAuthEntryProjection(homeMethods, {
        env: context.env,
        principal: context.principal ?? null,
        ...(context.requestIp === undefined ? {} : { requestIp: context.requestIp }),
        emailDeliveryReady,
    }, email === undefined);
}
