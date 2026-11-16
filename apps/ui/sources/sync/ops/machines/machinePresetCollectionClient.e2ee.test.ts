import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const {
    createMachinePresetCollectionClient, hasOpenedManagedMachinePresetCreationV1,
    isOpenedManagedMachinePresetV1, openManagedMachineReadSnapshots, readManagedMachineReadForSnapshot,
    prepareManagedMachinePresetResizeOverrideForSnapshot,
} = await import('./machinePresetCollectionClient');
const { captureManagedMachinePresetCustodyV1 } = await import('./managedMachinePresetCustody');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');

const launch = {
    provider: { pluginId: 'custom.compute', localId: 'native' },
    schemaVersion: 1,
    name: 'Guest',
    choices: {},
} as const;
const controller = { machineId: 'controller', installationId: 'installation' } as const;

function recipient(accountId: string, contentPublicKey: Uint8Array,
    envelopeStatus: 'missing' | 'prepared' = 'missing') {
    return {
        account: { kind: 'account' as const, accountId, name: null, firstName: accountId, lastName: null, username: accountId, avatarUrl: null },
        readiness: {
            status: 'available' as const,
            contentPublicKey: encodeBase64(contentPublicKey, 'base64'),
            contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(contentPublicKey),
        },
        envelopeStatus,
    };
}

function readyPlainCensus() {
    return { kind: 'ready' as const, contentEncryptionMode: 'plain' as const, recipients: [] };
}

beforeEach(async () => {
    await harness.reset();
    (await import('@/sync/ops/actions/scopedHomeActionExecutor')).resetScopedHomeActionExecutorsForTests();
});
afterEach(async () => {
    standardCleanup();
    await harness.reset();
});

describe('machine preset content envelopes', () => {
    it.each(['opened', 'unopened', 'legacy'] as const)('retains the original %s managed read for native control without exposing its carrier in the row', async form => {
        const { ManagedMachineReadV1Schema } = await import('@happier-dev/protocol/machines/managed/actionsV1');
        const serverId = await harness.addHome({ name: 'Retained managed read', serverUrl: 'https://retained-managed-read.example',
            serverIdentityId: 'srv_retained_managed_read', accountId: 'owner', currentAccount: true });
        const structural = { id: 'managed-read', homeId: 'srv_retained_managed_read', custodianAccountId: 'owner', controller,
            allocation: 'may-exist', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const read = ManagedMachineReadV1Schema.parse(form === 'legacy' ? { ...structural, launch } : {
            machine: { ...structural, preset: { id: 'retained-preset', revision: 3, contentEncryptionMode: 'plain' } },
            presetContent: { content: { t: 'plain', v: form === 'unopened' ? { v: 1, name: 'No launch' }
                : { v: 1, name: 'Private row', launch } }, recipientEnvelope: null },
        });
        const [snapshot] = await openManagedMachineReadSnapshots({ serverId, accountId: 'owner' }, [read]);
        if (!snapshot) throw new Error('Expected the retained managed snapshot');
        const retained = readManagedMachineReadForSnapshot(snapshot);
        expect(retained).toBe(read);
        expect(ManagedMachineReadV1Schema.safeParse(retained).success).toBe(true);
        expect(snapshot).not.toHaveProperty('presetContent');
        expect(snapshot.launch !== undefined).toBe(form !== 'unopened');
        if (form === 'unopened') expect(await prepareManagedMachinePresetResizeOverrideForSnapshot(
            { serverId, accountId: 'owner' }, snapshot, { cpuCores: 4 })).toEqual({ kind: 'failed', code: 'content_unavailable' });
        expect(harness.requests.filter(request => request.path.startsWith('/v1/machines/'))).toEqual([]);
    });
    it('propagates a retired Action Account instead of opening plaintext after its custody has changed', async () => {
        const serverId = await harness.addHome({
            name: 'Preset custody', serverUrl: 'https://preset-custody.example',
            serverIdentityId: 'srv_preset_custody', accountId: 'owner', currentAccount: true,
        });
        const account = await captureLazyActionAccountContext(serverId);
        try {
            const custody = await captureManagedMachinePresetCustodyV1({ account, expectedAccountId: 'owner' });
            expect(custody?.mode).toBe('plain');
            if (!custody || custody.mode !== 'plain') throw new Error('Plain custody expected');

            await harness.switchAccount(serverId, 'replacement', { currentAccount: true });

            expect(() => custody.open({
                presetId: 'preset-custody', mode: 'plain',
                projection: { content: { t: 'plain', v: { v: 1, name: 'Private preset' } }, recipientEnvelope: null },
            })).toThrow(expect.objectContaining({ code: 'action_account_scope_changed' }));
            custody.dispose();
        } finally {
            account.dispose();
        }
    });

    it('does not open a plaintext managed-row projection after its read boundary is cancelled', async () => {
        const serverId = await harness.addHome({
            name: 'Cancelled preset row', serverUrl: 'https://cancelled-preset-row.example',
            serverIdentityId: 'srv_cancelled_preset_row', accountId: 'owner', currentAccount: true,
        });
        const abort = new AbortController();
        abort.abort();

        await expect(openManagedMachineReadSnapshots({ serverId, accountId: 'owner' }, [{
            machine: {
                id: 'cancelled-row', homeId: 'srv_cancelled_preset_row', custodianAccountId: 'owner',
                preset: { id: 'cancelled-preset', revision: 1, contentEncryptionMode: 'plain' }, controller,
                allocation: 'may-exist', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            },
            presetContent: {
                content: { t: 'plain', v: { v: 1, name: 'Must not open after cancellation', launch } },
                recipientEnvelope: null,
            },
        }], abort.signal)).rejects.toThrow();
    });

    it('recognizes an opened launch as a portable creation preset before placement is selected', () => {
        expect(hasOpenedManagedMachinePresetCreationV1({ launch })).toBe(true);
        expect(hasOpenedManagedMachinePresetCreationV1({ launch, controller })).toBe(true);
        expect(hasOpenedManagedMachinePresetCreationV1({ launch,
            controllerPoolId: '4d783830-8626-4da8-8fde-a6da516025e1' })).toBe(true);
    });

    it('uses the server recipient census, then seals Plain create content without publishing private fields', async () => {
        const serverId = await harness.addHome({
            name: 'Preset content', serverUrl: 'https://preset-content.example',
            serverIdentityId: 'srv_preset_content', accountId: 'owner', currentAccount: true,
        });
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: readyPlainCensus() });
        harness.answer(serverId, '/v1/machines/presets/create', {
            body: { kind: 'refused', code: 'permission_denied' },
        });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_preset_content');

        await client.execute('machines.presets.create', {
            homeId: 'srv_preset_content', id: 'preset-1',
            owner: { kind: 'account', accountId: 'owner' },
            controller,
            privateContent: {
                v: 1,
                name: 'Private preset',
                launch,
                setup: { scripts: [{ body: 'echo setup', affects: 'none' }], items: [] },
                controllerDisplayName: 'Private controller label',
            },
        });

        expect(harness.requestsFor('/v1/machines/presets/recipient-census')[0]?.input).toEqual({
            homeId: 'srv_preset_content', owner: { kind: 'account', accountId: 'owner' }, controller,
        });
        const input = harness.requestsFor('/v1/machines/presets/create')[0]?.input;
        expect(input).toMatchObject({
            homeId: 'srv_preset_content', id: 'preset-1',
            owner: { kind: 'account', accountId: 'owner' },
            contentEncryptionMode: 'plain',
            content: {
                t: 'plain',
                v: {
                    v: 1,
                    name: 'Private preset',
                    launch,
                    setup: { scripts: [{ body: 'echo setup', affects: 'none' }], items: [] },
                    controllerDisplayName: 'Private controller label',
                },
            },
            recipients: [],
        });
        expect(input).not.toHaveProperty('privateContent');
        expect(input).not.toHaveProperty('name');
        expect(input).not.toHaveProperty('launch');
        expect(input).not.toHaveProperty('setup');
        expect(input).not.toHaveProperty('controllerDisplayName');
        expect(harness.requests.filter(request => request.path.includes('/machines/')
            && !request.path.includes('/presets/'))).toEqual([]);
    });

    it('refuses an E2EE author write when a census falsely selects Plain before any preset mutation', async () => {
        const credentials = {
            token: createAccountTokenForTests('owner', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(13), 'base64url'),
        };
        const serverId = await harness.addHome({
            name: 'Preset write authority', serverUrl: 'https://preset-write-authority.example',
            serverIdentityId: 'srv_preset_write_authority', accountId: 'owner', currentAccount: true,
            accountEncryptionMode: 'e2ee', credentials,
        });
        // The census is recipient preparation only; it cannot downgrade this author's stored mode.
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: readyPlainCensus() });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_preset_write_authority');

        await expect(client.execute('machines.presets.create', {
            homeId: 'srv_preset_write_authority', id: 'mode-mismatch-preset',
            owner: { kind: 'account', accountId: 'owner' }, controller,
            privateContent: { v: 1, name: 'Must not be sent as Plain', launch },
        })).resolves.toEqual({ kind: 'failed', code: 'account_mode_mismatch' });

        expect(harness.requestsFor('/v1/machines/presets/create')).toEqual([]);
        expect(harness.requestsFor('/v1/machines/presets/update')).toEqual([]);
    });

    it('opens a legacy Plain projection for its E2EE author and reseals only on normal save', async () => {
        const credentials = { token: createAccountTokenForTests('owner', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(17), 'base64url') };
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const homeId = 'srv_legacy_preset';
        const serverId = await harness.addHome({ name: 'Legacy preset', serverUrl: 'https://legacy-preset.example',
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true, accountEncryptionMode: 'e2ee', credentials });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [{
            id: 'legacy-preset', homeId, revision: 4, owner: { kind: 'account', accountId: 'owner' }, controller,
            contentEncryptionMode: 'plain', content: { t: 'plain', v: { v: 1, name: 'Legacy name', launch } }, recipients: [],
        }] } });
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [recipient('owner', encryption.contentDataKey)],
        } });
        harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'refused', code: 'permission_denied' } });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, homeId);
        const listed = await client.list();
        expect(listed).toMatchObject({ kind: 'succeeded', value: [{ id: 'legacy-preset', name: 'Legacy name' }] });
        expect(harness.requestsFor('/v1/machines/presets/update')).toEqual([]);
        if (listed.kind !== 'succeeded' || !listed.value[0] || !isOpenedManagedMachinePresetV1(listed.value[0]))
            throw new Error('Legacy Plain content must remain readable before save');
        await client.execute('machines.presets.update', { homeId, id: 'legacy-preset', expectedRevision: 4,
            patch: { privateContent: { v: 1, name: 'Edited legacy name', launch } } }, { preset: listed.value[0] });
        expect(harness.requestsFor('/v1/machines/presets/update')[0]?.input).toMatchObject({
            expectedRevision: 4, patch: { contentEncryptionMode: 'e2ee', content: { t: 'encrypted', c: expect.any(String) } },
        });
        expect(JSON.stringify(harness.requestsFor('/v1/machines/presets/update')[0]?.input)).not.toContain('Edited legacy name');
    });

    it.each(['account', 'team'] as const)('seals retained Plain %s preset content on a structural save by an E2EE author', async ownerKind => {
        const credentials = { token: createAccountTokenForTests('owner', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(17), 'base64url') };
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const homeId = 'srv_legacy_preset';
        const serverId = await harness.addHome({ name: 'Legacy structural save', serverUrl: 'https://legacy-structural.example',
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true, accountEncryptionMode: 'e2ee', credentials });
        const owner = ownerKind === 'team' ? { kind: 'team' as const, teamId: 'team-1' }
            : { kind: 'account' as const, accountId: 'owner' };
        const privateContent = { v: 1, name: 'Retained private name', launch,
            setup: { scripts: [{ body: 'retained private setup' }] }, controllerDisplayName: 'Retained controller' } as const;
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [{
            id: 'legacy-preset', homeId, revision: 22, owner, controller,
            contentEncryptionMode: 'plain', content: { t: 'plain', v: privateContent }, recipients: [],
        }] } });
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [recipient('owner', encryption.contentDataKey)],
        } });
        harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'refused', code: 'permission_denied' } });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, homeId);
        const listed = await client.list();
        if (listed.kind !== 'succeeded' || !listed.value[0] || !isOpenedManagedMachinePresetV1(listed.value[0]))
            throw new Error('Expected the retained Plain preset to open');
        expect(harness.requestsFor('/v1/machines/presets/update')).toEqual([]);
        await client.execute('machines.presets.update', { homeId, id: 'legacy-preset', expectedRevision: 22,
            patch: { simultaneousLimit: { maximum: 4 } } }, { preset: listed.value[0] });
        const update = harness.requestsFor('/v1/machines/presets/update')[0]?.input;
        expect(update).toMatchObject({ expectedRevision: 22, patch: {
            simultaneousLimit: { maximum: 4 }, contentEncryptionMode: 'e2ee',
            content: { t: 'encrypted', c: expect.any(String) }, recipients: [expect.objectContaining({ accountId: 'owner' })],
        } });
        expect(JSON.stringify(update)).not.toContain('Retained private name');
        expect(JSON.stringify(update)).not.toContain('retained private setup');
        const patch = (update as { patch: Record<string, unknown> }).patch;
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [{
            id: 'legacy-preset', homeId, revision: 23, owner, controller, ...patch,
        }] } });
        await expect(client.list()).resolves.toMatchObject({ kind: 'succeeded', value: [{ ...privateContent, revision: 23 }] });
    });

    it('saves the editor draft through one private body instead of raw content fields', async () => {
        const homeId = 'srv_editor_draft';
        const serverId = await harness.addHome({ name: 'Editor draft', serverUrl: 'https://editor-draft.example',
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: readyPlainCensus() });
        harness.answer(serverId, '/v1/machines/presets/create', { body: { kind: 'refused', code: 'permission_denied' } });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, homeId);
        await client.saveDraft({ id: 'editor-preset', owner: { kind: 'account', accountId: 'owner' },
            draft: { name: 'Edited draft', setup: { scripts: [{ body: 'echo retained editor script' }] } } });
        expect(harness.requestsFor('/v1/machines/presets/create')[0]?.input).toMatchObject({
            id: 'editor-preset', contentEncryptionMode: 'plain', content: { t: 'plain', v: {
                v: 1, name: 'Edited draft', setup: { scripts: [{ body: 'echo retained editor script' }] },
            } },
        });
        expect(harness.requestsFor('/v1/machines/presets/create')[0]?.input).not.toHaveProperty('name');
        expect(harness.requestsFor('/v1/machines/presets/create')[0]?.input).not.toHaveProperty('setup');
    });

    it.each(['plain', 'e2ee'] as const)('preserves incumbent private preparation state when the editor saves in %s', async mode => {
        const credentials = mode === 'e2ee' ? {
            token: createAccountTokenForTests('owner', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(43), 'base64url'),
        } : undefined;
        const encryption = credentials ? await createEncryptionFromAuthCredentials(credentials) : null;
        const homeId = `srv_editor_prepared_${mode}`;
        const serverId = await harness.addHome({
            name: `Prepared editor ${mode}`, serverUrl: `https://prepared-editor-${mode}.example`,
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true,
            accountEncryptionMode: mode, ...(credentials ? { credentials } : {}),
        });
        const protocol = await import('@happier-dev/protocol/machines/managed/managedMachinePresetContentV1');
        const setup = { scripts: [{ body: 'echo original setup', affects: 'none' as const }] };
        const preparation = { enabled: true } as const;
        const prepared = {
            operationId: 'prepare-operation',
            binding: {
                presetRevision: 7,
                configuration: {
                    launch: { provider: launch.provider, schemaVersion: launch.schemaVersion, choices: launch.choices },
                    setup,
                },
                cliIdentity: 'home-payload:0.3:prepared',
                credentialConfigurations: [],
            },
            status: 'ready' as const,
            artifact: { contributionRef: launch.provider, schemaVersion: launch.schemaVersion, value: { imageId: 'private-image' } },
            bakedSetup: setup,
        };
        const census = encryption ? [recipient('owner', encryption.contentDataKey)] : [];
        let nonce = 1;
        const randomBytes = (length: number) => new Uint8Array(length).fill(nonce++);
        const initial = mode === 'plain'
            ? protocol.sealManagedMachinePresetContentV1({ presetId: 'prepared-preset', mode, content: {
                v: 1, name: 'Original name', launch, setup, preparation,
            } })
            : protocol.sealManagedMachinePresetContentV1({ presetId: 'prepared-preset', mode, content: {
                v: 1, name: 'Original name', launch, setup, preparation,
            }, recipientCensus: census, randomBytes });
        const preparedWrite = mode === 'plain'
            ? protocol.replaceManagedMachinePresetPreparationV1({
                presetId: 'prepared-preset', mode, content: initial.content, expectedOperationId: null, prepared,
            })
            : protocol.replaceManagedMachinePresetPreparationV1({
                presetId: 'prepared-preset', mode, content: initial.content, recipients: initial.recipients,
                accountId: 'owner', accountKey: encryption!.getContentPrivateKey(), randomBytes,
                expectedOperationId: null, prepared,
            });
        if (!preparedWrite) throw new Error('Expected prepared fixture content');
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [{
            id: 'prepared-preset', homeId, revision: 7, owner: { kind: 'account', accountId: 'owner' }, controller,
            contentEncryptionMode: mode, content: preparedWrite.content, recipients: initial.recipients,
        }] } });
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: mode === 'plain'
            ? readyPlainCensus()
            : { kind: 'ready', contentEncryptionMode: 'e2ee',
                recipients: [recipient('owner', encryption!.contentDataKey, 'prepared')] } });
        harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'refused', code: 'permission_denied' } });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, homeId);
        const listed = await client.list();
        if (listed.kind !== 'succeeded' || !listed.value[0] || !isOpenedManagedMachinePresetV1(listed.value[0])) {
            throw new Error('Expected prepared preset content to open');
        }

        await client.saveDraft({ preset: listed.value[0], draft: {
            name: 'Edited name', creation: { launch }, setup,
        } });

        const request = harness.requestsFor('/v1/machines/presets/update')[0]?.input as {
            patch: { contentEncryptionMode: 'plain' | 'e2ee'; content: unknown; recipients: readonly {
                accountId: string; envelope: { encryptedDataKey: string };
            }[] };
        };
        const opened = mode === 'plain'
            ? protocol.openManagedMachinePresetContentV1({ presetId: 'prepared-preset', mode,
                content: request.patch.content })
            : protocol.openManagedMachinePresetContentV1({ presetId: 'prepared-preset', mode,
                content: request.patch.content, recipients: request.patch.recipients,
                accountId: 'owner', accountKey: encryption!.getContentPrivateKey() });
        if (mode === 'e2ee') {
            const openDataKey = (encryptedDataKey: string) => openEncryptedDataKeyEnvelopeV1({
                envelope: decodeBase64(encryptedDataKey),
                recipientSecretKeyOrSeed: encryption!.getContentPrivateKey(),
            });
            expect(openDataKey(request.patch.recipients[0]!.envelope.encryptedDataKey)).not.toEqual(
                openDataKey(initial.recipients[0]!.envelope.encryptedDataKey),
            );
        }
        expect(opened).toEqual({ v: 1, name: 'Edited name', launch, setup, preparation, prepared });
        expect(opened?.prepared?.binding.presetRevision).toBe(7);
    });

    it('opens list rows before applying the local name filter and never sends search to the Home', async () => {
        const serverId = await harness.addHome({
            name: 'Preset reads', serverUrl: 'https://preset-reads.example',
            serverIdentityId: 'srv_preset_reads', accountId: 'owner', currentAccount: true,
        });
        const row = (id: string, name: string) => ({
            id, homeId: 'srv_preset_reads', revision: 1,
            owner: { kind: 'account' as const, accountId: 'owner' },
            contentEncryptionMode: 'plain' as const,
            controller,
            content: { t: 'plain' as const, v: { v: 1 as const, name, launch } },
            recipients: [],
        });
        harness.answer(serverId, '/v1/machines/presets/list', {
            body: { kind: 'listed', presets: [row('one', 'Foo build'), row('two', 'Bar build')] },
        });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_preset_reads');

        const result = await client.list({ search: 'foo' });

        expect(result).toEqual({ kind: 'succeeded', value: [expect.objectContaining({ id: 'one', name: 'Foo build' })] });
        expect(result.kind === 'succeeded' ? result.value[0] : null).not.toHaveProperty('content');
        expect(harness.requestsFor('/v1/machines/presets/list')[0]?.input).not.toHaveProperty('search');
    });

    it('uses the server census for a private update and places its result only in the envelope patch', async () => {
        const serverId = await harness.addHome({
            name: 'Preset update', serverUrl: 'https://preset-update.example',
            serverIdentityId: 'srv_preset_update', accountId: 'owner', currentAccount: true,
        });
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: readyPlainCensus() });
        harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'refused', code: 'permission_denied' } });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_preset_update');
        await client.execute('machines.presets.update', {
            homeId: 'srv_preset_update', id: 'preset-update', expectedRevision: 1,
            patch: { privateContent: { v: 1, name: 'Edited', launch, controllerDisplayName: 'Edited controller' } },
        }, { preset: { owner: { kind: 'account', accountId: 'owner' }, controller } });
        expect(harness.requestsFor('/v1/machines/presets/recipient-census')[0]?.input).toEqual({
            homeId: 'srv_preset_update', owner: { kind: 'account', accountId: 'owner' }, controller,
        });
        const patch = (harness.requestsFor('/v1/machines/presets/update')[0]?.input as { patch: Record<string, unknown> }).patch;
        expect(patch).toMatchObject({
            contentEncryptionMode: 'plain',
            content: { t: 'plain', v: { v: 1, name: 'Edited', launch, controllerDisplayName: 'Edited controller' } },
            recipients: [],
        });
        expect(patch).not.toHaveProperty('privateContent');
        expect(patch).not.toHaveProperty('name');
        expect(patch).not.toHaveProperty('launch');
        expect(patch).not.toHaveProperty('controllerDisplayName');
    });

    it('seals E2EE create content for the server-selected census and keeps plaintext out of the Action input', async () => {
        const credentials = {
            token: createAccountTokenForTests('owner', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(17), 'base64url'),
        };
        const ownerEncryption = await createEncryptionFromAuthCredentials(credentials);
        const serverId = await harness.addHome({
            name: 'Preset e2ee', serverUrl: 'https://preset-e2ee.example',
            serverIdentityId: 'srv_preset_e2ee', accountId: 'owner', currentAccount: true,
            accountEncryptionMode: 'e2ee', credentials,
        });
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [recipient('owner', ownerEncryption.contentDataKey)],
        } });
        harness.answer(serverId, '/v1/machines/presets/create', {
            body: { kind: 'refused', code: 'permission_denied' },
        });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_preset_e2ee');

        await client.execute('machines.presets.create', {
            homeId: 'srv_preset_e2ee', id: 'preset-e2ee',
            owner: { kind: 'account', accountId: 'owner' }, controller,
            privateContent: { v: 1, name: 'E2EE preset', launch },
        });

        const input = harness.requestsFor('/v1/machines/presets/create')[0]?.input as Record<string, unknown> | undefined;
        expect(input).toMatchObject({ contentEncryptionMode: 'e2ee', content: { t: 'encrypted' },
            recipients: [{ accountId: 'owner', envelope: {
                encryptedDataKey: expect.any(String), recipientContentPublicKeyFingerprint: expect.any(String),
            } }] });
        expect(input).not.toHaveProperty('privateContent');
        expect(input).not.toHaveProperty('name');
        expect(input).not.toHaveProperty('launch');
    });

    it('seals an edited E2EE setup as the exact opaque revision override', async () => {
        const credentials = {
            token: createAccountTokenForTests('owner', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(19), 'base64url'),
        };
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const serverId = await harness.addHome({
            name: 'Preset setup override', serverUrl: 'https://preset-setup-override.example',
            serverIdentityId: 'srv_preset_setup_override', accountId: 'owner', currentAccount: true,
            accountEncryptionMode: 'e2ee', credentials,
        });
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [recipient('owner', encryption.contentDataKey)],
        } });
        harness.answer(serverId, '/v1/machines/presets/create', { body: { kind: 'refused', code: 'permission_denied' } });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_preset_setup_override');
        await client.execute('machines.presets.create', {
            homeId: 'srv_preset_setup_override', id: 'setup-override-preset',
            owner: { kind: 'account', accountId: 'owner' }, controller,
            privateContent: { v: 1, name: 'E2EE setup preset', launch, setup: { scripts: [{ body: 'base private setup' }] } },
        });
        const created = harness.requestsFor('/v1/machines/presets/create')[0]!.input as Record<string, unknown>;
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [recipient('owner', encryption.contentDataKey, 'prepared')],
        } });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [{
            id: 'setup-override-preset', homeId: 'srv_preset_setup_override', revision: 3,
            owner: { kind: 'account', accountId: 'owner' }, contentEncryptionMode: 'e2ee', controller,
            content: created.content, recipients: created.recipients,
        }] } });
        const listed = await client.list();
        expect(listed).toMatchObject({ kind: 'succeeded', value: [expect.objectContaining({ id: 'setup-override-preset' })] });
        if (listed.kind !== 'succeeded' || !isOpenedManagedMachinePresetV1(listed.value[0]!)) throw new Error('opened preset expected');

        const override = await client.prepareSetupOverride(listed.value[0], { scripts: [{ body: 'edited private setup' }] });

        expect(override).toMatchObject({ kind: 'ready', override: { content: { t: 'encrypted' } } });
        expect(override.kind === 'ready' ? override.override : {}).not.toHaveProperty('setup');
    });

    it('seals an E2EE resize from the selected recipient projection without exposing its size', async () => {
        const credentials = {
            token: createAccountTokenForTests('owner', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(20), 'base64url'),
        };
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const serverId = await harness.addHome({
            name: 'Preset resize override', serverUrl: 'https://preset-resize-override.example',
            serverIdentityId: 'srv_preset_resize_override', accountId: 'owner', currentAccount: true,
            accountEncryptionMode: 'e2ee', credentials,
        });
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [recipient('owner', encryption.contentDataKey)],
        } });
        harness.answer(serverId, '/v1/machines/presets/create', { body: { kind: 'refused', code: 'permission_denied' } });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_preset_resize_override');
        await client.execute('machines.presets.create', {
            homeId: 'srv_preset_resize_override', id: 'resize-override-preset',
            owner: { kind: 'account', accountId: 'owner' }, controller,
            privateContent: { v: 1, name: 'E2EE resize preset', launch },
        });
        const created = harness.requestsFor('/v1/machines/presets/create')[0]!.input as Record<string, unknown>;
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [recipient('owner', encryption.contentDataKey, 'prepared')],
        } });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [{
            id: 'resize-override-preset', homeId: 'srv_preset_resize_override', revision: 3,
            owner: { kind: 'account', accountId: 'owner' }, contentEncryptionMode: 'e2ee', controller,
            content: created.content, recipients: created.recipients,
        }] } });
        const listed = await client.list();
        if (listed.kind !== 'succeeded' || !isOpenedManagedMachinePresetV1(listed.value[0]!)) throw new Error('opened preset expected');
        const before = harness.requestsFor('/v1/machines/presets/list').length;

        const override = await client.prepareResizeOverride(listed.value[0], { cpuCores: 8 });

        expect(override).toMatchObject({ kind: 'ready', override: { content: { t: 'encrypted' } } });
        expect(override.kind === 'ready' ? override.override : {}).not.toHaveProperty('size');
        expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before);
    });

    it('seals reviewed and author-only E2EE acquire choices from the selected recipient projection without a new Preset read', async () => {
        const credentials = {
            token: createAccountTokenForTests('owner', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(21), 'base64url'),
        };
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const serverId = await harness.addHome({
            name: 'Preset acquire override', serverUrl: 'https://preset-acquire-override.example',
            serverIdentityId: 'srv_preset_acquire_override', accountId: 'owner', currentAccount: true,
            accountEncryptionMode: 'e2ee', credentials,
        });
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [recipient('owner', encryption.contentDataKey)],
        } });
        harness.answer(serverId, '/v1/machines/presets/create', { body: { kind: 'refused', code: 'permission_denied' } });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_preset_acquire_override');
        await client.execute('machines.presets.create', {
            homeId: 'srv_preset_acquire_override', id: 'acquire-override-preset',
            owner: { kind: 'account', accountId: 'owner' }, controller,
            privateContent: { v: 1, name: 'E2EE acquire preset', launch },
        });
        const created = harness.requestsFor('/v1/machines/presets/create')[0]!.input as Record<string, unknown>;
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [recipient('owner', encryption.contentDataKey, 'prepared')],
        } });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [{
            id: 'acquire-override-preset', homeId: 'srv_preset_acquire_override', revision: 3,
            owner: { kind: 'account', accountId: 'owner' }, contentEncryptionMode: 'e2ee', controller,
            content: created.content, recipients: created.recipients,
        }] } });
        const listed = await client.list();
        if (listed.kind !== 'succeeded' || !isOpenedManagedMachinePresetV1(listed.value[0]!)) throw new Error('opened preset expected');
        const before = harness.requestsFor('/v1/machines/presets/list').length;

        const override = await client.prepareAcquireOverride(listed.value[0], {
            launchName: 'Private allocation name', enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
        });

        expect(override).toMatchObject({ kind: 'ready', override: { content: { t: 'encrypted' } } });
        expect(override.kind === 'ready' ? override.override : {}).not.toHaveProperty('launchName');
        expect(override.kind === 'ready' ? override.override : {}).not.toHaveProperty('enrollmentIdentity');
        expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before);
    });

    it('uses the real Team census and opens the shared E2EE row as a member Account', async () => {
        const ownerCredentials = {
            token: createAccountTokenForTests('owner', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(23), 'base64url'),
        };
        const memberCredentials = {
            token: createAccountTokenForTests('member', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(29), 'base64url'),
        };
        const ownerEncryption = await createEncryptionFromAuthCredentials(ownerCredentials);
        const memberEncryption = await createEncryptionFromAuthCredentials(memberCredentials);
        const serverId = await harness.addHome({
            name: 'Preset Team', serverUrl: 'https://preset-team.example',
            serverIdentityId: 'srv_preset_team', accountId: 'owner', currentAccount: true,
            accountEncryptionMode: 'e2ee', credentials: ownerCredentials,
        });
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [
                recipient('owner', ownerEncryption.contentDataKey), recipient('member', memberEncryption.contentDataKey),
            ],
        } });
        harness.answer(serverId, '/v1/machines/presets/create', { body: { kind: 'refused', code: 'permission_denied' } });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_preset_team');
        await client.execute('machines.presets.create', {
            homeId: 'srv_preset_team', id: 'team-preset',
            owner: { kind: 'team', teamId: 'team' }, controller,
            privateContent: { v: 1, name: 'Team preset', launch },
        });
        const createInput = harness.requestsFor('/v1/machines/presets/create')[0]?.input as Record<string, unknown>;
        expect(createInput.recipients).toEqual([
            expect.objectContaining({ accountId: 'owner', envelope: expect.objectContaining({
                encryptedDataKey: expect.any(String), recipientContentPublicKeyFingerprint: expect.any(String),
            }) }),
            expect.objectContaining({ accountId: 'member', envelope: expect.objectContaining({
                encryptedDataKey: expect.any(String), recipientContentPublicKeyFingerprint: expect.any(String),
            }) }),
        ]);

        await harness.switchAccount(serverId, 'member', memberCredentials);
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [
                recipient('owner', ownerEncryption.contentDataKey, 'prepared'),
                recipient('member', memberEncryption.contentDataKey, 'prepared'),
            ],
        } });
        harness.answer(serverId, '/v1/machines/presets/list', {
            body: { kind: 'listed', presets: [{ id: 'team-preset', homeId: 'srv_preset_team', revision: 1,
                owner: { kind: 'team', teamId: 'team' }, contentEncryptionMode: 'e2ee', controller,
                content: createInput.content, recipients: createInput.recipients }] },
        });
        const memberClient = createMachinePresetCollectionClient({ serverId, accountId: 'member' }, 'srv_preset_team');
        await expect(memberClient.list()).resolves.toMatchObject({ kind: 'succeeded', value: [
            expect.objectContaining({ id: 'team-preset', name: 'Team preset' }),
        ] });
    });

    it('does not mutate an existing E2EE revision when its census says every envelope is prepared', async () => {
        const credentials = {
            token: createAccountTokenForTests('owner', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(31), 'base64url'),
        };
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const serverId = await harness.addHome({
            name: 'Prepared preset', serverUrl: 'https://preset-prepared.example',
            serverIdentityId: 'srv_preset_prepared', accountId: 'owner', currentAccount: true,
            accountEncryptionMode: 'e2ee', credentials,
        });
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [recipient('owner', encryption.contentDataKey)],
        } });
        harness.answer(serverId, '/v1/machines/presets/create', { body: { kind: 'refused', code: 'permission_denied' } });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_preset_prepared');
        await client.execute('machines.presets.create', {
            homeId: 'srv_preset_prepared', id: 'prepared-preset', owner: { kind: 'team', teamId: 'team' }, controller,
            privateContent: { v: 1, name: 'Prepared Team preset', launch },
        });
        const created = harness.requestsFor('/v1/machines/presets/create')[0]!.input as Record<string, unknown>;
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [recipient('owner', encryption.contentDataKey, 'prepared')],
        } });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [{
            id: 'prepared-preset', homeId: 'srv_preset_prepared', revision: 4,
            owner: { kind: 'team', teamId: 'team' }, contentEncryptionMode: 'e2ee', controller,
            content: created.content, recipients: created.recipients,
        }] } });

        await expect(client.list()).resolves.toMatchObject({ kind: 'succeeded', value: [
            expect.objectContaining({ id: 'prepared-preset', revision: 4, name: 'Prepared Team preset' }),
        ] });
        expect(harness.requestsFor('/v1/machines/presets/recipient-census')[1]?.input).toEqual({
            homeId: 'srv_preset_prepared', presetId: 'prepared-preset', owner: { kind: 'team', teamId: 'team' }, controller,
        });
        expect(harness.requestsFor('/v1/machines/presets/update')).toEqual([]);
    });

    it('prunes a departed Account envelope when every remaining census recipient is already prepared', async () => {
        const ownerCredentials = {
            token: createAccountTokenForTests('owner', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(32), 'base64url'),
        };
        const departedCredentials = {
            token: createAccountTokenForTests('departed', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(34), 'base64url'),
        };
        const ownerEncryption = await createEncryptionFromAuthCredentials(ownerCredentials);
        const departedEncryption = await createEncryptionFromAuthCredentials(departedCredentials);
        const serverId = await harness.addHome({
            name: 'Pruned preset', serverUrl: 'https://preset-pruned.example',
            serverIdentityId: 'srv_preset_pruned', accountId: 'owner', currentAccount: true,
            accountEncryptionMode: 'e2ee', credentials: ownerCredentials,
        });
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [
                recipient('owner', ownerEncryption.contentDataKey), recipient('departed', departedEncryption.contentDataKey),
            ],
        } });
        harness.answer(serverId, '/v1/machines/presets/create', { body: { kind: 'refused', code: 'permission_denied' } });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_preset_pruned');
        await client.execute('machines.presets.create', {
            homeId: 'srv_preset_pruned', id: 'pruned-preset', owner: { kind: 'team', teamId: 'team' }, controller,
            privateContent: { v: 1, name: 'Pruned Team preset', launch },
        });
        const created = harness.requestsFor('/v1/machines/presets/create')[0]!.input as Record<string, unknown>;
        const existing = {
            id: 'pruned-preset', homeId: 'srv_preset_pruned', revision: 4,
            owner: { kind: 'team' as const, teamId: 'team' }, contentEncryptionMode: 'e2ee' as const, controller,
            content: created.content, recipients: created.recipients,
        };
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [recipient('owner', ownerEncryption.contentDataKey, 'prepared')],
        } });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [existing] } });
        harness.answer(serverId, '/v1/machines/presets/update', { select: value => {
            const input = value as Readonly<{ patch: Readonly<{ recipients: unknown }> }>;
            return { body: { kind: 'saved', preset: { ...existing, revision: 5, recipients: input.patch.recipients } } };
        } });

        await expect(client.list()).resolves.toMatchObject({ kind: 'succeeded', value: [
            expect.objectContaining({ id: 'pruned-preset', revision: 5, name: 'Pruned Team preset' }),
        ] });
        const update = harness.requestsFor('/v1/machines/presets/update')[0]?.input as { patch: Record<string, unknown> } | undefined;
        expect(update?.patch).toEqual({ recipients: [expect.objectContaining({ accountId: 'owner' })] });
        expect(update?.patch).not.toHaveProperty('content');
    });

    it('keeps an already opened E2EE row visible when the optional recipient repair census is unavailable', async () => {
        const credentials = {
            token: createAccountTokenForTests('owner', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(33), 'base64url'),
        };
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const serverId = await harness.addHome({
            name: 'Repair unavailable', serverUrl: 'https://preset-repair-unavailable.example',
            serverIdentityId: 'srv_preset_repair_unavailable', accountId: 'owner', currentAccount: true,
            accountEncryptionMode: 'e2ee', credentials,
        });
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [recipient('owner', encryption.contentDataKey)],
        } });
        harness.answer(serverId, '/v1/machines/presets/create', { body: { kind: 'refused', code: 'permission_denied' } });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_preset_repair_unavailable');
        await client.execute('machines.presets.create', {
            homeId: 'srv_preset_repair_unavailable', id: 'repair-unavailable-preset',
            owner: { kind: 'team', teamId: 'team' }, controller,
            privateContent: { v: 1, name: 'Visible without repair', launch },
        });
        const created = harness.requestsFor('/v1/machines/presets/create')[0]!.input as Record<string, unknown>;
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: { kind: 'unexpected' } });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [{
            id: 'repair-unavailable-preset', homeId: 'srv_preset_repair_unavailable', revision: 4,
            owner: { kind: 'team', teamId: 'team' }, contentEncryptionMode: 'e2ee', controller,
            content: created.content, recipients: created.recipients,
        }] } });

        await expect(client.list()).resolves.toMatchObject({ kind: 'succeeded', value: [
            expect.objectContaining({ id: 'repair-unavailable-preset', revision: 4, name: 'Visible without repair' }),
        ] });
        expect(harness.requestsFor('/v1/machines/presets/update')).toEqual([]);
    });

    it('repairs the existing Team revision from a current keyholder before a newly joined member opens it', async () => {
        const ownerCredentials = {
            token: createAccountTokenForTests('owner', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(37), 'base64url'),
        };
        const memberCredentials = {
            token: createAccountTokenForTests('member', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(39), 'base64url'),
        };
        const ownerEncryption = await createEncryptionFromAuthCredentials(ownerCredentials);
        const memberEncryption = await createEncryptionFromAuthCredentials(memberCredentials);
        const serverId = await harness.addHome({
            name: 'Preset rewrap', serverUrl: 'https://preset-rewrap.example',
            serverIdentityId: 'srv_preset_rewrap', accountId: 'owner', currentAccount: true,
            accountEncryptionMode: 'e2ee', credentials: ownerCredentials,
        });
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [recipient('owner', ownerEncryption.contentDataKey)],
        } });
        harness.answer(serverId, '/v1/machines/presets/create', { body: { kind: 'refused', code: 'permission_denied' } });
        const ownerClient = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_preset_rewrap');
        await ownerClient.execute('machines.presets.create', {
            homeId: 'srv_preset_rewrap', id: 'existing-team-preset', owner: { kind: 'team', teamId: 'team' }, controller,
            privateContent: { v: 1, name: 'Existing Team preset', launch },
        });
        const created = harness.requestsFor('/v1/machines/presets/create')[0]!.input as Record<string, unknown>;
        const existing = {
            id: 'existing-team-preset', homeId: 'srv_preset_rewrap', revision: 1,
            owner: { kind: 'team' as const, teamId: 'team' }, contentEncryptionMode: 'e2ee' as const, controller,
            content: created.content, recipients: created.recipients,
        };
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [
                recipient('owner', ownerEncryption.contentDataKey), recipient('member', memberEncryption.contentDataKey),
            ],
        } });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [existing] } });
        harness.answer(serverId, '/v1/machines/presets/update', { select: value => {
            const input = value as Readonly<{ patch: Readonly<{ recipients: unknown }> }>;
            return { body: { kind: 'saved', preset: { ...existing, revision: 2, recipients: input.patch.recipients } } };
        } });

        await expect(ownerClient.list()).resolves.toMatchObject({ kind: 'succeeded', value: [expect.objectContaining({
            id: existing.id, revision: 2,
        })] });

        expect(harness.requestsFor('/v1/machines/presets/recipient-census')[1]?.input).toEqual({
            homeId: 'srv_preset_rewrap', presetId: existing.id, owner: { kind: 'team', teamId: 'team' }, controller,
        });

        const repairPatch = (harness.requestsFor('/v1/machines/presets/update')[0]?.input as { patch: Record<string, unknown> }).patch;
        expect(repairPatch).toEqual({ recipients: [
            expect.objectContaining({ accountId: 'owner', envelope: expect.objectContaining({
                encryptedDataKey: expect.any(String), recipientContentPublicKeyFingerprint: expect.any(String),
            }) }),
            expect.objectContaining({ accountId: 'member', envelope: expect.objectContaining({
                encryptedDataKey: expect.any(String), recipientContentPublicKeyFingerprint: expect.any(String),
            }) }),
        ] });
        await harness.switchAccount(serverId, 'member', memberCredentials);
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [
                recipient('owner', ownerEncryption.contentDataKey, 'prepared'),
                recipient('member', memberEncryption.contentDataKey, 'prepared'),
            ],
        } });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [{ ...existing, revision: 2,
            recipients: repairPatch.recipients }] } });

        await expect(createMachinePresetCollectionClient({ serverId, accountId: 'member' }, 'srv_preset_rewrap').list())
            .resolves.toMatchObject({ kind: 'succeeded', value: [expect.objectContaining({ name: 'Existing Team preset' })] });
        expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1);
    });

    it('opens an author-Plain shared row for an E2EE viewer without resolving a viewer mode as resource authority', async () => {
        const memberCredentials = {
            token: createAccountTokenForTests('member', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(41), 'base64url'),
        };
        const serverId = await harness.addHome({
            name: 'Plain author', serverUrl: 'https://preset-plain-author.example',
            serverIdentityId: 'srv_preset_plain_author', accountId: 'member', currentAccount: true,
            accountEncryptionMode: 'e2ee', credentials: memberCredentials,
        });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [{
            id: 'plain-team-preset', homeId: 'srv_preset_plain_author', revision: 1,
            owner: { kind: 'team', teamId: 'team' }, contentEncryptionMode: 'plain', controller,
            content: { t: 'plain', v: { v: 1, name: 'Plain shared preset', launch } }, recipients: [],
        }] } });

        const result = await createMachinePresetCollectionClient({ serverId, accountId: 'member' }, 'srv_preset_plain_author').list();

        expect(result).toMatchObject({ kind: 'succeeded', value: [expect.objectContaining({ name: 'Plain shared preset' })] });
    });

    it('keeps an unreadable E2EE row explicit while retaining readable siblings', async () => {
        const ownerCredentials = {
            token: createAccountTokenForTests('owner', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(53), 'base64url'),
        };
        const ownerEncryption = await createEncryptionFromAuthCredentials(ownerCredentials);
        const serverId = await harness.addHome({
            name: 'E2EE author', serverUrl: 'https://preset-e2ee-author.example',
            serverIdentityId: 'srv_preset_e2ee_author', accountId: 'owner', currentAccount: true,
            accountEncryptionMode: 'e2ee', credentials: ownerCredentials,
        });
        harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: {
            kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [recipient('owner', ownerEncryption.contentDataKey)],
        } });
        harness.answer(serverId, '/v1/machines/presets/create', { body: { kind: 'refused', code: 'permission_denied' } });
        const ownerClient = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_preset_e2ee_author');
        await ownerClient.execute('machines.presets.create', {
            homeId: 'srv_preset_e2ee_author', id: 'encrypted-preset',
            owner: { kind: 'account', accountId: 'owner' }, controller,
            privateContent: { v: 1, name: 'Encrypted preset', launch },
        });
        const encrypted = harness.requestsFor('/v1/machines/presets/create')[0]?.input as Record<string, unknown>;

        await harness.switchAccount(serverId, 'plain-member', {
            token: createAccountTokenForTests('plain-member', { currentAccount: true }),
        });
        harness.answer(serverId, '/v1/account/encryption', { body: { mode: 'plain', updatedAt: 1 } });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [{
            id: 'encrypted-preset', homeId: 'srv_preset_e2ee_author', revision: 1,
            owner: { kind: 'account', accountId: 'owner' }, contentEncryptionMode: 'e2ee', controller,
            content: encrypted.content, recipients: encrypted.recipients,
        }, {
            id: 'plain-sibling', homeId: 'srv_preset_e2ee_author', revision: 1,
            owner: { kind: 'account', accountId: 'owner' }, contentEncryptionMode: 'plain', controller,
            content: { t: 'plain', v: { v: 1, name: 'Readable sibling', launch } }, recipients: [],
        }] } });

        await expect(createMachinePresetCollectionClient({ serverId, accountId: 'plain-member' }, 'srv_preset_e2ee_author').list())
            .resolves.toMatchObject({ kind: 'succeeded', value: [
                { kind: 'private_content_unavailable', id: 'encrypted-preset', contentEncryptionMode: 'e2ee' },
                { id: 'plain-sibling', name: 'Readable sibling' },
            ] });
    });

    it('opens an opaque managed row from its exact E2EE recipient projection without fetching a newer preset', async () => {
        const credentials = {
            token: createAccountTokenForTests('owner', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(59), 'base64url'),
        };
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const serverId = await harness.addHome({
            name: 'Managed row projection', serverUrl: 'https://managed-row-projection.example',
            serverIdentityId: 'srv_managed_row_projection', accountId: 'owner', currentAccount: true,
            accountEncryptionMode: 'e2ee', credentials,
        });
        const { replaceManagedMachinePresetLaunchNameV1, sealManagedMachinePresetContentV1,
            projectManagedMachinePresetForRecipientV1 } = await import(
            '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1'
        );
        const setup = { scripts: [], items: [] };
        const reviewedFacts = {
            launch, controller, optionStatus: 'current' as const,
            billing: { location: 'local' as const, stoppedBilling: 'not-billed' as const }, prerequisites: [],
            retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false, setup,
        } satisfies import('@happier-dev/protocol/machines/managed/managedConfigurationV1').ManagedConfigurationFactsV1;
        const nativeResult = {
            kind: 'bound' as const,
            resource: {
                contributionRef: launch.provider,
                schemaVersion: launch.schemaVersion,
                value: { namespace: 'sealed-native-namespace', backendId: 'sealed-native-id' },
            },
        };
        const observation = {
            observedAt: 3,
            availability: 'present' as const,
            power: 'running' as const,
            size: { cpuCores: 4 },
            nativeCause: { localCause: 'native_options_changed' as const },
        };
        const sealed = sealManagedMachinePresetContentV1({
            presetId: 'managed-row-preset', mode: 'e2ee',
            content: { v: 1, name: 'Private managed name', launch, setup },
            recipientCensus: [recipient('owner', encryption.contentDataKey)], randomBytes: length => new Uint8Array(length).fill(7),
        });
        const snapshotContent = replaceManagedMachinePresetLaunchNameV1({
            presetId: 'managed-row-preset', mode: 'e2ee', content: sealed.content, recipients: sealed.recipients,
            accountId: 'owner', accountKey: encryption.getContentPrivateKey(), launchName: launch.name,
            reviewedFacts, nativeResult, observation, randomBytes: length => new Uint8Array(length).fill(11),
        });
        expect(snapshotContent).not.toBeNull();
        const read = {
            machine: {
                id: 'managed-row', homeId: 'srv_managed_row_projection', custodianAccountId: 'owner',
                preset: { id: 'managed-row-preset', revision: 4, contentEncryptionMode: 'e2ee' }, controller,
                allocation: 'may-exist', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                machineSetup: { state: 'pending' as const },
            },
            presetContent: projectManagedMachinePresetForRecipientV1({
                content: snapshotContent, recipients: sealed.recipients, recipientAccountId: 'owner',
            }),
        };
        harness.answer(serverId, '/v1/machines/managed/actions/get', { body: read });
        const actionAccount = await captureLazyActionAccountContext(serverId);
        onTestFinished(() => actionAccount.dispose());
        const { createUiManagedMachineWakeReads } = await import('@/sync/ops/actions/managedMachineWakePreparation');
        const opened = await createUiManagedMachineWakeReads(actionAccount).readManagedMachine({
            homeId: 'srv_managed_row_projection', managedId: 'managed-row',
        }, { surface: 'ui', authority: 'present_user' });
        if (!opened || 'ok' in opened) throw new Error('Expected the captured wake reader to open its exact snapshot');
        const result = [opened];

        expect(result).toEqual([expect.objectContaining({
            id: 'managed-row', launch: expect.objectContaining({ name: 'Guest' }),
            preset: { id: 'managed-row-preset', revision: 4, contentEncryptionMode: 'e2ee' },
            reviewedFacts: expect.objectContaining({ retention: { kind: 'until-delete' } }),
            machineSetup: expect.objectContaining({ state: 'pending', setup }),
            resource: nativeResult.resource,
            observation,
        })]);
        expect(Object.keys(result[0]!)).not.toContain('recipientProjection');
        expect(JSON.stringify(result[0]!)).not.toContain('encryptedDataKey');
        const retained = readManagedMachineReadForSnapshot(result[0]!);
        expect(retained).toEqual(read);
        expect(readManagedMachineReadForSnapshot({ ...result[0]! })).toBeUndefined();
        const { ManagedMachineReadV1Schema } = await import('@happier-dev/protocol/machines/managed/actionsV1');
        expect(ManagedMachineReadV1Schema.safeParse(retained).success).toBe(true);
        const resize = await prepareManagedMachinePresetResizeOverrideForSnapshot({ serverId, accountId: 'owner' },
            result[0]!, { cpuCores: 8 });
        expect(resize).toMatchObject({ kind: 'ready', override: { content: { t: 'encrypted' } } });
        expect(resize.kind === 'ready' ? resize.override : {}).not.toHaveProperty('size');
        expect(harness.requests.filter(request => request.path.startsWith('/v1/machines/presets/'))).toEqual([]);
    });
});
