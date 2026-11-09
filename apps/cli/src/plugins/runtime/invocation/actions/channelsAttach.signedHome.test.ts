import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import fastify from 'fastify';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, FeaturesResponseSchema } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionInputV1Schema,
    PluginAvailabilityIntentReadActionOutputV1Schema,
} from '@happier-dev/protocol/plugins/availability/actions';
import { ExternalActionExecutionAuthorizationV1Schema,
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1,
} from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { ExternalActionHomeBinding } from '@/api/externalActionExecutionAuthorization';
import { handleActionsCommand } from '@/cli/commands/actions';
import { reloadConfiguration } from '@/configuration';
import { SignedRootActionExecuteRequestSchema, SIGNED_ROOT_ACTION_EXECUTE_PATH } from '@/daemon/externalActions/signedRootActionControl';
import * as persistence from '@/persistence';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { createCommittedContributedActionDefinitionLister } from './createCommittedContributedActionDeps';
import { executeContributedAction } from './executeContributedAction';
import { createHttpCollectionBoundary } from '../../context/accountPluginDataStorage.testkit';
import { CHANNELS_PLUGIN } from '../../../../../../../packages/plugins/channels/src/manifest';
import { CHANNEL_STATE_COLLECTION } from '../../../../../../../packages/plugins/channels/src/collections';

const homeUrl = 'https://channels-signed-home.test';
const serverIdentityId = 'srv_channels_signed_home';
const machineId = 'channels-owner-machine';
const installationId = 'channels-owner-installation';
const accountId = 'channels-owner';
const sessionId = 'c123456789012345678901234';
const localId = 'session-pull-request-binding-v1';
const qualifiedActionId = formatQualifiedPluginActionId({ pluginId: CHANNELS_PLUGIN.manifest.id, localId });
const actionId = 'action.invoke';
const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(21));
const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
})).toString('base64url')}.signature`;
const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };

afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests();
    process.exitCode = undefined;
});

async function fixture(options: Readonly<{ signingBinding?: boolean }> = {}) {
    const home = fastify();
    const paths: string[] = [];
    const signedPaths: string[] = [];
    const signedRequests: { path: string; effectActionId: string }[] = [];
    let daemonOrigin: string | undefined;
    let authorization: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> | undefined;
    let denySession = false;
    const collection = createHttpCollectionBoundary(CHANNEL_STATE_COLLECTION.indexes, 'plain');
    const currentness = createAccountEncryptionCurrentnessFixture({ mode: 'plain' });
    // Persistent credential acquisition is a system boundary. Account policy,
    // storage admission and declaration/Collection projection remain real.
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}),
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
        scopeKey: resolveAccountSettingsScopeKeyForToken(token),
    });
    home.addHook('preHandler', async (request, reply) => {
        paths.push(request.url);
        if (!authorization) {
            if (!['/v1/account/encryption/currentness', '/v2/account/settings',
                PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'],
                '/v1/machines/managed/actions/list',
            ].includes(request.url)) {
                throw new Error('Only original CLI Account preparation may precede admission');
            }
            expect(request.headers.authorization).toBe(`Bearer ${token}`);
            return;
        }
        const signature = request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
        expect(typeof signature).toBe('string');
        if (typeof signature !== 'string') throw new Error('Missing Machine signature');
        const effectActionId = request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER];
        if (effectActionId !== actionId) throw new Error('Signed HTTP must retain the admitted root Action');
        expect(verifyExternalActionMachineRequestV1({
            authorizationToken: authorization.token, effectActionId,
            target: authorization.binding.target, installationId, requestId: authorization.binding.requestId,
            method: request.method, path: request.url, signature, publicKey: keys.publicKey,
            ...(request.body === undefined ? {} : { body: request.body }),
        })).toBe(true);
        signedPaths.push(request.url);
        signedRequests.push({ path: request.url, effectActionId });
        // This fixture owns only the cryptographic HTTP boundary, not Home's
        // domain-purpose authorization; that server gate needs its own test.
        if (authorization.binding.accountId !== accountId) {
            return reply.code(403).send({ error: 'permission_denied' });
        }
    });
    home.get('/v1/account/encryption/currentness', async () => currentness);
    home.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    // This ordinary Machine has no managed power resource.
    home.post('/v1/machines/managed/actions/list', async () => ({ machines: [] }));
    home.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async request => {
        expect(PluginAvailabilityIntentReadActionInputV1Schema.parse(request.body).pluginId).toBe(CHANNELS_PLUGIN.manifest.id);
        return PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: false }, intent: null, release: null, uiArtifacts: [], packageAssets: [],
        });
    });
    home.get(`/v2/sessions/${sessionId}`, async (request, reply) => {
        if (denySession) return reply.code(404).send({ error: 'Session not found' });
        return { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
            metadata: JSON.stringify({ machineId, path: '/home/happier' }),
        }) };
    });
    home.get(`/v1/sessions/${sessionId}/messages`, async () => ({
        messages: [], hasMore: false, externalShareableSnapshot: { turns: [] },
    }));
    home.post('/v2/sessions/lookup-by-tags', async () => ({ sessions: [] }));
    home.get('/v2/sessions', async () => ({ sessions: [], nextCursor: null, hasNext: false }));
    home.get('/v2/sessions/archived', async () => ({ sessions: [], nextCursor: null, hasNext: false }));
    const restoreHttp = installAxiosFastifyAdapter({ app: home, origin: homeUrl });
    // Home HTTP and persistent Collection storage are the only substituted
    // systems. The real admitted Channels module, registry and nested reader run.
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
        const parsedUrl = new URL(String(url));
        if (parsedUrl.origin === daemonOrigin) return nativeFetch(url, options);
        if (parsedUrl.origin !== homeUrl) throw new Error('Unexpected external origin');
        const path = parsedUrl.pathname;
        if (!['/v1/features', '/v1/features/authenticated'].includes(path)) {
            throw new Error(`Unexpected external request ${path}`);
        }
        return Response.json(FeaturesResponseSchema.parse({ features: {},
            capabilities: { serverIdentity: { serverIdentityId } },
        }));
    }));
    const externalActionHomeBinding = { serverId: serverIdentityId, serverIdentityId,
        externalActionMachineInstallationId: installationId,
        externalActionMachineRequestPrivateKey: keys.secretKey,
    } satisfies ExternalActionHomeBinding;
    const runtimeOptions = {
        ...(options.signingBinding === false ? {} : { externalActionHomeBinding }),
        accountStorageDependencies: { http: collection.http,
            resolveBaseUrl: () => homeUrl,
            resolveAccountEncryptionCurrentness: async () => currentness,
        },
        resolveCurrentMachineId: () => machineId,
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId, machineId }),
    };
    const packageRoot = resolve(import.meta.dirname, '../../../../../../../packages/plugins/channels');
    const resources = normalizePluginManifestV2(CHANNELS_PLUGIN.manifest).contributes.resources;
    const files: Record<string, string | Uint8Array> = {
        '.happier-plugin/daemon.js': 'export function activate() {}',
    };
    await Promise.all(resources.map(async resource => {
        if ('path' in resource && typeof resource.path === 'string') {
            files[resource.path] = await readFile(resolve(packageRoot, resource.path));
        }
    }));
    const runtime = await runWithServerHttpBaseUrl(homeUrl, () => createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [{ manifest: CHANNELS_PLUGIN.manifest,
            files,
            instantiateCommittedModule: () => ({ activate: CHANNELS_PLUGIN.activate }),
        }],
        async resolveContributes(happyHomeDir) {
            return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'first_party',
            }));
        },
        runtimeOptions,
    }));
    await runtime.registry.activateContributionsOnDemand([{ pluginId: CHANNELS_PLUGIN.manifest.id,
        family: 'actions', localId,
    }]);
    function admit(input: unknown, requesterAccountId: string, requestId: string) {
        const target = { kind: 'machine' as const, machineId };
        authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1,
            token: 'synthetic-home-admission-proof', binding: {
                accountId: requesterAccountId, custodianAccountId: accountId,
                authentication: { kind: 'terminal', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
                serverIdentityId, machineId, installationId, actionId, requestId, target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target,
                    input: { action: { pluginId: CHANNELS_PLUGIN.manifest.id, localId }, input },
                }),
            },
        });
        return { authority: 'account_automation' as const, serverId: serverIdentityId,
            serverIdentityId, actionRequestId: requestId, externalActionExecutionAuthorization: authorization,
            externalActionTarget: target };
    }
    return {
        paths, signedPaths, signedRequests, collection,
        denySession() { denySession = true; },
        allowDaemonOrigin(origin: string) { daemonOrigin = origin; },
        listContributedActionDefinitions: createCommittedContributedActionDefinitionLister({
            tryAcquireRuntimeRegistryLease: runtime.controller.tryAcquireRuntimeRegistry,
        }),
        async invoke(input: unknown, requesterAccountId = accountId) {
            const externalActionContext = admit(input, requesterAccountId, randomUUID());
            return runWithServerHttpBaseUrl(homeUrl, () => runtime.registry.targetActionInvocations!.invoke({
                pluginId: CHANNELS_PLUGIN.manifest.id, localId, input, surface: 'cli',
                invocationAuthority: 'account_automation',
                externalActionContext,
            }));
        },
        async invokeAdmittedAction(input: unknown, requestId: string) {
            const externalActionContext = admit(input, accountId, requestId);
            return runWithServerHttpBaseUrl(homeUrl, () => executeContributedAction({
                runtimeRegistry: runtime.registry,
                actionId: buildQualifiedPluginContributionKey({ pluginId: CHANNELS_PLUGIN.manifest.id, localId }), input,
                context: { surface: 'cli', invocationSurface: 'cli', externalActionContext },
            }));
        },
        async dispose() { try { await runtime.dispose(); } finally { restoreHttp(); await home.close(); } },
    };
}

describe('signed Home Session PR attachment through the admitted CLI Channels runtime', () => {
    it('carries the real CLI action.invoke machine route into the signed contributed reader', async () => {
        const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_TOKEN']);
        try {
            await withTempDir('happier-channels-signed-cli-', async homeDir => {
                env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: homeUrl,
                    HAPPIER_WEBAPP_URL: homeUrl, HAPPIER_TOKEN: undefined });
                reloadConfiguration();
                const subject = await fixture();
                const daemon = fastify();
                const received: unknown[] = [];
                const daemonErrors: string[] = [];
                daemon.addHook('onError', async (_request, _reply, error) => { daemonErrors.push(error.message); });
                // The daemon/Home admission boundary supplies the signed context.
                // The CLI sender, discovery, dispatcher and Channels reader are real.
                daemon.post(SIGNED_ROOT_ACTION_EXECUTE_PATH, async request => {
                    expect(request.headers['x-happier-daemon-token']).toBe('channels-daemon-control');
                    const root = SignedRootActionExecuteRequestSchema.parse(request.body);
                    received.push(root);
                    expect(root.target).toEqual({ kind: 'machine', machineId });
                    if (root.actionId === 'action.spec.get') {
                        // Original CLI placement discovery reaches the same real
                        // committed catalog through the daemon transport boundary.
                        return createCliActionExecutorFromCredentials({ credentials,
                            serverId: serverIdentityId, serverIdentityId, serverApiUrl: homeUrl,
                            pluginActionExecutionOwner: 'current_process',
                            listContributedActionDefinitions: subject.listContributedActionDefinitions,
                        }).execute('action.spec.get', root.input, { surface: 'cli' });
                    }
                    expect(root.actionId).toBe('action.invoke');
                    const input = getActionSpec('action.invoke').inputSchema.parse(root.input);
                    expect(input.action).toEqual({ pluginId: CHANNELS_PLUGIN.manifest.id, localId });
                    const attempt = await subject.invokeAdmittedAction(input.input, root.actionRequestId ?? randomUUID());
                    if (!attempt.matched) throw new Error('CLI Action did not match the committed Channels contribution');
                    return attempt.result;
                });
                try {
                const origin = await daemon.listen({ port: 0, host: '127.0.0.1' });
                subject.allowDaemonOrigin(origin);
                const port = Number(new URL(origin).port);
                const profile = await seedTestServerProfile({ id: serverIdentityId, homeId: serverIdentityId, serverUrl: homeUrl });
                await mkdir(join(homeDir, 'servers', profile.id), { recursive: true });
                await writeFile(join(homeDir, 'servers', profile.id, 'daemon.state.json'), JSON.stringify({
                    pid: process.pid, httpPort: port, startedAt: Date.now(), startedWithCliVersion: 'test',
                    machineId, accountId, controlToken: 'channels-daemon-control',
                }));
                const output = captureStdoutJsonOutput<unknown>();
                try {
                    await handleActionsCommand(['invoke', qualifiedActionId, '--input-json', JSON.stringify({
                        kind: 'attach', sessionId, pullRequestUrl: 'https://github.com/acme/widgets/pull/12',
                    }), '--server-id', profile.id, '--machine-id', machineId, '--request-id', 'channels-cli-attach', '--json'], {
                        readCredentialsFn: async () => credentials,
                        readCredentialsForServerIdFn: async () => credentials,
                        getServerProfileFn: async () => profile,
                        createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
                            listContributedActionDefinitions: subject.listContributedActionDefinitions,
                        }),
                    });
                    expect(output.json(), JSON.stringify({ output: output.json(), paths: subject.paths, received, daemonErrors })).toMatchObject({ ok: false,
                        error: { code: 'channels_pr_link_checkout_not_verified' } });
                    expect(received).toEqual([
                        expect.objectContaining({ actionId: 'action.spec.get' }),
                        expect.objectContaining({ actionId: 'action.spec.get' }),
                        expect.objectContaining({ actionId: 'action.invoke',
                            actionRequestId: 'channels-cli-attach', target: { kind: 'machine', machineId } }),
                    ]);
                    expect(subject.signedPaths.some(path => path.startsWith(`/v1/sessions/${sessionId}/messages?`))).toBe(true);
                    expect(subject.collection.capturedMutationRequests).toEqual([]);
                    expect(output.chunks.join('')).not.toContain(token);
                    expect(output.chunks.join('')).not.toContain('synthetic-home-admission-proof');
                } finally { output.restore(); }
                } finally { await daemon.close(); await subject.dispose(); }
            });
        } finally {
            env.restore();
            reloadConfiguration();
        }
    });

    it('reaches the checkout refusal for an own-Account signed terminal request', async () => {
        const subject = await fixture();
        try {
            const result = await subject.invoke({ kind: 'attach', sessionId,
                pullRequestUrl: 'https://github.com/acme/widgets/pull/12' });
            expect(result, JSON.stringify({ result, paths: subject.paths })).toMatchObject({ status: 'failed', code: 'channels_pr_link_checkout_not_verified' });
            expect(subject.paths.some(path => path.startsWith(`/v1/sessions/${sessionId}/messages?`))).toBe(true);
            expect(subject.signedPaths).toEqual(subject.paths);
            expect(subject.collection.capturedMutationRequests).toEqual([]);
            expect(JSON.stringify(result)).not.toContain(token);
            expect(JSON.stringify(result)).not.toContain('synthetic-home-admission-proof');
        } finally { await subject.dispose(); }
    });

    it('lets the own-Account signed reader list links while preserving Session reader denial', async () => {
        const subject = await fixture();
        try {
            expect(await subject.invoke({ kind: 'list', sessionId })).toMatchObject({ status: 'executed',
                value: { kind: 'links', sessionId, pullRequestLinks: [] } });
            subject.denySession();
            const result = await subject.invoke({ kind: 'list', sessionId });
            expect(result, JSON.stringify({ result, paths: subject.paths })).toMatchObject({ status: 'failed', code: 'session_not_found' });
            expect(subject.collection.capturedMutationRequests).toEqual([]);
            expect(JSON.stringify(result)).not.toContain(token);
        } finally { await subject.dispose(); }
    });

    it('does not borrow the custodian token for a different Account', async () => {
        const subject = await fixture();
        try {
            const readsBefore = [...subject.collection.capturedReadPaths];
            expect(await subject.invoke({ kind: 'list', sessionId }, 'other-person')).toMatchObject({ status: 'failed' });
            expect(subject.collection.capturedReadPaths).toEqual(readsBefore);
            expect(subject.collection.capturedMutationRequests).toEqual([]);
        } finally { await subject.dispose(); }
    });

    it('fails closed without the host signing binding before any Session or Collection read', async () => {
        const subject = await fixture({ signingBinding: false });
        try {
            const readsBefore = [...subject.collection.capturedReadPaths];
            const result = await subject.invoke({ kind: 'list', sessionId });
            expect(result).toMatchObject({ status: 'failed', code: 'not_authenticated' });
            expect(subject.paths).toEqual([]);
            expect(subject.collection.capturedReadPaths).toEqual(readsBefore);
            expect(subject.collection.capturedMutationRequests).toEqual([]);
            expect(JSON.stringify(result)).not.toContain(token);
        } finally { await subject.dispose(); }
    });
});
