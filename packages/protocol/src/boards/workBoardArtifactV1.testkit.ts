import { buildWorkBoardArtifactHeaderV1, type WorkBoardArtifactTransportV1, type WorkBoardArtifactV1 } from './workBoardArtifactV1.js';
import { WorkBoardV1Schema } from './workBoardV1.js';
import type { HomeHubArtifactTransportV1 } from '../home/homeHubArtifactV1.js';

/** Artifact persistence is the genuine boundary; tests retain the real Board schema, editor and CAS replay. */
export function createWorkBoardArtifactBoundary(initial: readonly unknown[] = []) {
    const rows = new Map<string, WorkBoardArtifactV1>();
    let written = false;
    let offline = false;
    const reads: string[] = [];
    const updates: string[] = [];
    const add = (raw: unknown) => {
        const parsed = WorkBoardV1Schema.safeParse(raw);
        const value = raw as { id: string; name?: string };
        rows.set(value.id, { artifactId: value.id, body: JSON.stringify(raw),
            header: parsed.success ? buildWorkBoardArtifactHeaderV1(parsed.data)
                : { kind: 'work-board.v1', v: 1, title: value.name ?? value.id, pinnedInSessions: false, readsNeedsYou: false },
            revision: { headerVersion: 1, bodyVersion: 1 }, access: 'owner', shared: false });
    };
    initial.forEach(add);
    const available = () => { if (offline) throw new Error('offline'); };
    const transport: WorkBoardArtifactTransportV1 = {
        read: async id => { available(); reads.push(id); return rows.get(id) ?? null; },
        list: async () => { available(); return { items: [...rows.values()].map(row => ({ artifactId: row.artifactId, header: row.header,
            ...row.revision, ownerAccountId: row.ownerAccountId, access: row.access })) }; },
        create: async input => {
            available(); written = true;
            if (!rows.has(input.artifactId)) rows.set(input.artifactId, { ...input, revision: { headerVersion: 1, bodyVersion: 1 }, access: 'owner', shared: false });
            return { artifactId: input.artifactId };
        },
        update: async input => {
            available(); const row = rows.get(input.artifactId);
            if (!row) return { ok: false, errorCode: 'not_found', error: 'not_found' };
            if (JSON.stringify(row.revision) !== JSON.stringify(input.expectedRevision)) return { ok: false, errorCode: 'version_mismatch', error: 'version_mismatch' };
            written = true; updates.push(input.artifactId);
            const revision = { headerVersion: row.revision.headerVersion + 1, bodyVersion: row.revision.bodyVersion + 1 };
            rows.set(input.artifactId, { ...row, artifactId: input.artifactId, header: input.header, body: input.body, revision });
            return { ok: true, revision };
        },
        delete: async (id, options) => {
            available(); const row = rows.get(id);
            if (!row) return { ok: false, errorCode: 'not_found', error: 'not_found' };
            if (options?.expectedRevision && JSON.stringify(row.revision) !== JSON.stringify(options.expectedRevision)) return { ok: false, errorCode: 'version_mismatch', error: 'version_mismatch' };
            written = true; rows.delete(id); return { ok: true };
        },
    };
    const forAccount = (accountId: string): HomeHubArtifactTransportV1 => ({
        read: async (id, options) => { const row = await transport.read(id, options); return row ? { ...row,
            ownerAccountId: row.ownerAccountId ?? accountId, access: row.access ?? 'owner', shared: row.shared ?? false } : null; },
        create: async input => {
            await transport.create(input);
            const current = rows.get(input.artifactId)!;
            const row = { ...current, ownerAccountId: current.ownerAccountId ?? accountId,
                access: current.access ?? 'owner' as const, shared: current.shared ?? false };
            rows.set(input.artifactId, row);
            return row;
        },
        update: transport.update,
    });
    return { transport, forAccount, rows, reads, updates, add, offline: (next: boolean) => { offline = next; },
        readCollection: () => rows.size === 0 && !written ? null : { v: 1, boards: [...rows.values()].map(row => {
            if (typeof row.body !== 'string') throw new Error('invalid_board_record');
            return JSON.parse(row.body);
        }) } };
}
