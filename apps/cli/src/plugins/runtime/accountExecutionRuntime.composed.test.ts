import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse, FeaturesResponseSchema, QualifiedConnectedAccountRefSchema, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { parseQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { createManagedMachineAcquisitionDriver } from '@/machines/managed/acquire';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';
import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';
import { resolveAccountExecutionRuntime } from './accountExecutionRuntime';
import { PLUGIN_MANIFEST as boatManifest } from '../../../../../packages/plugins/machine-boat/src/manifest';
import { PLUGIN_MANIFEST as agent37Manifest } from '../../../../../packages/plugins/machine-agent37/src/manifest';

const vendor = vi.hoisted(() => ({ request: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>() }));
// test-policy-boundary: Undici is the third-party network transport; credential composition stays real.
vi.mock('undici', async importOriginal => ({ ...await importOriginal<typeof import('undici')>(),
    fetch: (url: string, init?: RequestInit) => vendor.request(url, init),
}));
afterEach(() => { vi.restoreAllMocks(); });

it.each([
    { name: 'Boat native-only credentials on the held Machine registry', borrowNativeRegistry: true, manifest: boatManifest, directory: 'machine-boat', serviceId: 'boat-account', provisionerId: 'boat', origin: 'https://boat.dev' },
    { name: 'Agent37 portable credentials on the held Machine registry', borrowNativeRegistry: true, manifest: agent37Manifest, directory: 'machine-agent37', serviceId: 'agent37-account', provisionerId: 'agent37', origin: 'https://api.agent37.com' },
    { name: 'Agent37 portable credentials on the default Account registry', borrowNativeRegistry: false, manifest: agent37Manifest, directory: 'machine-agent37', serviceId: 'agent37-account', provisionerId: 'agent37', origin: 'https://api.agent37.com' },
])('runs controller-bound Account checks with the selected $name', async fixture => {
    const directory = await mkdtemp(join(tmpdir(), 'account-role-credentials-'));
    const app = fastify();
    const home = 'https://account-role-credentials.test';
    const accountId = 'requester';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const account = { service: { pluginId: fixture.manifest.id, localId: fixture.serviceId }, accountId: 'selected-cloud' };
    const settings = accountSettingsParse({});
    const homeFeatures = registerAccountHomeHttp(app, { accountId, serverId: 'srv_role_credentials', settings });
    const features = FeaturesResponseSchema.parse({ ...homeFeatures, capabilities: {
        ...homeFeatures.capabilities, connectedServices: { qualifiedAccounts: { protocolVersion: 4 } },
    } });
    const projectRoot = resolve(import.meta.dirname, '../../../../../packages/plugins', fixture.directory);
    await registerAuthoredAccountActionRelease(app, accountId, { primary: {
        // Both packages export their Account artifact from manifest.ts; index.ts is their daemon entry.
        manifest: fixture.manifest, projectRoot, entryPath: join(projectRoot, 'src/manifest.ts'), manifestExport: null,
    } });
    const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    app.get<{ Querystring: { ref: string } }>('/v4/connect/qualified/credential', request => {
        expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
        const ref = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountRefSchema, request.query.ref);
        expect(ref).toEqual(account);
        return QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref, authenticationModeId: 'token',
            revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: null, metadata: { scopes: [] },
            content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
                payload: { v: 1, values: { token: 'selected-private-key' } }, randomBytes: length => new Uint8Array(length) }),
        });
    });
    app.get('/v4/connect/qualified/configuration', async (_request, reply) => reply.code(404).send({ error: 'not_found' }));
    app.get('/v4/connect/qualified/accounts', () => QualifiedConnectedAccountListResponseV4Schema.parse({ service: account.service,
        accounts: [{ ref: account, authenticationModeId: 'token', status: 'connected', revisionSemantics: 'revisioned',
            credentialRevision: revision, configurationRevision: null, configurationReady: true, scopes: [] }],
    }));
    await app.ready();
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: home });
    let native: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
    let runtime: Awaited<ReturnType<typeof resolveAccountExecutionRuntime>> | undefined;
    let current = true;
    vendor.request.mockReset();
    vendor.request.mockImplementation(async (url, init) => {
        expect(new URL(url).origin).toBe(fixture.origin);
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer selected-private-key');
        return Response.json(fixture.directory === 'machine-boat' ? { ok: true, type: 'limits.info' } : { data: [] });
    });
    try {
        await runWithServerHttpBaseUrl(home, async () => {
            await ensureCliActionPolicySettings(credentials, home);
            const snapshot = getActiveAccountSettingsSnapshot();
            if (!snapshot) throw new Error('Expected requester Account settings');
            const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
                serverHttpBaseUrl: home, isCurrent: async () => current });
            native = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: directory, pluginIds: [fixture.manifest.id],
                resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({ kind: 'development',
                    registeredRootId: `credential-fixture:${pluginId}`, canonicalRoot: rootPath, observedRevision: 1 }),
            });
            expect(await native.resolveConnectedAccountRuntime?.(account.service)).toBeTruthy();
            const input = { happyHomeDir: directory,
                ...(fixture.borrowNativeRegistry ? { credentialRuntimeRegistry: native } : {}),
                resolveServerFeaturesSnapshot: () => ({ status: 'ready' as const, features }),
                accountExecution: { credentials, serverUrl: home, machineId: 'controller', explicitMachineId: 'controller',
                    savedSecretOperationContext, isCurrent: () => current },
            };
            runtime = await resolveAccountExecutionRuntime(input);
            if (!runtime.purposeRuntime) throw new Error('Expected the requester purpose owner');
            const authority = createManagedProviderOperationAuthority({ materializationBaseDir: directory,
                purposeBindingOwner: runtime.purposeRuntime.purposes, requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
                resolveRequestAuthHttpPort: () => 43123, createRedactionLease: () => ({ add() {}, close() {} }),
            });
            const controller = { machineId: 'controller', installationId: 'installation' };
            const contribution = { pluginId: fixture.manifest.id, localId: fixture.provisionerId };
            const accountHost = runtime;
            const driver = createManagedMachineAcquisitionDriver({ token: credentials.token, credentials, serverUrl: home,
                homeId: 'srv_role_credentials', controller, runtimeRegistry: native, managedProviderOperationAuthority: authority,
                homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: 'srv_role_credentials',
                    canonicalServerUrl: home, revision: 1, endpoints: [{ kind: 'https', url: home }] }, authority: 'current_connection' }),
                resolveAccountRuntime: async () => ({ runtimeRegistry: accountHost.registry, managedProviderOperationAuthority: authority }),
            });
            expect(await driver.execute('machines.provisioners.check', { homeId: 'srv_role_credentials', controller, contribution,
                credentials: [{ purpose: { consumer: contribution, purpose: 'cloud-api' }, account }],
            }, { requestId: 'controller-check' })).toMatchObject({ available: true });
            expect(vendor.request).toHaveBeenCalled();
            current = false;
            await expect(runtime.purposeRuntime.established.invokeWithReceipt({ account,
                operation: { kind: 'materialize', request: { kind: 'httpHeaders', origin: fixture.origin, headerNames: ['authorization'] } },
            })).rejects.toThrow();
        });
    } finally {
        await runtime?.registry.dispose();
        await native?.dispose();
        restoreHttp();
        await app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
