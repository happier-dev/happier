import type { Metadata } from '@/api/types';

type MetadataRecord = Record<string, unknown>;

export type SessionHandoffRuntimeLocalMetadata = Readonly<Partial<Pick<
    Metadata,
    'claudeSessionId' | 'codexSessionId' | 'opencodeSessionId' | 'directSessionV1'
>>>;

export type SessionHandoffMetadataSplit = Readonly<{
    exportMetadata: MetadataRecord;
    runtimeLocalMetadata?: SessionHandoffRuntimeLocalMetadata;
}>;

export type SessionHandoffLocalMetadataSource = SessionHandoffMetadataSplit;

function asMetadataRecord(value: unknown): MetadataRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as MetadataRecord;
}

function cloneMetadataRecord(metadata: MetadataRecord): MetadataRecord {
    return { ...metadata };
}

function normalizeMetadataMachineId(metadata: MetadataRecord | null): string {
    return typeof metadata?.machineId === 'string' ? metadata.machineId.trim() : '';
}

function cloneRuntimeLocalMetadata(
    runtimeLocalMetadata: SessionHandoffRuntimeLocalMetadata,
): SessionHandoffRuntimeLocalMetadata {
    return {
        ...runtimeLocalMetadata,
        ...(runtimeLocalMetadata.directSessionV1
            ? {
                directSessionV1: {
                    ...runtimeLocalMetadata.directSessionV1,
                    source:
                        runtimeLocalMetadata.directSessionV1.source
                        && typeof runtimeLocalMetadata.directSessionV1.source === 'object'
                        && !Array.isArray(runtimeLocalMetadata.directSessionV1.source)
                            ? { ...runtimeLocalMetadata.directSessionV1.source }
                            : runtimeLocalMetadata.directSessionV1.source,
                },
            }
            : {}),
    };
}

export function isSessionHandoffMetadataSplit(value: unknown): value is SessionHandoffMetadataSplit {
    const record = asMetadataRecord(value);
    if (!record) {
        return false;
    }
    return asMetadataRecord(record.exportMetadata) !== null;
}

export function pickSessionHandoffRuntimeLocalMetadata(
    metadata: MetadataRecord | null,
): SessionHandoffRuntimeLocalMetadata | undefined {
    if (!metadata) {
        return undefined;
    }

    const picked: SessionHandoffRuntimeLocalMetadata = {
        ...(typeof metadata.claudeSessionId === 'string' ? { claudeSessionId: metadata.claudeSessionId } : {}),
        ...(typeof metadata.codexSessionId === 'string' ? { codexSessionId: metadata.codexSessionId } : {}),
        ...(typeof metadata.opencodeSessionId === 'string' ? { opencodeSessionId: metadata.opencodeSessionId } : {}),
        ...(metadata.directSessionV1 && typeof metadata.directSessionV1 === 'object' && !Array.isArray(metadata.directSessionV1)
            ? { directSessionV1: metadata.directSessionV1 as Metadata['directSessionV1'] }
            : {}),
    };

    return Object.keys(picked).length > 0 ? cloneRuntimeLocalMetadata(picked) : undefined;
}

export function createSessionHandoffMetadataSplit(input: Readonly<{
    exportMetadata: MetadataRecord;
    runtimeLocalMetadata?: SessionHandoffRuntimeLocalMetadata;
}>): SessionHandoffMetadataSplit {
    return {
        exportMetadata: cloneMetadataRecord(input.exportMetadata),
        ...(input.runtimeLocalMetadata
            ? { runtimeLocalMetadata: cloneRuntimeLocalMetadata(input.runtimeLocalMetadata) }
            : {}),
    };
}

export function resolveSessionHandoffExportMetadata(input: Readonly<{
    remoteMetadata: MetadataRecord | null;
    localMetadata: SessionHandoffLocalMetadataSource | null;
    preferredLocalExportMachineId?: string;
}>): MetadataRecord | null {
    const localSplit = input.localMetadata && isSessionHandoffMetadataSplit(input.localMetadata)
        ? input.localMetadata
        : null;
    const preferredLocalExportMachineId = typeof input.preferredLocalExportMachineId === 'string'
        ? input.preferredLocalExportMachineId.trim()
        : '';
    const shouldPreferLocalExportMetadata =
        Boolean(
            localSplit
            && input.remoteMetadata
            && preferredLocalExportMachineId
            && normalizeMetadataMachineId(localSplit.exportMetadata) === preferredLocalExportMachineId
            && normalizeMetadataMachineId(input.remoteMetadata) !== preferredLocalExportMachineId,
        );
    const baseMetadata = input.remoteMetadata
        ? shouldPreferLocalExportMetadata
            ? {
                ...input.remoteMetadata,
                ...cloneMetadataRecord(localSplit!.exportMetadata),
                // Preserve remote handoff state when resolving a "pinned to another machine" snapshot.
                // Local export metadata can be stale here, but `handoffV1` must remain the remote truth
                // (it drives sync-changes handoff-back root resolution).
                ...(input.remoteMetadata.handoffV1 !== undefined ? { handoffV1: input.remoteMetadata.handoffV1 } : {}),
            }
            : input.remoteMetadata
        : localSplit?.exportMetadata;
    if (!baseMetadata) {
        return null;
    }

    const exportMetadata = cloneMetadataRecord(baseMetadata);
    const runtimeLocalMetadata = localSplit?.runtimeLocalMetadata;

    if (!runtimeLocalMetadata) {
        return exportMetadata;
    }

    return {
        ...exportMetadata,
        ...cloneRuntimeLocalMetadata(runtimeLocalMetadata),
    };
}
