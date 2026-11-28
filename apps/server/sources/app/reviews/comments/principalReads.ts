import { db } from "@/storage/db";
import { workflowRunIdentityWhere } from "@/app/workflows/workflowRunService";
import { readCurrentCommittedSessionInputMachineTargetInTx } from "@/app/session/messages/sessionInputAdmission";
import { resolveReviewAccessInTx } from "../reviewAccess";

/** Reuse read facts within one HTTP request; proof and item admission stay with the route. */
function reuseRequestRead<Args extends unknown[], Result>(read: (...args: Args) => Promise<Result>) {
    const pending = new Map<string, Promise<Result>>();
    return (...args: Args): Promise<Result> => {
        const key = JSON.stringify(args);
        let result = pending.get(key);
        if (!result) {
            result = read(...args);
            pending.set(key, result);
        }
        return result;
    };
}

export function createReviewCommentPrincipalReads() {
    return {
        account: reuseRequestRead(async (accountId: string) => db.account.findUnique({
            where: { id: accountId },
            select: { publicKey: true, seq: true, encryptionMode: true, contentPublicKey: true, contentPublicKeySig: true },
        })),
        workflow: reuseRequestRead(async (accountId: string, runId: string) => db.automationRun.findFirst({
            where: workflowRunIdentityWhere({ runId, accountId }),
            select: {
                originSessionId: true, claimedByMachineId: true, workflowCustodyState: true, state: true,
                assignments: { orderBy: { priority: "asc" }, take: 1,
                    select: { machineId: true, admittedMachineInstallationId: true } },
            },
        })),
        sessionPlacement: reuseRequestRead(async (sessionId: string) => readCurrentCommittedSessionInputMachineTargetInTx(db, sessionId, { admittedWork: true })),
        machine: reuseRequestRead(async (accountId: string, machineId: string, usesSharedInstallation: boolean) => db.machine.findFirst({
            where: { ...(usesSharedInstallation ? {} : { accountId }), id: machineId },
            select: { installationId: true, installationPublicKey: true, replacedByMachineId: true, revokedAt: true },
        })),
        logicalInvocation: reuseRequestRead(async (runId: string, invocationId: string) => db.workflowRunInvocation.findFirst({
            where: { id: invocationId, runId }, select: { parentRecordId: true, memberOrdinal: true },
        })),
        invocation: reuseRequestRead(async (runId: string, invocationId: string) => db.workflowRunInvocation.findFirst({
            where: { id: invocationId, runId }, select: { parentRecordId: true, memberOrdinal: true, attempt: true, lifecycle: true },
        })),
        reviewAccess: reuseRequestRead(async (actorAccountId: string, reviewId: string) => resolveReviewAccessInTx(db, { actorAccountId, reviewId })),
    };
}

export type ReviewCommentPrincipalReads = ReturnType<typeof createReviewCommentPrincipalReads>;
