import { isActiveHomeAccountStatus } from '@happier-dev/protocol/home/governance';

import type { Tx } from "@/storage/inTx";
import { endTeamPlanForMemberInTx } from "@/app/plans/accountPlanEntitlement";
import { acquireAccountLifecycleAdmissionInTx } from "./accountLifecycle";
import { captureSessionAccessMembershipImpactsInTx, applySessionAccessMembershipImpactsInTx } from "@/app/session/access/sessionAccessMembershipImpact";
import {
    prepareProvisionedIdentityRebindForAccountReplacementInTx,
    rebindPreparedProvisionedIdentitiesForAccountReplacementInTx,
} from "@/app/teams/directory/provisionedIdentityBinding";
import { publishAccountTeamMembershipsChangedInTx } from "@/app/teams/teamChanges";
import { changeUsernameInTx } from "@/app/social/usernameUpdate";

import { assertHomeOwnershipSurvivesTransitionInTx } from "./homeCapabilities";

/**
 * The identity material of the Account that replaces a reset provider Account.
 * The ID is chosen by the caller before any network work so the row itself can
 * be inserted inside the replacement transaction.
 */
export type ProviderResetReplacementAccount = Readonly<{
    accountId: string;
    publicKey: string;
    /**
     * `Uint8Array<ArrayBuffer>` is the repository's canonical `Bytes` shape,
     * matching the verified content-key binding these values come from and the
     * Prisma column they are written to.
     */
    contentPublicKey?: Uint8Array<ArrayBuffer> | null;
    contentPublicKeySignature?: Uint8Array<ArrayBuffer> | null;
}>;

export type ProviderResetAccountReplacementInput = Readonly<{
    oldAccountId: string;
    replacement: ProviderResetReplacementAccount;
    desiredUsername: string | null;
    usernamePolicyEnv?: NodeJS.ProcessEnv;
    /**
     * The canonical Account-lifecycle transition that retires the replaced
     * Account: terminal `disabled`, token-epoch increment, and PAT deletion.
     * It is injected because that transition is the authentication lane's
     * canonical owner; this coordinator owns only when it runs relative to the
     * ownership guard and the replacement's role assignment.
     */
    retireReplacedAccountInTx: (tx: Tx) => Promise<void>;
}>;

/**
 * A Home-governance invariant that a committed transaction must never violate.
 * Throwing aborts the caller's transaction, which is the only safe response
 * once the composition has already mutated rows.
 */
export class HomeGovernanceInvariantError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HomeGovernanceInvariantError";
    }
}

/**
 * Both rejections are decided before any row is mutated, so a caller may return
 * them from its transaction without leaving partial replacement state behind.
 */
export type ProviderResetAccountReplacementResult =
    | Readonly<{ status: "replaced"; replacementAccountId: string; transferredTeamMembershipCount: number }>
    | Readonly<{
        status: "rejected";
        code: "home_account_not_found" | "home_account_inactive" | "team_membership_transfer_conflict";
        details?: Readonly<{ teamIds: readonly string[] }>;
    }>;

/**
 * Moves every Team membership lifetime from the replaced Account to its
 * replacement.
 *
 * Only `accountId` moves: the membership ID, role, status, and
 * `sessionAccessStartsAt` are the immutable lifetime identity that Group rows,
 * external source bindings, and membership-lifetime grants key on, so none of
 * those rows move or are recreated.
 */
async function transferTeamMembershipsForAccountReplacementInTx(
    tx: Tx,
    input: Readonly<{ oldAccountId: string; replacementAccountId: string }>,
): Promise<number> {
    const memberships = await tx.teamMembership.findMany({ where: { accountId: input.oldAccountId }, select: { teamId: true } });
    const changes = memberships.map(({ teamId }) => ({ kind: "teamMembership" as const, teamId }));
    const impacts = await captureSessionAccessMembershipImpactsInTx(tx, {
        accountIds: [input.oldAccountId, input.replacementAccountId],
        changes,
    });
    if (memberships.length > 0) await endTeamPlanForMemberInTx(tx, input.oldAccountId);
    const moved = await tx.teamMembership.updateMany({
        where: { accountId: input.oldAccountId },
        data: { accountId: input.replacementAccountId },
    });
    await applySessionAccessMembershipImpactsInTx(tx, { impacts: impacts.values() });
    return moved.count;
}

/**
 * The sole coordinator for provider-driven Account replacement.
 *
 * Everything happens in the caller's serializable transaction: the replacement
 * Account row is inserted here rather than before the transaction, so a failed
 * transfer, identity connection, or retirement rolls the whole replacement back
 * and leaves the replaced Account authoritative. There is no compensating
 * delete, reset saga, or transfer ledger.
 *
 * Ordering is load-bearing. The replacement inherits the replaced Account's
 * Home role first, so the last-active-owner guard that follows sees the
 * surviving owner and a Home that has an owner both before and after the
 * transaction. Retirement runs last, after the guard has admitted it.
 */
export async function replaceAccountForProviderResetInTx(
    tx: Tx,
    input: ProviderResetAccountReplacementInput,
): Promise<ProviderResetAccountReplacementResult> {
    await acquireAccountLifecycleAdmissionInTx(tx,
        { accountId: input.oldAccountId, additionalAccountIds: [input.replacement.accountId] });
    const replaced = await tx.account.findUnique({
        where: { id: input.oldAccountId },
        select: { id: true, homeRole: true, feedSeq: true, status: true },
    });
    if (!replaced) return { status: "rejected", code: "home_account_not_found" };
    // A provider reset recovers a credential, never a lifecycle. The replacement
    // inherits this Account's Home role and every Team membership lifetime into
    // a fresh active Account, so running it for a suspended or retired source
    // would undo the Home's own hold — the lifecycle owner's rule that a
    // disabled Account is never reactivated, decided here before any mutation
    // because the retirement callback runs last and cannot refuse the transfer.
    if (!isActiveHomeAccountStatus(replaced.status)) {
        return { status: "rejected", code: "home_account_inactive" };
    }

    // A replacement Account that already carries a membership in an affected
    // Team is an ambiguous merge, not a transfer. Refuse before any mutation.
    const affectedMemberships = await tx.teamMembership.findMany({
        where: { accountId: input.oldAccountId },
        select: { id: true, teamId: true },
    });
    const affectedTeamIds = [...new Set(affectedMemberships.map((membership) => membership.teamId))].sort();
    const conflictTeamIds = new Set<string>();
    if (affectedTeamIds.length > 0) {
        const collisions = await tx.teamMembership.findMany({
            where: { accountId: input.replacement.accountId, teamId: { in: affectedTeamIds } },
            select: { teamId: true },
        });
        for (const collision of collisions) conflictTeamIds.add(collision.teamId);
    }
    const identityRebind = await prepareProvisionedIdentityRebindForAccountReplacementInTx(tx, {
        oldAccountId: input.oldAccountId,
        memberships: affectedMemberships,
    });
    if (identityRebind.status === "conflict") {
        for (const teamId of identityRebind.teamIds) conflictTeamIds.add(teamId);
    }
    if (conflictTeamIds.size > 0) {
        return {
            status: "rejected",
            code: "team_membership_transfer_conflict",
            details: { teamIds: [...conflictTeamIds].sort() },
        };
    }
    if (identityRebind.status !== "ready") {
        throw new Error("Provider Account replacement conflict preflight returned no conflicting Team");
    }

    await tx.account.create({
        data: {
            id: input.replacement.accountId,
            publicKey: input.replacement.publicKey,
            homeRole: replaced.homeRole,
            feedSeq: replaced.feedSeq,
            ...(input.replacement.contentPublicKey ? { contentPublicKey: input.replacement.contentPublicKey } : {}),
            ...(input.replacement.contentPublicKeySignature
                ? { contentPublicKeySig: input.replacement.contentPublicKeySignature }
                : {}),
        },
        select: { id: true },
    });

    // Recovery transfers the existing identity and its manual/automatic intent;
    // it is not a voluntary release and must not create a release hold.
    await changeUsernameInTx(tx, input.replacement.accountId, {
        kind: 'account_replacement', oldAccountId: input.oldAccountId, desiredUsername: input.desiredUsername,
    }, input.usernamePolicyEnv);

    const transferredTeamMembershipCount = await transferTeamMembershipsForAccountReplacementInTx(tx, {
        oldAccountId: input.oldAccountId,
        replacementAccountId: input.replacement.accountId,
    });
    await rebindPreparedProvisionedIdentitiesForAccountReplacementInTx(tx, {
        oldAccountId: input.oldAccountId,
        replacementAccountId: input.replacement.accountId,
        identityIds: identityRebind.identityIds,
    });
    // Membership IDs stay stable, but every projection that names the Account
    // behind those lifetimes changed. Publish through the ordinary Team audience
    // after the atomic transfer; the old Account no longer owns memberships at
    // the lifecycle transition below, so waiting until retirement would miss it.
    await publishAccountTeamMembershipsChangedInTx(tx, {
        accountId: input.replacement.accountId,
    });

    // Defensive: the replacement already holds the replaced Account's role, so
    // retiring the replaced Account cannot strand the Home. A violation here
    // means the construction above changed, and it must abort the whole
    // replacement rather than commit a Home without an owner.
    const ownership = await assertHomeOwnershipSurvivesTransitionInTx(tx, {
        targetAccountId: input.oldAccountId,
        nextStatus: "disabled",
    });
    if (ownership.status !== "allowed") {
        throw new HomeGovernanceInvariantError(
            `Provider-reset replacement would leave the Home without an active owner (${ownership.status}).`,
        );
    }

    await input.retireReplacedAccountInTx(tx);

    return {
        status: "replaced",
        replacementAccountId: input.replacement.accountId,
        transferredTeamMembershipCount,
    };
}
