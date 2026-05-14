import type { Tx } from "@/storage/inTx";
import { applyMachineReplacement, MachineReplacementWriteConflictError } from "./applyMachineReplacement";
import { validateMachineReplacement, type MachineReplacementRow } from "./validateMachineReplacement";

export type ApplyVerifiedMachineRegistrationReplacementParams = Readonly<{
    tx: Tx;
    accountId: string;
    replacementMachineId: string;
    replacesMachineId: string | null | undefined;
    replacementMachine?: MachineReplacementRow | null;
    reason: string;
}>;

export class MachineRegistrationReplacementError extends Error {
    constructor(readonly statusCode: number, readonly reason: string) {
        super(reason);
    }
}

export type MachineRegistrationReplacementResult =
    | Readonly<{ status: "applied"; replacesMachineId: string }>
    | Readonly<{ status: "alreadyApplied"; replacesMachineId: string }>;

export async function applyVerifiedMachineRegistrationReplacement(
    params: ApplyVerifiedMachineRegistrationReplacementParams,
): Promise<MachineRegistrationReplacementResult | null> {
    const replacesMachineId = typeof params.replacesMachineId === "string" && params.replacesMachineId.trim()
        ? params.replacesMachineId.trim()
        : null;
    if (!replacesMachineId) return null;

    const oldMachine = await params.tx.machine.findFirst({
        where: { accountId: params.accountId, id: replacesMachineId },
    });
    const replacementMachine = params.replacementMachine ?? await params.tx.machine.findFirst({
        where: { accountId: params.accountId, id: params.replacementMachineId },
    });

    const validation = validateMachineReplacement({
        accountId: params.accountId,
        oldMachine,
        replacementMachine,
        replacementMachineId: params.replacementMachineId,
        source: "automatic",
    });
    if (!validation.ok) {
        if (validation.reason === "old_machine_replacement_conflict") {
            throw new MachineRegistrationReplacementError(validation.statusCode, validation.reason);
        }
        return null;
    }
    if (validation.alreadyApplied) {
        return { status: "alreadyApplied", replacesMachineId };
    }

    try {
        await applyMachineReplacement({
            tx: params.tx,
            accountId: params.accountId,
            oldMachineId: replacesMachineId,
            replacementMachineId: params.replacementMachineId,
            reason: params.reason,
            source: "automatic",
            actorUserId: null,
        });
    } catch (error) {
        if (error instanceof MachineReplacementWriteConflictError) {
            throw new MachineRegistrationReplacementError(error.statusCode, error.reason);
        }
        throw error;
    }
    return { status: "applied", replacesMachineId };
}
