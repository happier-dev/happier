import { markAccountsChanged } from "@/app/changes/markAccountChanged";
import type { Tx } from "@/storage/inTx";
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from "@happier-dev/protocol/changes";

/**
 * The stable coalescing identity for Team invalidation.
 *
 * New clients branch on this entity ID and reload the exact Home's Team
 * projection; older clients keep their existing broad `account` refresh and
 * still advance their cursor safely. That is the whole realtime design: no Team
 * `ChangeKind`, socket room, roster push stream, or hint schema is introduced,
 * because a wake plus the canonical HTTP projection already tells a client
 * everything a snapshot would have.
 */
export const TEAM_CHANGE_ENTITY_ID = TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1;

async function publishTeamsChangedInTx(
    tx: Tx,
    input: Readonly<{
        teamIds: readonly string[];
        additionalAccountIds?: readonly string[];
        excludeAccountIds?: readonly string[];
    }>,
): Promise<number> {
    const teamIds = [...new Set(input.teamIds)].sort();
    if (teamIds.length === 0) return 0;
    const excluded = new Set(input.excludeAccountIds ?? []);
    const memberships = await tx.teamMembership.findMany({
        where: { teamId: { in: teamIds } },
        select: { accountId: true },
    });
    const administrators = await tx.account.findMany({
        where: { status: "active", homeRole: { in: ["owner", "admin"] } },
        select: { id: true },
    });
    const audience = new Set<string>(memberships.map(({ accountId }) => accountId));
    for (const administrator of administrators) audience.add(administrator.id);
    for (const accountId of input.additionalAccountIds ?? []) audience.add(accountId);
    const recipients = [...audience].filter((accountId) => !excluded.has(accountId));
    return (await markAccountsChanged(tx, {
        accountIds: recipients,
        entityId: TEAM_CHANGE_ENTITY_ID,
    })).length;
}

/**
 * Wakes the Accounts whose Team projection one mutation can invalidate.
 *
 * The audience has two parts, and both are canonical readers of the state this
 * mutation changed:
 *
 * - the Team's current membership, whose directory rows, capabilities, and Team
 *   detail change;
 * - every active Home `owner`/`admin`, because `manageAllTeams` gives them a
 *   Home-level administered Team directory. Creating, renaming, or archiving any
 *   Team changes that list even when no administrator is a member, and an
 *   already-mounted admin directory would otherwise stay stale. Refetch-on-view
 *   is not a substitute: the projection is live, so it must be invalidated like
 *   any other live projection.
 *
 * The administrator set is small by construction — it is the same bounded
 * audience the Home-governance publisher already wakes — so this is a bounded
 * fanout over two reader sets, not a Home-wide broadcast. Inactive Accounts are
 * excluded because they hold no authority and therefore have no administered
 * directory to invalidate.
 *
 * Every Team mutation uses this one audience, including membership and directory
 * changes whose effect on an administrator is the Team detail rather than the
 * directory row. Splitting it would put a second "who reads this?" decision in
 * each caller for one concept; a wake is a cursor bump plus a refetch of the
 * canonical projection, so the cost of waking slightly wide is far below the
 * cost of a caller that reasons wrong and leaves a reader stale.
 *
 * `additionalAccountIds` carries the Accounts a mutation affects that are not
 * (or not yet) members, such as the initial owner of a Team created for someone
 * else. `excludeAccountIds` exists because `markAccountChanged` allocates a
 * cursor by incrementing `Account.seq` once per call, so an Account this
 * transaction has already marked must not be incremented again. The three
 * sources overlap freely — an administrator is often also a member and the actor
 * — so the audience is a set and each Account is marked exactly once.
 */
export async function publishTeamChangedInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        additionalAccountIds?: readonly string[];
        excludeAccountIds?: readonly string[];
    }>,
): Promise<number> {
    return await publishTeamsChangedInTx(tx, {
        teamIds: [input.teamId],
        additionalAccountIds: input.additionalAccountIds,
        excludeAccountIds: input.excludeAccountIds,
    });
}

/**
 * Invalidates every Team projection whose result depends on one Account's
 * current lifecycle or identity.
 *
 * Account suspension, retirement, erasure and provider replacement can affect
 * several Teams at once. Keeping the membership-to-Team expansion here avoids
 * teaching the Account lifecycle owner who reads Team projections, while
 * reusing the same audience and coalescing identity as ordinary Team changes.
 * There is deliberately no lifecycle-specific event or second invalidation
 * channel.
 */
export async function publishAccountTeamMembershipsChangedInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        additionalAccountIds?: readonly string[];
        excludeAccountIds?: readonly string[];
    }>,
): Promise<number> {
    const memberships = await tx.teamMembership.findMany({
        where: { accountId: input.accountId },
        select: { teamId: true },
    });
    const teamIds = [...new Set(memberships.map(({ teamId }) => teamId))].sort();
    return await publishTeamsChangedInTx(tx, {
        teamIds,
        additionalAccountIds: input.additionalAccountIds,
        excludeAccountIds: input.excludeAccountIds,
    });
}

/**
 * Invalidates Team credential projections whose readiness depends on a source
 * Account's Connected Account or Pool state. Source mutation stays owned by the
 * connected-service repository; this owner only expands its current resource
 * references into the ordinary Team-change audience.
 */
export async function publishAccountCredentialSourceTeamsChangedInTx(
    tx: Tx,
    input: Readonly<{ accountId: string }>,
): Promise<number> {
    const resources = await tx.teamCredentialResource.findMany({
        where: { custodianAccountId: input.accountId },
        select: { teamId: true },
    });
    return await publishTeamsChangedInTx(tx, {
        teamIds: resources.map(({ teamId }) => teamId),
        // A departed active custodian is no longer in the Team audience but
        // still owns an administration projection for the resource. Source
        // currentness changes must wake that reader too.
        additionalAccountIds: [input.accountId],
    });
}

/**
 * Invalidates the Team projections that read one managed identity provider.
 *
 * Home-owned providers may be bound to several Teams, while a Team-owned
 * provider normally resolves back to its owner Team. The provider lifecycle
 * must not duplicate that ownership rule or broadcast to unrelated Teams, so
 * it supplies the exact provider identity and this owner expands the current
 * connection rows into the ordinary deduplicated Team audience.
 */
export async function publishIdentityProviderTeamsChangedInTx(
    tx: Tx,
    input: Readonly<{ providerInstanceId: string }>,
): Promise<number> {
    const connections = await tx.teamIdentityConnection.findMany({
        where: { providerInstanceId: input.providerInstanceId },
        select: { teamId: true },
    });
    return await publishTeamsChangedInTx(tx, {
        teamIds: connections.flatMap(({ teamId }) => teamId === null ? [] : [teamId]),
    });
}

/**
 * Invalidates Team projections backed by one Home-owned GitHub App.
 *
 * A registration is the shared mutable source for both managed identity and
 * directory consumers. Those consumers retain its installation id through
 * separate canonical relations, so expand both here and feed their union into
 * the ordinary deduplicated Team publisher. Team-owned registrations already
 * publish their exact owner Team and do not use this expansion.
 */
export async function publishGitHubAppRegistrationTeamsChangedInTx(
    tx: Tx,
    input: Readonly<{ registrationId: string }>,
): Promise<number> {
    const installations = await tx.gitHubAppInstallation.findMany({
        where: { registrationId: input.registrationId },
        select: { id: true },
    });
    if (installations.length === 0) return 0;
    const installationIds = installations.map(({ id }) => id);
    const [identityConnections, directorySources] = await Promise.all([
        tx.teamIdentityConnection.findMany({
            where: {
                providerInstance: { githubAppInstallationId: { in: installationIds } },
            },
            select: { teamId: true },
        }),
        tx.teamDirectorySource.findMany({
            where: { githubAppInstallationId: { in: installationIds } },
            select: { teamId: true },
        }),
    ]);
    return await publishTeamsChangedInTx(tx, {
        teamIds: [
            ...identityConnections.map(({ teamId }) => teamId),
            ...directorySources.map(({ teamId }) => teamId),
        ],
    });
}
