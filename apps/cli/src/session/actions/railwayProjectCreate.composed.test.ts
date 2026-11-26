import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import * as undici from 'undici';
import { expect, it, onTestFailed, vi } from 'vitest';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { prepareAccountSettingsV2Content } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { PLUGIN_MANIFEST as railway } from '../../../../../packages/plugins/deploy-railway/src/manifest';
import { PLUGIN_MANIFEST as railwayMachine } from '../../../../../packages/plugins/machine-railway/src/manifest';
import { createCliActionExecutor } from './createCliActionExecutor';
import { ensureCliActionPolicySettings } from './ensureCliActionPolicySettings';
import { registerActionHttpBodyBoundary } from './widgetApproval.testkit';

vi.mock('undici', async importOriginal => {
    const real = await importOriginal<typeof import('undici')>();
    return { ...real, fetch: vi.fn(real.fetch) };
});

it('returns the named Railway project and production environment through the encrypted Account Action executor', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'railway-scope-action-'));
    const app = fastify();
    const homeRequests: string[] = [];
    app.addHook('onResponse', async (request, reply) => {
        homeRequests.push(`${request.method} ${request.url.split('?')[0]} ${reply.statusCode}`);
    });
    onTestFailed(() => console.info({ homeRequests }));
    const serverId = 'srv_railway_fixture';
    const machineId = 'railway-controller';
    const accountId = 'railway-owner';
    let serverHttpBaseUrl = '';
    const keys = tweetnacl.box.keyPair();
    const material = { type: 'dataKey' as const, machineKey: keys.secretKey, publicKey: keys.publicKey };
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0, provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const credentials = { token, encryption: material, credentialProvenance: 'stored_session' as const };
    const action = { pluginId: railway.id, localId: 'project-create' };
    const credentialRef = { service: { pluginId: railwayMachine.id, localId: 'railway-account' }, accountId: 'railway-connection' };
    const features = { features: { connectedServices: { enabled: true } },
        capabilities: { serverIdentity: { serverIdentityId: serverId }, connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } };
    const packages = resolve(import.meta.dirname, '../../../../../packages/plugins');
    const realFetch = globalThis.fetch;
    try {
        registerActionHttpBodyBoundary(app);
        const release = await registerAuthoredAccountActionRelease(app, accountId, { encryptionMode: 'e2ee',
            primary: { manifest: railway, projectRoot: join(packages, 'deploy-railway'),
                entryPath: join(packages, 'deploy-railway/src/accountRuntime.ts'), manifestExport: null },
            additional: [{ manifest: railwayMachine, projectRoot: join(packages, 'machine-railway'),
                entryPath: join(packages, 'machine-railway/src/manifest.ts'), manifestExport: null }],
        });
        const settings = prepareAccountSettingsV2Content({ credentials, raw: {}, envelopeKind: 'encrypted' });
        app.get('/v1/features', async () => features);
        app.get('/v1/features/authenticated', async () => features);
        app.get('/v1/account/profile', async () => ({ id: accountId }));
        app.get('/v1/account/encryption', async () => ({ mode: 'e2ee', updatedAt: 1 }));
        app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({
            mode: 'e2ee', version: 1, updatedAt: 1, contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(keys.publicKey),
        }));
        app.get('/v2/account/settings', async () => ({ content: settings, version: 1 }));
        const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
        app.get('/v4/connect/qualified/accounts', async () => ({ service: credentialRef.service, accounts: [{
            ref: credentialRef, status: 'connected', authenticationModeId: 'token', revisionSemantics: 'revisioned',
            credentialRevision: revision, configurationReady: true, configurationRevision: null,
            kind: 'token', expiresAt: null, displayName: 'Railway test connection', scopes: [],
        }] }));
        app.get('/v4/connect/qualified/credential', async () => ({ ref: credentialRef, authenticationModeId: 'token',
            revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: null, metadata: { scopes: [] },
            content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee', material,
                payload: { v: 1, values: { token: 'fixture-railway-credential' } }, randomBytes: tweetnacl.randomBytes }),
        }));
        serverHttpBaseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => release.publishArtifacts(credentials));

        const writes: unknown[] = [];
        const railwayFetch: typeof fetch = async (url, init) => {
            expect(String(url)).toBe('https://backboard.railway.com/graphql/v2');
            expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-railway-credential');
            const wire = JSON.parse(await new Response(init?.body).text());
            const workspace = { id: 'workshop', name: 'Workshop' };
            const data = wire.query.includes('workspaces')
                ? { me: { workspaces: [workspace] }, externalWorkspaces: [] }
                : (() => {
                    expect(wire.query).toContain('projectCreate');
                    writes.push(wire.variables);
                    return { projectCreate: { id: 'orders-project', name: 'Order processing', workspaceId: workspace.id,
                        baseEnvironment: null, environments: { edges: [{ node: { id: 'default-environment', name: 'production' } }] } } };
                })();
            return new undici.Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
        };

        vi.stubGlobal('fetch', ((url, init) => String(url) === 'https://backboard.railway.com/graphql/v2'
            ? railwayFetch(url, init) : realFetch(url, init)) satisfies typeof fetch);
        const realUndici = await vi.importActual<typeof undici>('undici');
        vi.mocked(undici.fetch).mockImplementation((url, init) => String(url) === 'https://backboard.railway.com/graphql/v2'
            ? railwayFetch(url as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1]) as ReturnType<typeof undici.fetch>
            : realUndici.fetch(url, init));
        const executor = createCliActionExecutor({
            token, credentials, happyHomeDir, sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId, serverIdentityId: serverId, serverHttpBaseUrl, runtimeActionMachineId: machineId,
            accountPluginActions: true, pluginActionExecutionOwner: 'current_process',
        });
        const input = { action, input: { name: 'Order processing', workspaceId: 'workshop', credentialRef,
            credentialPrincipal: { kind: 'account', accountId, purpose: { consumer: action, purpose: 'cloud-api' },
                target: { kind: 'account', account: credentialRef } } } };
        const result = await runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
            await ensureCliActionPolicySettings(credentials, serverHttpBaseUrl);
            // Exercise the credentialed production host's post-approval settlement.
            return executor.execute(ACTION_INVOKE_ACTION_ID_V1, input, { surface: 'cli', bypassApprovals: true });
        });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
            project: { id: 'orders-project', name: 'Order processing' }, environment: { id: 'default-environment', name: 'production' },
        } });
        expect(writes).toEqual([{ input: { name: 'Order processing', workspaceId: 'workshop' } }]);
    } finally {
        vi.unstubAllGlobals();
        await app.close();
        resetActiveAccountSettingsSnapshotForTests();
        vi.mocked(undici.fetch).mockReset();
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});
