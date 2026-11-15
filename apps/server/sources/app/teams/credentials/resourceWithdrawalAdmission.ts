import { TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { acquireTeamMutationLockInTx } from "../actorContext";
import { acquireTeamMutationAccountAdmissionInTx } from "../memberships/sessionAccessEffects";

/** Admit withdrawal's complete publication audience before Team/resource locks.
 * Serializing (not exclusive): it orders withdrawal against credential consumers,
 * which admit at the same strength, while ordinary KEY SHARE writers of these
 * wide Team/Home-admin audiences cannot starve it. The resource row lock still
 * excludes binding and material writers.
 * The identity census is not authority: reread the resource after admission. */
export async function admitTeamCredentialWithdrawalInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; resourceId: string; additionalPublicationAccountIds?: readonly string[] }>,
): Promise<Awaited<ReturnType<Tx["teamCredentialResource"]["findUnique"]>>> {
    const identity = await tx.teamCredentialResource.findUnique({
        where: { id: input.resourceId }, select: { teamId: true, custodianAccountId: true },
    });
    if (!identity) return null;
    const recheck = await acquireTeamMutationAccountAdmissionInTx(tx, {
        teamId: identity.teamId,
        accountIds: [input.actorAccountId, identity.custodianAccountId, ...input.additionalPublicationAccountIds ?? []],
        intent: "serializing",
    });
    await acquireTeamMutationLockInTx(tx, identity.teamId);
    await recheck();
    const resource = await tx.teamCredentialResource.findUnique({ where: { id: input.resourceId } });
    if (resource && (resource.teamId !== identity.teamId || resource.custodianAccountId !== identity.custodianAccountId)) {
        throw new TransactionReplayRequiredError("transaction-account-audience-changed");
    }
    return resource;
}
