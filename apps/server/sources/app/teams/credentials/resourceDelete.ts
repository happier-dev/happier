import type { Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { admitTeamCredentialWithdrawalInTx } from "./resourceWithdrawalAdmission";
import { AccountStatus } from "@/storage/enums.generated";
import { resolveTeamActorContextInTx, type TeamOperationAuthenticationContext } from "../actorContext";
import { resolveTeamCredentialCapabilities } from "../capabilities";
import { publishTeamChangedInTx } from "../teamChanges";
import { recordTeamCredentialActivityInTx } from "./resourceActivity";
import { qualifyTeamCredentialOperationInTx } from "./resourceRead";
import { prepareNativeCredentialPolicyChangesInTx, readNativeCredentialPolicyPublicationAccountIdsInTx } from './nativePolicyChanges';

export type DeleteTeamCredentialResourceResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; error: "not_found_or_not_visible" | "forbidden" | "resource_changed" | "invalid_resource_input" | "team_authentication_required" | "team_authentication_policy_unavailable" }>;

export async function deleteTeamCredentialResourceInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; resourceId: string; expectedRevision: number; authentication: TeamOperationAuthenticationContext }>,
): Promise<DeleteTeamCredentialResourceResult> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return { ok: false, error: "invalid_resource_input" };
    const resource = await admitTeamCredentialWithdrawalInTx(tx, { ...input,
        additionalPublicationAccountIds: await readNativeCredentialPolicyPublicationAccountIdsInTx(tx, { resourceIds: [input.resourceId] }) });
    if (!resource) return { ok: false, error: "not_found_or_not_visible" };
    const isCustodian = resource.custodianAccountId === input.actorAccountId;
    const account = await tx.account.findUnique({ where: { id: input.actorAccountId }, select: { status: true } });
    if (account?.status !== AccountStatus.active) return { ok: false, error: "forbidden" };
    const actor = isCustodian ? null : await resolveTeamActorContextInTx(tx, { teamId: resource.teamId, actorAccountId: input.actorAccountId });
    if (!isCustodian && (!actor || !resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt }).manageCredentials)) {
        return { ok: false, error: "not_found_or_not_visible" };
    }
    if (!isCustodian && actor) {
        const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, input.authentication);
        if (!qualification.ok) return qualification;
    }
    // Serialize with the FK key-share held by accepted-binding insertion.
    // A Team lifecycle lock alone cannot protect this resource's child census.
    const provider = getDbProviderFromEnv(process.env, "postgres");
    if (provider !== "sqlite") await tx.$queryRawUnsafe(
        provider === "mysql"
            ? "SELECT `id` FROM `TeamCredentialResource` WHERE `id` = ? FOR UPDATE"
            : 'SELECT "id" FROM "TeamCredentialResource" WHERE "id" = $1 FOR UPDATE',
        resource.id,
    );
    const publishNativePolicyChanges = await prepareNativeCredentialPolicyChangesInTx(tx, { resourceIds: [resource.id] });
    const deleted = await tx.teamCredentialResource.deleteMany({ where: { id: resource.id, revision: input.expectedRevision } });
    if (deleted.count !== 1) return { ok: false, error: "resource_changed" };
    await publishNativePolicyChanges();
    await recordTeamCredentialActivityInTx(tx, {
        teamId: resource.teamId, resourceId: resource.id, kind: "resource_deleted",
        actor: { kind: "account", accountId: input.actorAccountId }, subjectDisplayName: resource.displayName,
    });
    await publishTeamChangedInTx(tx, { teamId: resource.teamId, additionalAccountIds: [resource.custodianAccountId, input.actorAccountId] });
    return { ok: true };
}
