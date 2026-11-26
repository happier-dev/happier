import { createHash } from "node:crypto";

import { AccountStatus, TeamMembershipStatus } from "@/storage/enums.generated";
import { TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { acquireAccountChangePublicationLocksInTx } from "@/app/changes/markAccountChanged";
import { publishTeamChangedInTx, readTeamChangePublicationAudienceInTx } from "../teamChanges";

export type TeamCredentialBrokerPoolReferenceSummary = Readonly<{
    assignmentCount: number;
    visibleTeamNames: readonly string[];
    witness: string;
}>;

/** Counts the custodian's retained assignments and discloses names through current membership. */
export async function readTeamCredentialBrokerPoolReferenceSummaryInTx(
    tx: Tx,
    input: Readonly<{ custodianAccountId: string; poolId: string }>,
): Promise<TeamCredentialBrokerPoolReferenceSummary> {
    const resources = await tx.teamCredentialResource.findMany({
        where: { custodianAccountId: input.custodianAccountId, brokerPoolId: input.poolId },
        orderBy: { id: "asc" },
        select: { id: true, teamId: true, revision: true },
    });
    const assignmentCount = resources.length;
    const witness = createHash("sha256")
        .update("team-credential-broker-pool-refs-v1")
        .update(JSON.stringify(resources.map(({ id, revision }) => [id, revision])))
        .digest("hex");
    if (assignmentCount === 0) return { assignmentCount, visibleTeamNames: [], witness };

    const custodian = await tx.account.findUnique({
        where: { id: input.custodianAccountId, status: AccountStatus.active },
        select: { id: true },
    });
    if (!custodian) return { assignmentCount, visibleTeamNames: [], witness };

    const teamIds = [...new Set(resources.map(({ teamId }) => teamId))];
    const memberships = await tx.teamMembership.findMany({
        where: { accountId: custodian.id, teamId: { in: teamIds }, status: TeamMembershipStatus.active },
        select: { team: { select: { name: true } } },
    });
    const visibleTeamNames = [...new Set(memberships.map(({ team }) => team.name.trim()).filter(Boolean))].sort();
    return { assignmentCount, visibleTeamNames, witness };
}

async function readBrokerPoolTeamIdsInTx(tx: Tx, input: Readonly<{ custodianAccountId: string; poolId: string }>): Promise<readonly string[]> {
    const resources = await tx.teamCredentialResource.findMany({
        where: { custodianAccountId: input.custodianAccountId, brokerPoolId: input.poolId }, select: { teamId: true },
    });
    return [...new Set(resources.map(row => row.teamId))].sort();
}

/** Pure resource-effect audience for a Pool deletion's early Account admission. */
export async function readTeamCredentialBrokerPoolAdmissionAccountIdsInTx(
    tx: Tx,
    input: Readonly<{ custodianAccountId: string; poolId: string }>,
): Promise<readonly string[]> {
    const teamIds = await readBrokerPoolTeamIdsInTx(tx, input);
    const publicationAccountIds = await readTeamChangePublicationAudienceInTx(tx, { teamIds, additionalAccountIds: [input.custodianAccountId] });
    return [...new Set([input.custodianAccountId, ...publicationAccountIds])].sort();
}

/** Admit the complete publication cohort before the deleting caller takes its Pool row. */
export async function acquireTeamCredentialBrokerPoolAdmissionInTx(
    tx: Tx, input: Readonly<{ custodianAccountId: string; poolId: string }>,
): Promise<() => Promise<void>> {
    const accountIds = await readTeamCredentialBrokerPoolAdmissionAccountIdsInTx(tx, input);
    await acquireAccountChangePublicationLocksInTx(tx, accountIds, { includeSingleAccount: true });
    const accounts = new Set(accountIds);
    const recheck = async () => {
        if ((await readTeamCredentialBrokerPoolAdmissionAccountIdsInTx(tx, input)).some(accountId => !accounts.has(accountId))) {
            throw new TransactionReplayRequiredError("transaction-account-audience-changed");
        }
    };
    await recheck();
    return recheck;
}

/**
 * Clears Pool placement at the credential-resource owner. Resource revision is
 * advanced in the same transaction so every signed/open authority admitted
 * against the deleted placement fails through the incumbent currentness gate.
 */
export async function clearTeamCredentialBrokerPoolReferencesInTx(
    tx: Tx,
    input: Readonly<{ custodianAccountId: string; poolId: string }>,
): Promise<void> {
    const affected = await tx.teamCredentialResource.findMany({
        where: { custodianAccountId: input.custodianAccountId, brokerPoolId: input.poolId },
        select: { teamId: true },
    });
    if (affected.length === 0) return;
    await tx.teamCredentialResource.updateMany({
        where: { custodianAccountId: input.custodianAccountId, brokerPoolId: input.poolId },
        data: { brokerPoolId: null, revision: { increment: 1 } },
    });
    for (const teamId of new Set(affected.map((row) => row.teamId))) {
        await publishTeamChangedInTx(tx, {
            teamId,
            additionalAccountIds: [input.custodianAccountId],
        });
    }
}
