import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import { createMachineDataEncryptionKeyV1, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MACHINE_PRESET_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionExecutionAuthorizationV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    sealExternalActionRequestV2, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions';
import { encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { storeOpaquePresetLaunch } from '@/app/machines/managed/managedRows';
import { readMachinePresetRecipientCensus } from '@/app/machines/managed/machinePresetService';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createMachineContentCodec } from '../../../../../../../cli/src/api/machine/machineStoredContent';
import { registerExternalActionRoutes } from '../../actions/registerExternalActionRoutes';
import { registerMachinePresetRoutes } from './registerMachinePresetRoutes';

describe('Prepare original admission through preset HTTP and storage', () => {
    const homeId = 'srv_preset_preparation';
    const accountId = 'prepare-owner';
    const machineId = 'prepare-machine';
    const installationId = 'prepare-installation';
    const keys = nacl.sign.keyPair();
    let database: LightSqliteHarness;
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    let token: string;

    beforeAll(async () => {
        database = await createLightSqliteHarness({ tempDirPrefix: 'happier-preset-prepare-', initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: 'none' } });
        await db.account.create({ data: { id: accountId, encryptionMode: 'plain' } });
        await db.account.create({ data: { id: 'other-prepare-owner', encryptionMode: 'plain' } });
        await db.machine.create({ data: { id: machineId, accountId, installationId,
            installationPublicKey: keys.publicKey, active: true, lastActiveAt: new Date(),
            metadata: encodePlainMachineStoredContent({ host: 'Prepare host', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/prepare', happyHomeDir: '/home/prepare/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } },
        } });
        token = await auth.createToken(accountId, undefined, { kind: 'terminal', authority: 'account_automation' });
        app = createAuthenticatedTestApp({ authentication: 'real' });
        registerExternalActionRoutes(app, { dispatch: async () => { throw new Error('Mint must not execute Prepare'); } });
        registerMachinePresetRoutes(app);
        await app.ready();
    }, 120_000);
    afterAll(async () => { try { await app?.close(); } finally { await database?.close(); } });

    async function seed(id: string, custodianAccountId = accountId) {
        await db.managedMachinePreset.create({ data: { id, homeId, custodianAccountId, name: '',
            launch: storeOpaquePresetLaunch({ contentEncryptionMode: 'plain', recipients: [],
                content: { t: 'plain', v: { v: 1, name: 'Preset' } } }),
        } });
    }
    function mint(id: string, overrides: Readonly<{ homeId?: string; machineId?: string; expectedRevision?: number }> = {}) {
        return app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(MACHINE_PRESET_PREPARE_ACTION_ID_V1),
            headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId,
                envelope: { v: 1, requestId: `prepare-${id}`, target: { kind: 'machine', machineId },
                    input: { homeId, id, expectedRevision: 0, machineId, ...overrides } } } });
    }
    function signed(authorization: ExternalActionExecutionAuthorizationV1, path: string, body: unknown,
        signingKey = keys.secretKey, target = authorization.binding.target, signedBody = body) {
        return app.inject({ method: 'POST', url: path, payload: body, headers: {
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: authorization.binding.actionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                authorizationToken: authorization.token, effectActionId: authorization.binding.actionId,
                target, installationId, requestId: authorization.binding.requestId, method: 'POST', path, body: signedBody, privateKey: signingKey,
            }),
        } });
    }

    it('admits once and persists two content CAS revisions using the original proof after bearer withdrawal', async () => {
        await seed('prepared');
        const issued = await mint('prepared');
        expect(issued.statusCode, issued.body).toBe(200);
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
        expect(authorization.binding.presetPreparationAdmission).toEqual({ homeId, id: 'prepared', expectedRevision: 0, machineId });
        await db.account.update({ where: { id: accountId }, data: { tokenEpoch: { increment: 1 } } });
        for (const expectedRevision of [0, 1]) {
            const read = await signed(authorization, '/v1/machines/presets/get', { homeId, id: 'prepared' });
            expect(read.statusCode, read.body).toBe(200);
            expect(read.json()).toMatchObject({ kind: 'found', preset: { revision: expectedRevision } });
            const written = await signed(authorization, '/v1/machines/presets/update', { homeId, id: 'prepared', expectedRevision,
                patch: { content: { t: 'plain', v: { v: 1, name: `Prepared ${expectedRevision}` } }, recipients: [] } });
            expect(written.statusCode, written.body).toBe(200);
            expect(written.json()).toMatchObject({ kind: 'saved', preset: { revision: expectedRevision + 1 } });
        }
        const conflict = await signed(authorization, '/v1/machines/presets/update', { homeId, id: 'prepared', expectedRevision: 0,
            patch: { content: { t: 'plain', v: { v: 1, name: 'Stale' } } } });
        expect(conflict.statusCode, conflict.body).toBe(409);
        expect(conflict.json()).toEqual({ kind: 'conflict', currentRevision: 2 });
        expect((await mint('prepared', { expectedRevision: 2 })).statusCode).toBe(401);
        token = await auth.createToken(accountId, undefined, { kind: 'terminal', authority: 'account_automation' });
    });

    it('retains one Archive admission through exact cleanup CAS and the final revision', async () => {
        await seed('archive-admitted');
        await seed('archive-sibling');
        const issue = (id = 'archive-admitted', expectedRevision = 0) => app.inject({ method: 'POST',
            url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.presets.archive'),
            headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId,
                envelope: { v: 1, requestId: `archive-${id}-${expectedRevision}`, target: { kind: 'machine', machineId },
                    input: { homeId, id, expectedRevision } } } });
        expect((await issue('archive-admitted', 1)).statusCode).toBeGreaterThanOrEqual(400);
        const issued = await issue();
        expect(issued.statusCode, issued.body).toBe(200);
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
        const read = await signed(authorization, '/v1/machines/presets/get', { homeId, id: 'archive-admitted' });
        expect(read.statusCode, read.body).toBe(200);
        const sibling = await signed(authorization, '/v1/machines/presets/get', { homeId, id: 'archive-sibling' });
        expect(sibling.statusCode).toBeGreaterThanOrEqual(400);
        const update = await signed(authorization, '/v1/machines/presets/update', { homeId, id: 'archive-admitted', expectedRevision: 0,
            patch: { content: { t: 'plain', v: { v: 1, name: 'Cleaned original image' } }, recipients: [] } });
        expect(update.statusCode, update.body).toBe(200);
        expect((await signed(authorization, '/v1/machines/presets/archive', { homeId, id: 'archive-admitted', expectedRevision: 0 })).statusCode).toBe(409);
        const archived = await signed(authorization, '/v1/machines/presets/archive', { homeId, id: 'archive-admitted', expectedRevision: 1 });
        expect(archived.statusCode, archived.body).toBe(200);
        expect(archived.json()).toMatchObject({ kind: 'saved', preset: { revision: 2, archivedAt: expect.any(Number) } });
        expect((await signed(authorization, '/v1/machines/presets/archive', { homeId, id: 'archive-sibling', expectedRevision: 0 })).statusCode)
            .toBeGreaterThanOrEqual(400);
    });

    it('requires its own preset Manage and exact Home, Machine and initial revision at admission', async () => {
        await seed('negative');
        await seed('foreign', 'other-prepare-owner');
        for (const [id, overrides] of [
            ['foreign', {}], ['negative', { homeId: 'another-home' }],
            ['negative', { machineId: 'another-machine' }], ['negative', { expectedRevision: 1 }],
        ] as const) {
            const refused = await mint(id, overrides);
            expect(refused.statusCode).toBeGreaterThanOrEqual(400);
        }
    });

    it('confines the signed root to its preset and content-only CAS with the original installed signer', async () => {
        await seed('confined');
        await seed('sibling');
        const issued = await mint('confined');
        expect(issued.statusCode, issued.body).toBe(200);
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
        for (const body of [{ homeId, id: 'sibling' }, { homeId: 'another-home', id: 'confined' }]) {
            expect((await signed(authorization, '/v1/machines/presets/get', body)).statusCode).toBe(401);
        }
        expect((await signed(authorization, '/v1/machines/presets/get', { homeId, id: 'confined' },
            nacl.sign.keyPair().secretKey)).statusCode).toBe(401);
        expect((await signed(authorization, '/v1/machines/presets/get', { homeId, id: 'confined' }, keys.secretKey,
            { kind: 'machine', machineId: 'another-machine' })).statusCode).toBe(401);
        expect((await signed(authorization, '/v1/machines/presets/get', { homeId, id: 'confined' }, keys.secretKey,
            authorization.binding.target, { homeId, id: 'sibling' })).statusCode).toBe(401);
        for (const patch of [{ retention: { kind: 'keep' } }, { contentEncryptionMode: 'e2ee' },
            { content: { t: 'encrypted', c: 'opaque' } }, { recipients: [{ accountId: 'other-prepare-owner' }] }]) {
            const refused = await signed(authorization, '/v1/machines/presets/update', { homeId, id: 'confined', expectedRevision: 0, patch });
            expect(refused.statusCode, refused.body).toBeGreaterThanOrEqual(400);
        }
        expect((await db.managedMachinePreset.findUniqueOrThrow({ where: { id: 'confined' } })).revision).toBe(0);
    });

    it('admits Team preset Manage independently and lets that finite build finish after the manager role changes', async () => {
        await db.team.create({ data: { id: 'prepare-team', name: 'Prepare team' } });
        const membership = await db.teamMembership.create({ data: { teamId: 'prepare-team', accountId, role: 'owner' } });
        await db.managedMachinePreset.create({ data: { id: 'team-prepared', homeId, teamId: 'prepare-team', name: '',
            launch: storeOpaquePresetLaunch({ contentEncryptionMode: 'plain', recipients: [],
                content: { t: 'plain', v: { v: 1, name: 'Team preset' } } }) } });
        const issued = await mint('team-prepared');
        expect(issued.statusCode, issued.statusCode >= 400 ? issued.body : undefined).toBe(200);
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
        await db.teamMembership.update({ where: { id: membership.id }, data: { role: 'member' } });
        const ordinary = await app.inject({ method: 'POST', url: '/v1/machines/presets/update',
            headers: { authorization: `Bearer ${token}` }, payload: { homeId, id: 'team-prepared', expectedRevision: 0,
                patch: { content: { t: 'plain', v: { v: 1, name: 'Unauthorized edit' } } } } });
        expect(ordinary.statusCode).toBe(404);
        const written = await signed(authorization, '/v1/machines/presets/update', { homeId, id: 'team-prepared', expectedRevision: 0,
            patch: { content: { t: 'plain', v: { v: 1, name: 'Prepared team preset' } }, recipients: [] } });
        expect(written.statusCode, written.body).toBe(200);
        expect(written.json()).toMatchObject({ kind: 'saved', preset: { revision: 1, owner: { kind: 'team', teamId: 'prepare-team' } } });
        expect((await mint('team-prepared', { expectedRevision: 1 })).statusCode).toBe(403);
    });

    it('retains E2EE content and recipient identity while allowing fresh opaque envelopes across CAS revisions', async () => {
        const accountKeys = nacl.box.keyPair();
        const account = await db.account.update({ where: { id: accountId }, data: { encryptionMode: 'e2ee',
            ...createSignedAccountContentBinding(accountKeys.publicKey) } });
        const machineMaterial = createMachineDataEncryptionKeyV1({ material: { type: 'dataKey', machineKey: accountKeys.secretKey },
            dataKeyPublicKey: accountKeys.publicKey, randomBytes: nacl.randomBytes });
        await db.machine.update({ where: { id: machineId }, data: { dataEncryptionKey: machineMaterial.dataEncryptionKey,
            metadata: createMachineContentCodec({ encryptionMode: 'e2ee', ...machineMaterial }).encodeStored({
                host: 'Private Prepare host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/prepare',
                happyHomeDir: '/home/prepare/.happier' }) } });
        const id = 'encrypted-prepared';
        const census = await readMachinePresetRecipientCensus({ accountId,
            input: { homeId, owner: { kind: 'account', accountId } } });
        expect(census.kind).toBe('ready');
        if (census.kind !== 'ready') throw new Error('E2EE recipient census unavailable');
        const seal = (name: string) => sealManagedMachinePresetContentV1({ presetId: id, mode: 'e2ee',
            content: { v: 1, name, setup: { scripts: [{ body: 'echo private-preparation-sentinel' }] } },
            recipientCensus: census.recipients, randomBytes: nacl.randomBytes });
        const original = seal('Original private preset');
        await db.managedMachinePreset.create({ data: { id, homeId, custodianAccountId: accountId, name: '',
            launch: storeOpaquePresetLaunch({ contentEncryptionMode: 'e2ee', ...original }) } });
        const input = { homeId, id, expectedRevision: 0, machineId };
        const envelope = sealExternalActionRequestV2({ binding: { serverIdentityId: homeId, accountId,
            authentication: { kind: 'terminal', tokenEpoch: account.tokenEpoch }, actionId: MACHINE_PRESET_PREPARE_ACTION_ID_V1,
            requestId: 'encrypted-preparation', target: { kind: 'machine', machineId } }, input,
            material: { type: 'dataKey', machineKey: nacl.randomBytes(32) }, randomBytes: nacl.randomBytes,
            projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 });
        const issued = await app.inject({ method: 'POST',
            url: bindExternalActionExecutionAuthorizationHttpPathV1(MACHINE_PRESET_PREPARE_ACTION_ID_V1),
            headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId, envelope } });
        expect(issued.statusCode, issued.statusCode >= 400 ? issued.body : undefined).toBe(200);
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
        expect(authorization.binding.presetPreparationAdmission).toEqual(input);
        const ordinary = await app.inject({ method: 'POST',
            url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.work.summary.get'),
            headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId, envelope } });
        expect(ordinary.statusCode).toBeGreaterThanOrEqual(400);
        for (const expectedRevision of [0, 1]) {
            const replacement = seal(`Private preparation ${expectedRevision}`);
            const written = await signed(authorization, '/v1/machines/presets/update', { homeId, id, expectedRevision,
                patch: replacement });
            expect(written.statusCode, written.body).toBe(200);
            const preset = ManagedMachinePresetV1Schema.parse(written.json().preset);
            expect(preset).toMatchObject({ revision: expectedRevision + 1, contentEncryptionMode: 'e2ee', content: replacement.content,
                recipients: replacement.recipients });
        }
        const current = seal('Confined private preparation');
        for (const patch of [
            { content: { t: 'plain', v: { v: 1, name: 'Mode downgrade' } } },
            { recipients: [] },
            { recipients: current.recipients.map(recipient => ({ ...recipient, accountId: 'other-prepare-owner' })) },
            { recipients: current.recipients.map(recipient => ({ ...recipient, envelope: { ...recipient.envelope,
                recipientContentPublicKeyFingerprint: 'changed-recipient-key' } })) },
        ]) {
            const refused = await signed(authorization, '/v1/machines/presets/update', { homeId, id, expectedRevision: 2, patch });
            expect(refused.statusCode).toBe(403);
        }
        const stored = await db.managedMachinePreset.findUniqueOrThrow({ where: { id } });
        expect(stored.revision).toBe(2);
        expect(JSON.stringify(stored)).not.toContain('private-preparation-sentinel');
    });
});
