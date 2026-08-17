import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
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

    // Flat vendor resume keys are the one field group here that identifies WHICH
    // Agent the Session is running, so they cannot be restored unconditionally.
    // A cross-Agent transition clears the source Agent's key on purpose and the
    // next snapshot already names the target, so restoring the previous key would
    // resurrect exactly the id that was cleared and leave two live resume keys —
    // the state `REQ-STATE-01` forbids and the resume path breaks on. Preservation
    // therefore applies only while the Session still names the same Agent; an
    // update that names no Agent at all (or a previous snapshot that never did)
    // keeps the existing behaviour, because nothing there contradicts the key.
    const previousAgentId = resolveAgentIdFromSessionMetadata(previousMetadata);
    const preservedAgentId = resolveAgentIdFromSessionMetadata(preservedMetadata);
    const preservesVendorResumeKeys = previousAgentId === null
        || preservedAgentId === null
        || previousAgentId === preservedAgentId;

    if (
        preservesVendorResumeKeys
        && preservedMetadata.claudeSessionId == null
        && previousMetadata.claudeSessionId != null
    ) {
        preservedMetadata = {
            ...preservedMetadata,
            claudeSessionId: previousMetadata.claudeSessionId,
        };
    }

    if (
        preservesVendorResumeKeys
        && preservedMetadata.codexSessionId == null
        && previousMetadata.codexSessionId != null
    ) {
        preservedMetadata = {
            ...preservedMetadata,
            codexSessionId: previousMetadata.codexSessionId,
        };
    }

    if (
        preservesVendorResumeKeys
        && preservedMetadata.opencodeSessionId == null
        && previousMetadata.opencodeSessionId != null
    ) {
        preservedMetadata = {
            ...preservedMetadata,
            opencodeSessionId: previousMetadata.opencodeSessionId,
        };
    }

    return preservedMetadata;
}
