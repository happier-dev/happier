import { describe, expect, it, vi } from 'vitest';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fastify from 'fastify';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { definePlugin, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { accountSettingsParse, HappierStructuredInputV1Schema } from '@happier-dev/protocol';
import { TriageSourcesContributionProtocolV1 } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';

import { prepareSessionInputForProviderDispatch, readStructuredInputPreparationFailure } from '@/agent/runtime/turns/prepareSessionInputForProviderDispatch';
import { admitPluginSessionInputAttachmentsV1 } from '@/session/composer/admitPluginSessionInputAttachmentsV1';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { TRIAGE_PLUGIN } from '../../../../../packages/plugins/triage/src/manifest';
import { planEntrySessionInput } from '../../../../../packages/plugins/triage/src/sessions/entrySessionDelivery';
import { CORPUS_SESSION_LINKS_COLLECTION_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../../../../../packages/plugins/triage/src/corpus/collections/ids';
import { readSessionInputForgeEvidenceV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import { admitSessionStructuredInputV1 } from '@/session/services/admitSessionStructuredInputV1';
import { PluginCollectionGetRequestV1Schema, PluginCollectionGetResultV1Schema,
    PluginCollectionMutationRequestV1Schema, PluginCollectionMutationResultV1Schema,
    PluginCollectionQueryRequestV1Schema, type PluginCollectionRowV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';

import type { AccountPluginDataStorageHostDependencies } from './context/accountPluginDataStorage';
import { readStoredCredentials } from '@/persistence';
import type { StoredCredentials } from '@/persistence';
import nacl from 'tweetnacl';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { prepareAccountSettingsV2Content } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { sealPluginCollectionPrivatePayloadV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { projectSessionAccessCapabilitiesV1, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { encodeBase64 } from '@/api/encryption';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { readCurrentAccountPluginExecutionSelection } from './accountPluginActivationSource';
import type { RpcHandler } from '@/api/rpc/types';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_CONNECTED_ACCOUNT_SERVICE, GITHUB_PLUGIN_ID } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_TRIAGE_ACTION_IDS_V1, GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 } from '../../../../../packages/plugins/scm-github/src/triage/contribution';
import { githubNativeReadActionId } from '../../../../../packages/plugins/scm-github/src/triage/readActions';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';

// Stored sign-in is an OS credential boundary. A real captured Account is also
// required to construct the host Action service consumed by Triage's source get.
vi.mock('@/persistence', async importOriginal => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readStoredCredentials: vi.fn(async () => ({ token: 'composer-fixture-token', encryption: null })),
}));

const pluginId = 'acme.composer-account-context';
const marker = 'Fresh Account context for the selected issue';
const collection = {
    id: 'issues', schemaVersion: 1,
    schema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'text'], additionalProperties: false },
    rowIdField: 'id', serverReadable: ['id'], indexes: [],
} as const;

function accountBoundary(signedIn = false, encryptionMode: 'plain' | 'e2ee' = 'plain') {
    const keys = encryptionMode === 'e2ee' ? nacl.box.keyPair() : null;
    const credentials: StoredCredentials = { token: signedIn
        ? `e30.${Buffer.from(JSON.stringify({ sub: 'composer-fixture-account' })).toString('base64url')}.signature`
        : 'composer-fixture-token', encryption: keys ? { type: 'dataKey', machineKey: keys.secretKey, publicKey: keys.publicKey } : null };
    const contentKeyFingerprint = keys ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
            material: { type: 'dataKey', machineKey: keys.secretKey }, dataKeyPublicKey: keys.publicKey }).contentPublicKeyFingerprint,
    ) : null;
    let current = true;
    const reads: string[] = [];
    // Substitute only credentials and Account HTTP. Storage declaration checks,
    // mode admission, decoding and invocation/occurrence fences remain real.
    const dependencies = {
        readCredentials: async () => credentials,
        isCurrentAccount: () => current,
        resolveAccountScopeKey: () => resolveAccountSettingsScopeKey(credentials),
        resolveBaseUrl: () => 'https://composer-account.example.test',
        resolveAccountEncryptionCurrentness: async () => createAccountEncryptionCurrentnessFixture({ mode: encryptionMode, version: 1, updatedAt: 1, contentKeyFingerprint }),
        http: {
            async get(url) {
                if (url.endsWith('/v1/account/encryption')) {
                    return { status: 200, data: { mode: encryptionMode, updatedAt: 1 } };
                }
                throw new Error(`Unexpected Account GET: ${url}`);
            },
            async post(url) {
                reads.push(url);
                if (url.endsWith('/v1/plugins/data/get')) {
                    return { status: 200, data: PluginCollectionGetResultV1Schema.parse({ absenceEpoch: 0, row: {
                        rowId: '42', revision: 1, projection: { id: '42' },
                        content: { t: 'plain', v: { text: marker } },
                    } }) };
                }
                throw new Error(`Unexpected Account POST: ${url}`);
            },
        },
    } satisfies AccountPluginDataStorageHostDependencies;
    return { dependencies, reads, retire: () => { current = false; } };
}

function externalPlugin(declareStorage: boolean) {
    let retainedRead: (() => Promise<unknown>) | undefined;
    const eventContexts: string[] = [];
    async function read(context: PluginInvocationContext) {
        const account = context.services.storage.account;
        if (!account) throw new PluginError({ code: 'fixture_account_unavailable', message: 'Account storage is unavailable' });
        const issues = account.collection(collection);
        retainedRead = () => issues.get('42');
        const row = await issues.get('42');
        return String(row?.value.text);
    }
    const plugin = definePlugin({
        id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        hostAccess: { required: declareStorage ? [{ id: 'account-data', capability: 'storage.account',
            reason: 'Resolve selected issue context', scope: { enabled: true } }] : [], optional: [] },
        accountCollections: { issues: collection },
        events: {
            changed: { declaration: { kind: 'event', title: 'Changed' } },
            observe: { declaration: { kind: 'subscription', target: { kind: 'plugin', event: 'changed' } },
                async handler(_payload, context) { eventContexts.push(await read(context)); } },
        },
        requestInterceptors: { context: { declaration: { origins: ['https://composer.example.test'] },
            async interceptor(request, context) {
                return { decision: 'continue', request: { ...request, headers: { ...request.headers, 'x-fixture-context': await read(context) } } };
            } } },
        mcp: { discoverySources: { 'issue-discovery': {
            declaration: { title: 'Issues', loadedInHappierSessions: true },
            async discover(_request, context) {
                const text = await read(context);
                return { items: [], endpoints: [{ id: 'issues', name: text, kind: 'http', url: 'https://composer.example.test/mcp' }] };
            },
        } } },
        composer: {
            references: { 'issue-reference': {
                title: 'Issues', description: 'Find issues', icon: 'search', triggers: ['@'],
                async search(_query, context) { return [{ id: '42', label: await read(context) }]; },
                async resolve(id, context) { return { id, label: 'Issue 42', context: await read(context) }; },
            } },
            attachments: { issue: {
                title: 'Issue', icon: 'error', cardinality: 'many', value: defineProtocolObject({}, { policy: 'closed' }),
                runtime: {
                    async resolveForDispatch(request, context) {
                        const text = await read(context);
                        return { attachments: request.attachments.map(attachment => ({
                            instanceId: attachment.instanceId, status: 'ready', context: text,
                        })) };
                    },
                },
            } },
        },
    });
    return { plugin, eventContexts, readAfterCompletion: () => {
        if (!retainedRead) throw new Error('Callback has not read Account storage');
        return retainedRead();
    } };
}

async function fixture(declareStorage: boolean) {
    const external = externalPlugin(declareStorage);
    const account = accountBoundary();
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [{ manifest: external.plugin.manifest, files: { 'daemon.mjs': 'export function activate() {}', 'package.json': '{"type":"module"}' },
            instantiateCommittedModule: () => ({ activate: external.plugin.activate }) }],
        async resolveContributes(happyHomeDir) {
            return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
            }));
        },
        coldStart: true,
        runtimeOptions: { accountStorageDependencies: account.dependencies },
    });
    return { ...runtime, account, external };
}

async function prepare(registry: Awaited<ReturnType<typeof fixture>>['registry']) {
    const structuredInput = HappierStructuredInputV1Schema.parse({ v: 1, composerAttachments: [{
        v: 1, instanceId: 'selected-issue', attachment: { pluginId, localId: 'issue' },
        key: '42', value: {}, presentation: { label: 'Issue 42', typeLabel: 'Issue' },
    }] });
    return await prepareSessionInputForProviderDispatch({
        prompt: { text: 'Review the selected issue', localId: 'input-1', structuredInput },
        transformedUserText: 'Review the selected issue', providerNativeCommand: false,
        signal: new AbortController().signal, localId: 'input-1',
        services: { sessionId: 'session-1', resolveComposerAttachmentForDispatch: async input => {
            if (!registry.composerAttachments) throw new Error('Composer attachment registry is missing');
            return await registry.composerAttachments.resolveForDispatch(input);
        } },
    });
}

describe('declared Composer callback services through admitted runtime composition', () => {
    it('demands an external attachment, reads real Account storage and prepares provider context', async () => {
        const subject = await fixture(true);
        try {
            const prepared = await prepare(subject.registry);
            expect(prepared.requiredPrompt).toContain(marker);
            expect(prepared.structuredInput).toMatchObject({ resolvedComposerAttachments: [{
                attachment: { pluginId, localId: 'issue' }, instanceId: 'selected-issue',
            }] });
            expect(subject.account.reads).toHaveLength(1);
            await expect(subject.external.readAfterCompletion()).rejects.toBeDefined();
            subject.account.retire();
            await expect(prepare(subject.registry)).rejects.toMatchObject({ code: 'composer_attachment_resolution_failed' });
            expect(subject.account.reads).toHaveLength(1);
        } finally { await subject.dispose(); }
    });

    it('binds the same declared Account storage to reference search and resolution', async () => {
        const subject = await fixture(true);
        try {
            const references = subject.registry.composerReferences!;
            const input = { reference: { pluginId, localId: 'issue-reference' }, signal: new AbortController().signal };
            await expect(references.search({ ...input, query: '42', trigger: '@' })).resolves.toEqual([{ id: '42', label: marker }]);
            await expect(references.resolve({ ...input, candidateId: '42', sessionId: 'session-1' }))
                .resolves.toMatchObject({ context: marker });
            await expect(subject.external.readAfterCompletion()).rejects.toBeDefined();
        } finally { await subject.dispose(); }
    });

    it('uses admitted Account storage for attachments and references without a HostAccess declaration', async () => {
        const subject = await fixture(false);
        try {
            const prepared = await prepare(subject.registry);
            expect(prepared.requiredPrompt).toContain(marker);
            await expect(subject.registry.composerReferences!.resolve({ reference: { pluginId, localId: 'issue-reference' },
                candidateId: '42', signal: new AbortController().signal }))
                .resolves.toMatchObject({ context: marker });
            await expect(subject.external.readAfterCompletion()).rejects.toBeDefined();
        } finally { await subject.dispose(); }
    });

    it('uses declared services for neighboring full-context interceptor, event and MCP callbacks', async () => {
        const subject = await fixture(true);
        try {
            await subject.registry.activateContributionsOnDemand([
                { pluginId, family: 'requestInterceptors', localId: 'context' },
                { pluginId, family: 'events', localId: 'observe' },
            ]);
            const interceptor = subject.registry.requestInterceptors!.find(binding => binding.pluginId === pluginId)!;
            await expect(subject.registry.invokeRequestInterceptor!(interceptor, {
                method: 'GET', url: 'https://composer.example.test/issue', headers: {},
            }, new AbortController().signal)).resolves.toMatchObject({
                decision: 'continue', request: { headers: { 'x-fixture-context': marker } },
            });
            const publisher = subject.registry.createPluginEventsService!({ pluginId, pluginVersion: '1.0.0' });
            await publisher!.emit('changed', {});
            await vi.waitFor(() => expect(subject.external.eventContexts).toEqual([marker]));
            await expect(subject.registry.discoverMcpServersForDetection!({
                pluginId, localId: 'issue-discovery', input: { directory: subject.happyHomeDir }, signal: new AbortController().signal,
            })).resolves.toMatchObject({ endpoints: [{ name: marker }] });
        } finally { await subject.dispose(); }
    });

    it.each([
        { kind: 'entry', sourceExecution: 'daemon', requester: 'owner', encryptionMode: 'plain' },
        { kind: 'entry', sourceExecution: 'daemon', requester: 'guest', encryptionMode: 'plain' },
        { kind: 'entry', sourceExecution: 'account', requester: 'owner', encryptionMode: 'plain' },
        { kind: 'selectedForgeEvidence', sourceExecution: 'daemon', requester: 'owner', encryptionMode: 'plain' },
        { kind: 'entry', sourceExecution: 'accountNative', requester: 'owner', encryptionMode: 'plain' },
        { kind: 'entry', sourceExecution: 'accountNative', requester: 'owner', encryptionMode: 'e2ee' },
    ] as const)('dispatches the real Triage delivery producer through activation, Account storage and the admitted source ($kind/$sourceExecution/$requester/$encryptionMode)', async ({ kind, sourceExecution, requester, encryptionMode }) => {
        const sourceFixture = createTriageSourceV1Fixture();
        const configuredInstance = sourceExecution === 'accountNative' ? {
            ...sourceFixture.configuredInstance,
            instance: { ...sourceFixture.configuredInstance.instance, source: {
                pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1,
            } },
            binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native' as const, service: GITHUB_CONNECTED_ACCOUNT_SERVICE },
        } : sourceFixture.configuredInstance;
        const source = { ...sourceFixture, configuredInstance,
            descriptor: { ...sourceFixture.descriptor, purpose: configuredInstance.binding.purpose },
            getInput: { ...sourceFixture.getInput, instance: configuredInstance },
        };
        const sourceIdentity = source.configuredInstance.instance.source;
        const getActionId = sourceExecution === 'accountNative' ? GITHUB_TRIAGE_ACTION_IDS_V1.get : 'get';
        const nativeGetActionId = githubNativeReadActionId(getActionId);
        const roles = TriageSourcesContributionProtocolV1.operations;
        const reads: unknown[] = [];
        const provider = definePlugin({
            id: sourceIdentity.pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            actions: {
                instances: { title: 'Instances', surfaces: roles.listInstances.declaration.surfaces,
                    dangerLevel: 'safe', inputSchema: roles.listInstances.declaration.input.schema,
                    resultSchema: roles.listInstances.declaration.resultSchema, run: () => source.listInstancesResult },
                scan: { title: 'Scan', surfaces: roles.scan.declaration.surfaces,
                    dangerLevel: 'safe', inputSchema: roles.scan.declaration.input.schema,
                    resultSchema: roles.scan.declaration.resultSchema, run: () => source.scanResult },
                [getActionId]: { title: 'Get', surfaces: roles.get.declaration.surfaces,
                    dangerLevel: 'safe', inputSchema: roles.get.declaration.input.schema,
                    resultSchema: roles.get.declaration.resultSchema,
                    ...(sourceExecution !== 'daemon' ? {
                        execution: { target: 'account' as const, account: { artifactId: 'source-account-runtime', exportName: 'activate' } },
                    } : {}),
                    run(input) { reads.push(input); return source.getResult; } },
                ...(sourceExecution === 'accountNative' ? { [nativeGetActionId]: {
                    title: 'Get through Machine-native source', surfaces: ['plugin'] as const,
                    dangerLevel: 'safe' as const, inputSchema: roles.get.declaration.input.schema,
                    resultSchema: roles.get.declaration.resultSchema,
                    run(input: unknown) { reads.push(input); return source.getResult; },
                } } : {}),
            },
            ui: { renderers: [{ id: 'detail', kind: 'declarative', root: { kind: 'text', text: 'Source detail' } }] },
            contributesTo: { 'happier.triage': { sources: { [sourceIdentity.localId]:
                TriageSourcesContributionProtocolV1.contribute({ descriptor: source.descriptor,
                    operations: { listInstances: roles.listInstances.bind('instances'), scan: roles.scan.bind('scan'), get: roles.get.bind(getActionId) },
                    surfaces: { detail: { renderer: 'detail' } },
                }),
            } } },
        });
        const account = accountBoundary(true, encryptionMode);
        vi.mocked(readStoredCredentials).mockResolvedValue(await account.dependencies.readCredentials());
        // Match a signed-in daemon's canonical Account lifetime. Only the
        // credential and Account HTTP boundaries are supplied by this fixture.
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}),
            settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(await account.dependencies.readCredentials()),
        });
        const requesterCredentials = requester === 'guest'
            ? { token: `e30.${Buffer.from(JSON.stringify({ sub: 'composer-fixture-guest' })).toString('base64url')}.signature`, encryption: null }
            : await account.dependencies.readCredentials();
        const requesterAccount = createInvocationSavedSecretOperationContextV1({ credentials: requesterCredentials,
            snapshot: { ...getActiveAccountSettingsSnapshot()!, scopeKey: resolveAccountSettingsScopeKey(requesterCredentials) },
            ...(requester === 'guest' ? { machineAdmission: { actorAccountId: 'composer-fixture-guest',
                custodianAccountId: 'composer-fixture-account', role: 'use' as const } } : {}),
            serverHttpBaseUrl: 'https://composer-account.example.test', isCurrent: async () => true });
        const home = await mkdtemp(join(tmpdir(), 'triage-account-source-'));
        // Match the real Home transport when publishing the compiled GitHub
        // wrapper as an encrypted Account artifact.
        const app = fastify({ bodyLimit: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 });
        let published: Awaited<ReturnType<typeof registerAuthoredAccountActionRelease>> | undefined;
        if (sourceExecution !== 'daemon') {
            if (encryptionMode === 'plain') registerAccountHomeHttp(app, { accountId: 'composer-fixture-account', serverId: 'composer-fixture-home' });
            else {
                app.get('/v1/account/encryption', async () => ({ mode: encryptionMode, updatedAt: 1 }));
                app.get('/v1/account/encryption/currentness', async () => account.dependencies.resolveAccountEncryptionCurrentness());
                app.get('/v1/account/profile', async () => ({ id: 'composer-fixture-account' }));
                app.get('/v2/account/settings', async () => ({ version: 1, content: prepareAccountSettingsV2Content({
                    credentials: requesterCredentials, raw: {}, envelopeKind: 'encrypted', randomBytes: nacl.randomBytes,
                }) }));
            }
            const entryPath = join(home, 'source-account.ts');
            await writeFile(entryPath, `import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
${sourceExecution === 'accountNative' ? `import { GITHUB_ACCOUNT_READ_ACTIONS } from '${resolve(import.meta.dirname, '../../../../../packages/plugins/scm-github/src/triage/readActions.ts')}';` : ''}
const fixture = createTriageSourceV1Fixture();
export function activate(registrar) { registrar.actions.register('${getActionId}', ${sourceExecution === 'accountNative'
    ? `GITHUB_ACCOUNT_READ_ACTIONS['${getActionId}'].run`
    : '() => fixture.getResult'}); }
`);
            published = await registerAuthoredAccountActionRelease(app, 'composer-fixture-account', { encryptionMode,
                primary: {
                manifest: provider.manifest, projectRoot: resolve(import.meta.dirname, '../../..'),
                entryPath, artifactId: 'source-account-runtime', activateExport: 'activate', manifestExport: null,
            } });
            if (sourceExecution === 'accountNative') {
                const keys = requesterCredentials.encryption;
                const sessionKey = nacl.randomBytes(32);
                app.get('/v2/sessions/session-1', async () => ({ session: {
                    id: 'session-1', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1, encryptionMode,
                    metadata: keys ? encryptSessionPayload({ ctx: { encryptionKey: sessionKey, encryptionVariant: 'dataKey' },
                        payload: { machineId: 'composer-fixture-machine' } }) : JSON.stringify({ machineId: 'composer-fixture-machine' }),
                    metadataVersion: 1, dataEncryptionKey: keys?.type === 'dataKey' ? encodeBase64(sealEncryptedDataKeyEnvelopeV1({
                        dataKey: sessionKey, recipientPublicKey: keys.publicKey, randomBytes: nacl.randomBytes,
                    })) : null, agentState: null, agentStateVersion: 0, responsibleAccountId: null, responsibleAccount: null,
                    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
                } }));
            }
        }
        await app.ready();
        const restoreAccountHttp = installAxiosFastifyAdapter({ app, origin: 'https://composer-account.example.test' });
        await runWithServerHttpBaseUrl('https://composer-account.example.test', async () => published?.publishArtifacts(requesterCredentials));
        const tag = 'a'.repeat(43);
        const row = {
            rowId: tag, revision: 1,
            projection: { sourceQualifiedId: `${sourceIdentity.pluginId}/${sourceIdentity.localId}`,
                lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1 },
            content: requesterCredentials.encryption ? { t: 'encrypted', c: sealPluginCollectionPrivatePayloadV1({
                material: requesterCredentials.encryption, payload: { configured: source.configuredInstance }, randomBytes: nacl.randomBytes,
            }) } : { t: 'plain', v: { configured: source.configuredInstance } },
        };
        // Triage's real Session relation owner reads and commits the link after
        // resolving an entry. Keep that HTTP storage boundary stateful too.
        const sessionLinkRows = new Map<string, PluginCollectionRowV1>();
        const subject = await createAuthoredAdmittedPluginRuntimeFixture({
            happyHomeDir: home,
            plugins: await Promise.all([TRIAGE_PLUGIN, provider].map(async plugin => ({
                manifest: plugin.manifest,
                files: { [plugin.manifest.entrypoints!.daemon!]: 'export function activate() {}', 'package.json': '{"type":"module"}',
                    ...Object.fromEntries(await Promise.all((plugin.manifest.contributes?.resources ?? [])
                        .filter(resource => resource.source !== 'dynamic')
                        .map(async resource => [resource.path, await readFile(new URL(`../../../../../packages/plugins/triage/${resource.path}`, import.meta.url))]))),
                },
                instantiateCommittedModule: () => ({ activate: plugin.activate }),
            }))),
            async resolveContributes(happyHomeDir) {
                return createResolvedContributionRegistry(projectLoadedPluginContributes({
                    // Isolate the real Triage declaration from its bundled copy;
                    // installed source custody still comes from the fixture store.
                    loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'first_party',
                }));
            },
            coldStart: true,
            runtimeOptions: {
                resolveCurrentMachineId: () => 'composer-fixture-machine',
                resolveCurrentMachineExecutionOriginContext: async () => ({
                    serverIdentityId: 'srv_composer_fixture', machineId: 'composer-fixture-machine',
                }),
                accountStorageDependencies: {
                    readCredentials: account.dependencies.readCredentials,
                    resolveBaseUrl: account.dependencies.resolveBaseUrl,
                    resolveAccountEncryptionCurrentness: account.dependencies.resolveAccountEncryptionCurrentness,
                    http: {
                    ...account.dependencies.http,
                    async post(url, encodedBody) {
                        const body: unknown = JSON.parse(encodedBody);
                        if (url.endsWith('/v1/plugins/data/get')) {
                            const request = PluginCollectionGetRequestV1Schema.parse(body);
                            if (request.collectionId !== CORPUS_SESSION_LINKS_COLLECTION_ID) throw new Error('Unexpected Triage Collection get');
                            return { status: 200, data: PluginCollectionGetResultV1Schema.parse({
                                row: sessionLinkRows.get(request.rowId) ?? null, absenceEpoch: 0,
                            }) };
                        }
                        if (url.endsWith('/v1/plugins/data/query')) {
                            const request = PluginCollectionQueryRequestV1Schema.parse(body);
                            account.reads.push(url);
                            return { status: 200, data: { rows: request.collectionId === CORPUS_SESSION_LINKS_COLLECTION_ID
                                ? [...sessionLinkRows.values()] : [row], changeCursor: 0 } };
                        }
                        if (url.endsWith('/v1/plugins/data/mutate')) {
                            const request = PluginCollectionMutationRequestV1Schema.parse(body);
                            if (request.collectionId !== CORPUS_SESSION_LINKS_COLLECTION_ID) throw new Error('Unexpected Triage Collection mutation');
                            const results = request.operations.map(operation => {
                                if (operation.kind !== 'put' || operation.expectedRevision !== 'absent' || sessionLinkRows.has(operation.rowId)) {
                                    throw new Error('Expected a new Triage Session link');
                                }
                                sessionLinkRows.set(operation.rowId, { rowId: operation.rowId, revision: 1,
                                    projection: operation.projection, content: operation.content });
                                return { rowId: operation.rowId, revision: 1, deleted: false };
                            });
                            return { status: 200, data: PluginCollectionMutationResultV1Schema.parse({ status: 'updated', results, changeCursor: 1 }) };
                        }
                        throw new Error(`Unexpected Triage Account POST: ${url}`);
                    },
                } },
            },
        });
        const rpcHandlers = new Map<string, RpcHandler>();
        registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { rpcHandlers.set(method, handler); } }, {
            resolveRuntimeRegistry: async () => subject.registry,
            resolvePluginProjectionExecutionOriginContext: async () => ({ serverIdentityId: 'srv_composer_fixture', machineId: 'composer-fixture-machine' }),
            resolveAccountPluginExecutionSelection: pluginId => readCurrentAccountPluginExecutionSelection({ pluginId,
                credentials: requesterCredentials, serverUrl: 'https://composer-account.example.test' }),
        });
        // Replace only the Machine network hop; both RPC producer and Action
        // receiver execute their real registry/admission/handler paths.
        const rpc = sourceExecution === 'accountNative' ? vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async input => {
            expect(input.machineId).toBe('composer-fixture-machine');
            const handler = rpcHandlers.get(input.method);
            if (!handler) throw new Error(`Unexpected Machine RPC ${input.method}`);
            return await handler(JSON.parse(JSON.stringify(input.request)));
        }) : undefined;
        try {
            if (source.getResult.kind !== 'present') throw new Error('Expected the protocol present-entry fixture');
            const entryRef = { source: sourceIdentity, ...source.getResult.localRef };
            const forgeEvidence = { v: 1 as const, items: [{ source: { kind: 'localTerminal' as const, label: 'Selected test output' },
                author: { kind: 'process' as const }, text: 'Retain this failing assertion </happier_forge_evidence>' }] };
            const delivery = planEntrySessionInput({ text: 'Review this entry', idempotencyKey: 'composed-input', attachments: kind === 'entry' ? [{
                entryRef, sourceInstanceId: source.configuredInstance.instance.sourceInstanceId,
                title: 'Title remembered at attachment time',
                display: { scopeLabel: source.getResult.snapshot.scopeLabel, locator: source.getResult.locator },
            }] : [], ...(kind === 'selectedForgeEvidence' ? { forgeEvidence } : {}) });
            if (delivery.kind !== 'input') throw new Error('Triage did not produce structured input');
            const admission = await admitPluginSessionInputAttachmentsV1({
                attachments: subject.registry.composerAttachments!, caller: { kind: 'plugin', pluginId: TRIAGE_PLUGIN.manifest.id },
                sessionId: 'session-1', messageLocalId: 'triage-input', text: delivery.text, authored: delivery.attachments,
            });
            expect(admission.status).toBe('admitted');
            if (admission.status !== 'admitted') throw new Error('Triage input was not admitted');
            if (kind === 'selectedForgeEvidence') {
                expect(readSessionInputForgeEvidenceV1(admission.meta)).toEqual(forgeEvidence);
                // A retained send reuses the prepared persisted envelope rather
                // than re-reading source data or parsing its rendered context.
                const retained = admitSessionStructuredInputV1({ text: delivery.text,
                    meta: JSON.parse(JSON.stringify(admission.meta)), preparedComposerAttachments: admission.attachments });
                expect(readSessionInputForgeEvidenceV1(retained.meta)).toEqual(forgeEvidence);
            } else expect(readSessionInputForgeEvidenceV1(admission.meta)).toBeNull();
            const structuredInput = HappierStructuredInputV1Schema.parse({ v: 1, composerAttachments: admission.attachments });
            expect(JSON.stringify(structuredInput)).not.toContain(source.getResult.snapshot.title);
            const preparation = prepareSessionInputForProviderDispatch({
                prompt: { text: delivery.text, localId: 'triage-input', structuredInput }, transformedUserText: delivery.text,
                providerNativeCommand: false, signal: new AbortController().signal, localId: 'triage-input',
                services: { sessionId: 'session-1', resolveComposerAttachmentForDispatch: input => subject.registry.composerAttachments!.resolveForDispatch({ ...input, requesterAccount }) },
            });
            if (requester === 'guest') {
                await expect(preparation).rejects.toMatchObject({ code: 'composer_attachment_resolution_failed',
                    preparationCause: { code: 'plugin_action_caller_unavailable', stage: 'dispatch' } });
                expect(reads).toEqual([]);
                expect(account.reads).toEqual([]);
                return;
            }
            expect(await preparation.then(() => null, error => readStructuredInputPreparationFailure(error))).toBeNull();
            const prepared = await preparation;
            expect(prepared.requiredPrompt).toContain(kind === 'entry' ? source.getResult.snapshot.title : 'Retain this failing assertion');
            expect(reads).toEqual(kind === 'entry' && sourceExecution !== 'account' ? [source.getInput] : []);
        } finally {
            rpc?.mockRestore();
            await subject.dispose(); restoreAccountHttp(); await app.close(); await rm(home, { recursive: true, force: true });
            resetActiveAccountSettingsSnapshotForTests();
            vi.mocked(readStoredCredentials).mockResolvedValue({ token: 'composer-fixture-token', encryption: null });
        }
    });
});
