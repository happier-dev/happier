import { describe, expect, it, vi } from 'vitest';
import { definePlugin, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { HappierStructuredInputV1Schema } from '@happier-dev/protocol';
import { TriageSourcesContributionProtocolV1 } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';

import { prepareSessionInputForProviderDispatch } from '@/agent/runtime/turns/prepareSessionInputForProviderDispatch';
import { admitPluginSessionInputAttachmentsV1 } from '@/session/composer/admitPluginSessionInputAttachmentsV1';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { TRIAGE_PLUGIN } from '../../../../../packages/plugins/triage/src/manifest';
import { planEntrySessionInput } from '../../../../../packages/plugins/triage/src/sessions/entrySessionDelivery';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../../../../../packages/plugins/triage/src/corpus/collections/ids';

import type { AccountPluginDataStorageHostDependencies } from './context/accountPluginDataStorage';

// Stored sign-in is an OS credential boundary. A real captured Account is also
// required to construct the host Action service consumed by Triage's source get.
vi.mock('@/persistence', async importOriginal => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readStoredCredentials: async () => ({ token: 'composer-fixture-token', encryption: null }),
}));

const pluginId = 'acme.composer-account-context';
const marker = 'Fresh Account context for the selected issue';
const collection = {
    id: 'issues', schemaVersion: 1,
    schema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'text'], additionalProperties: false },
    rowIdField: 'id', serverReadable: ['id'], indexes: [],
} as const;

function accountBoundary() {
    const credentials = { token: 'composer-fixture-token', encryption: null } as const;
    let current = true;
    const reads: string[] = [];
    // Substitute only credentials and Account HTTP. Storage declaration checks,
    // mode admission, decoding and invocation/occurrence fences remain real.
    const dependencies = {
        readCredentials: async () => credentials,
        isCurrentAccount: () => current,
        resolveAccountScopeKey: () => resolveAccountSettingsScopeKey(credentials),
        resolveBaseUrl: () => 'https://composer-account.example.test',
        resolveAccountEncryptionCurrentness: async () => ({
            mode: 'plain', version: 1, signingKeyFingerprint: null,
            contentKeyFingerprint: null, updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
        }),
        http: {
            async get(url) {
                if (url.endsWith('/v1/account/encryption')) {
                    return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                }
                throw new Error(`Unexpected Account GET: ${url}`);
            },
            async post(url) {
                reads.push(url);
                if (url.endsWith('/v1/plugins/data/get')) {
                    return { status: 200, data: { row: {
                        rowId: '42', revision: 1, projection: { id: '42' },
                        content: { t: 'plain', v: { text: marker } },
                    } } };
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

    it('does not lend undeclared Account storage to attachments or references', async () => {
        const subject = await fixture(false);
        try {
            await expect(prepare(subject.registry)).rejects.toMatchObject({ code: 'composer_attachment_resolution_failed' });
            await expect(subject.registry.composerReferences!.resolve({ reference: { pluginId, localId: 'issue-reference' },
                candidateId: '42', signal: new AbortController().signal }))
                .rejects.toMatchObject({ code: 'fixture_account_unavailable' });
            expect(subject.account.reads).toEqual([]);
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

    it('dispatches the real Triage delivery producer through activation, Account storage and the admitted source', async () => {
        const source = createTriageSourceV1Fixture();
        const sourceIdentity = source.configuredInstance.instance.source;
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
                get: { title: 'Get', surfaces: roles.get.declaration.surfaces,
                    dangerLevel: 'safe', inputSchema: roles.get.declaration.input.schema,
                    resultSchema: roles.get.declaration.resultSchema,
                    run(input) { reads.push(input); return source.getResult; } },
            },
            ui: { renderers: [{ id: 'detail', kind: 'declarative', root: { kind: 'text', text: 'Source detail' } }] },
            contributesTo: { 'happier.triage': { sources: { [sourceIdentity.localId]:
                TriageSourcesContributionProtocolV1.contribute({ descriptor: source.descriptor,
                    operations: { listInstances: roles.listInstances.bind('instances'), scan: roles.scan.bind('scan'), get: roles.get.bind('get') },
                    surfaces: { detail: { renderer: 'detail' } },
                }),
            } } },
        });
        const account = accountBoundary();
        const tag = 'a'.repeat(43);
        const row = {
            rowId: tag, revision: 1,
            projection: { sourceQualifiedId: `${sourceIdentity.pluginId}/${sourceIdentity.localId}`,
                lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1 },
            content: { t: 'plain', v: { configured: source.configuredInstance } },
        };
        const subject = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [TRIAGE_PLUGIN, provider].map(plugin => ({
                manifest: plugin.manifest,
                files: { [plugin.manifest.entrypoints!.daemon!]: 'export function activate() {}', 'package.json': '{"type":"module"}' },
                instantiateCommittedModule: () => ({ activate: plugin.activate }),
            })),
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
                accountStorageDependencies: { ...account.dependencies, http: {
                    ...account.dependencies.http,
                    async post(url) {
                        if (url.endsWith('/v1/plugins/data/query')) {
                            return { status: 200, data: { rows: [row], changeCursor: 0 } };
                        }
                        throw new Error(`Unexpected Triage Account POST: ${url}`);
                    },
                } },
            },
        });
        try {
            if (source.getResult.kind !== 'present') throw new Error('Expected the protocol present-entry fixture');
            const entryRef = { source: sourceIdentity, ...source.getResult.localRef };
            const delivery = planEntrySessionInput({ text: 'Review this entry', idempotencyKey: 'composed-input', attachments: [{
                entryRef, sourceInstanceId: source.configuredInstance.instance.sourceInstanceId,
                title: 'Title remembered at attachment time',
                display: { scopeLabel: source.getResult.snapshot.scopeLabel, locator: source.getResult.locator },
            }] });
            if (delivery.kind !== 'input') throw new Error('Triage did not produce structured input');
            const admission = await admitPluginSessionInputAttachmentsV1({
                attachments: subject.registry.composerAttachments!, pluginId: TRIAGE_PLUGIN.manifest.id,
                sessionId: 'session-1', messageLocalId: 'triage-input', text: delivery.text, authored: delivery.attachments,
            });
            expect(admission.status).toBe('admitted');
            if (admission.status !== 'admitted') throw new Error('Triage input was not admitted');
            const structuredInput = HappierStructuredInputV1Schema.parse({ v: 1, composerAttachments: admission.attachments });
            expect(JSON.stringify(structuredInput)).not.toContain(source.getResult.snapshot.title);
            const prepared = await prepareSessionInputForProviderDispatch({
                prompt: { text: delivery.text, localId: 'triage-input', structuredInput }, transformedUserText: delivery.text,
                providerNativeCommand: false, signal: new AbortController().signal, localId: 'triage-input',
                services: { sessionId: 'session-1', resolveComposerAttachmentForDispatch: input => subject.registry.composerAttachments!.resolveForDispatch(input) },
            });
            expect(prepared.requiredPrompt).toContain(source.getResult.snapshot.title);
            expect(reads).toEqual([source.getInput]);
        } finally { await subject.dispose(); }
    });
});
