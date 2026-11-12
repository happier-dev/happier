import fastify from 'fastify';
import * as undici from 'undici';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AccountSettingsSchema, normalizeActionsSettingsV1, QualifiedConnectedAccountCredentialSnapshotV4Schema,
    QualifiedConnectedAccountConfigurationSnapshotV4Schema, QualifiedConnectedAccountProfileV4Schema,
    QualifiedConnectedAccountCredentialHealthPatchV4Schema, QualifiedConnectedAccountCredentialMutationSuccessV4Schema } from '@happier-dev/protocol';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createAccountServerActionDeps } from './accountServerActionDeps';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { withTempDir } from '@/testkit/fs/tempDir';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
    resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { PLUGIN_MANIFEST } from '../../../../packages/plugins/machine-vercel/src/manifest';

// Portable Account HTTP uses the native Undici adapter; feature discovery uses fetch.
vi.mock('undici', async importOriginal => ({ ...await importOriginal<typeof import('undici')>(), fetch: vi.fn() }));

// Original CLI preparation, portable public author/runtime, credential owner,
// power engine and report stay real. Only Home/vendor HTTP and temp OS custody vary.
it.each(['custodian', 'noncustodian'] as const)(
    'uses canonical Home power authority through the default CLI Action without a Machine or supplied child port (%s)', async actor => {
    await withTempDir('cli-account-power-composed-', async happyHomeDir => {
        const app = fastify();
        const accountId = 'power-owner';
        const actorAccountId = actor === 'custodian' ? accountId : 'other-account';
        const homeId = 'srv_cli_account_power';
        const serverHttpBaseUrl = 'http://cli-account-power.test';
        const token = `e30.${Buffer.from(JSON.stringify({ sub: actorAccountId })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
        const policy = normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.managed.power.set': ['cli'] } });
        const settings = AccountSettingsSchema.parse({ actionsSettingsV1: policy });
        setActiveAccountSettingsSnapshot({ source: 'network', settings, settingsVersion: 1, loadedAtMs: 1,
            settingsSecretsReadKeys: [], scopeKey: runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKeyForToken(token)) });
        const authored = await registerAuthoredAccountActionRelease(app, actorAccountId, { primary: {
            manifest: PLUGIN_MANIFEST, projectRoot: resolve(import.meta.dirname, '../../../../packages/plugins/machine-vercel'),
            entryPath: resolve(import.meta.dirname, '../../../../packages/plugins/machine-vercel/src/manifest.ts'),
            manifestExport: 'PLUGIN_MANIFEST', activateExport: 'activateAccount',
        } });
        const provisioner = authored.manifest.contributes.machineProvisioners[0]!;
        const provider = { pluginId: authored.pluginId, localId: provisioner.id };
        const selected = { service: { pluginId: authored.pluginId, localId: 'vercel-account' }, accountId: 'selected-account' };
        const secret = 'private-cli-selected-token';
        const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
        const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: selected, status: 'connected', authenticationModeId: 'token',
            revisionSemantics: 'revisioned', credentialRevision: revision, configurationReady: true,
            configurationRevision: 'selected-config', displayName: 'Selected', scopes: [] });
        const seal = (kind: 'credential' | 'configuration', payload: Parameters<typeof sealQualifiedConnectedAccountContentEnvelope>[0]['payload']) => sealQualifiedConnectedAccountContentEnvelope({
            kind, accountMode: 'plain', payload, randomBytes: length => new Uint8Array(length),
        });
        let credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: selected, authenticationModeId: 'token',
            revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: 'selected-config',
            content: seal('credential', { v: 1, values: { token: secret } }), metadata: { scopes: [] } });
        const configuration = QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({ target: { kind: 'account', ref: selected },
            authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision: revision,
            configurationRevision: 'selected-config', configurationContent: seal('configuration', {
                values: { teamId: 'team_one', projectId: 'prj_one' }, secretRefs: {},
            }) });
        const resource = { name: 'happier-retained', managedId: 'retained', createdAt: 1000, teamId: 'team_one', projectId: 'prj_one' };
        const launch = { provider, schemaVersion: 1, name: 'Retained', choices: { image: 'vercel/sandbox/universal:latest', region: 'iad1',
            vcpus: 2, timeoutMs: 300000, snapshotExpirationMs: 0 }, credentials: [{
            purpose: { consumer: provider, purpose: 'cloud-api' },
            account: selected,
        }] };
        let machine = ManagedMachineV1Schema.parse({ id: resource.managedId, homeId, custodianAccountId: accountId,
            launch: { ...launch, credentials: launch.credentials.map(selection => ({ ...selection, configurationRevision: 'selected-config' })) },
            allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 2,
            resource: { contributionRef: provider, schemaVersion: 1, value: resource }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
                retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' },
        });
        let machineReads = 0;
        let admissions = 0;
        let submissions = 0;
        let reports = 0;
        const readAccounts: string[] = [];
        app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
        app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, settingsVersion: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
        app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: settings }, version: 1 }));
        app.get('/v4/connect/qualified/accounts', async () => ({ service: selected.service, accounts: [profile] }));
        app.get('/v4/connect/qualified/credential', async request => {
            const ref = JSON.parse(new URL(request.url, serverHttpBaseUrl).searchParams.get('ref') ?? 'null');
            readAccounts.push(ref?.accountId);
            expect(ref).toEqual(selected);
            return credential;
        });
        app.get('/v4/connect/qualified/configuration', async () => configuration);
        app.patch('/v4/connect/qualified/credential/health', async request => {
            const patch = QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse(request.body);
            expect(patch.ref).toEqual(selected);
            expect(patch.expectedCredentialRevision).toBe(credential.credentialRevision);
            expect(patch.expectedConfigurationRevision).toBe(credential.configurationRevision);
            credential = { ...credential, health: patch.health };
            return QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse({ success: true,
                credentialRevision: credential.credentialRevision, configurationRevision: credential.configurationRevision });
        });
        app.post('/v1/machines/managed/actions/get', async (_request, reply) => {
            machineReads++;
            return actor === 'noncustodian' ? reply.code(403).send({ code: 'permission_denied' }) : machine;
        });
        app.post('/v1/machines/managed/controller/admit-control', async (request, reply) => {
            expect(request.body).toMatchObject({ action: 'machines.managed.power.set', requestId: 'original-default-power',
                input: { homeId, managedId: machine.id, expectedRevision: 2, intent: 'start', when: 'now' } });
            admissions++;
            if (actor === 'noncustodian') return reply.code(403).send({ code: 'managed_power_required' });
            machine = { ...machine, desired: 'start', intentRevision: 3 };
            return { machine, replayed: false };
        });
        app.post('/v1/machines/managed/controller/submit-intent', async () => { submissions++; return { machine, submitted: true }; });
        app.post('/v1/machines/managed/controller/report-intent', async request => {
            expect(request.body).toMatchObject({ requestId: 'original-default-power', expectedIntentRevision: 3,
                result: { kind: 'confirmed' }, observation: { availability: 'present', power: 'running', storage: 'retained' } });
            reports++;
            return { machine };
        });
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
        let running = false;
        let resumes = 0;
        const vendorHeaders: string[] = [];
        const session = { id: 'sbx_one', sourceSandboxName: resource.name, projectId: resource.projectId, createdAt: resource.createdAt };
        const fixtureFetch = vi.fn<typeof fetch>(async (url, init) => {
            const address = new URL(String(url));
            if (address.origin !== 'https://api.vercel.com') {
                expect(address.origin).toBe(serverHttpBaseUrl);
                expect(address.pathname).toBe('/features');
                return Response.json({ features: { connectedServices: { enabled: true } },
                    capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } });
            }
            vendorHeaders.push(new Headers(init?.headers).get('authorization') ?? '');
            if (address.searchParams.get('resume') === 'true') { resumes++; running = true; }
            if (address.pathname.endsWith('/logs')) return new Response('', { headers: { 'content-type': 'application/x-ndjson' } });
            if (address.pathname.includes('/cmd')) return Response.json({ command: { id: 'cmd_one', sessionId: session.id, exitCode: 0 } });
            if (address.pathname.includes('/snapshots/')) return Response.json({ snapshot: { id: 'snap_one', sourceSessionId: session.id,
                status: 'created', createdAt: 1000 } });
            expect(address.pathname).toBe(`/v2/sandboxes/${resource.name}`);
            return Response.json({ sandbox: { name: resource.name, createdAt: resource.createdAt,
                tags: { 'happier-managed-id': machine.id }, persistent: true, status: running ? 'running' : 'stopped',
                currentSessionId: session.id, ...(!running ? { currentSnapshotId: 'snap_one' } : {}) }, session });
        });
        vi.stubGlobal('fetch', fixtureFetch);
        vi.mocked(undici.fetch).mockImplementation(async (url, init) => {
            const response = await fixtureFetch(String(url), { method: init?.method,
                headers: [...new undici.Headers(init?.headers)] });
            return new undici.Response(await response.arrayBuffer(), { status: response.status,
                headers: [...response.headers] });
        });
        try {
            const snapshot = getActiveAccountSettingsSnapshot()!;
            const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
            // The public credential executor captures this same admitted Account
            // context before constructing its private CLI executor.
            const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot, serverHttpBaseUrl,
                isCurrent: async () => lifetime === getActiveAccountSettingsSnapshotLifetimeToken() });
            const cli = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createCliActionExecutor({
                token, credentials, happyHomeDir, savedSecretOperationContext, sessionId: 'cli-global', mode: 'plain', ctx: null,
                serverId: 'route-home', serverIdentityId: homeId, serverHttpBaseUrl,
                accountServerActionDeps: createAccountServerActionDeps({ token, credentials,
                    serverId: 'route-home', serverIdentityId: homeId, serverHttpBaseUrl }),
            }));
            const result = await cli.execute('machines.managed.power.set', { homeId, managedId: machine.id, expectedRevision: 2,
                intent: 'start', when: 'now' }, { surface: 'cli', authority: 'present_user', actionsSettings: policy,
                actionRequestId: 'original-default-power' });
            if (actor === 'noncustodian') {
                expect(result).toMatchObject({ ok: false, errorCode: 'managed_power_required' });
                expect(machineReads).toBe(1);
                expect(admissions).toBe(1);
                expect([submissions, reports, resumes]).toEqual([0, 0, 0]);
                expect(readAccounts).toEqual([]);
                expect(vendorHeaders).toEqual([]);
                return;
            }
            expect(result, JSON.stringify({ result, machineReads, admissions, submissions, reports, resumes })).toMatchObject({
                ok: true, result: { kind: 'accepted', managedId: machine.id, intentRevision: 3 },
            });
            expect(machineReads).toBe(1);
            expect(admissions).toBe(1);
            expect(submissions).toBe(1);
            expect(reports).toBe(1);
            expect(resumes).toBe(1);
            expect(vendorHeaders.length).toBeGreaterThan(0);
            expect(vendorHeaders.every(header => header === `Bearer ${secret}`)).toBe(true);
            expect(readAccounts.length).toBeGreaterThan(0);
            expect(readAccounts.every(account => account === selected.accountId)).toBe(true);
            expect(JSON.stringify(result)).not.toContain(secret);
        } finally {
            restore(); await app.close(); vi.mocked(undici.fetch).mockReset(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests();
        }
    });
});
