import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import * as accountKeyBinding from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import {
    ManagedMachinePresetEnvelopeV1Schema, openManagedMachinePresetContentV1,
    rewrapManagedMachinePresetRecipientsV1, sealManagedMachinePresetContentV1,
    type ManagedMachinePresetRecipientsV1,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { ManagedMachinePresetListResultV1Schema,
    type ManagedMachinePresetRecipientCensusResultV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { readMachinePresetRecipientCensus } from '@/app/machines/managed/machinePresetService';
import { storeOpaquePresetLaunch } from '@/app/machines/managed/managedRows';
import { databaseQueryDurationHistogram } from '@/app/monitoring/metrics/databaseDriverMetrics';
import { db } from '@/storage/db';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { registerMachinePresetRoutes } from './registerMachinePresetRoutes';

describe('Machine preset owed recipient delivery', () => {
    const homeId = 'srv_owed_preset';
    const teamId = 'owed-preset-team';
    const id = 'owed-team-preset';
    const path = '/v1/machines/presets/recipient-census/owed';
    let database: LightSqliteHarness;
    let app: ReturnType<typeof createAuthenticatedTestApp>;

    beforeAll(async () => {
        database = await createLightSqliteHarness({ tempDirPrefix: 'happier-preset-owed-', initAuth: false,
            env: { HAPPIER_SERVER_IDENTITY_ID: homeId, HAPPIER_FEATURE_TEAMS__ENABLED: '1', METRICS_ENABLED: '1' } });
        app = createAuthenticatedTestApp();
        registerMachinePresetRoutes(app);
        await app.ready();
    }, 120_000);
    afterAll(async () => { try { await app?.close(); } finally { await database?.close(); } });

    async function account(accountId: string) {
        const key = nacl.box.keyPair();
        await db.account.create({ data: { id: accountId, encryptionMode: 'e2ee', ...createSignedAccountContentBinding(key.publicKey) } });
        return key.secretKey;
    }

    it('returns only the requested page of full Team preset bodies and preserves access across a cursor', async () => {
        const manager = 'preset-page-manager';
        const viewer = 'preset-page-viewer';
        const outsider = 'preset-page-outsider';
        const sharedWithTeamId = 'preset-page-team';
        await account(manager);
        const viewerKey = await account(viewer);
        await account(outsider);
        await db.team.create({ data: { id: sharedWithTeamId, name: 'Preset page' } });
        await db.teamMembership.createMany({ data: [{ teamId: sharedWithTeamId, accountId: manager, role: 'owner' },
            { teamId: sharedWithTeamId, accountId: viewer, role: 'member' }] });
        const owner = { kind: 'team' as const, teamId: sharedWithTeamId };
        const census = await readMachinePresetRecipientCensus({ accountId: manager, input: { homeId, owner } });
        if (census.kind !== 'ready') throw new Error('Expected manager census');
        const post = (endpoint: string, payload: object, accountId = viewer) => app.inject({ method: 'POST',
            url: `/v1/machines/presets/${endpoint}`, headers: { 'x-test-user-id': accountId }, payload });
        const id = 'page-a';
        const content = { v: 1, name: 'Encrypted preset', setup: { scripts: [{ body: 'echo private setup' }] } };
        const sealed = sealManagedMachinePresetContentV1({ presetId: id, mode: 'e2ee', content,
            recipientCensus: census.recipients, randomBytes: nacl.randomBytes });
        const created = await post('create', { id, homeId, owner, contentEncryptionMode: 'e2ee', ...sealed }, manager);
        expect(created.statusCode, created.body).toBe(200);

        const archivedAt = new Date('2026-01-01T00:00:00Z');
        await db.managedMachinePreset.createMany({ data: ['page-b', 'page-c', 'page-d'].map(presetId => ({
            id: presetId, homeId, teamId: sharedWithTeamId, name: '', ...(presetId === 'page-d' ? { archivedAt } : {}),
            launch: storeOpaquePresetLaunch({ contentEncryptionMode: 'plain', recipients: [],
                content: { t: 'plain', v: { ...content, name: presetId } } }),
        })) });
        const input = { homeId, sharedWithTeamId, limit: 1 };
        expect.soft((await post('list', { ...input, cursor: id }, outsider)).json()).toEqual({ kind: 'listed', presets: [] });
        expect.soft((await post('list', { homeId, sharedWithTeamId, cursor: id, projection: 'revisions' }, outsider)).json())
            .toEqual({ kind: 'revisions', presets: [] });

        const first = await post('list', input);
        expect(first.statusCode, first.body).toBe(200);
        const page = ManagedMachinePresetListResultV1Schema.parse(first.json());
        if (page.kind !== 'listed') throw new Error('Expected a page of full presets');
        expect(page.presets.map(preset => preset.id)).toEqual([id]);
        expect(page.cursor).toBe(id);
        expect(openManagedMachinePresetContentV1({ presetId: id, mode: 'e2ee', ...page.presets[0],
            accountId: viewer, accountKey: viewerKey })).toMatchObject(content);

        const second = await post('list', { ...input, cursor: id, limit: 2 });
        expect(second.statusCode, second.body).toBe(200);
        expect(second.json()).toMatchObject({ kind: 'listed', presets: [{ id: 'page-b', content: { t: 'plain' } },
            { id: 'page-c', content: { t: 'plain' } }] });
        expect(second.json()).not.toHaveProperty('cursor');

        await db.team.update({ where: { id: sharedWithTeamId }, data: { archivedAt } });
        expect((await post('list', { ...input, cursor: id })).json()).toEqual({ kind: 'listed', presets: [] });
    });

    it('offers only the owed preset to its manager and opens it for a later member after one repair', async () => {
        const manager = 'owed-manager';
        const member = 'owed-member';
        const viewer = 'owed-viewer';
        const managerKey = await account(manager);
        const memberKey = await account(member);
        await account(viewer);
        await account('owed-outsider');
        await db.team.create({ data: { id: teamId, name: 'Preset Team' }, select: { id: true } });
        await db.teamMembership.createMany({ data: [
            { teamId, accountId: manager, role: 'owner' },
            { teamId, accountId: viewer, role: 'member' },
        ] });
        const owner = { kind: 'team' as const, teamId };
        const input = { homeId, owner };
        const initial = await readMachinePresetRecipientCensus({ accountId: manager, input });
        if (initial.kind !== 'ready') throw new Error('Expected manager census');
        const sealed = sealManagedMachinePresetContentV1({ presetId: id, mode: 'e2ee',
            content: { v: 1, name: 'Saved before join', setup: { scripts: [{ body: 'echo ready' }] } }, recipientCensus: initial.recipients, randomBytes: nacl.randomBytes });
        const row = { id, homeId, teamId, name: '' };
        await db.managedMachinePreset.create({ data: { ...row, launch: storeOpaquePresetLaunch({ contentEncryptionMode: 'e2ee', ...sealed }) } });
        expect(openManagedMachinePresetContentV1({ presetId: id, mode: 'e2ee', ...sealed, accountId: member, accountKey: memberKey })).toBeNull();
        await db.teamMembership.create({ data: { teamId, accountId: member, role: 'member' } });
        const current = await readMachinePresetRecipientCensus({ accountId: manager, input });
        if (current.kind !== 'ready') throw new Error('Expected current census');
        const prepared = rewrapManagedMachinePresetRecipientsV1({ recipients: sealed.recipients, accountId: manager,
            accountKey: managerKey, recipientCensus: current.recipients, randomBytes: nacl.randomBytes });
        if (!prepared) throw new Error('Expected current recipients');
        const preparedLaunch = storeOpaquePresetLaunch({ contentEncryptionMode: 'e2ee', content: sealed.content, recipients: prepared });
        const request = (url: string, accountId: string, payload?: object) => app.inject({ url, method: payload ? 'POST' : 'GET',
            headers: { 'x-test-user-id': accountId }, ...(payload ? { payload } : {}) });
        const statementCount = async () => {
            const metric = await databaseQueryDurationHistogram.get();
            return metric.values.find(sample => sample.metricName === `${metric.name}_count`)?.value ?? 0;
        };
        const requestManagerCensus = async () => {
            const before = await statementCount();
            const response = await request(path, manager);
            return { response, statements: (await statementCount()) - before };
        };
        const single = await requestManagerCensus();
        expect(single.response.statusCode, single.response.body).toBe(200);
        expect(single.response.json().items.map((item: { id: string }) => item.id)).toEqual([id]);
        expect(single.statements).toBeGreaterThan(0);

        await db.managedMachinePreset.createMany({ data: Array.from({ length: 1_000 },
            (_, index) => ({ ...row, id: `preset-prepared-${index}`, launch: preparedLaunch })) });

        const parses = vi.spyOn(ManagedMachinePresetEnvelopeV1Schema, 'parse');
        const verifies = vi.spyOn(accountKeyBinding, 'verifyAccountContentKeyBindingV1');
        try {
            const { response: owed, statements } = await requestManagerCensus();
            expect(statements).toBe(single.statements);
            expect(owed.statusCode, owed.body).toBe(200);
            const { items } = owed.json<{ items: { homeId: string; id: string; expectedRevision: number;
                recipients: ManagedMachinePresetRecipientsV1; census: Extract<ManagedMachinePresetRecipientCensusResultV1, { kind: 'ready' }> }[] }>();
            expect(items.map(item => item.id)).toEqual([id]);
            expect(items[0]).toMatchObject({ homeId, expectedRevision: 0, recipients: sealed.recipients,
                census: { kind: 'ready', contentEncryptionMode: 'e2ee' } });
            expect(items[0]).not.toHaveProperty('content');
            expect(parses).not.toHaveBeenCalled();
            expect(verifies).toHaveBeenCalledTimes(3);
            for (const accountId of [viewer, member, 'owed-outsider']) {
                const refused = await request(path, accountId);
                expect(refused.statusCode, refused.body).toBe(200);
                expect(refused.json()).toEqual({ items: [] });
            }
            const item = items[0]!;
            const recipients = rewrapManagedMachinePresetRecipientsV1({ recipients: item.recipients, accountId: manager,
                accountKey: managerKey, recipientCensus: item.census.recipients, randomBytes: nacl.randomBytes });
            expect(recipients).not.toBeNull();
            const update = { homeId: item.homeId, id: item.id, expectedRevision: item.expectedRevision, patch: { recipients } };
            expect((await request('/v1/machines/presets/update', viewer, update)).statusCode).toBe(404);
            const repaired = await request('/v1/machines/presets/update', manager, update);
            expect(repaired.statusCode, repaired.body).toBe(200);
            expect(repaired.json()).toMatchObject({ kind: 'saved', preset: { revision: 1, content: sealed.content } });
            const read = await request('/v1/machines/presets/get', member, { homeId, id });
            expect(read.statusCode, read.body).toBe(200);
            const { preset } = read.json();
            expect(openManagedMachinePresetContentV1({ presetId: id, mode: 'e2ee', ...preset,
                accountId: member, accountKey: memberKey })).toMatchObject({ name: 'Saved before join' });
            expect((await request('/v1/machines/presets/get', 'owed-outsider', { homeId, id })).statusCode).toBe(404);
            verifies.mockClear();
            parses.mockClear();
            expect((await request(path, manager)).json()).toEqual({ items: [] });
            expect(verifies).not.toHaveBeenCalled();
            expect(parses).not.toHaveBeenCalled();
        } finally {
            verifies.mockRestore();
            parses.mockRestore();
        }
    });
});
