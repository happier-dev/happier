export class MachineIdConflictError extends Error {
    readonly machineId: string;

    constructor(machineId: string) {
        super(`Machine id conflict: ${machineId} is already registered to a different account on this server`);
        this.name = 'MachineIdConflictError';
        this.machineId = machineId;
    }
}

export class MachineRevokedError extends Error {
    readonly machineId: string;

    constructor(machineId: string) {
        super(`Machine revoked: ${machineId} is no longer valid on this server and must be rotated`);
        this.name = 'MachineRevokedError';
        this.machineId = machineId;
    }
}

export class MachineReplacedError extends Error {
    readonly machineId: string;
    readonly replacementMachineId: string;

    constructor(machineId: string, replacementMachineId: string) {
        super(`Machine replaced: ${machineId} was replaced by ${replacementMachineId}`);
        this.name = 'MachineReplacedError';
        this.machineId = machineId;
        this.replacementMachineId = replacementMachineId;
    }
}

export class MachineContentPublicKeyMismatchError extends Error {
    readonly machineId: string;
    readonly reason: string;

    constructor(machineId: string, reason: string) {
        super(
            `Machine registration rejected by server (reason=${reason}). ` +
                'This usually means your local encryption key does not match your current account credentials. ' +
                'Try `happier auth logout` then `happier auth login`.',
        );
        this.name = 'MachineContentPublicKeyMismatchError';
        this.machineId = machineId;
        this.reason = reason;
    }
}

function hasMachineId(error: unknown): error is { machineId: string } {
    return !!error && typeof error === 'object' && typeof (error as { machineId?: unknown }).machineId === 'string';
}

export function isMachineIdConflictError(error: unknown): error is MachineIdConflictError {
    // Avoid relying on `instanceof`: bundlers / test runners may load multiple module instances.
    if (!error || typeof error !== 'object') return false;
    const maybe = error as Record<string, unknown>;
    if (maybe.name !== 'MachineIdConflictError' || !hasMachineId(error)) return false;
    return error.machineId.length > 0;
}

export function isMachineRevokedError(error: unknown): error is MachineRevokedError {
    if (!error || typeof error !== 'object') return false;
    const maybe = error as Record<string, unknown>;
    if (maybe.name !== 'MachineRevokedError' || !hasMachineId(error)) return false;
    return error.machineId.length > 0;
}

export function isMachineReplacedError(error: unknown): error is MachineReplacedError {
    if (!error || typeof error !== 'object') return false;
    const maybe = error as Record<string, unknown>;
    if (maybe.name !== 'MachineReplacedError' || !hasMachineId(error)) return false;
    return error.machineId.length > 0 && typeof maybe.replacementMachineId === 'string' && maybe.replacementMachineId.length > 0;
}

export function isMachineContentPublicKeyMismatchError(error: unknown): error is MachineContentPublicKeyMismatchError {
    if (!error || typeof error !== 'object') return false;
    const maybe = error as Record<string, unknown>;
    if (maybe.name !== 'MachineContentPublicKeyMismatchError' || !hasMachineId(error)) return false;
    return error.machineId.length > 0 && typeof maybe.reason === 'string' && maybe.reason.length > 0;
}
