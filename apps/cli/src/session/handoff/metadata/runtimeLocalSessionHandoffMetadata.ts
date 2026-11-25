import {
    cloneSessionRuntimeLocalMetadata,
    pickSessionRuntimeLocalMetadata,
    type SessionRuntimeLocalMetadata,
} from '@/agent/runtime/identity';
import { normalizeLinkedExternalSessionMetadataV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';

type MetadataRecord = Record<string, unknown>;

export type SessionHandoffRuntimeLocalMetadata = SessionRuntimeLocalMetadata;

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
    return pickSessionRuntimeLocalMetadata(metadata);
}

export function createSessionHandoffMetadataSplit(input: Readonly<{
    exportMetadata: MetadataRecord;
    runtimeLocalMetadata?: SessionHandoffRuntimeLocalMetadata;
}>): SessionHandoffMetadataSplit {
    return {
        exportMetadata: cloneMetadataRecord(input.exportMetadata),
        ...(input.runtimeLocalMetadata
            ? { runtimeLocalMetadata: cloneSessionRuntimeLocalMetadata(input.runtimeLocalMetadata) }
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
    const remoteIsOnSource = Boolean(preferredLocalExportMachineId
        && normalizeMetadataMachineId(input.remoteMetadata) === preferredLocalExportMachineId);
    const shouldPreferLocalExportMetadata =
        Boolean(
            localSplit
            && input.remoteMetadata
            && preferredLocalExportMachineId
            && normalizeMetadataMachineId(localSplit.exportMetadata) === preferredLocalExportMachineId
            && !remoteIsOnSource,
        );
    const shouldSupplementRemoteExportMetadata =
        Boolean(
            localSplit
            && input.remoteMetadata
            && preferredLocalExportMachineId
            && normalizeMetadataMachineId(localSplit.exportMetadata) === preferredLocalExportMachineId
            && remoteIsOnSource,
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
            : shouldSupplementRemoteExportMetadata
                ? {
                    ...cloneMetadataRecord(localSplit!.exportMetadata),
                    ...input.remoteMetadata,
                }
            : input.remoteMetadata
        : localSplit?.exportMetadata;
    if (!baseMetadata) {
        return null;
    }

    const exportMetadata = cloneMetadataRecord(baseMetadata);
    const runtimeLocalMetadata = localSplit?.runtimeLocalMetadata;

    if (!runtimeLocalMetadata) {
        return normalizeLinkedExternalSessionMetadataV1(exportMetadata, 'stored') ?? exportMetadata;
    }

    // The runner publishes its launch descriptor after the daemon's spawn snapshot.
    // Prefer it for this source Machine. A handoff-back still uses this daemon's local snapshot.
    const publishedRuntimeDescriptor = remoteIsOnSource
        ? readRuntimeDescriptorV1FromMetadata(input.remoteMetadata)
        : null;
    const mergedMetadata = {
        ...exportMetadata,
        ...cloneSessionRuntimeLocalMetadata(runtimeLocalMetadata),
        ...(publishedRuntimeDescriptor ? { runtimeDescriptorV1: publishedRuntimeDescriptor } : {}),
    };
    return normalizeLinkedExternalSessionMetadataV1(mergedMetadata, 'stored') ?? mergedMetadata;
}
