import { isPersistentMachine, type MachineKind } from '@happier-dev/protocol/machines/machineKind';

export type MachineReplacementSource = "automatic" | "manual";

export type MachineReplacementRow = Readonly<{
    id: string;
    accountId: string;
    kind?: MachineKind;
    active: boolean;
    revokedAt: Date | null;
    installationId?: string | null;
    installationPublicKey?: Uint8Array | null;
    contentPublicKeyFingerprint?: string | null;
    replacedByMachineId?: string | null;
}>;

export type MachineReplacementValidationInput = Readonly<{
    accountId: string;
    oldMachine: MachineReplacementRow | null;
    replacementMachine: MachineReplacementRow | null;
    replacementMachineId: string;
    source: MachineReplacementSource;
    confirmActiveOldMachine?: boolean;
}>;

export type MachineReplacementValidationResult =
    | { ok: true; alreadyApplied?: boolean }
    | { ok: false; statusCode: number; reason: string };

function hasIncompatibleKeyspace(oldMachine: MachineReplacementRow, replacementMachine: MachineReplacementRow): boolean {
    const oldFingerprint = oldMachine.contentPublicKeyFingerprint ?? null;
    const replacementFingerprint = replacementMachine.contentPublicKeyFingerprint ?? null;
    return Boolean(oldFingerprint && replacementFingerprint && oldFingerprint !== replacementFingerprint);
}

export function validateMachineReplacement(input: MachineReplacementValidationInput): MachineReplacementValidationResult {
    const { accountId, oldMachine, replacementMachine, replacementMachineId, source } = input;
    if (!oldMachine || oldMachine.accountId !== accountId) {
        return { ok: false, statusCode: 404, reason: "old_machine_not_found" };
    }
    if (!replacementMachine || replacementMachine.accountId !== accountId) {
        return { ok: false, statusCode: 404, reason: "replacement_machine_not_found" };
    }
    if (!isPersistentMachine(oldMachine) || !isPersistentMachine(replacementMachine)) {
        return { ok: false, statusCode: 400, reason: "persistent_machine_required" };
    }
    if (oldMachine.id === replacementMachineId) {
        return { ok: false, statusCode: 400, reason: "replacement_same_machine" };
    }
    if (oldMachine.replacedByMachineId) {
        if (oldMachine.replacedByMachineId === replacementMachineId) {
            return { ok: true, alreadyApplied: true };
        }
        if (source === "automatic") {
            return { ok: false, statusCode: 409, reason: "old_machine_replacement_conflict" };
        }
    }
    const target = validateMachineReplacementTarget({ oldMachine, replacementMachine });
    if (!target.ok) return target;

    if (source === "manual" && oldMachine.active && input.confirmActiveOldMachine !== true) {
        return { ok: false, statusCode: 409, reason: "old_machine_active_confirmation_required" };
    }

    return { ok: true };
}

/** Initial admission and terminal publication enforce the same destination rule. */
export function validateMachineReplacementTarget(input: Readonly<{
    oldMachine: MachineReplacementRow; replacementMachine: MachineReplacementRow;
}>): MachineReplacementValidationResult {
    const { oldMachine, replacementMachine } = input;
    if (replacementMachine.revokedAt) {
        return { ok: false, statusCode: 400, reason: "replacement_machine_revoked" };
    }
    if (replacementMachine.replacedByMachineId) {
        return { ok: false, statusCode: 400, reason: "replacement_machine_already_replaced" };
    }
    if (hasIncompatibleKeyspace(oldMachine, replacementMachine)) {
        return { ok: false, statusCode: 400, reason: "content_public_key_fingerprint_mismatch" };
    }

    return { ok: true };
}
