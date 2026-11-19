import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch } from 'node:fs';

import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createUnavailablePluginInvocationServiceBinding } from '../invocation/services/factory';
import { createUnavailablePluginServices } from '../invocation/services/unavailable';
import { createPluginInvocationPresentation } from '../invocation/services/interactions';
import { activatePluginRuntimeRegistry } from './manager';
import { bindPluginRuntimeSourceAuthority, resolvePluginSourceCustody } from '../sourceAuthority';
import { projectAdmittedBackgroundServicePlugin } from './contributions/backgroundServiceProcessSource';
import { resolveBackgroundServiceProcessBootstrap, type BackgroundServiceProcessPluginHost } from './contributions/backgroundServiceProcessBootstrap';
import { createProductionPluginInvocationServiceOwners } from '../invocation/services/production';
import { createBackgroundServiceProcessServiceClient, createBackgroundServiceProcessServiceHost, type BackgroundServiceProcessBridgeMessage } from './contributions/backgroundServiceProcessBridge';
import { waitForProcessExit } from '@/testkit/process/spawn';
import type { PluginRuntimeOccurrenceId } from '../runtimeSlots';

describe('admitted background service host activation', () => {
    it('executes a consumed external-session reader with child-local Exec and daemon-admitted operation roots', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-background-consumed-reader-'));
        const controller = new AbortController();
        const owner = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, exec: {
            resolveExecutable: async () => { throw new Error('Reader must use its admitted system tool'); },
            resolvePath: async () => { throw new Error('Reader must use its operation filesystem roots'); },
        } });
        try {
            const pluginId = 'acme.consumed-reader';
            const localAgentId = 'native-reader';
            const occurrenceId = 'daemon-admitted-reader-occurrence' as PluginRuntimeOccurrenceId;
            const entryPath = join(root, 'daemon.mjs');
            await writeFile(join(root, 'native-transcript'), 'native operation roots');
            await writeFile(entryPath, `
                import { appendFile } from 'node:fs/promises';
                export function activate(api) {
                    api.agents.registerExternalSessions(${JSON.stringify(localAgentId)}, {
                        async resolveSource(request) { return { ok: true, value: { source: request.source } }; },
                        async listCandidates(request) {
                            try {
                            const tool = await request.exec.systemTools.resolve({ toolId: 'fixture-reader', purpose: 'Read the native transcript fixture' });
                            const result = await request.exec.run({ executable: tool.executable,
                                cwd: { root: 'workspace', relativePath: '' },
                                args: ['-e', request.source.mode === 'hold'
                                    ? 'require("node:fs").writeFileSync("reader-started",String(process.pid)); setInterval(() => {}, 1000)'
                                    : 'const fs = require("node:fs"); process.stdout.write(JSON.stringify({pid:process.pid,text:fs.readFileSync("native-transcript","utf8")}))'] });
                            if (result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0) throw new Error('reader_process_failed: ' + JSON.stringify(result.termination));
                            const observed = JSON.parse(Buffer.from(result.stdout).toString('utf8'));
                            return { ok: true, value: { candidates: [{ remoteSessionId: String(observed.pid), title: observed.text, updatedAtMs: 1 }], nextCursor: null } };
                            } catch (error) {
                                await appendFile(${JSON.stringify(join(root, 'reader-errors'))}, JSON.stringify({mode:request.source.mode,message:error.message,data:error.data}) + '\\n');
                                throw error;
                            }
                        },
                        async resolveLinkIdentity(request) { return { ok: true, value: { source: request.source, remoteSessionId: request.remoteSessionId, linkData: {} } }; },
                        async resolveLinkedIdentity(request) { return { ok: true, value: { source: request.source, remoteSessionId: request.remoteSessionId, linkData: request.linkData } }; },
                        async pageTranscript() { return { ok: true, value: { items: [], nextCursor: null } }; },
                        async readAfterTranscript() { return { ok: true, value: { outcome: 'already_current' } }; },
                    });
                }
            `);
            const parsed = ingestCanonicalPluginManifest({
                schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Consumed native reader',
                engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
                hostAccess: { required: [{ id: 'reader-exec', capability: 'process', reason: 'Read native transcript fixture', scope: { executables: [{ kind: 'systemTool', id: 'fixture-reader' }] } },
                    { id: 'runtime-terminal', capability: 'terminal', reason: 'Run the Agent interactive session', scope: { operations: ['open'] } }] },
                contributes: { systemTools: [{ id: 'fixture-reader', title: 'Fixture reader', executableNames: ['fixture-reader'] }], agents: [{ id: localAgentId, title: 'Native reader',
                    capabilities: { surfaces: ['externalSessions'] },
                    surfaces: { externalSession: { sources: [{ sourceKind: 'nativeFixture',
                        schema: { fields: [{ name: 'kind', kind: 'literal', value: 'nativeFixture' }, { name: 'mode', kind: 'enum', values: ['read', 'hold'] }] },
                        key: { segments: [{ kind: 'literal', value: 'nativeFixture' }] },
                        instances: [{ kind: 'default', constants: { mode: 'read' } }],
                    }] } },
                }] },
            }, { sourceProvenance: 'registryCustodied' });
            if (!parsed.ok) throw new Error(parsed.diagnostics.map(({ message }) => message).join('\n'));
            const sourceAuthority = bindPluginRuntimeSourceAuthority({
                custody: { kind: 'development', registeredRootId: root }, resolvedRoot: root, observedRevision: 1,
            });
            const admitted = projectAdmittedBackgroundServicePlugin({
                target: {
                    provenance: 'external', source: { kind: 'path' }, pluginId,
                    manifestPath: join(root, 'plugin.json'), daemonEntryPath: entryPath,
                    sourceSpec: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link' },
                    manifest: parsed.manifest,
                },
                occurrenceId, sourceCustody: resolvePluginSourceCustody(sourceAuthority),
                source: { kind: 'file_backed', sourceAuthority, entryPath },
            });
            const requests: { pluginId: string; agentId: string; occurrenceId: string }[] = [];
            let retainedOperationServices = 0;
            const roots: { __backgroundServiceProcessPlugins: BackgroundServiceProcessPluginHost } = {
                __backgroundServiceProcessPlugins: {
                    prepareAgentInvocationServices: async request => {
                        requests.push({ pluginId: request.pluginId, agentId: request.agentId, occurrenceId: request.occurrenceId });
                        const prepared = await owner.prepareBackgroundServiceProcessOperationServices({
                            plugin: { id: request.pluginId, version: request.pluginVersion },
                            contribution: { id: localAgentId, qualifiedId: `${pluginId}/agents/${localAgentId}` },
                            occurrenceId: request.occurrenceId, correlationId: request.correlationId,
                            surface: 'agent', signal: request.signal, isOccurrenceCurrent: () => !controller.signal.aborted,
                        }, {
                            filesystemRoots: { pluginData: root, workspace: root, projects: new Map() },
                            hostAccessRequests: (parsed.manifest.hostAccess?.required ?? []).map(access => ({ request: access, required: true })),
                            systemTools: { resolve: async () => ({
                                grantId: 'native-reader-grant', toolId: 'fixture-reader', displayName: 'Fixture reader', source: 'managed',
                                executablePath: process.execPath, launch: { kind: 'binary', executablePath: process.execPath },
                            }) },
                            resolveExecutable: async () => { throw new Error('Reader must use its admitted system tool'); },
                        });
                        // Count live capabilities at the real parent/child service boundary.
                        retainedOperationServices += 1;
                        return { ...prepared, async dispose() {
                            await prepared.dispose();
                            retainedOperationServices -= 1;
                        } };
                    },
                },
            };
            let client: ReturnType<typeof createBackgroundServiceProcessServiceClient<typeof roots>>;
            // A JSON copy preserves the real transport boundary: callbacks and signals cannot cross by reference.
            const copy = (message: BackgroundServiceProcessBridgeMessage) => JSON.parse(JSON.stringify(message));
            const host = createBackgroundServiceProcessServiceHost({ services: roots, send: message => queueMicrotask(() => client.receive(copy(message))) });
            client = createBackgroundServiceProcessServiceClient<typeof roots>({ description: JSON.parse(JSON.stringify(host.description)), send: message => queueMicrotask(() => host.receive(copy(message))) });
            let observed: Awaited<ReturnType<NonNullable<import('./contributions/targetAgents').AgentRuntimeRegistrationLease['externalSessions']>['listCandidates']>> | undefined;
            const loaded = await resolveBackgroundServiceProcessBootstrap(JSON.parse(JSON.stringify({
                entry: 'host', entryId: 'memory-indexer', payload: {}, plugins: [admitted],
            })), { loadHostEntry: async () => ({
                async run(context) {
                    const runtime = [...(context.agentRuntimesByAgentId?.values() ?? [])].find(entry => entry.localAgentId === localAgentId);
                    if (!runtime?.externalSessions) throw new Error('Consumed reader is unavailable');
                    observed = await runtime.externalSessions.listCandidates({
                        source: { kind: 'nativeFixture', mode: 'read' }, maxItems: 1, maxSerializedBytes: 1_048_576,
                        deadlineAtMs: Date.now() + 30_000, signal: context.signal,
                    });
                    expect(observed, await readFile(join(root, 'reader-errors'), 'utf8').catch(() => '')).toMatchObject({ ok: true });
                    expect(retainedOperationServices).toBe(0);
                    const cancellation = new AbortController();
                    let resolveStarted!: (pid: number) => void;
                    let rejectStarted!: (error: Error) => void;
                    const started = new Promise<number>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
                    const watcher = watch(root, () => {
                        void readFile(join(root, 'reader-started'), 'utf8').then(text => {
                            const pid = Number(text);
                            if (Number.isSafeInteger(pid) && pid > 1) resolveStarted(pid);
                        }).catch(() => {});
                    });
                    watcher.once('error', rejectStarted);
                    try {
                        const pending = Promise.resolve(runtime.externalSessions.listCandidates({
                            source: { kind: 'nativeFixture', mode: 'hold' }, maxItems: 1, maxSerializedBytes: 1_048_576,
                            deadlineAtMs: Date.now() + 30_000, signal: cancellation.signal,
                        }));
                        const pid = await Promise.race([started, pending.then(async result => {
                            const detail = await readFile(join(root, 'reader-errors'), 'utf8').catch(() => '');
                            throw new Error(`Reader settled before its native process started: ${JSON.stringify(result)} ${detail}`);
                        })]);
                        cancellation.abort();
                        await expect(pending).resolves.toMatchObject({ ok: false, code: 'cancelled' });
                        expect(await waitForProcessExit(pid)).toBe(true);
                        expect(context.signal.aborted).toBe(false);
                        expect(retainedOperationServices).toBe(0);
                    } finally { cancellation.abort(); watcher.close(); }
                },
            }) });
            try {
                await loaded.run({ signal: controller.signal, services: client.services });
                expect(observed).toMatchObject({ ok: true, value: { candidates: [{ title: 'native operation roots' }], nextCursor: null } });
                if (!observed?.ok) throw new Error('Expected native reader result');
                expect(Number(observed.value.candidates[0]!.remoteSessionId)).toBeGreaterThan(1);
                expect(Number(observed.value.candidates[0]!.remoteSessionId)).not.toBe(process.pid);
                expect(requests).toEqual([
                    { pluginId, agentId: `${pluginId}/${localAgentId}`, occurrenceId },
                    { pluginId, agentId: `${pluginId}/${localAgentId}`, occurrenceId },
                ]);
            } finally { await loaded.dispose(); await client.dispose(); await host.dispose(); }
        } finally { controller.abort(); await owner.dispose(); await rm(root, { recursive: true, force: true }); }
    });

    it('round-trips only the selected admitted source and runner without store discovery or sibling work', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-background-bootstrap-'));
        try {
            const entryPath = join(root, 'daemon.mjs');
            const output = join(root, 'runs');
            await writeFile(entryPath, `
                import { appendFile } from 'node:fs/promises';
                export function activate(api) {
                    api.backgroundServices.register('selected', async context => {
                        context.signal.throwIfAborted();
                        await appendFile(${JSON.stringify(output)}, 'selected\\n');
                    });
                    api.backgroundServices.register('sibling', async () => {
                        await appendFile(${JSON.stringify(output)}, 'sibling\\n');
                    });
                }
            `);
            const pluginId = 'acme.admitted-child';
            const parsed = ingestCanonicalPluginManifest({
                schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Admitted child',
                engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 },
                entrypoints: { daemon: './daemon.mjs' },
                contributes: { backgroundServices: [{ id: 'selected' }, { id: 'sibling' }] },
            }, { sourceProvenance: 'registryCustodied' });
            if (!parsed.ok) throw new Error(parsed.diagnostics.map(({ message }) => message).join('\n'));
            const sourceAuthority = bindPluginRuntimeSourceAuthority({
                custody: { kind: 'development', registeredRootId: root }, resolvedRoot: root, observedRevision: 1,
            });
            const admitted = projectAdmittedBackgroundServicePlugin({
                target: {
                    provenance: 'external', source: { kind: 'path' }, pluginId,
                    manifestPath: join(root, 'plugin.json'), daemonEntryPath: entryPath,
                    sourceSpec: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link' },
                    manifest: parsed.manifest,
                },
                occurrenceId: 'daemon-admitted-occurrence' as PluginRuntimeOccurrenceId,
                sourceCustody: resolvePluginSourceCustody(sourceAuthority),
                source: { kind: 'file_backed', sourceAuthority, entryPath },
            });
            const loaded = await resolveBackgroundServiceProcessBootstrap(JSON.parse(JSON.stringify({
                entry: 'plugin', payload: { pluginId, localId: 'selected', generation: 7, plugins: [admitted] },
            })));
            try {
                await loaded.run({
                    plugin: { id: pluginId, version: '1.0.0' },
                    contribution: { id: 'selected', qualifiedId: `${pluginId}/backgroundServices/selected` },
                    surface: 'background', invokedAtMs: 1,
                    signal: new AbortController().signal,
                    services: createUnavailablePluginServices(),
                    ui: createPluginInvocationPresentation({ currentSession: null, signal: new AbortController().signal, isOccurrenceCurrent: () => true }),
                });
                expect(await readFile(output, 'utf8')).toBe('selected\n');
            } finally { await loaded.dispose(); }
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('loads ordinary activate registrations without starting sibling services', async () => {
        const pluginId = 'acme.service-host';
        const parsed = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Service host',
            engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            contributes: { backgroundServices: [{ id: 'selected' }, { id: 'sibling' }] },
        }, { sourceProvenance: 'registryCustodied' });
        if (!parsed.ok) throw new Error(parsed.diagnostics.map(({ message }) => message).join('\n'));
        const contributes = createResolvedContributionRegistry({
            activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
                manifestPath: '/virtual/plugin.json', daemonEntryPath: '@example/service-host',
                sourceSpec: { kind: 'bundled', locator: '@example/service-host', trustPolicy: 'local_trusted', installPolicy: 'copy' },
                manifest: parsed.manifest,
            }],
        });
        const runs: string[] = [];
        let activations = 0;
        const registry = await activatePluginRuntimeRegistry({
            contributes, generation: 7, pluginIds: [pluginId],
            serviceHost: true,
            invocationServices: {
                createOrdinaryServiceBinding: () => createUnavailablePluginInvocationServiceBinding('7', 'service-host'),
                createServices: () => createUnavailablePluginServices(),
            },
            resolveActivationSource: () => ({
                kind: 'bundled', moduleId: '@example/service-host',
                load: async () => ({
                    activate(api: import('@happier-dev/plugin-sdk').PluginApi) {
                        activations += 1;
                        api.backgroundServices.register('selected', async () => { runs.push('selected'); });
                        api.backgroundServices.register('sibling', async () => { runs.push('sibling'); });
                    },
                }),
            }),
        });
        try {
            expect(activations).toBe(1);
            expect(registry.targetRegistrations.map(({ registration }) => registration.localId)).toEqual(['selected', 'sibling']);
            registry.startAdoptedBackgroundServices();
            await Promise.resolve();
            await Promise.resolve();
            expect(runs).toEqual([]);
            expect(registry.pluginDiagnosticsByPluginId[pluginId]).toEqual([]);
        } finally {
            await registry.dispose();
        }
    });
});
