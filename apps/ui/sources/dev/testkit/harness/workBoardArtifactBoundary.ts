import { buildWorkBoardArtifactHeaderV1, type WorkBoardArtifactTransportV1, type WorkBoardArtifactV1,
    WorkBoardsV1Schema, type WorkBoardsV1 } from '@happier-dev/protocol';
import type { HomeHubArtifactTransportV1 } from '@happier-dev/protocol/home';

/** Persistence only: the real schema, editor, queue, projection and CAS replay run above it. */
export function createWorkBoardArtifactBoundary(initial: WorkBoardsV1) {
    const rows = new Map<string, WorkBoardArtifactV1>(initial.boards.map(board => [board.id, {
        artifactId: board.id, header: buildWorkBoardArtifactHeaderV1(board), body: JSON.stringify(board),
        revision: { headerVersion: 1, bodyVersion: 1 },
    }]));
    let gate = Promise.resolve();
    let offline = false;
    const reads: string[] = [];
    const available = async () => { await gate; if (offline) throw new Error('offline'); };
    const transport: WorkBoardArtifactTransportV1 = {
        read: async id => { await available(); reads.push(id); return rows.get(id) ?? null; },
        list: async () => { await available(); return { items: [...rows.values()].map(row => ({
            artifactId: row.artifactId, header: row.header, headerVersion: row.revision.headerVersion,
        })) }; },
        create: async input => { await available(); if (!rows.has(input.artifactId)) rows.set(input.artifactId,
            { ...input, revision: { headerVersion: 1, bodyVersion: 1 } }); },
        update: async input => {
            await available(); const row = rows.get(input.artifactId);
            if (!row) return { ok: false, errorCode: 'not_found', error: 'not_found' };
            if (row.revision.headerVersion !== input.expectedRevision.headerVersion || row.revision.bodyVersion !== input.expectedRevision.bodyVersion)
                return { ok: false, errorCode: 'version_mismatch', error: 'version_mismatch' };
            const revision = { headerVersion: row.revision.headerVersion + 1, bodyVersion: row.revision.bodyVersion + 1 };
            rows.set(input.artifactId, { artifactId: input.artifactId, header: input.header, body: input.body, revision });
            return { ok: true, revision };
        },
        delete: async (id, options) => {
            await available(); const row = rows.get(id);
            if (!row) return { ok: false, errorCode: 'not_found', error: 'not_found' };
            if (options?.expectedRevision && (row.revision.headerVersion !== options.expectedRevision.headerVersion || row.revision.bodyVersion !== options.expectedRevision.bodyVersion))
                return { ok: false, errorCode: 'version_mismatch', error: 'version_mismatch' };
            rows.delete(id); return { ok: true };
        },
    };
    const forAccount = (accountId: string): HomeHubArtifactTransportV1 => ({
        read: async (id, options) => { const row = await transport.read(id, options); return row ? { ...row, ownerAccountId: accountId } : null; },
        create: async input => { await transport.create(input); return { ...rows.get(input.artifactId)!, ownerAccountId: accountId }; },
        update: transport.update,
    });
    return { transport, forAccount, rows, reads, offline: (value: boolean) => { offline = value; },
        acknowledged: () => WorkBoardsV1Schema.parse({ v: 1, boards: [...rows.values()].map(row => {
            if (typeof row.body !== 'string') throw new Error('Expected Work board text');
            return JSON.parse(row.body);
        }) }),
        hold() { let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; }); return release; },
    };
}
