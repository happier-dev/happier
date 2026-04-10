import { z } from 'zod';

export const MACHINE_OWNER_CONFLICT_ERROR = 'machine-owner-conflict' as const;

export const MACHINE_DAEMON_STARTUP_SOURCE_VALUES = [
    'manual',
    'background-service',
    'self-restart',
    'installer',
    'unknown',
] as const;

export const MachineDaemonStartupSourceSchema = z.enum(MACHINE_DAEMON_STARTUP_SOURCE_VALUES);

export const MachineDaemonOwnershipMetadataSchema = z.object({
    runtimeId: z.string().trim().min(1).optional(),
    cliVersion: z.string().trim().min(1).optional(),
    publicReleaseChannel: z.string().trim().min(1).optional(),
    startupSource: MachineDaemonStartupSourceSchema.optional(),
    serviceManaged: z.boolean().optional(),
    serviceLabel: z.string().trim().min(1).optional(),
});

export type MachineDaemonOwnershipMetadata = z.infer<typeof MachineDaemonOwnershipMetadataSchema>;

export const MachineOwnerConflictMetadataSchema = MachineDaemonOwnershipMetadataSchema.omit({
    runtimeId: true,
});

export type MachineOwnerConflictMetadata = z.infer<typeof MachineOwnerConflictMetadataSchema>;

export const MachineOwnerConflictSocketPayloadSchema = z.object({
    error: z.literal(MACHINE_OWNER_CONFLICT_ERROR),
    statusCode: z.literal(409),
    owner: MachineOwnerConflictMetadataSchema,
});

export type MachineOwnerConflictSocketPayload = z.infer<typeof MachineOwnerConflictSocketPayloadSchema>;

function normalizeOptionalStringField(value: unknown): string | undefined {
    const parsed = z.string().trim().min(1).safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

function normalizeOptionalBooleanField(value: unknown): boolean | undefined {
    const parsed = z.boolean().safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

function normalizeOptionalStartupSource(value: unknown): MachineDaemonOwnershipMetadata['startupSource'] {
    const parsed = MachineDaemonStartupSourceSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

function normalizeMachineDaemonOwnershipMetadata(input: unknown): MachineDaemonOwnershipMetadata {
    const object = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
    return {
        ...(normalizeOptionalStringField(object.runtimeId) ? { runtimeId: normalizeOptionalStringField(object.runtimeId) } : null),
        ...(normalizeOptionalStringField(object.cliVersion) ? { cliVersion: normalizeOptionalStringField(object.cliVersion) } : null),
        ...(normalizeOptionalStringField(object.publicReleaseChannel)
            ? { publicReleaseChannel: normalizeOptionalStringField(object.publicReleaseChannel) }
            : null),
        ...(normalizeOptionalStartupSource(object.startupSource) ? { startupSource: normalizeOptionalStartupSource(object.startupSource) } : null),
        ...(typeof normalizeOptionalBooleanField(object.serviceManaged) === 'boolean'
            ? { serviceManaged: normalizeOptionalBooleanField(object.serviceManaged) }
            : null),
        ...(normalizeOptionalStringField(object.serviceLabel) ? { serviceLabel: normalizeOptionalStringField(object.serviceLabel) } : null),
    };
}

export function buildMachineScopedSocketAuth(params: Readonly<{
    token: string;
    machineId: string;
    runtimeId?: string;
    cliVersion?: string;
    publicReleaseChannel?: string;
    startupSource?: string;
    serviceManaged?: boolean;
    serviceLabel?: string;
    takeover?: boolean;
}>): Record<string, unknown> {
    const ownership = readMachineDaemonOwnershipMetadataFromSocketAuth(params);
    return {
        token: params.token,
        clientType: 'machine-scoped' as const,
        machineId: params.machineId,
        ...ownership,
        ...(params.takeover === true ? { takeover: true as const } : null),
    };
}

export function readMachineDaemonOwnershipMetadataFromSocketAuth(
    input: unknown,
): MachineDaemonOwnershipMetadata {
    return normalizeMachineDaemonOwnershipMetadata(input);
}

export function buildMachineOwnerConflictSocketPayload(
    owner: MachineDaemonOwnershipMetadata,
): MachineOwnerConflictSocketPayload {
    const normalizedOwner = normalizeMachineDaemonOwnershipMetadata(owner);
    const { runtimeId: _runtimeId, ...conflictOwner } = normalizedOwner;
    return {
        error: MACHINE_OWNER_CONFLICT_ERROR,
        statusCode: 409,
        owner: MachineOwnerConflictMetadataSchema.parse(conflictOwner),
    };
}

export function readMachineOwnerConflictSocketPayload(
    input: unknown,
): MachineOwnerConflictSocketPayload | null {
    const object = typeof input === 'object' && input !== null ? input as Record<string, unknown> : null;
    if (!object || object.error !== MACHINE_OWNER_CONFLICT_ERROR || object.statusCode !== 409) {
        return null;
    }
    const owner = readMachineDaemonOwnershipMetadataFromSocketAuth(object.owner);
    const { runtimeId: _runtimeId, ...conflictOwner } = owner;
    return {
        error: MACHINE_OWNER_CONFLICT_ERROR,
        statusCode: 409,
        owner: conflictOwner,
    } satisfies MachineOwnerConflictSocketPayload;
}
