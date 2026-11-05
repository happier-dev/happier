import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentExternalSessionsContribution } from '@happier-dev/plugin-sdk/sessions/external';
import { FeaturesResponseSchema, ingestPluginManifestV2, UsageEventIngestRequestSchema } from '@happier-dev/protocol';
import { resolveExternalSessionsSourceKeyForDeclaration } from '@happier-dev/protocol/sessions/external/sourceCatalog';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-claude/manifest';
import { PLUGIN_MANIFEST as PI_MANIFEST } from '@happier-dev/plugins-pi/manifest';
import { createPiExternalSessionsContribution } from '../../../../../packages/plugins/pi/src/agent/externalSessions/contribution';
import { resolvePiExternalSessionSource } from '../../../../../packages/plugins/pi/src/agent/externalSessions/source';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { createBoundedAgentExternalSessionsContribution } from '@/session/external/agentExternalSessionsInvocation';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { discoverNativeUsageSourceMetadata, resolveNativeUsageSourceMetadata } from './nativeUsageSourceDiscovery';
import { readNativeUsageAccountingAtAdmission } from './nativeUsageDaemonRuntime';
import { deriveNativeUsageAccountingIdentity } from './nativeUsageAccountingIdentity';
import { resolveExternalSessionSourceFromAgentProjection } from '@/plugins/projection/registry/externalSessionSources';
import { createExternalSessionObservationDaemonProjection } from '@/api/session/external/leases/createExternalSessionObservationDaemonProjection';
import { createClaudeExternalSessionsContribution } from '../../../../../packages/plugins/claude/src/agent/surfaces/sessions/external/contribution';
import { createNativeUsageCollector } from './nativeUsageCollector';
import { createNativeUsageCaptureStore } from './nativeUsageCaptureState';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { createUsageObservationPublisher } from '../createUsageObservationPublisher';
import { UsageSourcesListV1Schema } from '@happier-dev/protocol/usage/usageSources';

const nativeFileBoundary = vi.hoisted(() => ({ opendir: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs/promises')>();
    nativeFileBoundary.opendir.mockImplementation(fs.opendir);
    return { ...fs, opendir: (...args: Parameters<typeof fs.opendir>) => nativeFileBoundary.opendir(...args) };
});

afterEach(() => { vi.unstubAllEnvs(); });

describe('native source metadata discovery', () => {
    it('keeps discovery-only configured identity out of sealed accounting custody', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-source-custody-'));
        try {
            const ingestion = ingestPluginManifestV2(PLUGIN_MANIFEST);
            if (!ingestion.ok) throw new Error(JSON.stringify(ingestion.diagnostics));
            const agents = ingestion.manifest.contributes.agents.map(definition => projectManifestAgentContribution({
                definition, pluginId: ingestion.manifest.id, provenance: 'first_party', source: { kind: 'bundled' },
            }));
            const retirement = new AbortController();
            const bounded = createBoundedAgentExternalSessionsContribution({
                contribution: createClaudeExternalSessionsContribution({ env: { NODE_ENV: 'test', CLAUDE_CONFIG_DIR: directory } }),
                identity: { pluginId: ingestion.manifest.id, agentId: 'claude', occurrenceId: 'current',
                    contributionQualifiedId: `${ingestion.manifest.id}/agents/claude`, sourceCustody: { kind: 'development', registeredRootId: 'root' } },
                retirementSignal: retirement.signal, isCurrent: () => true,
                createInvocationExec: async () => createUnavailablePluginServices().exec,
            });
            const authority = { serverId: 'home', accountId: 'account', machineId: 'machine' };
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const store = createNativeUsageCaptureStore({ authority, storage, path: join(directory, 'capture.sealed') });
            await mkdir(join(directory, 'projects', 'project'), { recursive: true });
            // File metadata is enough: these deliberately invalid records must never be opened by discovery.
            await writeFile(join(directory, 'projects', 'project', 'one.jsonl'), 'PRIVATE_INVALID_NATIVE_CONTENT');
            await writeFile(join(directory, 'projects', 'project', 'two.jsonl'), 'PRIVATE_INVALID_NATIVE_CONTENT');
            const unavailable = async () => { throw new Error('Unconsented accounting access'); };
            const collector = createNativeUsageCollector({ authority, storage, store,
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }),
                discoverSources: () => discoverNativeUsageSourceMetadata({ agents, account: { connectedServicesV2: [] },
                    activeServerId: 'home', activeServerDir: directory, signal: new AbortController().signal,
                    resolveBoundary: async () => ({ catalogEntry: null, externalSessions: bounded, occurrenceId: 'current', retirementSignal: retirement.signal, isCurrent: () => true }) }),
                resolveRoot: unavailable, readAccounting: unavailable, subscribeSource: unavailable,
                publisher: { publish: unavailable }, deleteHistory: unavailable,
            });
            try {
                const discovered = await collector.discover();
                expect(discovered[0]).toMatchObject({ accountingSources: ['claude-assistant-usage', 'claude-sdk-result'], captureKind: 'from_logs' });
                expect(discovered[0]).toMatchObject({ discoveredFileCount: 2, consent: 'disabled', pendingCount: 0 });
                expect(UsageSourcesListV1Schema.parse({ sources: discovered }).sources[0].discoveredFileCount).toBe(2);
                expect(discovered[0]).not.toHaveProperty('tokens');
                expect(discovered[0]).not.toHaveProperty('sessionCount');
                const state = await store.load();
                expect(state.sources).toHaveLength(1);
                expect(state.sources[0].agent).toEqual({ pluginId: ingestion.manifest.id, localId: 'claude' });
                expect(state.sources[0]).toMatchObject({ accountingSources: ['claude-assistant-usage', 'claude-sdk-result'] });
                expect(state.sources[0]).not.toHaveProperty('configuredSourceKey');
                expect(state.sources[0]).not.toHaveProperty('discoveredFileCount');
                expect((await collector.get())[0]).not.toHaveProperty('discoveredFileCount');
                // Reauthorizing a retained source needs identity, not another
                // accounting inventory. Real plugin/host admission stays live.
                nativeFileBoundary.opendir.mockRejectedValueOnce(new Error('identity admission must not enumerate accounting history'));
                const identityOnly = await resolveNativeUsageSourceMetadata({ agents, agentId: 'claude',
                    source: state.sources[0]!.source, activeServerDir: directory, signal: new AbortController().signal,
                    includeAccountingSource: false,
                    boundary: { catalogEntry: null, externalSessions: bounded, occurrenceId: 'current', retirementSignal: retirement.signal, isCurrent: () => true } });
                expect(identityOnly?.descriptor.source).toEqual(state.sources[0]!.source);
                expect(identityOnly?.metadata.accountingSource).toBeUndefined();
                nativeFileBoundary.opendir.mockReset();
                const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
                nativeFileBoundary.opendir.mockImplementation(fs.opendir);
            } finally { await collector.dispose(); }
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
    it.each(['legacy_env', 'settings'] as const)('requires fresh consent when Pi changes its actual %s session root', async mode => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-root-consent-'));
        let collector: ReturnType<typeof createNativeUsageCollector> | undefined;
        let observation: ReturnType<typeof createExternalSessionObservationDaemonProjection> | undefined;
        try {
            // HOME is the real OS environment boundary used by the SDK default-root resolver.
            vi.stubEnv('HOME', directory);
            vi.stubEnv('USERPROFILE', directory);
            const agentDir = join(directory, '.pi', 'agent');
            const roots = [join(directory, 'root-a'), join(directory, 'root-b')];
            await mkdir(agentDir, { recursive: true });
            for (const [index, root] of roots.entries()) {
                await mkdir(join(root, '--project--'), { recursive: true });
                await writeFile(join(root, '--project--', 'session.jsonl'),
                    JSON.stringify({ type: 'session', version: 3, id: `session-${index}`, timestamp: '2026-01-01T00:00:00.000Z' }) + '\n'
                    + JSON.stringify({ type: 'message', id: `inference-${index}`, parentId: null, timestamp: '2026-01-01T00:00:01.000Z',
                        message: { role: 'assistant', model: 'model', timestamp: 1767225601000,
                            usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 }, content: [] } }) + '\n');
            }
            const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
            const selectRoot = async (root: string) => {
                if (mode === 'legacy_env') env.PI_CODING_AGENT_SESSION_DIR = root;
                else await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: root }));
            };
            await selectRoot(roots[0]);
            const ingestion = ingestPluginManifestV2(PI_MANIFEST);
            if (!ingestion.ok) throw new Error(JSON.stringify(ingestion.diagnostics));
            const agents = ingestion.manifest.contributes.agents.map(definition => projectManifestAgentContribution({
                definition, pluginId: ingestion.manifest.id, provenance: 'first_party', source: { kind: 'bundled' },
            }));
            const retirement = new AbortController();
            const bounded = createBoundedAgentExternalSessionsContribution({
                contribution: createPiExternalSessionsContribution({ env }),
                identity: { pluginId: ingestion.manifest.id, agentId: 'pi', occurrenceId: 'current',
                    contributionQualifiedId: `${ingestion.manifest.id}/agents/pi`, sourceCustody: { kind: 'development', registeredRootId: 'root' } },
                retirementSignal: retirement.signal, isCurrent: () => !retirement.signal.aborted,
                createInvocationExec: async () => createUnavailablePluginServices().exec,
            });
            const discoverSources = () => discoverNativeUsageSourceMetadata({ agents, account: { connectedServicesV2: [] },
                activeServerId: 'home', activeServerDir: directory, signal: new AbortController().signal,
                resolveBoundary: async () => ({ catalogEntry: null, externalSessions: bounded, occurrenceId: 'current', retirementSignal: retirement.signal,
                    isCurrent: () => !retirement.signal.aborted }),
            });
            const [before] = await discoverSources();
            expect(before.root).toBe(roots[0]);
            expect(resolvePiExternalSessionSource({ source: before.source, env })?.sessionsRoot).toBe(roots[0]);
            expect(before.source.agentDir).toBe(agentDir);
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const authority = { serverId: 'home', accountId: 'account', machineId: 'machine' };
            const store = createNativeUsageCaptureStore({ path: join(directory, 'capture.sealed'), authority, storage });
            collector = createNativeUsageCollector({ authority, storage, store, discoverSources,
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }),
                resolveRoot: async () => { throw new Error('No root edit requested'); },
                readAccounting: async (source, signal) => bounded.readAccounting({ source: source.source, cursor: source.cursor, signal }),
                // OS observer boundary: re-discovery below supplies the real invalidation.
                subscribeSource: async () => ({ dispose() {} }),
                publisher: createUsageObservationPublisher({ token: 'token', apiServerUrl: 'https://home.test',
                    emitLegacyUsageReport: () => false, fetchServerFeaturesSnapshot: async () => ({ status: 'unsupported', reason: 'endpoint_missing' }) }),
                deleteHistory: async () => ({ success: true, deletedEventCount: 0 }),
            });
            const [consented] = await collector.discover();
            await collector.setConsent(consented.sourceId, true);
            await collector.flushPending();
            expect((await store.load()).sources[0].pending.map(row => row.inferenceId)).toEqual(['inference-0']);
            await selectRoot(roots[1]);
            const [after] = await discoverSources();
            expect(after.root).toBe(roots[1]);
            expect(resolvePiExternalSessionSource({ source: after.source, env })?.sessionsRoot).toBe(roots[1]);
            expect(after.source.agentDir).toBe(before.source.agentDir);
            expect(after.source.sessionsRoot).toBe(roots[1]);
            expect(after.sourceKey).not.toBe(before.sourceKey);
            await collector.discover();
            await collector.flushPending();
            // A different physical source must not inherit consent from its former root.
            expect((await store.load()).sources.flatMap(source => source.pending.map(row => row.inferenceId)))
                .not.toContain('inference-1');
            const captured = (await store.load()).sources.find(source => source.sourceId === consented.sourceId)!;
            await collector.dispose();
            collector = undefined;
            const legacySource = { kind: 'piAgentDir', agentDir };
            const projected = resolveExternalSessionSourceFromAgentProjection({ agents }, 'pi', legacySource);
            if (!projected.ok) throw new Error('Legacy Pi source must remain admitted');
            // Exact pre-pin declaration observed before RED39412: only agentDir was a key segment.
            const legacyDeclaration = { ...projected.declaration, key: { ...projected.declaration.key,
                segments: projected.declaration.key.segments.filter(segment => segment.kind !== 'field' || segment.field !== 'sessionsRoot') } };
            const legacyKey = resolveExternalSessionsSourceKeyForDeclaration(legacyDeclaration, legacySource);
            expect(await readNativeUsageAccountingAtAdmission({ agents, agentId: 'pi',
                source: legacySource, admittedSourceKey: legacyKey, activeServerDir: directory,
                signal: new AbortController().signal, boundary: { catalogEntry: null, externalSessions: bounded,
                    occurrenceId: 'current', retirementSignal: retirement.signal, isCurrent: () => true },
            })).toEqual({ ok: false, code: 'unavailable' });
            const legacyId = deriveNativeUsageAccountingIdentity({ authority, storage, agent: captured.agent, sourceKey: legacyKey }).sourceRootKey;
            await store.save({ v: 1, authority, sources: [{ ...captured, sourceId: legacyId,
                source: legacySource, sourceKey: legacyKey, root: agentDir }] });
            const watched: string[] = [];
            observation = createExternalSessionObservationDaemonProjection({ publishField: async () => {},
                // Real OS watcher boundary, beneath the incumbent shared reconciler.
                watchFile: file => { watched.push(file); return () => {}; },
            });
            let ingestAvailable = false;
            const attempted: unknown[] = [];
            const published: unknown[] = [];
            collector = createNativeUsageCollector({ authority, storage, store, discoverSources,
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }),
                resolveRoot: async () => { throw new Error('No root edit requested'); },
                readAccounting: (source, signal) => readNativeUsageAccountingAtAdmission({ agents, agentId: 'pi',
                    source: source.source, admittedSourceKey: source.sourceKey, cursor: source.cursor,
                    activeServerDir: directory, signal, boundary: { catalogEntry: null, externalSessions: bounded, occurrenceId: 'current',
                        retirementSignal: retirement.signal, isCurrent: () => true } }),
                subscribeSource: async (source, onChange, signal) => {
                    const resolved = await resolveNativeUsageSourceMetadata({ agents, agentId: 'pi', source: source.source,
                        admittedSourceKey: source.sourceKey, activeServerDir: directory, signal,
                        boundary: { catalogEntry: null, externalSessions: bounded, occurrenceId: 'current', retirementSignal: retirement.signal, isCurrent: () => true } });
                    const descriptor = resolved?.metadata.accountingSource;
                    if (!resolved || !descriptor) throw new Error('Source unavailable');
                    return await observation!.registerAccountingSource({ source: resolved.descriptor.source,
                        resource: { pluginId: source.agent.pluginId, agentLocalId: source.agent.localId,
                            occurrenceId: 'current', resourceKey: descriptor.resourceKey, retirementSignal: signal },
                        changeObservation: descriptor.changeObservation, watchFileChanges: descriptor.watchFileChanges,
                        onChange: input => onChange(input.changedNativeSessionIds) });
                },
                publisher: createUsageObservationPublisher({ token: 'token', apiServerUrl: 'https://home.test',
                    emitLegacyUsageReport: () => false,
                    fetchServerFeaturesSnapshot: async () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
                        features: {}, capabilities: { server: { usageAnalytics: { version: 1,
                            eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
                            legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' },
                        } } },
                    }) }),
                    postJson: async request => {
                        attempted.push(request.body);
                        if (!ingestAvailable) throw Object.assign(new Error('Usage transport unavailable'), { response: { status: 503 } });
                        published.push(request.body); return { ok: true };
                    },
                }),
                deleteHistory: async () => ({ success: true, deletedEventCount: 0 }),
            });
            await collector.initialize();
            await collector.flushPending();
            expect((await store.load()).sources[0].pending.map(row => row.inferenceId)).toEqual(['inference-0']);
            expect(watched).toEqual([]);
            expect(published).toEqual([]);
            expect(attempted.length).toBeGreaterThan(0);
            ingestAvailable = true;
            await collector.flushPending();
            expect(published).toHaveLength(1);
            expect(UsageEventIngestRequestSchema.parse(published[0]).subject).toMatchObject({ kind: 'native', sourceRootKey: legacyId });
            expect((await store.load()).sources[0].pending).toEqual([]);
            const rediscovered = await collector.discover();
            const fresh = rediscovered.find(source => source.sourceId !== legacyId && source.root.path === roots[1]);
            expect(fresh?.consent).toBe('disabled');
            if (!fresh) throw new Error('The actual current root must be discoverable');
            await collector.setConsent(fresh.sourceId, true);
            await collector.flushPending();
            expect(published).toHaveLength(2);
            expect(UsageEventIngestRequestSchema.parse(published[1]).subject).toMatchObject({ kind: 'native', sourceRootKey: fresh.sourceId });
            expect(watched).toContain(join(roots[1], '--project--', 'session.jsonl'));
        } finally { await collector?.dispose(); await observation?.dispose(); await rm(directory, { recursive: true, force: true }); }
    });
    it('uses declared configured roots without invoking candidate, transcript or accounting readers', async () => {
        const ingestion = ingestPluginManifestV2(PLUGIN_MANIFEST);
        if (!ingestion.ok) throw new Error(JSON.stringify(ingestion.diagnostics));
        const manifest = ingestion.manifest;
        const agents = manifest.contributes.agents.map(definition => projectManifestAgentContribution({
            definition, pluginId: manifest.id, provenance: 'first_party', source: { kind: 'bundled' },
        }));
        const retirement = new AbortController();
        const contentAccess = () => { throw new Error('Native records must remain unopened without consent'); };
        let discoveredFileCount: number | undefined;
        let retireDuringResolve = false;
        const contribution: AgentExternalSessionsContribution = {
            resolveSource: ({ source }) => {
                if (retireDuringResolve) retirement.abort();
                return { ok: true, value: {
                source: { ...source, configDir: '/configured/claude' },
                accountingSource: { rootPath: '/configured/claude', rootField: 'configDir', resourceKey: 'claude-root',
                    ...(discoveredFileCount === undefined ? {} : { discoveredFileCount }),
                    changeObservation: 'watch_file_changes', watchFileChanges: { files: ['/configured/claude/a.jsonl', '/configured/claude/b.jsonl'], topologyDirectories: ['/configured/claude'] } },
            } };
            },
            listCandidates: contentAccess, resolveLinkIdentity: contentAccess, resolveLinkedIdentity: contentAccess,
            pageTranscript: contentAccess, readAfterTranscript: contentAccess, readAccounting: contentAccess,
        };
        const bounded = createBoundedAgentExternalSessionsContribution({
            contribution, identity: { pluginId: manifest.id, agentId: 'claude', occurrenceId: 'current',
                contributionQualifiedId: `${manifest.id}/agents/claude`, sourceCustody: { kind: 'development', registeredRootId: 'root' } },
            retirementSignal: retirement.signal, isCurrent: () => !retirement.signal.aborted,
            createInvocationExec: async () => createUnavailablePluginServices().exec,
        });
        const request = {
            agents, account: { connectedServicesV2: [] }, agentSettings: { claudeConfigDir: '/configured/claude' },
            activeServerId: 'home', activeServerDir: '/happier/home', signal: new AbortController().signal,
            resolveBoundary: async () => ({ catalogEntry: null, externalSessions: bounded, occurrenceId: 'current', retirementSignal: retirement.signal,
                isCurrent: () => !retirement.signal.aborted }),
        };
        const unwitnessed = await discoverNativeUsageSourceMetadata(request);
        expect(unwitnessed[0]).not.toHaveProperty('discoveredFileCount');
        discoveredFileCount = 2;
        const sources = await discoverNativeUsageSourceMetadata(request);
        expect(sources).toEqual([expect.objectContaining({ agent: { pluginId: manifest.id, localId: 'claude' },
            root: '/configured/claude', rootKind: 'default', supported: true, discoveredFileCount: 2, source: { kind: 'claudeConfig', configDir: '/configured/claude' } })]);
        expect(await discoverNativeUsageSourceMetadata({ agents, account: { connectedServicesV2: [] },
            activeServerId: 'home', activeServerDir: '/happier/home', signal: new AbortController().signal,
            // Plugin activation is an executable boundary and can be unavailable independently.
            resolveBoundary: async () => { throw new Error('Plugin activation unavailable'); },
        })).toEqual([expect.objectContaining({ supported: false, error: 'agent_unavailable' })]);
        retireDuringResolve = true;
        expect(await discoverNativeUsageSourceMetadata(request)).toEqual(sources);
        // The next admission refuses a retired occurrence.
        expect(await discoverNativeUsageSourceMetadata({ agents, account: { connectedServicesV2: [] },
            activeServerId: 'home', activeServerDir: '/happier/home', signal: new AbortController().signal,
            resolveBoundary: async () => ({ catalogEntry: null, externalSessions: bounded, occurrenceId: 'current', retirementSignal: retirement.signal,
                isCurrent: () => !retirement.signal.aborted }) })).toEqual([]);
    });
});
