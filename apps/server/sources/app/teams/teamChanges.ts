import { acquireAccountChangePublicationLocksInTx, assertAccountChangePublicationAudienceInTx, beforeAccountChangePublication, markAccountsChanged } from "@/app/changes/markAccountChanged";
import { TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { TEAM_CREDENTIAL_MATERIAL_ACCOUNT_CHANGE_ENTITY_ID_V1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from "@happier-dev/protocol/changes";
import { readDiscussionGrantAudienceForTeamsInTx, reconcileDiscussionGrantAudienceForTeamsInTx } from "@/app/discussions/accessService";
import type { AccountAdmissionIntent } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { readTeamCredentialSourceBinding } from './credentials/sourceBindingRead';
import type { QualifiedConnectedAccountServiceRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';

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

async function readTeamProjectionAdministratorAccountIdsInTx(tx: Tx): Promise<readonly string[]> {
    return (await tx.account.findMany({
        where: { status: "active", homeRole: { in: ["owner", "admin"] } }, select: { id: true },
    })).map(account => account.id);
}

/** Team creation has no persisted Team identity yet, but its initial recipients are known. */
export async function readTeamCreationPublicationAudienceInTx(tx: Tx, initialAccountIds: readonly string[]): Promise<readonly string[]> {
    return [...new Set([...initialAccountIds, ...await readTeamProjectionAdministratorAccountIdsInTx(tx)])].sort();
}

async function readTeamsChangedAudienceInTx(
    tx: Tx,
    input: Readonly<{
        teamIds: readonly string[];
        additionalAccountIds?: readonly string[];
        excludeAccountIds?: readonly string[];
    }>,
): Promise<readonly string[]> {
    const teamIds = [...new Set(input.teamIds)].sort();
    if (teamIds.length === 0) return [];
    const excluded = new Set(input.excludeAccountIds ?? []);
    const memberships = await tx.teamMembership.findMany({
        where: { teamId: { in: teamIds } },
        select: { accountId: true },
    });
    const brokerResources = await tx.teamCredentialResource.findMany({
        where: { teamId: { in: teamIds }, OR: [{ brokerMachineId: { not: null } }, { brokerPoolId: { not: null } }] },
        select: { custodianAccountId: true },
    });
    const administrators = await readTeamProjectionAdministratorAccountIdsInTx(tx);
    const audience = new Set<string>(memberships.map(({ accountId }) => accountId));
    for (const resource of brokerResources) audience.add(resource.custodianAccountId);
    for (const accountId of administrators) audience.add(accountId);
    for (const accountId of input.additionalAccountIds ?? []) audience.add(accountId);
    return [...audience].filter((accountId) => !excluded.has(accountId)).sort();
}

/** Consumer retirement is a payload-free wake to the exact custodians, using
 * the same Team feed that already invalidates retained broker authorization. */
export async function publishTeamCredentialBrokerConsumersChangedInTx(
    tx: Tx,
    input: Readonly<{ custodianAccountIds: readonly string[] }>,
): Promise<void> {
    await markAccountsChanged(tx, { accountIds: input.custodianAccountIds, entityId: TEAM_CHANGE_ENTITY_ID });
}

/** Pure complete recipient census for the Team publisher and its resource effects. */
export async function readTeamChangePublicationAudienceInTx(
    tx: Tx,
    input: Readonly<{ teamIds: readonly string[]; additionalAccountIds?: readonly string[]; excludeAccountIds?: readonly string[] }>,
): Promise<readonly string[]> {
    const [teamAccountIds, discussionAccountIds] = await Promise.all([
        readTeamsChangedAudienceInTx(tx, input),
        readDiscussionGrantAudienceForTeamsInTx(tx, input),
    ]);
    return [...new Set([...teamAccountIds, ...discussionAccountIds])].sort();
}

async function publishTeamsChangedInTx(
    tx: Tx,
    input: Readonly<{ teamIds: readonly string[]; additionalAccountIds?: readonly string[]; excludeAccountIds?: readonly string[] }>,
    entityId: typeof TEAM_CHANGE_ENTITY_ID | typeof TEAM_CREDENTIAL_MATERIAL_ACCOUNT_CHANGE_ENTITY_ID_V1 = TEAM_CHANGE_ENTITY_ID,
): Promise<number> {
    const teamIds = [...new Set(input.teamIds)].sort();
    if (teamIds.length === 0) return 0;
    await reconcileDiscussionGrantAudienceForTeamsInTx(tx, { teamIds, additionalAccountIds: input.additionalAccountIds });
    const recipients = await readTeamsChangedAudienceInTx(tx, { ...input, teamIds });
    beforeAccountChangePublication(tx, recipients, async () => {
        const current = await readTeamsChangedAudienceInTx(tx, { ...input, teamIds });
        assertAccountChangePublicationAudienceInTx(tx, current);
    });
    return (await markAccountsChanged(tx, {
        accountIds: recipients,
        entityId,
    })).length;
}

/**
 * Wakes the Accounts whose Team projection one mutation can invalidate.
 *
 * The audience includes the canonical readers of the state this
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
 * directory to invalidate. Broker resource custodians, including departed
 * members, also recheck retained consumer authorization after Team changes.
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

/** Material delivery changes recipient currentness and administration readiness,
 * including on the custodian's other clients, but cannot change source authority.
 * Keep the canonical Team audience while avoiding source-census feedback. */
export async function publishTeamCredentialMaterialChangedInTx(
    tx: Tx,
    input: Readonly<{ teamId: string }>,
): Promise<number> {
    return await publishTeamsChangedInTx(tx, { teamIds: [input.teamId] }, TEAM_CREDENTIAL_MATERIAL_ACCOUNT_CHANGE_ENTITY_ID_V1);
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
    const teamIds = await readAccountTeamIdsInTx(tx, input.accountId);
    return await publishTeamsChangedInTx(tx, {
        teamIds,
        additionalAccountIds: input.additionalAccountIds,
        excludeAccountIds: input.excludeAccountIds,
    });
}

async function readAccountTeamIdsInTx(tx: Tx, accountId: string): Promise<readonly string[]> {
    const memberships = await tx.teamMembership.findMany({ where: { accountId }, select: { teamId: true } });
    return [...new Set(memberships.map(({ teamId }) => teamId))].sort();
}

/** Lifecycle admission includes Team projections and their Discussion grant effects. */
export async function readAccountTeamMembershipsChangeAudienceInTx(
    tx: Tx,
    input: Readonly<{ accountId: string; additionalAccountIds?: readonly string[]; excludeAccountIds?: readonly string[] }>,
): Promise<readonly string[]> {
    const teamIds = await readAccountTeamIdsInTx(tx, input.accountId);
    return await readTeamChangePublicationAudienceInTx(tx, { ...input, teamIds });
}

/**
 * Invalidates Team credential projections whose readiness depends on a source
 * Account's Connected Account or Pool state. Source mutation stays owned by the
 * connected-service repository; this owner only expands its current resource
 * references into the ordinary Team-change audience.
 */
export async function publishAccountCredentialSourceTeamsChangedInTx(
    tx: Tx,
    input: Readonly<{ accountId: string; service?: QualifiedConnectedAccountServiceRef }>,
): Promise<number> {
    const teamIds = await readAccountCredentialSourceTeamIdsInTx(tx, input.accountId, input.service);
    return await publishTeamsChangedInTx(tx, {
        teamIds,
        // Departed custodians retain their source administration projection.
        additionalAccountIds: [input.accountId],
    });
}

async function readAccountCredentialSourceTeamIdsInTx(
    tx: Tx, accountId: string, service?: QualifiedConnectedAccountServiceRef,
): Promise<readonly string[]> {
    const resources = await tx.teamCredentialResource.findMany({
        where: { custodianAccountId: accountId },
        select: { teamId: true, sourceBindingJson: service !== undefined },
    });
    const affected = service ? resources.filter(resource => {
        const parsed = readTeamCredentialSourceBinding(resource.sourceBindingJson);
        // A corrupt binding cannot establish irrelevance. Preserve the wake
        // that lets current admission withdraw any previously issued material.
        if (!parsed.success) return true;
        const source = parsed.data;
        if (source.kind === 'provider_connection') return false;
        const sourceService = source.kind === 'connected_account' ? source.target.account.service : source.target.service;
        return sourceService.pluginId === service.pluginId && sourceService.localId === service.localId;
    }) : resources;
    return [...new Set(affected.map(({ teamId }) => teamId))].sort();
}

/** Complete live publication recipients of credential-source changes. */
export async function readAccountCredentialSourceTeamAdmissionAccountIdsInTx(
    tx: Tx, input: Readonly<{ accountId: string }>,
): Promise<readonly string[]> {
    const teamIds = await readAccountCredentialSourceTeamIdsInTx(tx, input.accountId);
    const accountIds = await readTeamChangePublicationAudienceInTx(tx, { teamIds, additionalAccountIds: [input.accountId] });
    return [...new Set([input.accountId, ...accountIds])].sort();
}

/** Admit source changes with their caller's strongest intent across the complete
 * publication scope. Return the same census check for a later source fence. */
export async function acquireAccountCredentialSourceTeamAdmissionInTx(
    tx: Tx, input: Readonly<{ accountId: string; intent: AccountAdmissionIntent }>,
): Promise<() => Promise<void>> {
    const accountIds = await readAccountCredentialSourceTeamAdmissionAccountIdsInTx(tx, input);
    await acquireAccountChangePublicationLocksInTx(tx, accountIds, { includeSingleAccount: true, intent: input.intent });
    const admitted = new Set(accountIds);
    const recheck = async () => {
        if ((await readAccountCredentialSourceTeamAdmissionAccountIdsInTx(tx, input)).some(accountId => !admitted.has(accountId))) {
            throw new TransactionReplayRequiredError("transaction-account-audience-changed");
        }
    };
    await recheck();
    return recheck;
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
    const teamIds = await readIdentityProviderTeamIdsInTx(tx, input.providerInstanceId);
    return await publishTeamsChangedInTx(tx, { teamIds });
}

export async function readIdentityProviderTeamIdsInTx(tx: Tx, providerInstanceId: string): Promise<readonly string[]> {
    const connections = await tx.teamIdentityConnection.findMany({
        where: { providerInstanceId },
        select: { teamId: true },
    });
    return [...new Set(connections.flatMap(({ teamId }) => teamId === null ? [] : [teamId]))].sort();
}

/** Complete live Team/Discussion recipients of a managed provider change. */
export async function readIdentityProviderTeamsChangeAudienceInTx(
    tx: Tx, input: Readonly<{ providerInstanceId: string }>,
): Promise<readonly string[]> {
    const teamIds = await readIdentityProviderTeamIdsInTx(tx, input.providerInstanceId);
    return await readTeamChangePublicationAudienceInTx(tx, { teamIds });
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
    const teamIds = await readGitHubAppRegistrationTeamIdsInTx(tx, input.registrationId);
    return await publishTeamsChangedInTx(tx, { teamIds });
}

export async function readGitHubAppRegistrationTeamsChangeAudienceInTx(
    tx: Tx, input: Readonly<{ registrationId: string }>,
): Promise<readonly string[]> {
    const teamIds = await readGitHubAppRegistrationTeamIdsInTx(tx, input.registrationId);
    return await readTeamChangePublicationAudienceInTx(tx, { teamIds });
}

export async function readGitHubAppRegistrationTeamIdsInTx(tx: Tx, registrationId: string): Promise<readonly string[]> {
    const installations = await tx.gitHubAppInstallation.findMany({
        where: { registrationId },
        select: { id: true },
    });
    if (installations.length === 0) return [];
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
    return [...new Set([
            ...identityConnections.flatMap(({ teamId }) => teamId === null ? [] : [teamId]),
            ...directorySources.map(({ teamId }) => teamId),
        ])].sort();
}
