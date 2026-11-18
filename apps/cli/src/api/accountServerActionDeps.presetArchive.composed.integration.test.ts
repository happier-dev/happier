import fastify from 'fastify';
import { enableExternalActionHttpBody } from '../../../server/sources/app/api/utils/externalActionHttpBody';
import tweetnacl from 'tweetnacl';
import * as undici from 'undici';
import { resolve } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { AccountSettingsSchema, normalizeActionsSettingsV1, QualifiedConnectedAccountCredentialSnapshotV4Schema,
    QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { openManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { createManagedMachinePresetPreparationBindingV1, readManagedMachinePresetPreparationV1 } from '@happier-dev/cli-common/machines/managed';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createAccountServerActionDeps } from './accountServerActionDeps';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { withTempDir } from '@/testkit/fs/tempDir';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
    resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { PLUGIN_MANIFEST } from '../../../../packages/plugins/machine-daytona/src/manifest';
import { PLUGIN_MANIFEST as LIMA_MANIFEST } from '../../../../packages/plugins/machine-lima/src/manifest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';

// Home/vendor HTTP and temporary filesystem custody are the genuine boundaries.
// The original Action, review, Account selection, provider and private CAS stay real.
vi.mock('undici', async importOriginal => ({ ...await importOriginal<typeof import('undici')>(), fetch: vi.fn() }));

it.each([
    { prepared: true, refuseFirstDelete: false, hostState: undefined },
    { prepared: false, refuseFirstDelete: false, hostState: undefined },
    { prepared: true, refuseFirstDelete: true, hostState: undefined },
    ...(['ready-context', 'ready', 'member-ready', 'team-member-ready', 'wrong-host', 'revoked', 'replaced', 'offline', 'not_found', 'abort'] as const).map(hostState => ({
        prepared: true, refuseFirstDelete: false, hostState,
    })),
])('archives after native cleanup or confirmed permanent host loss and restores cold ($prepared/$refuseFirstDelete/$hostState)', async ({ prepared, refuseFirstDelete, hostState }) => {
    const machineNative = hostState !== undefined;
    const member = hostState === 'member-ready' || hostState === 'team-member-ready';
    const onInstalledHost = hostState === 'ready-context' || hostState === 'ready' || member || hostState === 'wrong-host';
    const permanentlyGone = hostState === 'revoked' || hostState === 'replaced';
    const controller = new AbortController();
    onTestFinished(() => controller.abort());
    await withTempDir('cli-preset-archive-composed-', async happyHomeDir => {
        const app = fastify();
        enableExternalActionHttpBody(app);
        const accountId = 'archive-owner';
        const homeId = 'srv_cli_preset_archive';
        const serverHttpBaseUrl = 'http://cli-preset-archive.test';
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const installationKeys = tweetnacl.sign.keyPair();
        const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
        const policy = normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: {
            'machines.presets.archive': ['cli', 'ui'], 'machines.presets.restore': ['cli', 'ui'],
        } });
        const settings = AccountSettingsSchema.parse({ actionsSettingsV1: policy });
        setActiveAccountSettingsSnapshot({ source: 'network', settings, settingsVersion: 1, loadedAtMs: 1,
            settingsSecretsReadKeys: [], scopeKey: runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKeyForToken(token)) });
        const authored = await registerAuthoredAccountActionRelease(app, accountId, { includeBundledPluginIds: [LIMA_MANIFEST.id], ...(machineNative ? {} : { primary: {
            manifest: PLUGIN_MANIFEST, projectRoot: resolve(import.meta.dirname, '../../../../packages/plugins/machine-daytona'),
            entryPath: resolve(import.meta.dirname, '../../../../packages/plugins/machine-daytona/src/manifest.ts'),
            manifestExport: 'PLUGIN_MANIFEST', activateExport: 'activateAccount',
        } }) });
        const provider = machineNative ? { pluginId: LIMA_MANIFEST.id, localId: LIMA_MANIFEST.contributes.machineProvisioners[0]!.id }
            : { pluginId: authored.pluginId, localId: authored.manifest.contributes.machineProvisioners[0]!.id };
        const selected = { service: { pluginId: authored.pluginId, localId: 'daytona-account' }, accountId: 'selected' };
        const secret = 'private-archive-api-key';
        const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
        const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: selected, status: 'connected', authenticationModeId: 'token',
            revisionSemantics: 'revisioned', credentialRevision: revision, configurationReady: true,
            configurationRevision: null, displayName: 'Selected', scopes: [] });
        const seal = (kind: 'credential' | 'configuration', payload: Parameters<typeof sealQualifiedConnectedAccountContentEnvelope>[0]['payload']) =>
            sealQualifiedConnectedAccountContentEnvelope({ kind, accountMode: 'plain', payload, randomBytes: length => new Uint8Array(length) });
        const credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: selected, authenticationModeId: 'token',
            revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: null,
            content: seal('credential', { v: 1, values: { token: secret } }), metadata: { scopes: [] } });
        const limaChoices = { store: '/private/lima', image: 'private-image', arch: 'aarch64', vmType: 'vz',
            cpus: 2, memoryGiB: 4, diskGiB: 16, mounts: [] };
        const launch = { provider, schemaVersion: 1, name: 'Private archive base',
            choices: machineNative ? limaChoices : { snapshot: 'original-base' },
            credentials: machineNative ? [] : [{ purpose: { consumer: provider, purpose: 'cloud-api' }, account: selected }] };
        const credentialConfigurations = machineNative ? [] : [{ account: selected, revision: null }];
        const content = { v: 1 as const, name: 'Private preset', launch, preparation: { enabled: true } };
        const artifact = { contributionRef: provider, schemaVersion: 1, value: machineNative ? {
            operationId: 'original-build', launch: { ...limaChoices, preparedBase: { operationId: 'original-build' } },
        } : {
            snapshotId: 'owned-image', name: 'happier-prepared-original-build', organizationId: 'organization', launch: { snapshot: 'owned-image' },
        } };
        let preset = ManagedMachinePresetV1Schema.parse({ id: 'archive-preset', homeId, revision: 1,
            owner: hostState === 'team-member-ready' ? { kind: 'team', teamId: 'managed-team' }
                : { kind: 'account', accountId: member ? 'archive-member' : accountId }, contentEncryptionMode: 'plain', recipients: [],
            content: { t: 'plain', v: { ...content, ...(prepared ? { prepared: { operationId: 'original-build', status: 'ready', artifact,
                cliBinaryPath: '/opt/happier/bin/happier', binding: createManagedMachinePresetPreparationBindingV1({
                    content, cliIdentity: 'original-cli', credentialConfigurations,
                    machineId: 'original-prepare-host' }) } } : {}) } } });
        let nativePresent = prepared;
        let refuseDelete = refuseFirstDelete;
        const nativePresenceAtArchive: boolean[] = [];
        const vendorMethods: string[] = [];
        const supplierRequests: string[] = [];
        const homeRequests: string[] = [];
        const hostAvailabilityRequests: string[] = [];
        app.addHook('onRequest', async request => { homeRequests.push(`${request.method} ${request.url.split('?')[0]}`); });
        app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
        app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, settingsVersion: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
        app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: settings }, version: 1 }));
        app.get('/v4/connect/qualified/accounts', async () => ({ service: selected.service, accounts: [profile] }));
        app.get('/v4/connect/qualified/credential', async () => credential);
        // Daytona's token mode has no configuration sidecar; an invented Account
        // configuration is rejected by the real established-runtime owner.
        app.get('/v4/connect/qualified/configuration', async (_request, reply) => reply.code(404).send());
        app.patch('/v4/connect/qualified/credential/health', async () => ({ success: true,
            credentialRevision: revision, configurationRevision: null }));
        app.post('/v1/machines/presets/get', async () => ({ kind: 'found', preset }));
        app.get('/v1/machines/original-prepare-host', async () => ({ machine: { id: 'original-prepare-host',
            managedMachineRef: null, active: true, revokedAt: null, replacedByMachineId: null,
            access: { custodian: { accountId, displayName: 'Published Custodian' }, role: 'use',
                resourceMode: 'plain', accessState: 'ready' },
            metadata: JSON.stringify({ host: 'owner-private-host-secret', credential: 'owner-private-credential-secret' }),
        } }));
        app.post('/v1/machines/read-batch', async request => {
            const body = request.body as { machineIds: string[] };
            expect(body.machineIds).toEqual(['original-prepare-host']);
            hostAvailabilityRequests.push(...body.machineIds);
            if (hostState === 'abort') controller.abort();
            if (hostState === 'not_found') return { results: [{ machineId: 'original-prepare-host', status: 'not_found' }] };
            return { results: [{ machineId: 'original-prepare-host', status: 'found', machine: {
                id: 'original-prepare-host', managedMachineRef: null, active: onInstalledHost,
                revokedAt: hostState === 'revoked' ? 123 : null, replacedByMachineId: hostState === 'replaced' ? 'new-host' : null,
                metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
            } }] };
        });
        app.post('/v1/machines/presets/update', async (request, reply) => {
            const body = request.body as { expectedRevision: number; patch: { content: typeof preset.content; recipients: typeof preset.recipients } };
            if (body.expectedRevision !== preset.revision) return reply.code(409).send({ kind: 'conflict', currentRevision: preset.revision });
            preset = { ...preset, ...body.patch, revision: preset.revision + 1 };
            return { kind: 'saved', preset };
        });
        for (const verb of ['archive', 'restore'] as const) app.post(`/v1/machines/presets/${verb}`, async (request, reply) => {
            const body = request.body as { expectedRevision: number };
            if (body.expectedRevision !== preset.revision) return reply.code(409).send({ kind: 'conflict', currentRevision: preset.revision });
            if (verb === 'archive') nativePresenceAtArchive.push(nativePresent);
            const { archivedAt: _archived, ...active } = preset;
            preset = { ...active, revision: preset.revision + 1, ...(verb === 'archive' ? { archivedAt: 100 } : {}) };
            return { kind: 'saved', preset };
        });
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
        const fixtureFetch = vi.fn<typeof fetch>(async (url, init) => {
            const address = new URL(String(url));
            if (address.origin === serverHttpBaseUrl && address.pathname === '/features') return Response.json({
                features: { connectedServices: { enabled: true }, machines: { enabled: true, managed: { enabled: true } } },
                capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } });
            if (address.origin !== 'https://app.daytona.io') {
                supplierRequests.push(address.href);
                throw new Error('Archive and Restore must not request CLI build assets');
            }
            expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`);
            const method = init?.method ?? 'GET';
            vendorMethods.push(`${method} ${address.pathname}`);
            if (address.pathname === '/api/api-keys/current') return Response.json({ name: 'Selected', organizationId: 'organization' });
            expect(address.pathname).toBe('/api/snapshots/owned-image');
            if (method === 'DELETE') {
                if (refuseDelete) return Response.json({ message: 'Delete refused' }, { status: 403 });
                nativePresent = false; return new Response(null, { status: 204 });
            }
            return nativePresent ? Response.json({ id: 'owned-image', name: 'happier-prepared-original-build', organizationId: 'organization', state: 'active' })
                : Response.json({}, { status: 404 });
        });
        vi.stubGlobal('fetch', fixtureFetch);
        vi.mocked(undici.fetch).mockImplementation(async (url, init) => {
            const response = await fixtureFetch(String(url), { method: init?.method, headers: [...new undici.Headers(init?.headers)] });
            return new undici.Response(response.body === null ? null : await response.arrayBuffer(),
                { status: response.status, headers: [...response.headers] });
        });
        try {
            const snapshot = getActiveAccountSettingsSnapshot()!;
            const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
            const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot, serverHttpBaseUrl,
                isCurrent: async () => lifetime === getActiveAccountSettingsSnapshotLifetimeToken() });
            const accountDeps = createAccountServerActionDeps({ token, credentials, serverId: 'route-home', serverIdentityId: homeId, serverHttpBaseUrl });
            const nativeRoles: string[] = [];
            const cli = onInstalledHost ? createCliActionExecutorFromCredentials({ credentials,
                ...(member ? { externalActionMachineRequestPrivateKey: installationKeys.secretKey,
                    externalActionMachineInstallationId: 'owner-installation' } : {}),
                serverId: 'route-home', serverIdentityId: homeId, serverApiUrl: serverHttpBaseUrl,
                machineId: hostState === 'wrong-host' ? 'another-controller' : 'original-prepare-host',
                actionsSettingsProvider: { getActionsSettings: () => policy },
                // The separately hosted native plugin is the boundary. Parent review,
                // retained-image placement, private content and row settlement stay real.
                invokeContributedAction: async ({ action }) => {
                    nativeRoles.push(action.localId);
                    if (action.localId === LIMA_MANIFEST.contributes.machineProvisioners[0]!.preparation!.actions.destroy) {
                        nativePresent = false;
                        return { ok: true, result: { kind: 'confirmed' } };
                    }
                    return { ok: true, result: nativePresent ? { kind: 'ready', artifact,
                        launch: artifact.value.launch } : { kind: 'absent' } };
                },
            }) : runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createCliActionExecutor({ token, credentials, happyHomeDir,
                savedSecretOperationContext, sessionId: 'cli-global', mode: 'plain', ctx: null,
                serverId: 'route-home', serverIdentityId: homeId, serverHttpBaseUrl,
                accountServerActionDeps: accountDeps }));
            const context = { surface: onInstalledHost ? 'ui' as const : 'cli' as const,
                authority: 'present_user' as const, actionsSettings: policy, signal: controller.signal,
                ...(onInstalledHost ? { externalActionTarget: { kind: 'machine' as const, machineId: 'original-prepare-host' } } : {}),
                // Positive control and forged caller identity: only host-captured identity may win.
                ...(hostState === 'ready-context' || hostState === 'wrong-host' ? { runtimeActionMachineId: 'original-prepare-host' } : {}),
                ...(member ? { runtimeAccountId: 'archive-member', serverId: 'route-home', serverIdentityId: homeId,
                    externalActionExecutionAuthorization: await projectExternalActionRequesterHttpAuthorization({
                        authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-member-archive', binding: {
                            accountId: 'archive-member', custodianAccountId: accountId, accountEncryptionMode: 'plain',
                            authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: homeId,
                            machineId: 'original-prepare-host', installationId: 'owner-installation', admittedMachineRole: 'use',
                            actionId: 'machines.presets.archive', requestId: 'original-archive',
                            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'original-archive',
                                target: { kind: 'machine', machineId: 'original-prepare-host' },
                                input: { homeId, id: preset.id, expectedRevision: 1 } }),
                            target: { kind: 'machine', machineId: 'original-prepare-host' },
                            presetPreparationAdmission: { homeId, id: preset.id, expectedRevision: 1 },
                        } }), target: { kind: 'machine', machineId: 'original-prepare-host' },
                        serverId: 'route-home', serverIdentityId: homeId, serverHttpBaseUrl,
                        installationId: 'owner-installation', privateKey: installationKeys.secretKey, rootAdmitted: true,
                    }) ?? undefined,
                } : {}),
            };
            let archived = await cli.execute('machines.presets.archive', { homeId, id: preset.id, expectedRevision: 1 },
                { ...context, actionRequestId: 'original-archive' });
            if (member) {
                expect(nativePresent, JSON.stringify({ archived, nativeRoles })).toBe(true);
                expect(archived, JSON.stringify({ archived, nativeRoles, homeRequests, preset })).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
                expect(archived).toMatchObject({ failureCause: { phase: 'machines.presets.archive',
                    nativeErrorReason: 'prepared_image_custodian_required' } });
                if (archived.ok) throw new Error('Expected Archive refusal');
                expect(archived.error).toContain('original-prepare-host');
                expect(archived.error).toContain('Published Custodian');
                expect(JSON.stringify(archived)).not.toContain('owner-private-host-secret');
                expect(JSON.stringify(archived)).not.toContain('owner-private-credential-secret');
                expect(nativeRoles).toEqual([]);
                expect(nativePresenceAtArchive).toEqual([]);
                expect(preset.archivedAt).toBeUndefined();
                return;
            }
            if (machineNative && !permanentlyGone && hostState !== 'ready' && hostState !== 'ready-context') {
                expect(archived).toMatchObject({ ok: false });
                expect(preset.archivedAt).toBeUndefined();
                expect(nativePresenceAtArchive).toEqual([]);
                expect(hostAvailabilityRequests).toEqual(['original-prepare-host']);
                expect(nativePresent).toBe(true);
                expect(openManagedMachinePresetContentV1({ presetId: preset.id, mode: 'plain', content: preset.content })?.prepared?.artifact).toEqual(artifact);
                expect(vendorMethods).toEqual([]);
                expect(supplierRequests).toEqual([]);
                if (hostState === 'wrong-host') {
                    expect(nativeRoles).toEqual([]);
                }
                if (hostState === 'abort') expect(homeRequests).not.toContain('POST /v1/machines/presets/update');
                return;
            }
            if (refuseFirstDelete) {
                expect(archived).toMatchObject({ ok: false });
                expect(vendorMethods).toContain('DELETE /api/snapshots/owned-image');
                expect(nativePresent).toBe(true);
                expect(preset.archivedAt).toBeUndefined();
                expect(nativePresenceAtArchive).toEqual([]);
                const retained = openManagedMachinePresetContentV1({ presetId: preset.id, mode: 'plain', content: preset.content });
                expect(retained?.prepared?.artifact).toEqual(artifact);
                refuseDelete = false;
                archived = await cli.execute('machines.presets.archive', { homeId, id: preset.id, expectedRevision: preset.revision },
                    { ...context, actionRequestId: 'retry-archive' });
            }
            expect(archived, JSON.stringify({ archived, vendorMethods, homeRequests, supplierRequests })).toMatchObject({ ok: true, result: { kind: 'saved', preset: { archivedAt: 100 } } });
            expect(nativePresenceAtArchive, 'Only canonical permanent host loss permits Archive with a retained image').toEqual([permanentlyGone]);
            expect(hostAvailabilityRequests).toEqual(machineNative ? ['original-prepare-host'] : []);
            const restored = await cli.execute('machines.presets.restore', { homeId, id: preset.id, expectedRevision: preset.revision },
                { ...context, actionRequestId: 'original-restore' });
            expect(restored).toMatchObject({ ok: true, result: { kind: 'saved' } });
            expect(preset.archivedAt).toBeUndefined();
            const opened = openManagedMachinePresetContentV1({ presetId: preset.id, mode: 'plain', content: preset.content });
            if (!opened) throw new Error('Expected readable retained private content');
            expect(readManagedMachinePresetPreparationV1({ content: opened,
                cliIdentity: 'original-cli', credentialConfigurations })).toMatchObject({ kind: 'cold' });
            if (permanentlyGone) expect(opened.prepared).toMatchObject({ status: 'cancelled', code: 'preparation_cleanup_required', artifact });
            expect(nativePresent).toBe(permanentlyGone);
            expect(vendorMethods.some(method => method.startsWith('DELETE '))).toBe(prepared && !permanentlyGone && !onInstalledHost);
            if (onInstalledHost) expect(nativeRoles).toContain(LIMA_MANIFEST.contributes.machineProvisioners[0]!.preparation!.actions.destroy);
            expect(supplierRequests).toEqual([]);
            expect(JSON.stringify({ archived, restored })).not.toContain(secret);
        } finally {
            restore(); await app.close(); vi.mocked(undici.fetch).mockReset(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests();
        }
    });
});
