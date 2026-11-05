import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountProfileResponseSchema } from '@happier-dev/protocol/account/profile';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { configuration } from '@/configuration';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { createExternalSessionObservationDaemonProjection } from '@/api/session/external/leases/createExternalSessionObservationDaemonProjection';
import { createNativeUsageDaemonRuntime } from './nativeUsageDaemonRuntime';
import { createNativeUsageCaptureStore } from './nativeUsageCaptureState';
import { deriveNativeUsageAccountingIdentity } from './nativeUsageAccountingIdentity';
import { createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';

describe('native usage daemon lifetime', () => {
    it('reapplies a recovered Claude root without its stale failure and resumes daemon capture', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-claude-retry-'));
        vi.stubEnv('CLAUDE_CONFIG_DIR', directory);
        const admitted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.agent.claude'] } });
        const observation = createExternalSessionObservationDaemonProjection({ publishField: async () => {},
            watchFile: () => () => {}, watchTopologyDirectory: () => () => {} });
        const profile = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: AccountProfileResponseSchema.parse({ id: 'account' }) });
        const features = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(FeaturesResponseSchema.parse({ features: {},
            capabilities: { server: { usageAnalytics: { version: 1, eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
                legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' } } } } })));
        const published: unknown[] = [];
        const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
            published.push(body); return { status: 200, data: { ok: true } };
        });
        let runtime: ReturnType<typeof createNativeUsageDaemonRuntime> | undefined;
        try {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
            runtime = createNativeUsageDaemonRuntime({ authority: { serverId: configuration.activeServerId, accountId: 'account', machineId: 'machine' },
                installationId: 'installation', activeServerDir: directory, serverHttpBaseUrl: 'https://native-claude.test', token,
                storage: await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') }), observation,
                readCredentials: async () => ({ token, encryption: null }),
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }) });
            const sources = await runtime.owner.service.discover();
            const initial = sources.find(source => source.agent.pluginId === 'happier.agent.claude');
            if (!initial) throw new Error('Claude default must be discoverable');
            const root = join(directory, 'override');
            const override = await runtime.owner.service.setRoot(initial.sourceId, root);
            await runtime.owner.service.setConsent(override.sourceId, true);
            await runtime.flushPending();
            expect((await runtime.owner.service.get(override.sourceId))[0]).toMatchObject({ status: 'unavailable', errorCode: 'source_unavailable' });
            const native = join(root, 'projects', 'qa-project');
            await mkdir(native, { recursive: true });
            await writeFile(join(native, 'native-session.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 'qa-usage-acct-1030-claude', uuid: 'qa-record-a',
                timestamp: '2026-10-30T10:00:00.000Z', message: { id: 'qa-inference-a', model: 'qa-usage-acct-1030-model-a',
                    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } }) + '\n');
            await runtime.owner.service.stop(override.sourceId);
            const reset = await runtime.owner.service.setRoot(override.sourceId, null);
            const reapplied = await runtime.owner.service.setRoot(reset.sourceId, root);
            expect(reapplied).toMatchObject({ sourceId: override.sourceId, consent: 'disabled', status: 'found' });
            expect(reapplied).not.toHaveProperty('errorCode');
            await runtime.owner.service.setConsent(override.sourceId, true);
            await runtime.flushPending();
            expect((await runtime.owner.service.get(override.sourceId))[0]).toMatchObject({ status: 'ready', pendingCount: 0, asOfMs: 1793354400000 });
            expect(published).toMatchObject([{ tokens: { total: 20 } }]);
            const defaultOverride = await runtime.owner.service.setRoot(override.sourceId, directory);
            expect(defaultOverride.root.kind).toBe('override');
            const restored = await runtime.owner.service.setRoot(defaultOverride.sourceId, null);
            expect(restored).toMatchObject({ consent: 'disabled', root: { kind: 'default', path: directory } });
        } finally {
            await runtime?.dispose(); await observation.dispose(); await admitted.dispose();
            profile.mockRestore(); features.mockRestore(); post.mockRestore(); vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
        }
    });
    it.each(['account', 'other-account'])('captures Project material for %s once and publishes with the Machine bearer', async capturedAccount => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-project-credentials-'));
        const observation = createExternalSessionObservationDaemonProjection({ publishField: async () => {} });
        const tokenFor = (accountId: string, revision: number) => `header.${Buffer.from(JSON.stringify({ sub: accountId, revision })).toString('base64url')}.signature`;
        const token = tokenFor('account', 1);
        const authority = { serverId: configuration.activeServerId, accountId: 'account', machineId: 'machine' };
        const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
        const custodyKey = storage.deriveOpaqueIdentity({ purpose: 'usage_accounting_identity',
            value: JSON.stringify(['capture', authority.serverId, authority.accountId, authority.machineId]) });
        const store = createNativeUsageCaptureStore({ path: join(directory, 'usage', `${custodyKey}.sealed`), authority, storage });
        const descriptor = { agent: { pluginId: 'fixture.unavailable', localId: 'agent' },
            source: { kind: 'fixture' }, sourceKey: 'fixture-root', root: directory, supported: false };
        const sourceId = deriveNativeUsageAccountingIdentity({ authority, storage, ...descriptor }).sourceRootKey;
        await store.save({ v: 1, authority, sources: [{ ...descriptor, sourceId, consented: true, pending: [{
            nativeSessionId: 'native', observedAt: 10, project: { rootPath: '/private/native' },
            observation: { provider: 'fixture', source: 'native', scope: 'turn_delta', key: 'paid', modelId: 'model',
                tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 5 },
                cost: null, contextUsedTokens: null, contextWindowTokens: null },
        }] }] });
        const projectRows: unknown[] = [];
        const projectHttp = createProjectAccountRowsHttpBoundary(projectRows);
        const bearers: string[] = [];
        const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'e2ee', updatedAt: 0 } });
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            bearers.push(String(config?.headers?.Authorization));
            if (new URL(String(url)).pathname === '/v2/usage-events') return { status: 200, data: { ok: true } };
            return await projectHttp(String(url), body);
        });
        const features = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(FeaturesResponseSchema.parse({ features: {},
            capabilities: { server: { usageAnalytics: { version: 1, eventsIngest: { path: '/v2/usage-events' },
                query: { path: '/v2/usage/query' }, legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' } } } } })));
        const readCredentials = vi.fn(async () => ({ token: tokenFor(capturedAccount, 2),
            encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(8) } }));
        const runtime = createNativeUsageDaemonRuntime({ authority, installationId: 'installation', activeServerDir: directory,
            serverHttpBaseUrl: 'https://native-project.test', token, storage, observation, readCredentials,
            budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }) });
        try {
            await runtime.flushPending();
            expect(readCredentials).toHaveBeenCalledOnce();
            const sameAccount = capturedAccount === authority.accountId;
            expect((await runtime.owner.service.get(sourceId))[0].pendingCount).toBe(sameAccount ? 0 : 1);
            expect(projectRows).toHaveLength(sameAccount ? 1 : 0);
            if (sameAccount) {
                expect(projectRows[0]).toMatchObject({ content: { t: 'encrypted' } });
                expect(bearers.length).toBeGreaterThan(0);
                expect(new Set(bearers)).toEqual(new Set([`Bearer ${token}`]));
            } else expect(bearers).toEqual([]);
        } finally {
            await runtime.dispose(); await observation.dispose(); get.mockRestore(); post.mockRestore(); features.mockRestore();
            withdrawActiveProjectAccountRowsSnapshot(); await rm(directory, { recursive: true, force: true });
        }
    });
    it('retains unchanged source watches and rebinds a retired plugin occurrence', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-reload-'));
        const agentDir = join(directory, 'pi');
        const sessionDir = join(agentDir, 'sessions', '--project--');
        const sessionFile = join(sessionDir, 'session.jsonl');
        await mkdir(sessionDir, { recursive: true });
        await writeFile(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'native-session',
            timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
        const runtimeOptions = { contributes: createResolvedContributionRegistry(resolveBuiltInContributions({
            agentIdentity: { pluginId: 'happier.agent.pi', localId: 'pi' },
        })), pluginIds: ['happier.agent.pi'] };
        const admitted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions });
        let replacement: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
        const watches: { file: string; onChange(file: string): void; stopped: boolean }[] = [];
        const observation = createExternalSessionObservationDaemonProjection({
            publishField: async () => { throw new Error('Native accounting cannot fabricate Sessions'); },
            // OS watchers are the boundary; real occurrence-bound demand owns their lifetime.
            watchFile: (file, onChange) => {
                const watch = { file, onChange, stopped: false };
                watches.push(watch);
                return () => { watch.stopped = true; };
            },
            watchTopologyDirectory: () => () => {},
        });
        resetActiveAccountSettingsSnapshotForTests();
        setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'native-reload-account', settingsVersion: 1,
            loadedAtMs: 1, settings: accountSettingsParse({ piAgentDir: agentDir }), settingsSecretsReadKeys: [] });
        const profileRead = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            if (new URL(url).pathname !== '/v1/account/profile') throw new Error('Unexpected native discovery HTTP read');
            return { status: 200, data: AccountProfileResponseSchema.parse({ id: 'account' }) };
        });
        let ingestAvailable = false;
        const featuresRead = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
            Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: { server: { usageAnalytics: {
                version: 1, eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
                legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' },
            } } } })));
        const credentialFile = join(directory, 'bearer');
        // The filesystem and HTTP are genuine boundaries; capture and plugin logic remain real.
        const readCredentials = vi.fn(async () => ({ token: await readFile(credentialFile, 'utf8'), encryption: null }));
        const publishedBearers: string[] = [];
        const ingest = vi.spyOn(axios, 'post').mockImplementation(async (url, _body, config) => {
            if (new URL(String(url)).pathname !== '/v2/usage-events') throw new Error('Unexpected native ingest HTTP write');
            if (!ingestAvailable) throw new axios.AxiosError('Native ingest unavailable', undefined, undefined, undefined,
                { status: 404, statusText: 'Not Found', data: {}, headers: {}, config: { headers: new axios.AxiosHeaders() } });
            publishedBearers.push(String(config?.headers?.Authorization));
            if (publishedBearers.length === 1) await writeFile(credentialFile,
                `header.${Buffer.from(JSON.stringify({ sub: 'replacement-account' })).toString('base64url')}.signature`);
            return { status: 200, data: { ok: true } };
        });
        let settledWakes = 0;
        let runtime: ReturnType<typeof createNativeUsageDaemonRuntime> | undefined;
        try {
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
            await writeFile(credentialFile, token);
            runtime = createNativeUsageDaemonRuntime({
                authority: { serverId: configuration.activeServerId, accountId: 'account', machineId: 'machine' },
                installationId: 'installation', activeServerDir: directory, serverHttpBaseUrl: 'https://native-reload.test',
                token, storage, observation, readCredentials, invalidateSources: () => { settledWakes += 1; },
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }),
            });
            const sources = await runtime.owner.service.discover();
            expect(readCredentials).toHaveBeenCalledOnce();
            readCredentials.mockClear();
            const selected = sources.find(source => source.agent.pluginId === 'happier.agent.pi');
            if (!selected) throw new Error('Admitted Pi source was not discovered');
            await runtime.owner.service.setConsent(selected.sourceId, true);
            await runtime.flushPending();
            expect(watches.map(watch => watch.file)).toEqual([sessionFile]);
            for (let index = 0; index < 3; index++) await runtime.owner.service.discover();
            await runtime.flushPending();
            expect(watches).toHaveLength(1);
            expect(watches[0].stopped).toBe(false);

            const incumbent = admitted.registry.agentRuntimesByAgentId.get('pi');
            if (!incumbent) throw new Error('Admitted Pi runtime was not activated');
            const appendInference = async (id: string, timestamp: number) => await appendFile(sessionFile,
                JSON.stringify({ type: 'message', id, parentId: null, timestamp: new Date(timestamp).toISOString(),
                    message: { role: 'assistant', model: 'model', timestamp,
                        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 }, content: [] } }) + '\n');
            // Reload must reconcile the unwatched interval without depending on a later OS event.
            await appendInference('during-reload', 1767225601000);
            await admitted.lease.release();
            replacement = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions });
            expect(incumbent.retirementSignal.aborted).toBe(true);
            expect(replacement.registry.agentRuntimesByAgentId.get('pi')?.occurrenceId).not.toBe(incumbent.occurrenceId);
            await vi.waitFor(() => expect(watches).toHaveLength(2));
            expect(watches[0].stopped).toBe(true);
            expect(watches[1]).toMatchObject({ file: sessionFile, stopped: false });
            await vi.waitFor(async () => expect(await runtime!.owner.service.get(selected.sourceId)).toEqual([
                expect.objectContaining({ consent: 'enabled', pendingCount: 1, asOfMs: 1767225601000 }),
            ]));
            await appendInference('after-reload', 1767225602000);
            watches[1].onChange(sessionFile);
            await vi.waitFor(async () => expect(await runtime!.owner.service.get(selected.sourceId)).toEqual([
                expect.objectContaining({ consent: 'enabled', pendingCount: 2, asOfMs: 1767225602000 }),
            ]));
            await runtime.flushPending();
            ingestAvailable = true;
            readCredentials.mockClear();
            const wakesBefore = settledWakes;
            await runtime.flushPending();
            expect(await runtime.owner.service.get(selected.sourceId)).toEqual([
                expect.objectContaining({ consent: 'enabled', pendingCount: 0 }),
            ]);
            expect(publishedBearers).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
            expect(readCredentials).not.toHaveBeenCalled();
            expect(settledWakes).toBe(wakesBefore + 1);
            // The Machine lifetime keeps its captured bearer; server admission owns revocation.
            await runtime.flushPending();
            expect(readCredentials).not.toHaveBeenCalled();
            expect(publishedBearers).toHaveLength(2);
        } finally {
            await runtime?.dispose(); await observation.dispose(); await replacement?.dispose(); await admitted.dispose();
            profileRead.mockRestore(); featuresRead.mockRestore(); ingest.mockRestore();
            resetActiveAccountSettingsSnapshotForTests(); await rm(directory, { recursive: true, force: true });
        }
    });
    it('retains declared Settings wakes after restoring consent without explicit discovery', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-settings-'));
        await mkdir(join(directory, 'pi', 'sessions'), { recursive: true });
        const admitted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { contributes: createResolvedContributionRegistry(resolveBuiltInContributions({
                agentIdentity: { pluginId: 'happier.agent.pi', localId: 'pi' },
            })), pluginIds: ['happier.agent.pi'] } });
        const observation = createExternalSessionObservationDaemonProjection({
            publishField: async () => { throw new Error('Native accounting cannot fabricate Sessions'); },
            watchFile: () => () => {},
            watchTopologyDirectory: () => () => {},
        });
        let runtime: ReturnType<typeof createNativeUsageDaemonRuntime> | undefined;
        resetActiveAccountSettingsSnapshotForTests();
        const base = { source: 'network' as const, scopeKey: 'native-settings-account', settingsVersion: 1,
            loadedAtMs: 1, settings: accountSettingsParse({ piAgentDir: join(directory, 'pi') }), settingsSecretsReadKeys: [] };
        setActiveAccountSettingsSnapshot(base);
        // HTTP is the external boundary; discovery still reads the real Account projection.
        const profileRead = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            if (new URL(url).pathname !== '/v1/account/profile') throw new Error('Unexpected native discovery HTTP read');
            return { status: 200, data: AccountProfileResponseSchema.parse({ id: 'account' }) };
        });
        try {
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
            const readCredentials = vi.fn(async () => ({ token, encryption: null }));
            const create = () => createNativeUsageDaemonRuntime({
                authority: { serverId: configuration.activeServerId, accountId: 'account', machineId: 'machine' },
                installationId: 'installation', activeServerDir: directory, serverHttpBaseUrl: 'https://server.test',
                token, storage, observation, readCredentials,
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }),
            });
            runtime = create();
            const sources = await runtime.owner.service.discover();
            const selected = sources.find(source => source.agent.pluginId === 'happier.agent.pi');
            if (!selected) throw new Error('Admitted Pi source was not discovered');
            await runtime.owner.service.setConsent(selected.sourceId, true);
            await runtime.dispose();
            runtime = create();
            await runtime.flushPending();
            await new Promise<void>(resolve => setImmediate(resolve));
            const reads = readCredentials.mock.calls.length;
            for (let index = 0; index < 25; index++) setActiveAccountSettingsSnapshot({ ...base,
                settingsVersion: index + 2, settings: accountSettingsParse({ ...base.settings, analyticsOptOut: index % 2 === 0 }) });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(readCredentials).toHaveBeenCalledTimes(reads);
            setActiveAccountSettingsSnapshot({ ...base, settingsVersion: 27,
                settings: accountSettingsParse({ ...base.settings, piAgentDir: join(directory, 'replacement-pi') }) });
            await vi.waitFor(async () => expect((await runtime!.owner.service.get()).some(source =>
                source.externalSessionSource?.agentDir === join(directory, 'replacement-pi'))).toBe(true));
            expect(readCredentials).toHaveBeenCalledTimes(reads);
        } finally {
            await runtime?.dispose(); await observation.dispose(); await admitted.dispose();
            profileRead.mockRestore();
            resetActiveAccountSettingsSnapshotForTests(); await rm(directory, { recursive: true, force: true });
        }
    });
    it('starts and reconnects an empty custody scope without discovering or opening native sources', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-daemon-'));
        const observation = createExternalSessionObservationDaemonProjection({
            publishField: async () => { throw new Error('No native Session may be fabricated'); },
            // OS observation boundary: empty, unrequested startup must never acquire a watch.
            watchFile: () => { throw new Error('No native watch may start without consent'); },
        });
        try {
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const runtime = createNativeUsageDaemonRuntime({
                authority: { serverId: configuration.activeServerId, accountId: 'account', machineId: 'machine' },
                installationId: 'installation', activeServerDir: directory, serverHttpBaseUrl: 'https://server.test',
                token: 'token', storage, observation,
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }),
                // Missing private material does not admit an unrequested native inventory.
                readCredentials: async () => null,
            });
            try {
                expect(await runtime.owner.service.get()).toEqual([]);
                await runtime.flushPending();
                expect(await runtime.owner.service.get()).toEqual([]);
            } finally { await runtime.dispose(); }
        } finally {
            await observation.dispose();
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('restores consented custody truthfully when its current plugin runtime is unavailable', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-unavailable-'));
        const observation = createExternalSessionObservationDaemonProjection({
            publishField: async () => { throw new Error('No native Session may be fabricated'); },
            watchFile: () => { throw new Error('Unavailable sources cannot acquire a watch'); },
        });
        try {
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const authority = { serverId: configuration.activeServerId, accountId: 'account', machineId: 'machine' };
            const custodyKey = storage.deriveOpaqueIdentity({ purpose: 'usage_accounting_identity',
                value: JSON.stringify(['capture', authority.serverId, authority.accountId, authority.machineId]) });
            const descriptor = { agent: { pluginId: 'fixture.unavailable', localId: 'agent' },
                source: { kind: 'fixture' }, sourceKey: 'fixture-root', root: directory, supported: true };
            const sourceId = deriveNativeUsageAccountingIdentity({ authority, storage, ...descriptor }).sourceRootKey;
            const store = createNativeUsageCaptureStore({ path: join(directory, 'usage', `${custodyKey}.sealed`), authority, storage });
            await store.save({ v: 1, authority, sources: [{ ...descriptor, sourceId, consented: true, pending: [] }] });
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
            const settledSources: Promise<unknown>[] = [];
            resetActiveAccountSettingsSnapshotForTests();
            const settings = { source: 'network' as const, scopeKey: 'native-account', settingsVersion: 1,
                loadedAtMs: 1, settings: accountSettingsParse({}), settingsSecretsReadKeys: [] };
            setActiveAccountSettingsSnapshot(settings);
            const readCredentials = vi.fn(async () => ({ token, encryption: null }));
            const runtime = createNativeUsageDaemonRuntime({
                authority, installationId: 'installation', activeServerDir: directory, serverHttpBaseUrl: 'https://server.test',
                token, storage, observation,
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }),
                readCredentials,
                invalidateSources: () => { settledSources.push(runtime.owner.service.get(sourceId)); },
            });
            try {
                await runtime.flushPending();
                expect(await runtime.owner.service.get(sourceId)).toEqual([expect.objectContaining({
                    consent: 'enabled', status: 'unavailable', errorCode: 'source_unavailable', pendingCount: 0,
                })]);
                expect(await Promise.all(settledSources)).toContainEqual([expect.objectContaining({
                    status: 'unavailable', errorCode: 'source_unavailable', pendingCount: 0,
                })]);
                const reads = readCredentials.mock.calls.length;
                for (let index = 0; index < 25; index++) setActiveAccountSettingsSnapshot({ ...settings,
                    settingsVersion: index + 2, settings: accountSettingsParse({ analyticsOptOut: index % 2 === 0 }) });
                await new Promise<void>(resolve => setImmediate(resolve));
                expect(readCredentials).toHaveBeenCalledTimes(reads);
                setActiveAccountSettingsSnapshot({ ...settings, settingsVersion: 27, source: 'cache' });
                await new Promise<void>(resolve => setImmediate(resolve));
                expect(readCredentials).toHaveBeenCalledTimes(reads);
            } finally { await runtime.dispose(); resetActiveAccountSettingsSnapshotForTests(); }
        } finally {
            await observation.dispose();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
