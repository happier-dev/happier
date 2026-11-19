import fastify from 'fastify';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createAccountScopedCryptoMaterialSnapshotV1, resolveAccountContentSecretKey } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { projectManagedMachinePresetForRecipientV1, transitionManagedMachinePresetContentEncryptionModeV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { createManagedMachinePresetPreparationBindingV1 } from '@happier-dev/cli-common/machines/managed';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { bindPresentUserActionConfirmationV1 } from '@happier-dev/protocol/actions/executor/approvalReview';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { configuration } from '@/configuration';
import { writeDaemonState } from '@/persistence';
import { libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { PLUGIN_MANIFEST as LIMA } from '../../../../../packages/plugins/machine-lima/src/manifest';
import { PLUGIN_MANIFEST as DAYTONA } from '../../../../../packages/plugins/machine-daytona/src/manifest';
import { resolveManagedControlControllerTarget, requiresManagedMachineDaemonIngress } from './reconcileExternalActionTarget';

it.each(['plain', 'e2ee'] as const)('places only retained host-image Archive on its original executor (%s)', async mode => {
    const app = fastify();
    const accountId = 'archive-owner';
    const serverHttpBaseUrl = 'http://archive-placement.test';
    const secret = new Uint8Array(32).fill(7);
    const crypto = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`,
        encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret }, credentialProvenance: 'stored_session' as const };
    const provider = { pluginId: LIMA.id, localId: LIMA.contributes.machineProvisioners[0]!.id };
    const launch = { provider, schemaVersion: 1, name: 'Retained image', choices: { store: '/private/lima' } };
    const authoredContent = { v: 1 as const, name: 'Retained image', launch, preparation: { enabled: true } };
    let preset = ManagedMachinePresetV1Schema.parse({ id: 'archive-preset', homeId: 'srv_home', revision: 5,
        owner: { kind: 'account', accountId }, contentEncryptionMode: 'plain', recipients: [], content: { t: 'plain', v: {
            ...authoredContent, prepared: { operationId: 'f7147172-bc62-48d6-9a89-a25a064e2993', status: 'cancelled',
                artifact: { contributionRef: provider, schemaVersion: 1, value: { operationId: 'original-build' } },
                binding: createManagedMachinePresetPreparationBindingV1({ content: authoredContent, cliIdentity: 'original-cli',
                    credentialConfigurations: [], machineId: 'original-prepare-host' }) },
        } } });
    let revokedAt: number | null = null;
    await registerAuthoredAccountActionRelease(app, accountId, { includeBundledPluginIds: [LIMA.id], primary: {
        manifest: DAYTONA, projectRoot: resolve(import.meta.dirname, '../../../../../packages/plugins/machine-daytona'),
        entryPath: resolve(import.meta.dirname, '../../../../../packages/plugins/machine-daytona/src/manifest.ts'),
        manifestExport: 'PLUGIN_MANIFEST', activateExport: 'activateAccount',
    } });
    app.get('/v1/account/encryption/currentness', async () => ({ mode, version: 1, settingsVersion: 1, signingKeyFingerprint: null,
        contentKeyFingerprint: mode === 'plain' ? null : convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(crypto.contentPublicKeyFingerprint), updatedAt: 1 }));
    app.post('/v1/machines/presets/get', async () => ({ kind: 'found', preset }));
    app.post('/v1/machines/presets/update', async request => {
        const body = request.body as { patch: { content: typeof preset.content; recipients: typeof preset.recipients } };
        preset = { ...preset, ...body.patch, revision: preset.revision + 1 };
        return { kind: 'saved', preset };
    });
    app.post('/v1/machines/read-batch', async () => ({ results: [{ machineId: 'original-prepare-host', status: 'found', machine: {
        id: 'original-prepare-host', managedMachineRef: null, active: true, revokedAt, replacedByMachineId: null,
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    } }] }));
    const restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
    const select = () => resolveManagedControlControllerTarget({ actionId: 'machines.presets.archive',
        rawInput: { homeId: preset.homeId, id: preset.id, expectedRevision: 5 }, credentials, serverHttpBaseUrl });
    const encodeMode = () => {
        if (mode === 'plain') return;
        const sealed = transitionManagedMachinePresetContentEncryptionModeV1({ presetId: preset.id, fromMode: 'plain', toMode: 'e2ee',
            source: projectManagedMachinePresetForRecipientV1({ ...preset, recipientAccountId: accountId }), accountId,
            targetContentPublicKey: libsodiumPublicKeyFromSecretKey(resolveAccountContentSecretKey(crypto.material)), randomBytes });
        if (!sealed) throw new Error('Expected fixture encryption');
        preset = { ...preset, ...sealed, contentEncryptionMode: 'e2ee' };
    };
    try {
        const plain = preset;
        encodeMode();
        const target = await select();
        expect(target).toEqual({ kind: 'machine', machineId: 'original-prepare-host' });
        expect(requiresManagedMachineDaemonIngress('machines.presets.archive', 'account', target)).toBe(true);
        if (mode === 'plain') await withConfiguredDaemonTestHome({ prefix: 'retained-archive-root-' }, async () => {
            const roots: unknown[] = [];
            // Local daemon HTTP is the process boundary. Every requester-side
            // placement, policy, private opening and native child issuer stays real.
            const daemon = createServer(async (request, response) => {
                response.setHeader('content-type', 'application/json');
                if (request.url === '/ping') { response.end(JSON.stringify({ status: 'ok' })); return; }
                const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
                roots.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                response.end(JSON.stringify({ ok: false, errorCode: 'receiver_witness', error: 'receiver_witness' }));
            });
            daemon.listen(0, '127.0.0.1'); await once(daemon, 'listening');
            const address = daemon.address();
            if (!address || typeof address === 'string') throw new Error('Expected daemon port');
            writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture', machineId: 'original-prepare-host', accountId });
            try {
                const input = { homeId: preset.homeId, id: preset.id, expectedRevision: 5 };
                const executor = createCliActionExecutorFromCredentials({ credentials, serverId: configuration.activeServerId,
                    serverIdentityId: preset.homeId, serverApiUrl: serverHttpBaseUrl, machineId: 'original-prepare-host',
                    actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
                const result = await executor.execute('machines.presets.archive', input,
                    bindPresentUserActionConfirmationV1('machines.presets.archive', input, { surface: 'cli', authority: 'present_user',
                        actionCaller: { kind: 'host' }, actionRequestId: 'archive-root', runtimeAccountId: accountId,
                        serverId: configuration.activeServerId, serverIdentityId: preset.homeId }));
                expect({ roots, result }).toMatchObject({ roots: [{ actionId: 'machines.presets.archive', input,
                    target: { kind: 'machine', machineId: 'original-prepare-host' } }],
                    result: { ok: false, errorCode: 'receiver_witness' } });
            } finally { daemon.closeAllConnections(); await new Promise<void>(done => daemon.close(() => done())); }
        });
        // Permanent host loss already permits metadata Archive with retained cleanup diagnostics.
        revokedAt = 123;
        expect(await select()).toBeNull();
        revokedAt = null;
        // Account providers can retain a historical build Machine without owning a native host image.
        const cloudProvider = { pluginId: DAYTONA.id, localId: DAYTONA.contributes.machineProvisioners[0]!.id };
        const cloudLaunch = { ...launch, provider: cloudProvider };
        const cloudContent = { ...authoredContent, launch: cloudLaunch };
        preset = ManagedMachinePresetV1Schema.parse({ ...plain, content: { t: 'plain', v: { ...cloudContent,
            prepared: { operationId: 'cloud-build', status: 'ready',
                artifact: { contributionRef: cloudProvider, schemaVersion: 1, value: { snapshotId: 'cloud-image' } },
                binding: createManagedMachinePresetPreparationBindingV1({ content: cloudContent, cliIdentity: 'original-cli',
                    credentialConfigurations: [], machineId: 'original-prepare-host' }) } } } });
        encodeMode();
        expect(await select()).toBeNull();
        preset = ManagedMachinePresetV1Schema.parse({ ...plain, content: { t: 'plain', v: { v: 1, name: 'Metadata only', setup: {} } } });
        encodeMode();
        expect(await select()).toBeNull();
    } finally { restore(); await app.close(); }
});
