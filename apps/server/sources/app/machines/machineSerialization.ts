import {
    ExternalActionMachineBootstrapV1Schema,
    MachineOperationProtocolCapabilitiesV1Schema,
} from "@happier-dev/protocol";

export type MachineSerializationRow = Readonly<{
    id: string;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    installationId?: string | null;
    installationPublicKey?: Uint8Array | null;
    contentPublicKeyFingerprint?: string | null;
    operationProtocolCapabilities?: unknown | null;
    operationProtocolCapabilitiesRevision?: number | null;
    replacedByMachineId?: string | null;
    replacedAt?: Date | null;
    replacementReason?: string | null;
    replacementSource?: string | null;
    replacementActorUserId?: string | null;
    seq: number;
    active: boolean;
    lastActiveAt: Date;
    revokedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}>;

export function serializeMachineRow(row: MachineSerializationRow) {
    const capabilityProjection =
        MachineOperationProtocolCapabilitiesV1Schema.safeParse(
            row.operationProtocolCapabilities,
        );
    const capabilityRevision =
        typeof row.operationProtocolCapabilitiesRevision === "number"
        && Number.isInteger(row.operationProtocolCapabilitiesRevision)
        && row.operationProtocolCapabilitiesRevision > 0
            ? row.operationProtocolCapabilitiesRevision
            : null;
    // A capability leaf is recipient-safe only together with the revision that
    // proves it was an accepted complete projection. Malformed or partial
    // persistence, or a revoked/replaced Machine, is deliberately
    // indistinguishable from unsupported.
    const operationProtocolCapabilities =
        capabilityProjection.success
        && capabilityRevision !== null
        && row.revokedAt === null
        && row.replacedByMachineId === null
            ? capabilityProjection.data
            : null;

    return {
        id: row.id,
        metadata: row.metadata,
        metadataVersion: row.metadataVersion,
        daemonState: row.daemonState,
        daemonStateVersion: row.daemonStateVersion,
        dataEncryptionKey: row.dataEncryptionKey ? Buffer.from(row.dataEncryptionKey).toString("base64") : null,
        installationId: row.installationId ?? null,
        installationPublicKey: row.installationPublicKey ? Buffer.from(row.installationPublicKey).toString("base64") : null,
        contentPublicKeyFingerprint: row.contentPublicKeyFingerprint ?? null,
        operationProtocolCapabilities,
        operationProtocolCapabilitiesRevision:
            operationProtocolCapabilities === null ? null : capabilityRevision,
        replacedByMachineId: row.replacedByMachineId ?? null,
        replacedAt: row.replacedAt ? row.replacedAt.getTime() : null,
        replacementReason: row.replacementReason ?? null,
        replacementSource: row.replacementSource ?? null,
        replacementActorUserId: row.replacementActorUserId ?? null,
        seq: row.seq,
        active: row.active,
        activeAt: row.lastActiveAt.getTime(),
        revokedAt: row.revokedAt ? row.revokedAt.getTime() : null,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
    };
}

export function serializeExternalActionMachineBootstrapRow(
    row: Pick<
        MachineSerializationRow,
        "id" | "active" | "revokedAt" | "replacedByMachineId"
    >,
) {
    return ExternalActionMachineBootstrapV1Schema.parse({
        id: row.id,
        active: row.active,
        revokedAt: row.revokedAt ? row.revokedAt.getTime() : null,
        replacedByMachineId: row.replacedByMachineId ?? null,
    });
}
