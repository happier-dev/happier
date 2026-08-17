import { resolveLinkedExternalSessionMetadataV1 } from '@happier-dev/protocol';
import type { Metadata } from '@/sync/domains/state/storageTypes';

type RuntimeLocalMetadataShape = {
    name?: unknown;
    summary?: unknown;
    path?: unknown;
    homeDir?: unknown;
    host?: unknown;
    machineId?: unknown;
    flavor?: unknown;
    externalSessionV1?: unknown;
    directSessionV1?: unknown;
    externalHistoryImportV1?: unknown;
    claudeSessionId?: unknown;
    codexSessionId?: unknown;
    opencodeSessionId?: unknown;
};

function readRuntimeLocalMachineId(metadata: RuntimeLocalMetadataShape): unknown {
    if (metadata.machineId != null) {
        return metadata.machineId;
    }

    const linkedSessionResolution = resolveLinkedExternalSessionMetadataV1(metadata);
    return linkedSessionResolution.ok
        ? linkedSessionResolution.linkedSession.machineId
        : undefined;
}

export function preserveSessionRuntimeLocalMetadata(
    previousMetadata: Metadata | null | undefined,
    nextMetadata: Metadata | null | undefined,
): Metadata | null;
export function preserveSessionRuntimeLocalMetadata<T extends RuntimeLocalMetadataShape>(
    previousMetadata: T | null | undefined,
    nextMetadata: T | null | undefined,
): T | null;
export function preserveSessionRuntimeLocalMetadata<T extends RuntimeLocalMetadataShape>(
    previousMetadata: T | null | undefined,
    nextMetadata: T | null | undefined,
): T | null {
    if (!previousMetadata || !nextMetadata) {
        return nextMetadata ?? null;
    }

    let preservedMetadata = nextMetadata;
    const previousRuntimeLocalMachineId = readRuntimeLocalMachineId(previousMetadata);

    if (
        preservedMetadata.externalHistoryImportV1 == null
        && preservedMetadata.externalSessionV1 == null
        && previousMetadata.externalSessionV1 != null
    ) {
        preservedMetadata = {
            ...preservedMetadata,
            externalSessionV1: previousMetadata.externalSessionV1,
        };
    }

    if (preservedMetadata.machineId == null && previousRuntimeLocalMachineId != null) {
        preservedMetadata = {
            ...preservedMetadata,
            machineId: previousRuntimeLocalMachineId,
        };
    }

    if (preservedMetadata.path == null && previousMetadata.path != null) {
        preservedMetadata = {
            ...preservedMetadata,
            path: previousMetadata.path,
        };
    }

    if (preservedMetadata.homeDir == null && previousMetadata.homeDir != null) {
        preservedMetadata = {
            ...preservedMetadata,
            homeDir: previousMetadata.homeDir,
        };
    }

    if (preservedMetadata.host == null && previousMetadata.host != null) {
        preservedMetadata = {
            ...preservedMetadata,
            host: previousMetadata.host,
        };
    }

    if (preservedMetadata.flavor == null && previousMetadata.flavor != null) {
        preservedMetadata = {
            ...preservedMetadata,
            flavor: previousMetadata.flavor,
        };
    }

    if (preservedMetadata.name == null && previousMetadata.name != null) {
        preservedMetadata = {
            ...preservedMetadata,
            name: previousMetadata.name,
        };
    }

    if (preservedMetadata.summary == null && previousMetadata.summary != null) {
        preservedMetadata = {
            ...preservedMetadata,
            summary: previousMetadata.summary,
        };
    }

    if (preservedMetadata.claudeSessionId == null && previousMetadata.claudeSessionId != null) {
        preservedMetadata = {
            ...preservedMetadata,
            claudeSessionId: previousMetadata.claudeSessionId,
        };
    }

    if (preservedMetadata.codexSessionId == null && previousMetadata.codexSessionId != null) {
        preservedMetadata = {
            ...preservedMetadata,
            codexSessionId: previousMetadata.codexSessionId,
        };
    }

    if (preservedMetadata.opencodeSessionId == null && previousMetadata.opencodeSessionId != null) {
        preservedMetadata = {
            ...preservedMetadata,
            opencodeSessionId: previousMetadata.opencodeSessionId,
        };
    }

    return preservedMetadata;
}
