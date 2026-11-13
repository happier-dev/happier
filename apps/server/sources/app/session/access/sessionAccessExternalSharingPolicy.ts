import { isSessionAccessGrantIncreaseV1 } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import type { Tx } from "@/storage/inTx";
import { AccountStatus, TeamExternalSharingPolicy, TeamMembershipStatus } from "@/storage/prisma";
import { TEAM_PRINCIPAL_ROLES_V1, isTeamPrincipalRoleV1 } from '@happier-dev/protocol/teams';
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { resolveTeamActorContextInTx } from "@/app/teams/actorContext";
import { isEffectiveTeamMembership } from "@/app/teams/memberships/effectiveMembership";
import { isPublicSessionShareActive } from "@/app/share/publicSessionSharePublication";

import type { ShareSubject } from "@/app/teams/shareEligibility";
import { resolveSessionGrantedAccountIdsInTx } from "./sessionRecipients";
import {
    qualifySessionTeamAuthenticationInTx,
    type SessionAccessAuthentication,
} from "./sessionAccessAuthentication";

export type SessionExternalSharingPolicyError =
    | "session_access_external_sharing_requires_team_admin"
    | "session_access_external_sharing_disabled"
    | "session_access_authentication_required"
    | "session_access_authentication_unavailable";

type StoredGrantValue = Readonly<{
    accessLevel: "view" | "edit" | "admin";
    canApprovePermissions: boolean;
}>;
type GrantValue = StoredGrantValue;
type StoredPublicLinkValue = Readonly<{
    expiresAt: Date | null;
    maxUses: number | null;
    useCount: number;
}>;
type PublicLinkValue = Readonly<{
    expiresAt: Date | null;
    maxUses: number | null;
    rotatesToken: boolean;
}>;

/**
 * Public-link policy applies only when a mutation admits more external use.
 * Tightening or disabling an existing publication must remain available after
 * Team policy becomes more restrictive.
 */
export function isSessionPublicLinkExternalSharingIncrease(input: Readonly<{
    previous: StoredPublicLinkValue | null;
    next: PublicLinkValue;
    now?: Date;
}>): boolean {
    const now = input.now ?? new Date();
    if (!isPublicSessionShareActive(input.next, now)) return false;
    if (!isPublicSessionShareActive(input.previous, now)) return true;
    if (input.next.rotatesToken) return true;

    const previousExpiry = input.previous!.expiresAt;
    const nextExpiry = input.next.expiresAt;
    if (previousExpiry !== null && (nextExpiry === null || nextExpiry > previousExpiry)) return true;

    const previousRemainingUses = input.previous!.maxUses === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, input.previous!.maxUses - input.previous!.useCount);
    const nextRemainingUses = input.next.maxUses === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, input.next.maxUses - input.previous!.useCount);
    return nextRemainingUses > previousRemainingUses;
}

/** External to the primary Team: another Team or Group, or an Account without effective non-guest membership. */
export async function isSubjectExternalToTeamInTx(
    tx: Tx,
    input: Readonly<{ primaryTeamId: string; subject: ShareSubject }>,
): Promise<boolean> {
    return (await classifySubjectsExternalToTeamInTx(tx, { primaryTeamId: input.primaryTeamId, subjects: [input.subject] }))[0]!;
}

/** The same externality decision, batched for a directory page rather than one read per Account. */
export async function classifySubjectsExternalToTeamInTx(
    tx: Tx,
    input: Readonly<{ primaryTeamId: string; subjects: readonly ShareSubject[] }>,
): Promise<readonly boolean[]> {
    const accountIds = input.subjects.flatMap((subject) => subject.kind === 'account' ? [subject.accountId] : []);
    const memberships = (await Promise.all(portableQueryChunks({ values: accountIds, bindingsPerValue: 1, fixedBindings: 2 }).map(ids => tx.teamMembership.findMany({
        where: {
            teamId: input.primaryTeamId,
            accountId: { in: [...ids] },
        },
        select: {
            accountId: true,
            status: true,
            role: true,
            account: { select: { status: true } },
            team: { select: { archivedAt: true } },
        },
    })))).flat();
    const internalAccountIds = new Set(memberships.filter((membership) => isTeamPrincipalRoleV1(membership.role)
        && isEffectiveTeamMembership({ accountStatus: membership.account.status,
            membershipStatus: membership.status, teamArchivedAt: membership.team.archivedAt }))
        .map((membership) => membership.accountId));
    return input.subjects.map((subject) => subject.kind === 'account'
        ? !internalAccountIds.has(subject.accountId) : subject.teamId !== input.primaryTeamId);
}

/**
 * The Session-scoped verdict: whether this actor may admit any external audience
 * under the primary Team's policy. It depends only on actor and Team, so a caller
 * evaluating many subjects resolves it once and pairs it with per-subject externality.
 */
export async function enforceTeamExternalSharingPolicyInTx(
    tx: Tx,
    input: Readonly<{
        actorAccountId: string;
        primaryTeamId: string;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionExternalSharingPolicyError | null> {
    const context = await resolveTeamActorContextInTx(tx, {
        teamId: input.primaryTeamId,
        actorAccountId: input.actorAccountId,
    });
    if (!context || context.team.archivedAt !== null) {
        return "session_access_external_sharing_disabled";
    }
    switch (context.team.externalSharingPolicy) {
        case TeamExternalSharingPolicy.allowed:
            return null;
        case TeamExternalSharingPolicy.disabled:
            return "session_access_external_sharing_disabled";
        case TeamExternalSharingPolicy.team_admins_only: {
            if (!context.capabilities.managePolicy) {
                return "session_access_external_sharing_requires_team_admin";
            }
            const qualification = await qualifySessionTeamAuthenticationInTx(tx, {
                accountId: input.actorAccountId,
                team: context.team,
                authentication: input.authentication,
            });
            if (qualification.status === "satisfied") return null;
            return qualification.status === "authentication_required"
                ? "session_access_authentication_required"
                : "session_access_authentication_unavailable";
        }
    }
}

/** Enforce an external grant increase against the Session's current primary Team. */
export async function enforceSessionGrantExternalSharingPolicyInTx(
    tx: Tx,
    input: Readonly<{
        actorAccountId: string;
        primaryTeamId: string | null;
        subject: ShareSubject;
        previous: StoredGrantValue | null;
        next: GrantValue;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionExternalSharingPolicyError | null> {
    if (!input.primaryTeamId || !isSessionAccessGrantIncreaseV1(input.previous, input.next)) return null;
    const primaryTeamId = input.primaryTeamId;
    if (!await isSubjectExternalToTeamInTx(tx, {
        primaryTeamId,
        subject: input.subject,
    })) return null;
    return await enforceTeamExternalSharingPolicyInTx(tx, {
        actorAccountId: input.actorAccountId,
        primaryTeamId,
        authentication: input.authentication,
    });
}

/** Enforce public-link creation or expansion against the Session's primary Team. */
export async function enforceSessionPublicLinkExternalSharingPolicyInTx(
    tx: Tx,
    input: Readonly<{
        actorAccountId: string;
        primaryTeamId: string | null;
        previous: StoredPublicLinkValue | null;
        next: PublicLinkValue;
        now?: Date;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionExternalSharingPolicyError | null> {
    return input.primaryTeamId && isSessionPublicLinkExternalSharingIncrease(input) ? await enforceTeamExternalSharingPolicyInTx(tx, {
        actorAccountId: input.actorAccountId,
        primaryTeamId: input.primaryTeamId,
        authentication: input.authentication,
    }) : null;
}

/**
 * Re-evaluate the current audience as it would be classified by a proposed Team
 * context. Context itself grants nothing; this only prevents moving an already
 * externally shared Session under a policy that forbids that audience.
 */
export async function enforceSessionContextExternalSharingPolicyInTx(
    tx: Tx,
    input: Readonly<{
        actorAccountId: string;
        sessionId: string;
        primaryTeamId: string | null;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionExternalSharingPolicyError | null> {
    if (!input.primaryTeamId) return null;
    const primaryTeamId = input.primaryTeamId;
    const [audienceAccountIds, publicLink, externalTeamGrant, externalGroupGrant] = await Promise.all([
        // Consume the current access owner rather than interpreting stored grant
        // rows here. Archived Teams/Groups, inactive Accounts, and expired
        // membership horizons therefore cannot become a second audience answer.
        resolveSessionGrantedAccountIdsInTx(tx, { sessionId: input.sessionId }),
        tx.publicSessionShare.findUnique({
            where: { sessionId: input.sessionId },
            select: { expiresAt: true },
        }),
        tx.sessionGrant.findFirst({
            where: { principalKind: 'team',
                sessionId: input.sessionId,
                teamId: { not: primaryTeamId },
                team: { archivedAt: null },
            },
            select: { teamId: true },
        }),
        tx.sessionGrant.findFirst({
            where: { principalKind: 'group',
                sessionId: input.sessionId,
                teamGroup: {
                    teamId: { not: primaryTeamId },
                    archivedAt: null,
                    team: { archivedAt: null },
                },
            },
            select: { teamGroupId: true },
        }),
    ]);
    const internalMemberships = audienceAccountIds.length === 0
        ? []
        : await tx.teamMembership.findMany({
            where: {
                teamId: primaryTeamId,
                accountId: { in: audienceAccountIds },
                status: TeamMembershipStatus.active,
                role: { in: [...TEAM_PRINCIPAL_ROLES_V1] },
                account: { status: AccountStatus.active },
                team: { archivedAt: null },
            },
            select: { accountId: true },
        });
    const internalAccountIds = new Set(internalMemberships.map((membership) => membership.accountId));
    // Collective grants retain their owning Team boundary even when every
    // current member happens to overlap with the proposed primary Team. Member
    // expansion alone cannot preserve that fact, so keep this policy-specific
    // classification alongside the canonical effective-account audience.
    const hasExternalAudience = externalTeamGrant !== null
        || externalGroupGrant !== null
        || isPublicSessionShareActive(publicLink)
        || audienceAccountIds.some((accountId) => !internalAccountIds.has(accountId));
    return hasExternalAudience
        ? await enforceTeamExternalSharingPolicyInTx(tx, {
            actorAccountId: input.actorAccountId,
            primaryTeamId,
            authentication: input.authentication,
        })
        : null;
}
