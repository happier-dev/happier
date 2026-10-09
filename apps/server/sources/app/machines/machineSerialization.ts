import {
    ACCOUNT_STORED_CONTENT_SESSION_SPAWN_PLACEMENT_ORIGIN_PROTOCOL_VERSION,
    ExternalActionMachineBootstrapV1Schema,
    MachineOperationProtocolCapabilitiesV1StoredReadSchema,
    MachineKindFromLegacyProjectionSchema,
    RunnerClaimV1Schema,
    RunnerMachineContentKeyBindingV1Schema,
    type AccessibleMachineAccessV1,
    type MachineKind,
} from "@happier-dev/protocol";
import * as privacyKit from 'privacy-kit';
import type { MachineKeyBasisV1 } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import type { DevcontainerChildProjectionV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';

export type MachineSerializationRow = Readonly<{
    id: string;
    kind?: MachineKind;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    runnerContentKeyBinding?: unknown | null;
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

/** Publish the owner envelope, never the caller's recipient-specific wrapping. */
export function serializeMachineKeyBasis(
    row: Pick<MachineSerializationRow, 'dataEncryptionKey' | 'metadataVersion' | 'daemonStateVersion'>,
): MachineKeyBasisV1 {
    return {
        dataEncryptionKey: row.dataEncryptionKey === null ? null : privacyKit.encodeBase64(row.dataEncryptionKey),
        metadataVersion: row.metadataVersion,
        daemonStateVersion: row.daemonStateVersion,
    };
}

export function serializeMachineRow(
    row: MachineSerializationRow,
    options: Readonly<{
        recipientAccountStoredContentProtocolVersion?: number | null;
        storageMode?: "plain" | "e2ee";
        devcontainerChild?: DevcontainerChildProjectionV1 | null;
    }> = {},
) {
    const kind = MachineKindFromLegacyProjectionSchema.parse(row.kind);
    const runnerContentKeyBinding = kind === "ephemeral_session_runner"
        ? RunnerMachineContentKeyBindingV1Schema.safeParse(row.runnerContentKeyBinding)
        : null;
    const capabilityProjection =
        MachineOperationProtocolCapabilitiesV1StoredReadSchema.safeParse(
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
    const completeOperationProtocolCapabilities =
        capabilityProjection.success
        && capabilityRevision !== null
        && row.revokedAt === null
        && row.replacedByMachineId === null
            ? capabilityProjection.data
            : null;
    const operationProtocolCapabilities = completeOperationProtocolCapabilities === null
        ? null
        : options.recipientAccountStoredContentProtocolVersion !== undefined
            && options.recipientAccountStoredContentProtocolVersion !== null
            && options.recipientAccountStoredContentProtocolVersion
                >= ACCOUNT_STORED_CONTENT_SESSION_SPAWN_PLACEMENT_ORIGIN_PROTOCOL_VERSION
            ? completeOperationProtocolCapabilities
            : (() => {
                const {
                    sessionSpawnPlacementOrigin: _withheldPlacementOrigin,
                    ...preV4Capabilities
                } = completeOperationProtocolCapabilities;
                return preV4Capabilities;
            })();

    const keyBasis = serializeMachineKeyBasis(row);
    const dataEncryptionKey = keyBasis.dataEncryptionKey;
    return {
        id: row.id,
        devcontainerChild: row.revokedAt === null && row.replacedByMachineId == null ? options.devcontainerChild ?? null : null,
        kind,
        ...(options.storageMode ? { storageMode: options.storageMode } : {}),
        metadata: row.metadata,
        metadataVersion: row.metadataVersion,
        daemonState: row.daemonState,
        daemonStateVersion: row.daemonStateVersion,
        dataEncryptionKey,
        keyBasis,
        runnerContentKeyBinding:
            runnerContentKeyBinding?.success === true
                ? runnerContentKeyBinding.data
                : null,
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

/** Access is server-derived; foreign rows carry only their own current resource envelope. */
export function serializeAccessibleMachineRow(
    row: MachineSerializationRow,
    options: Readonly<{
        access: AccessibleMachineAccessV1;
        owned: boolean;
        callerDataEncryptionKey: Uint8Array | null;
        devcontainerChild?: DevcontainerChildProjectionV1 | null;
        recipientAccountStoredContentProtocolVersion?: number | null;
    }>,
) {
    const projection = serializeMachineRow(row, {
        storageMode: options.access.resourceMode,
        recipientAccountStoredContentProtocolVersion: options.recipientAccountStoredContentProtocolVersion,
        devcontainerChild: options.devcontainerChild,
    });
    if (options.owned && options.access.accessState === 'ready') return { ...projection, access: options.access };

    const canReadContent = options.access.accessState === 'ready'
        && (options.access.resourceMode === 'plain' || options.callerDataEncryptionKey !== null);
    const dataEncryptionKey = canReadContent && options.access.resourceMode === 'e2ee'
        && options.callerDataEncryptionKey !== null
        ? privacyKit.encodeBase64(options.callerDataEncryptionKey)
        : null;
    // The CAS basis names the owner wrapping as an opaque identity, while
    // dataEncryptionKey is the recipient's own decryptable wrapping.
    return {
        ...projection,
        access: options.access,
        metadata: canReadContent ? projection.metadata : null,
        devcontainerChild: canReadContent ? projection.devcontainerChild : null,
        daemonState: canReadContent ? projection.daemonState : null,
        dataEncryptionKey,
        runnerContentKeyBinding: null,
    };
}

/**
 * A PAT caller selects an exact Machine with this row and, for a restricted
 * Runner, seals its protected request against the Runner's own content key.
 * Both Machine kinds carry their encoded recipient envelope, which a bearer
 * token cannot open. Runner authenticity additionally requires its signed
 * binding. Metadata and daemon state remain outside this bootstrap projection.
 *
 * `runnerClaim` is the activation's persisted, activation-signed claim, which
 * binds the Runner to the exact Session it was activated for. A
 * Session-targeted protected request selects the Runner only through it, so the
 * Home relays that correspondence but cannot author it. The claim carries public
 * keys and signatures only, never a credential.
 */
function runnerClaim(value: unknown) {
    const parsed = RunnerClaimV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export function serializeExternalActionMachineBootstrapRow(
    row: Pick<
        MachineSerializationRow,
        "id" | "active" | "revokedAt" | "replacedByMachineId"
    > & Partial<Pick<
        MachineSerializationRow,
        "kind" | "installationId" | "dataEncryptionKey" | "runnerContentKeyBinding"
    >> & Readonly<{
        activationClaim?: unknown;
        storageMode?: "plain" | "e2ee";
        access?: AccessibleMachineAccessV1;
    }>,
) {
    const kind = MachineKindFromLegacyProjectionSchema.parse(row.kind);
    const runnerContentKeyBinding = kind === "ephemeral_session_runner"
        ? RunnerMachineContentKeyBindingV1Schema.safeParse(row.runnerContentKeyBinding)
        : null;
    return ExternalActionMachineBootstrapV1Schema.parse({
        id: row.id,
        active: row.active,
        revokedAt: row.revokedAt ? row.revokedAt.getTime() : null,
        replacedByMachineId: row.replacedByMachineId ?? null,
        kind,
        ...(row.access ? { access: row.access } : {}),
        runnerClaim: kind === "ephemeral_session_runner"
            ? runnerClaim(row.activationClaim)
            : null,
        installationId: kind === "ephemeral_session_runner" || row.access
            ? row.installationId ?? null
            : null,
        dataEncryptionKey: row.dataEncryptionKey
            ? Buffer.from(row.dataEncryptionKey).toString("base64")
            : null,
        runnerContentKeyBinding: runnerContentKeyBinding?.success === true
            ? runnerContentKeyBinding.data
            : null,
    });
}
