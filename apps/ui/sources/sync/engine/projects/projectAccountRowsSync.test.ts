import { describe, expect, it } from 'vitest';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { buildProjectAccountRowPhysicalKeyV1, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { computeWorkspaceSyncPolicyDigest, WorkspaceSyncRelationshipV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { createProjectAccountRowsSync, type ProjectAccountRowsTransport } from './projectAccountRowsSync';
import type { ProjectAccountRowsSnapshot } from '@/sync/store/domains/projectAccountRows';
import { buildProjectsListGroups } from '@/components/projects/projectsListGrouping';

function harness(mode: 'plain' | 'e2ee' = 'plain') {
    const cipher = createProjectAccountRowCipherV1({ mode,
        material: mode === 'e2ee' ? { type: 'dataKey', machineKey: new Uint8Array(32).fill(3) } : null,
        randomBytes: length => new Uint8Array(length).fill(4) });
    let opens = 0;
    const rows = new Map<string, ProjectAccountRowV1>();
    let projection: ProjectAccountRowsSnapshot | null = null;
    let current = true;
    let listReads = 0;
    const exactReads: string[] = [];
    const requests: Parameters<ProjectAccountRowsTransport['mutate']>[0][] = [];
    const transport = {
        read: async key => {
            exactReads.push(buildProjectAccountRowPhysicalKeyV1(key));
            const row = rows.get(buildProjectAccountRowPhysicalKeyV1(key));
            return row ? { status: 'present', row } : { status: 'absent' };
        },
        list: async () => { listReads++; return { status: 'listed', rows: [...rows.values()], coverage: 'complete' }; },
        mutate: async (input) => {
            requests.push(input);
            for (const item of [...input.expectedRefs, ...input.mutations]) {
                const found = rows.get(buildProjectAccountRowPhysicalKeyV1(item.key));
                if ((found?.revision ?? 'absent') !== item.expectedRevision) return { status: 'conflict', key: item.key, revision: found?.revision ?? -1 };
            }
            const updated = input.mutations.map(item => ({ key: item.key, revision: (rows.get(buildProjectAccountRowPhysicalKeyV1(item.key))?.revision ?? -1) + 1, content: item.content }));
            for (const row of updated) rows.set(buildProjectAccountRowPhysicalKeyV1(row.key), row);
            return { status: 'updated', rows: updated, cursor: requests.length };
        },
    } satisfies ProjectAccountRowsTransport;
    const ref = { id: 'ref', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1, projectKey: 'anchor' };
    const key = { kind: 'workspace-ref' as const, serverId: 'home', id: ref.id };
    rows.set(buildProjectAccountRowPhysicalKeyV1(key), { key, revision: 0, content: cipher.seal({ key, value: ref }) });
    const recencyWrites: Array<{ refId: string; timestamp: number; committed: boolean }> = [];
    let recent: number | undefined;
    const owner = createProjectAccountRowsSync({ scope: { serverId: 'home', accountId: 'account' }, transport,
        cipher: { ...cipher, open: (key, content) => { opens += 1; return cipher.open(key, content); } },
        isCurrent: () => current, apply: (snapshot) => { projection = snapshot; },
        readRecency: () => recent,
        writeRecency: async (ref, timestamp) => { recent = timestamp; recencyWrites.push({ refId: ref.id, timestamp,
            committed: rows.has(buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId: ref.serverId, id: ref.id })) }); },
    });
    return { owner, rows, transport, requests, recencyWrites, cipher, opens: () => opens, exactReads, listReads: () => listReads,
        projection: () => projection, retire: () => { current = false; } };
}

describe('Project Account row sync owner', () => {
    it.each(['plain', 'e2ee'] as const)('opens only changed row content across refresh and one-row commits in %s', async mode => {
        const h = harness(mode);
        for (let i = 0; i < 32; i += 1) {
            const key = { kind: 'project-organization' as const, serverId: 'home', projectKey: `project-${i}` };
            h.rows.set(buildProjectAccountRowPhysicalKeyV1(key), { key, revision: 0,
                content: h.cipher.seal({ key, value: { label: `Project ${i}` } }) });
        }
        await h.owner.refresh();
        expect(h.opens()).toBe(33);
        const before = h.opens();
        // A transport refresh produces new row/envelope objects with the same admitted bytes.
        for (const [id, row] of h.rows) h.rows.set(id, structuredClone(row));
        await h.owner.refresh();
        expect(h.opens() - before).toBe(0);
        await h.owner.mutateWorkspaceMetadata({ serverId: 'home', workspaceId: 'ref', label: 'Renamed' });
        expect(h.opens() - before).toBe(1);
        expect(h.projection()?.workspaceRefs[0]?.label).toBe('Renamed');
        expect(h.projection()?.organizations).toHaveLength(32);
        const organization = await h.owner.mutateOrganizationAtRevision({ serverId: 'home', projectKey: 'project-0',
            expectedRevision: 0, mutate: value => ({ ...value, hidden: true }) });
        expect(organization).toMatchObject({ status: 'updated', value: { label: 'Project 0', hidden: true } });
        expect(h.opens() - before).toBe(2);
        expect(h.projection()?.organizations.find(row => row.key.projectKey === 'project-0')?.value.hidden).toBe(true);
        const changedKey = { kind: 'project-organization' as const, serverId: 'home', projectKey: 'project-1' };
        const changedId = buildProjectAccountRowPhysicalKeyV1(changedKey);
        const missingId = buildProjectAccountRowPhysicalKeyV1({ ...changedKey, projectKey: 'absent' });
        const listsBeforeHint = h.listReads();
        h.rows.set(changedId, { key: changedKey, revision: 1,
            content: h.cipher.seal({ key: changedKey, value: { label: 'Changed remotely' } }) });
        expect(await h.owner.refreshKeys([changedId, missingId])).toEqual(new Set([changedId, missingId]));
        expect(h.exactReads).toEqual([changedId, missingId]);
        expect(h.listReads()).toBe(listsBeforeHint);
        expect(h.opens() - before).toBe(3);
        expect(h.projection()?.organizations.find(row => row.key.projectKey === 'project-1')?.value.label).toBe('Changed remotely');
        const accepted = h.projection();
        const wrongMode = harness(mode === 'plain' ? 'e2ee' : 'plain');
        h.rows.set(changedId, { key: changedKey, revision: 2,
            content: wrongMode.cipher.seal({ key: changedKey, value: { label: 'Must remain private' } }) });
        await expect(h.owner.refreshKeys([changedId])).rejects.toThrow();
        expect(h.projection()).toBe(accepted);
    });

    it('projects server-visible authoring ids on cold refresh and retains them through legacy-shaped mutation acknowledgements', async () => {
        const h = harness();
        const key = { kind: 'workspace-ref' as const, serverId: 'home', id: 'ref' };
        const physicalKey = buildProjectAccountRowPhysicalKeyV1(key);
        const row = h.rows.get(physicalKey)!;
        const authoringSession = { serverId: 'author-home', sessionId: 'author-session' };
        h.rows.set(physicalKey, { ...row, ...{ authoringSession } });
        const initial = await h.owner.refresh();
        expect(Reflect.get(initial, 'authoringSessionsByPhysicalKey')).toEqual({ [physicalKey]: authoringSession });
        await h.owner.mutateWorkspaceMetadata({ serverId: 'home', workspaceId: 'ref', label: 'Renamed' });
        expect(Reflect.get(h.projection()!, 'authoringSessionsByPhysicalKey')).toEqual({ [physicalKey]: authoringSession });
        expect(h.projection()?.workspaceRefs[0]?.label).toBe('Renamed');
    });

    it('retains a newly observed missing repository identity without replacing accepted facts or creating a checkout', async () => {
        const h = harness();
        const address = { serverId: 'home', workspaceId: 'ref', machineId: 'machine', rootPath: '/repo' };
        const identity = { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/repo' };
        expect(await h.owner.recordWorkspaceRepositoryIdentity(address, identity)).toEqual({ ok: true, workspaceRefId: 'ref' });
        expect((await h.owner.refresh()).workspaceRefs).toMatchObject([{ id: 'ref', projectKey: 'anchor', repositoryIdentity: identity }]);
        expect(h.requests).toHaveLength(1);
        expect(h.requests[0]).toMatchObject({ topologyChange: false, expectedRefs: [], mutations: [{ expectedRevision: 0 }] });
        await h.owner.recordWorkspaceRepositoryIdentity(address, { ...identity, repository: 'different/repo' });
        expect(h.requests).toHaveLength(1);
        expect((await h.owner.refresh()).workspaceRefs[0]?.repositoryIdentity).toEqual(identity);
        expect(await h.owner.recordWorkspaceRepositoryIdentity({ ...address, workspaceId: 'missing' }, identity))
            .toEqual({ ok: false, code: 'workspace_ref_not_found' });
        expect(h.requests).toHaveLength(1);
        expect((await h.owner.refresh()).workspaceRefs).toHaveLength(1);
    });
    it('writes and reloads atmosphere through the organization owner while preserving label and pin', async () => {
        const h = harness();
        const key = { kind: 'project-organization' as const, serverId: 'home', projectKey: 'anchor' };
        h.rows.set(buildProjectAccountRowPhysicalKeyV1(key), { key, revision: 4,
            content: { t: 'plain', v: { key, value: { label: 'Project', pinned: true } } } });
        const result = await h.owner.mutateOrganizationAtRevision({ ...key, expectedRevision: 4,
            mutate: value => ({ ...value, atmosphere: 'home' }) });
        expect(result).toMatchObject({ status: 'updated', value: { label: 'Project', pinned: true, atmosphere: 'home' } });
        expect((await h.owner.refresh()).organizations).toMatchObject([{ value: { label: 'Project', pinned: true, atmosphere: 'home' } }]);
    });
    it('updates a label and anchored pin as one admitted batch without changing topology or dropping context', async () => {
        const h = harness();
        const key = { kind: 'project-organization' as const, serverId: 'home', projectKey: 'anchor' };
        h.rows.set(buildProjectAccountRowPhysicalKeyV1(key), { key, revision: 4,
            content: { t: 'plain', v: { key, value: { hidden: true, promptStack: [] } } } });
        expect(await h.owner.mutateWorkspaceMetadata({ serverId: 'home', workspaceId: 'ref', label: 'Named', pinned: true }))
            .toMatchObject({ workspaceRef: { id: 'ref', label: 'Named' }, organization: { hidden: true, pinned: true, promptStack: [] } });
        expect(h.projection()?.organizations).toEqual([{ key, revision: 5, value: { hidden: true, pinned: true, promptStack: [] } }]);
        expect(h.requests).toMatchObject([{ topologyChange: false, expectedRefs: [], mutations: [
            { key: { kind: 'workspace-ref', serverId: 'home', id: 'ref' }, expectedRevision: 0 },
            { key, expectedRevision: 4 },
        ] }]);
        await expect(h.owner.mutateWorkspaceMetadata({ serverId: 'foreign', workspaceId: 'ref', label: 'Wrong' }))
            .rejects.toMatchObject({ code: 'project_account_scope_mismatch' });
        expect(h.projection()?.workspaceRefs[0]?.label).toBe('Named');
    });
    it('groups a checkout with another Project and separates it again by writing only its explicit key (owner 11-08)', async () => {
        const h = harness();
        const other = { id: 'other', serverId: 'home', machineId: 'machine-b', rootPath: '/repo', createdAtMs: 2, projectKey: 'other' };
        const otherKey = { kind: 'workspace-ref' as const, serverId: 'home', id: other.id };
        h.rows.set(buildProjectAccountRowPhysicalKeyV1(otherKey), { key: otherKey, revision: 0, content: h.cipher.seal({ key: otherKey, value: other }) });
        expect(await h.owner.mutateWorkspaceMetadata({ serverId: 'home', workspaceId: 'other', projectKey: 'anchor' }))
            .toMatchObject({ workspaceRef: { id: 'other', projectKey: 'anchor' } });
        expect(h.requests.at(-1)?.mutations.map(item => item.key)).toEqual([otherKey]);
        expect(h.projection()?.workspaceRefs.find(item => item.id === 'other')?.projectKey).toBe('anchor');
        expect(await h.owner.mutateWorkspaceMetadata({ serverId: 'home', workspaceId: 'other', projectKey: 'self' }))
            .toMatchObject({ workspaceRef: { id: 'other', projectKey: 'other' } });
        await expect(h.owner.mutateWorkspaceMetadata({ serverId: 'home', workspaceId: 'other', projectKey: 'missing' }))
            .rejects.toMatchObject({ code: 'project_not_found' });
    });

    it('retains a newer materialized row when an earlier accepted mutation settles later', async () => {
        const h = harness();
        const key = { kind: 'project-organization' as const, serverId: 'home', projectKey: 'anchor' };
        let accepted!: () => void;
        const acceptance = new Promise<void>(resolve => { accepted = resolve; });
        let settle!: () => void;
        const settlement = new Promise<void>(resolve => { settle = resolve; });
        const mutate = h.transport.mutate;
        h.transport.mutate = async input => {
            const result = await mutate(input);
            accepted(); await settlement; return result;
        };
        const pending = h.owner.mutateOrganizationAtRevision({ serverId: 'home', projectKey: 'anchor',
            expectedRevision: 'absent', mutate: value => ({ ...value, hidden: true }) });
        await acceptance;
        h.rows.set(buildProjectAccountRowPhysicalKeyV1(key), { key, revision: 1,
            content: { t: 'plain', v: { key, value: { hidden: false } } } });
        await h.owner.refresh();
        settle(); await pending;
        expect(h.projection()?.organizations).toEqual([{ key, revision: 1, value: { hidden: false } }]);
    });
    it('returns explicit ambiguity before any mutation when two accepted refs share an exact scope', async () => {
        const h = harness();
        const key = { kind: 'workspace-ref' as const, serverId: 'home', id: 'other-ref' };
        h.rows.set(buildProjectAccountRowPhysicalKeyV1(key), { key, revision: 0, content: { t: 'plain', v: { key,
            value: { id: 'other-ref', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 } } } });
        expect(await h.owner.mutateRef({ kind: 'upsert', scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' },
            nowMs: 2, patch: { label: 'Changed' } })).toEqual({ ok: false, code: 'workspace_ref_ambiguous' });
        expect(h.requests).toEqual([]);
        expect(h.projection()?.workspaceRefs.map(ref => ref.id)).toEqual(['ref', 'other-ref']);
    });
    it('refuses a success receipt that does not acknowledge the admitted organization revision and content', async () => {
        const h = harness();
        const key = { kind: 'project-organization' as const, serverId: 'home', projectKey: 'anchor' };
        h.transport.mutate = async () => ({ status: 'updated', cursor: 1,
            rows: [{ key, revision: 0, content: { t: 'plain', v: { key, value: { hidden: false } } } }] });
        await expect(h.owner.mutateOrganizationAtRevision({ serverId: 'home', projectKey: 'anchor',
            expectedRevision: 'absent', mutate: value => ({ ...value, hidden: true }) }))
            .rejects.toMatchObject({ code: 'project_account_row_acknowledgement_invalid' });
        expect(h.projection()?.organizations).toEqual([]);
    });
    it('retains fallback Project Hide through persisted Source enrichment and row reload without a duplicate Project', async () => {
        const h = harness();
        const key = { kind: 'workspace-ref' as const, serverId: 'home', id: 'ref' };
        h.rows.set(buildProjectAccountRowPhysicalKeyV1(key), { key, revision: 0, content: { t: 'plain', v: { key,
            value: { id: 'ref', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 } } } });
        await h.owner.mutateOrganizationAtRevision({ serverId: 'home', projectKey: 'ref', expectedRevision: 'absent',
            mutate: value => ({ ...value, hidden: true }) });
        await h.owner.mutateRef({ kind: 'upsert', scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, nowMs: 2,
            patch: { source: { sourceId: 'source', revision: 1 },
                repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'org/repo' } } });
        const reloaded = await h.owner.refresh();
        expect(reloaded.workspaceRefs).toMatchObject([{ id: 'ref', projectKey: 'ref', source: { sourceId: 'source' } }]);
        const groups = buildProjectsListGroups({ activeServerId: 'home', workspaceRefs: reloaded.workspaceRefs,
            pinnedWorkspaceRefIds: [], projectOrganizations: reloaded.organizations });
        expect(groups.projectGroups).toEqual([]);
        expect(groups.hiddenProjectGroups).toMatchObject([{ projectKey: { serverId: 'home', projectKey: 'ref' }, items: [{ id: 'ref' }] }]);
    });
    it('writes explicit recency only after acceptance', async () => {
        const h = harness();
        await h.owner.mutateRef({ kind: 'upsert', scope: { serverId: 'home', machineId: 'other', rootPath: '/other' }, nowMs: 2, patch: { lastOpenedAtMs: 9 } });
        expect(h.recencyWrites).toEqual([{ refId: expect.any(String), timestamp: 9, committed: true }]);
    });
    it.each([
        { name: 'accepted anchor', fields: { projectKey: 'anchor' } },
        { name: 'implicit fallback anchor', fields: {} },
    ])('records Source provenance on an accepted checkout preserving its $name and other fields', async ({ fields }) => {
        const h = harness();
        const address = { serverId: 'home', workspaceId: 'ref', machineId: 'machine', rootPath: '/repo/' };
        const key = { kind: 'workspace-ref' as const, serverId: 'home', id: 'ref' };
        const physicalKey = buildProjectAccountRowPhysicalKeyV1(key);
        const accepted = { id: 'ref', serverId: 'home', machineId: 'machine', rootPath: '/repo', label: 'Saved checkout', createdAtMs: 1,
            repositoryIdentity: { kind: 'github' as const, deployment: 'https://github.com', repository: 'org/repo' }, ...fields };
        h.rows.set(physicalKey, { key, revision: 7, content: { t: 'plain', v: { key, value: accepted } } });
        await h.owner.mutateRef({ kind: 'upsert', scope: address, nowMs: 111, patch: { lastOpenedAtMs: 111 } });
        const source = { sourceId: 'source', revision: 2 };

        expect(await h.owner.recordWorkspaceSource(address, source)).toEqual({ ok: true, workspaceRefId: 'ref' });
        expect(h.rows.get(physicalKey)).toEqual({ key, revision: 8, content: { t: 'plain', v: { key, value: { ...accepted, source } } } });
        expect(h.projection()?.workspaceRefs).toEqual([{ ...accepted, source, lastOpenedAtMs: 111 }]);
        expect(h.requests).toMatchObject([{ topologyChange: false, expectedRefs: [], mutations: [{ key, expectedRevision: 7 }] }]);
        expect(await h.owner.recordWorkspaceSource(address, source)).toEqual({ ok: true, workspaceRefId: 'ref' });
        expect(h.rows.get(physicalKey)?.revision).toBe(8);
        expect(h.requests).toHaveLength(1);
    });
    it.each([
        { workspaceId: 'missing', machineId: 'machine', rootPath: '/repo' },
        { workspaceId: 'ref', machineId: 'other-machine', rootPath: '/repo' },
        { workspaceId: 'ref', machineId: 'machine', rootPath: '/other-repo' },
    ])('refuses Source provenance when the complete accepted address does not match: $workspaceId/$machineId/$rootPath', async address => {
        const h = harness();
        const acceptedRows = [...h.rows.values()];
        expect(await h.owner.recordWorkspaceSource({ serverId: 'home', ...address }, { sourceId: 'source', revision: 1 }))
            .toEqual({ ok: false, code: 'workspace_ref_not_found' });
        expect([...h.rows.values()]).toEqual(acceptedRows);
        expect(h.requests).toEqual([]);
    });
    it('refuses Source provenance after a refreshed deletion or deletion during CAS without resurrecting the checkout', async () => {
        const address = { serverId: 'home', workspaceId: 'ref', machineId: 'machine', rootPath: '/repo' };
        const key = { kind: 'workspace-ref' as const, serverId: 'home', id: 'ref' };
        const physicalKey = buildProjectAccountRowPhysicalKeyV1(key);
        const deleted = { key, revision: 1, content: null };
        const h = harness();
        await h.owner.refresh();
        h.rows.set(physicalKey, deleted);
        expect(await h.owner.recordWorkspaceSource(address, { sourceId: 'source', revision: 1 }))
            .toEqual({ ok: false, code: 'workspace_ref_not_found' });
        expect(h.requests).toEqual([]);
        expect(h.rows.get(physicalKey)).toEqual(deleted);

        const raced = harness();
        const mutate = raced.transport.mutate;
        raced.transport.mutate = async input => { raced.rows.set(physicalKey, deleted); return await mutate(input); };
        expect(await raced.owner.recordWorkspaceSource(address, { sourceId: 'source', revision: 1 }))
            .toEqual({ ok: false, code: 'workspace_ref_not_found' });
        expect(raced.rows.get(physicalKey)).toEqual(deleted);
        expect(raced.requests).toHaveLength(1);
        expect(raced.projection()?.workspaceRefs).toEqual([]);
    });
    it('re-admits Source provenance after a row conflict while preserving the newer label and anchor', async () => {
        const h = harness();
        const key = { kind: 'workspace-ref' as const, serverId: 'home', id: 'ref' };
        const physicalKey = buildProjectAccountRowPhysicalKeyV1(key);
        const newer = { id: 'ref', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
            projectKey: 'anchor', label: 'Renamed concurrently' };
        const mutate = h.transport.mutate;
        let changed = false;
        h.transport.mutate = async input => {
            if (!changed) {
                changed = true;
                h.rows.set(physicalKey, { key, revision: 1, content: { t: 'plain', v: { key, value: newer } } });
            }
            return await mutate(input);
        };
        const source = { sourceId: 'source', revision: 1 };
        expect(await h.owner.recordWorkspaceSource({ serverId: 'home', workspaceId: 'ref', machineId: 'machine', rootPath: '/repo' }, source))
            .toEqual({ ok: true, workspaceRefId: 'ref' });
        expect(h.rows.get(physicalKey)).toEqual({ key, revision: 2, content: { t: 'plain', v: { key, value: { ...newer, source } } } });
        expect(h.requests.map(request => request.mutations[0]?.expectedRevision)).toEqual([0, 1]);
    });
    it.each([
        { name: 'absent label and anchor', fields: {} },
        { name: 'explicit-null label and absent anchor', fields: { label: null } },
        { name: 'absent label and accepted anchor', fields: { projectKey: 'anchor' } },
        { name: 'explicit-null label and accepted anchor', fields: { label: null, projectKey: 'anchor' } },
    ])('joins repeated recency for $name without changing accepted structural content or revision', async ({ fields }) => {
        const h = harness();
        const key = { kind: 'workspace-ref' as const, serverId: 'home', id: 'ref' };
        const physicalKey = buildProjectAccountRowPhysicalKeyV1(key);
        const accepted = { key, revision: 7, content: { t: 'plain' as const, v: { key, value: {
            id: 'ref', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
            repositoryIdentity: { kind: 'github' as const, deployment: 'https://github.com', repository: 'org/repo' },
            source: { sourceId: 'source', revision: 2 }, ...fields,
        } } } };
        h.rows.set(physicalKey, accepted);
        for (const timestamp of [11, 13]) {
            expect(await h.owner.mutateRef({ kind: 'upsert', scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' },
                nowMs: timestamp, patch: { lastOpenedAtMs: timestamp } })).toEqual({ ok: true, workspaceRefId: 'ref' });
            expect(h.rows.get(physicalKey)).toEqual(accepted);
            expect(h.projection()?.revisionsByPhysicalKey[physicalKey]).toBe(7);
            expect(h.projection()?.workspaceRefs).toEqual([{ ...accepted.content.v.value, lastOpenedAtMs: timestamp }]);
        }
        expect(h.requests).toEqual([]);
        expect(h.recencyWrites).toEqual([11, 13].map(timestamp => ({ refId: 'ref', timestamp, committed: true })));

        await h.owner.mutateRef({ kind: 'upsert', scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, nowMs: 17,
            patch: { label: 'Named', source: { sourceId: 'source', revision: 3 }, lastOpenedAtMs: 17 } });
        expect(h.rows.get(physicalKey)).toMatchObject({ revision: 8, content: { t: 'plain', v: { value: {
            label: 'Named', projectKey: fields.projectKey ?? 'ref', source: { sourceId: 'source', revision: 3 },
            repositoryIdentity: accepted.content.v.value.repositoryIdentity,
        } } } });
        expect(h.projection()?.workspaceRefs[0]?.lastOpenedAtMs).toBe(17);
    });
    it('applies visibility against the caller revision without retrying stale intent or dropping context', async () => {
        const h = harness();
        const key = { kind: 'project-organization' as const, serverId: 'home', projectKey: 'anchor' };
        h.rows.set(buildProjectAccountRowPhysicalKeyV1(key), { key, revision: 4,
            content: { t: 'plain', v: { key, value: { pinned: true, promptStack: [] } } } });
        expect(await h.owner.mutateOrganizationAtRevision({ ...key, expectedRevision: 4, mutate: value => ({ ...value, hidden: true }) }))
            .toEqual({ status: 'updated', revision: 5, value: { hidden: true, pinned: true, promptStack: [] } });
        expect(await h.owner.mutateOrganizationAtRevision({ ...key, expectedRevision: 4, mutate: value => ({ ...value, hidden: false }) }))
            .toEqual({ status: 'conflict', revision: 5 });
        expect(h.requests).toHaveLength(1);
        expect(await h.owner.mutateOrganizationAtRevision({ ...key, expectedRevision: 5, mutate: value => ({ ...value }) }))
            .toEqual({ status: 'updated', revision: 5, value: { hidden: true, pinned: true, promptStack: [] } });
        expect(h.requests).toHaveLength(1);
        await expect(h.owner.mutateOrganizationAtRevision({ ...key, serverId: 'foreign', expectedRevision: 5,
            mutate: value => ({ ...value, hidden: false }) })).rejects.toThrow();
        expect(h.requests).toHaveLength(1);
    });
    it('pins only the anchored organization row, preserving the ref revision and unrelated context', async () => {
        const h = harness();
        const key = { kind: 'project-organization' as const, serverId: 'home', projectKey: 'anchor' };
        h.rows.set(buildProjectAccountRowPhysicalKeyV1(key), { key, revision: 4, content: { t: 'plain', v: { key, value: { hidden: true } } } });
        await h.owner.mutateRef({ kind: 'set_pinned', serverId: 'home', workspaceRefId: 'ref', pinned: true });
        expect(h.requests.at(-1)).toMatchObject({ topologyChange: false, expectedRefs: [], mutations: [{ key, expectedRevision: 4, content: { t: 'plain', v: { key, value: { hidden: true, pinned: true } } } }] });
        expect(h.projection()?.revisionsByPhysicalKey[buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId: 'home', id: 'ref' })]).toBe(0);
    });

    it('refuses Forget while even a paused relationship still holds the checkout', async () => {
        const h = harness();
        const target = { id: 'target', serverId: 'home', machineId: 'target-machine', rootPath: '/target', createdAtMs: 1, projectKey: 'anchor' };
        const targetKey = { kind: 'workspace-ref' as const, serverId: 'home', id: target.id };
        h.rows.set(buildProjectAccountRowPhysicalKeyV1(targetKey), { key: targetKey, revision: 0, content: { t: 'plain', v: { key: targetKey, value: target } } });
        const policy = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
        const relationship = WorkspaceSyncRelationshipV1Schema.parse({ v: 1, relationshipId: 'protected-link', controllerMachineId: 'machine',
            alphaWorkspaceRefId: 'ref', betaWorkspaceRefId: 'target', mode: 'keep_synced', enabled: false,
            contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 });
        const graphKey = { kind: 'relationship-graph' as const };
        h.rows.set(buildProjectAccountRowPhysicalKeyV1(graphKey), { key: graphKey, revision: 4,
            content: { t: 'plain', v: { key: graphKey, value: { relationships: [relationship] } } } });

        expect(await h.owner.mutateRef({ kind: 'remove', serverId: 'home', workspaceRefId: 'ref' }))
            .toEqual({ ok: false, code: 'workspace_ref_in_use', relationshipIds: ['protected-link'] });
        expect(h.projection()?.workspaceRefs.map(ref => ref.id)).toEqual(['ref', 'target']);
        expect(h.projection()?.relationships).toEqual([relationship]);
        expect(h.rows.get(buildProjectAccountRowPhysicalKeyV1(graphKey))?.revision).toBe(4);
        expect(h.requests).toEqual([]);
    });

    it('Forgets through the graph CAS and leaves a tombstone', async () => {
        const h = harness();
        expect(await h.owner.mutateRef({ kind: 'remove', serverId: 'home', workspaceRefId: 'ref' })).toEqual({ ok: true });
        const request = h.requests.at(-1)!;
        expect(request.topologyChange).toBe(true);
        expect(request.mutations.some(row => row.key.kind === 'relationship-graph' && row.expectedRevision === 'absent')).toBe(true);
        expect(h.projection()?.workspaceRefs).toEqual([]);
        expect([...h.rows.values()].find(row => row.key.kind === 'workspace-ref')?.content).toBe(null);
    });

    it('does not disclose a mismatched envelope or publish retired Home results', async () => {
        const h = harness();
        h.rows.set('bad', { key: { kind: 'project-organization', serverId: 'home', projectKey: 'bad' }, revision: 0, content: { t: 'encrypted', c: 'not-plain' } });
        await expect(h.owner.refresh()).rejects.toThrow();
        expect(h.projection()).toBe(null);
        h.rows.delete('bad'); h.retire();
        await expect(h.owner.refresh()).rejects.toThrow();
        expect(h.projection()).toBe(null);
    });
});
