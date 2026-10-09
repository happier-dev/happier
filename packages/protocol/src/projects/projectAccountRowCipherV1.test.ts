import { describe, expect, it } from 'vitest';
import { createProjectAccountRowCipherV1 } from './projectAccountRowCipherV1.js';
import {
    ProjectAccountRowListResponseV1Schema,
    ProjectAccountRowMutationRequestV1Schema,
    ProjectAccountRowPayloadV1Schema,
    ProjectAccountRowReadResponseV1Schema,
    ProjectAccountRowV1Schema,
} from './projectAccountRowsV1.js';
import { computeWorkspaceSyncPolicyDigest, getWorkspaceSyncWorkerCopyV1 } from '../sessions/control/handoff/workspaceSyncSchemas.js';

describe('Project Account row cipher admission', () => {
    it('opens retained unknown copy provenance as ordinary Sync through closed row read responses without admitting new writes', () => {
        const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
        const relationship = { v: 1 as const, relationshipId: 'retained-link', controllerMachineId: 'controller',
            alphaWorkspaceRefId: 'source', betaWorkspaceRefId: 'target', mode: 'keep_synced' as const,
            contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
            enabled: true, createdAtMs: 1, updatedAtMs: 1 };
        const key = { kind: 'relationship-graph' as const };
        const payload = { key, value: { relationships: [{ ...relationship,
            provenance: { kind: 'future_copy', sourceWorkspaceRefId: 'source', targetWorkspaceRefId: 'target' } }] } };
        const row = { key, revision: 3, content: { t: 'plain' as const, v: payload } };
        const listed = { status: 'listed' as const, coverage: 'complete' as const, rows: [row] };
        const read = ProjectAccountRowReadResponseV1Schema.parse({ status: 'present', row });
        const list = ProjectAccountRowListResponseV1Schema.parse(listed);
        expect(read.status).toBe('present');
        expect(list.status).toBe('listed');
        if (read.status !== 'present' || list.status !== 'listed') throw new Error('The retained row must be available');
        const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null,
            randomBytes: () => { throw new Error('Plain retained rows are keyless'); } });
        for (const retained of [read.row, ...list.rows]) {
            if (retained.content === null) throw new Error('The graph cannot be a tombstone');
            const opened = cipher.open(retained.key, retained.content);
            expect(opened).toEqual({ key, value: { relationships: [relationship] } });
            if (!('relationships' in opened.value)) throw new Error('The retained row must remain a graph');
            expect(getWorkspaceSyncWorkerCopyV1(opened.value.relationships[0]!)).toBeNull();
        }
        expect(ProjectAccountRowPayloadV1Schema.safeParse(payload).success).toBe(false);
        expect(ProjectAccountRowV1Schema.safeParse(row).success).toBe(false);
        expect(ProjectAccountRowMutationRequestV1Schema.safeParse({
            mutations: [{ key, expectedRevision: 3, content: row.content }], expectedRefs: [], topologyChange: true,
        }).success).toBe(false);
        for (const invalid of [
            { ...listed, futureResponse: true },
            { ...listed, coverage: 'partial' },
            { ...listed, rows: [{ ...row, futureRow: true }] },
            { ...listed, rows: [{ ...row, key: { ...key, futureKey: true } }] },
            { ...listed, rows: [{ ...row, revision: -1 }] },
            { ...listed, rows: [{ ...row, content: { ...row.content, futureEnvelope: true } }] },
            { ...listed, rows: [{ ...row, content: { t: 'encrypted', c: 1 } }] },
            { ...listed, rows: [{ ...row, content: { t: 'plain', v: { key, value: { relationships: [{ ...relationship,
                provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: 'source', targetWorkspaceRefId: 'source' } }] } } } }] },
        ]) expect(ProjectAccountRowListResponseV1Schema.safeParse(invalid).success).toBe(false);
    });

    it('refuses unavailable E2EE material before an empty census can be treated as absence', () => {
        expect(() => createProjectAccountRowCipherV1({ mode: 'e2ee', material: null,
            randomBytes: () => { throw new Error('No encryption may be attempted'); } }))
            .toThrow();
    });
    it('opens a Plain row without Account keys or randomness', () => {
        const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null,
            randomBytes: () => { throw new Error('Plain rows are keyless'); } });
        const key = { kind: 'project-organization' as const, serverId: 'home', projectKey: 'project' };
        expect(cipher.open(key, cipher.seal({ key, value: { pinned: true } })))
            .toEqual({ key, value: { pinned: true } });
    });
});
