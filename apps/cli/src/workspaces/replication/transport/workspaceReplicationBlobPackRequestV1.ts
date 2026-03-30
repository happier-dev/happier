import {
    assertSafeWorkspaceReplicationPackId,
    createWorkspaceReplicationPackIdForDigests,
} from './workspaceReplicationPackId';

export type WorkspaceReplicationBlobPackRequestV1 = Readonly<{
    t: 'workspace_replication_blob_pack_v1';
    packId: string;
    digests: readonly string[];
}>;

function isSortedUnique(values: readonly string[]): boolean {
    for (let index = 0; index < values.length; index += 1) {
        const current = values[index] ?? '';
        const next = values[index + 1];
        if (!current) return false;
        if (next !== undefined && current >= next) return false;
    }
    return true;
}

export function parseWorkspaceReplicationBlobPackRequestV1(
    input: unknown,
    options: Readonly<{ maxBlobs: number }>,
): WorkspaceReplicationBlobPackRequestV1 | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null;
    }

    const record = input as Record<string, unknown>;
    if (record.t !== 'workspace_replication_blob_pack_v1') {
        return null;
    }
    if (typeof record.packId !== 'string' || record.packId.trim().length === 0) {
        return null;
    }
    if (!Array.isArray(record.digests) || record.digests.some((digest) => typeof digest !== 'string')) {
        return null;
    }

    let packId: string;
    try {
        packId = assertSafeWorkspaceReplicationPackId(record.packId);
    } catch {
        return null;
    }

    const digests = (record.digests as string[]).map((digest) => digest.trim());
    // Fail closed: do not drop blank entries (prevents request-body smuggling and keeps packId stable).
    if (digests.length === 0 || digests.some((digest) => digest.length === 0) || !isSortedUnique(digests)) {
        return null;
    }
    if (digests.length > options.maxBlobs) {
        return null;
    }
    const expectedPackId = createWorkspaceReplicationPackIdForDigests(digests);
    if (expectedPackId !== packId) {
        return null;
    }

    return {
        t: 'workspace_replication_blob_pack_v1',
        packId,
        digests,
    };
}
