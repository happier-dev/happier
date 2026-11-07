import { buildTeamCredentialUsageChangedEphemeral, eventRouter } from "@/app/events/eventRouter";
import { readHomeGovernanceChangeAccountIdsInTx } from "@/app/home/governance/governanceChanges";
import { resolveTeamMembershipCredentialCapabilities } from "@/app/teams/memberships/capabilities";
import { AccountStatus, TeamRole } from "@/storage/enums.generated";
import { afterTx, type Tx } from "@/storage/inTx";

/**
 * Whether a viewer reads a Team credential resource's whole usage, rather than
 * only their own. The resource usage query and the usage wake audience share
 * this one rule.
 */
export function readsWholeTeamCredentialUsage(input: Readonly<{
    viewerAccountId: string;
    custodianAccountId: string;
    manageCredentials: boolean;
}>): boolean {
    return input.viewerAccountId === input.custodianAccountId || input.manageCredentials;
}

/**
 * Wakes the mounted readers of one resource's usage after a new immutable usage
 * fact commits (L10/07 L10.07-C step 5).
 *
 * The audience is exactly the viewers whose usage projection that fact changes:
 * the resource's whole-usage readers (current custodian and credential managers)
 * and the acting member, who reads their own use, plus Home administrators who
 * read aggregate usage. Other members and daemons are not woken: a usage write
 * changes no authorization, catalog or Settings fact, so it is not a Team AccountChange.
 *
 * The wake is an ephemeral to app connections only. It carries only the
 * resource and Team ids, persists nothing and allocates no cursor on the admission
 * path; every reader re-authorizes through the usage query, and a reader that was not
 * mounted reads current usage when it opens.
 */
export async function publishTeamCredentialUsageChangedInTx(
    tx: Tx,
    input: Readonly<{ resourceId: string; actorAccountId: string }>,
): Promise<void> {
    const resource = await tx.teamCredentialResource.findUnique({
        where: { id: input.resourceId },
        select: {
            teamId: true,
            custodianAccountId: true,
            custodianAccount: { select: { status: true } },
            team: {
                select: {
                    archivedAt: true,
                    memberships: {
                        where: { role: { in: [TeamRole.owner, TeamRole.admin] } },
                        select: { accountId: true, role: true, status: true, account: { select: { status: true } } },
                    },
                },
            },
        },
    });
    if (!resource) return;
    const audience = new Set<string>([input.actorAccountId]);
    if (resource.custodianAccount.status === AccountStatus.active) audience.add(resource.custodianAccountId);
    for (const membership of resource.team.memberships) {
        const { manageCredentials } = resolveTeamMembershipCredentialCapabilities({
            role: membership.role,
            membershipStatus: membership.status,
            accountStatus: membership.account.status,
            teamArchivedAt: resource.team.archivedAt,
        });
        if (membership.account.status === AccountStatus.active && readsWholeTeamCredentialUsage({
            viewerAccountId: membership.accountId,
            custodianAccountId: resource.custodianAccountId,
            manageCredentials,
        })) {
            audience.add(membership.accountId);
        }
    }
    for (const accountId of await readHomeGovernanceChangeAccountIdsInTx(tx)) audience.add(accountId);
    const payload = buildTeamCredentialUsageChangedEphemeral(input.resourceId, resource.teamId);
    afterTx(tx, () => {
        for (const accountId of audience) {
            eventRouter.emitEphemeral({ userId: accountId, payload, recipientFilter: { type: "user-scoped-only" } });
        }
    });
}
