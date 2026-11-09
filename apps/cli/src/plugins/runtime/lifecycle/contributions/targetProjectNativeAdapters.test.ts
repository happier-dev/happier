import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluginApi, PluginProjectNativeAdapterRuntimeV1, PluginInvocationContext, Disposable } from '@happier-dev/plugin-sdk';
import type { ManagedServiceNativeLogReadV1, ManagedServiceNativeLogWatchV1, ManagedServiceNativeLogResultV1 } from '@happier-dev/plugin-sdk/managed-services';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createProductionPluginInvocationServiceOwners } from '../../invocation/services/production';
import { createPluginInvocationLifetime } from '../../invocation/lifetime';
import { activatePluginRuntimeRegistry } from '../manager';
import { createPluginRuntimeOccurrenceId } from '../../runtimeSlots';
import { resolveProjectNativeAdapter, type ProjectNativeAdapterInvocationContextFactoryV1 } from './targetProjectNativeAdapters';

describe('native lifecycle-only invocation recovery', () => {
    it('uses admitted Exec for exact native controls after restart, without a command role or retained old invocation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-native-lifecycle-io-'));
        const statePath = join(root, 'resource.json');
        await writeFile(statePath, JSON.stringify({ phase: 'running' }));
        const pluginId = 'acme.native-lifecycle';
        const instance = { adapter: { pluginId, localId: 'native' }, nativeResourceId: 'exact-surviving-resource' };
        const machine = { serverId: 'server-exact', machineId: 'machine-exact' };
        const secondInstance = { ...instance, nativeResourceId: 'second-resource' };
        const discoveredMachines: unknown[] = [];
        const accountingBatches: unknown[] = [];
        const sourceCaptures: unknown[] = [];
        const composePath = join(root, 'compose.json');
        await writeFile(composePath, JSON.stringify({ services: { app: { image: 'example/app:1' } } }));
        let wrongDiscoveryAdapter = false;
        let wrongAccountingResource = false;
        let logReads = 0;
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: pluginId,
            runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: { projectNativeAdapters: [{ id: 'native', files: ['resource.json'], roles: ['nativeServiceLifecycle'] }] },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error('Expected admitted lifecycle-only fixture');
        const targets = [{ provenance: 'external' as const, source: { kind: 'path' as const }, pluginId,
            manifestPath: '/virtual/native/plugin.json', daemonEntryPath: '/virtual/native/daemon.mjs',
            sourceSpec: { kind: 'path' as const, locator: '/virtual/native', trustPolicy: 'local_trusted' as const, installPolicy: 'copy' as const },
            activationEvents: [], manifest: ingested.manifest }];
        const contributes = createResolvedContributionRegistry({ activationTargets: targets });
        // Installed tool lookup and plugin module loading are the only boundaries.
        // Admission, Exec spawn/IO, lifecycle capture and occurrence retirement are real.
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, exec: {
            resolvePath: async () => root,
            async resolveExecutable(reference) {
                if (reference.kind === 'systemTool' && reference.id === 'docker') return { command: process.execPath,
                    args: ['-e', `process.stdout.write(JSON.stringify(process.argv.includes('--variables')?{}:{services:{app:{image:'example/app:1'}}}))`, '--'] };
                if (reference.kind !== 'systemTool' || reference.id !== 'fixture.native') throw new Error('No starter tool is admitted');
                return { command: process.execPath };
            },
        } });
        function logs(candidate: typeof instance, request: ManagedServiceNativeLogReadV1, context?: PluginInvocationContext): Promise<ManagedServiceNativeLogResultV1>;
        function logs(candidate: typeof instance, request: ManagedServiceNativeLogWatchV1, context?: PluginInvocationContext): Promise<Disposable>;
        async function logs(candidate: typeof instance, request: ManagedServiceNativeLogReadV1 | ManagedServiceNativeLogWatchV1, context?: PluginInvocationContext): Promise<ManagedServiceNativeLogResultV1 | Disposable> {
            if (!context || candidate.nativeResourceId !== instance.nativeResourceId) throw new Error('Exact lifecycle context unavailable');
            if (request.kind === 'watch') {
                request.emit({ kind: 'unavailable', reason: 'unsupported' });
                return { dispose() {} };
            }
            logReads++;
            const result = await context.services.exec.run({ executable: { kind: 'systemTool', id: 'fixture.native' },
                args: ['-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(statePath)}, 'utf8').slice(-${request.maxBytes}))`] }, request);
            return { kind: 'page' as const, page: { sourceRevision: 'fixture-1', text: new TextDecoder().decode(result.stdout), nextCursor: null, truncated: false } };
        }
        const nativeServiceLifecycle: NonNullable<PluginProjectNativeAdapterRuntimeV1['nativeServiceLifecycle']> = {
            logs,
            async composeSource(candidate, _options, context) {
                if (!context) throw new Error('Source capture lost admitted services');
                sourceCaptures.push(candidate);
                return { kind: 'ready', source: { projectName: 'retained-project', engineId: 'retained-engine',
                    workingDirectory: root, configFiles: [composePath], containerIds: ['a'.repeat(64)] } };
            },
            async discover(candidate, _options, context) {
                if (!context) throw new Error('Machine discovery lost admitted services');
                discoveredMachines.push(candidate);
                return { kind: 'ready', failures: [], candidates: [instance, secondInstance].map(instance => ({
                    instance: wrongDiscoveryAdapter ? { ...instance, adapter: { pluginId: 'other.plugin', localId: 'native' } } : instance,
                    name: instance.nativeResourceId, observation: { phase: 'running', readiness: 'not_reported', endpoint: null },
                })) };
            },
            async accounting(instances, _options, context) {
                if (!context) throw new Error('Machine accounting lost admitted services');
                accountingBatches.push(instances);
                return { kind: 'sample', samples: instances.map(instance => ({
                    instance: wrongAccountingResource ? { ...instance, nativeResourceId: 'not-requested' } : instance,
                    cpuPercent: 5, memoryBytes: 1024,
                })) };
            },
            async start(candidate, options, context) {
                if (!context || candidate.nativeResourceId !== instance.nativeResourceId) throw new Error('Exact lifecycle context unavailable');
                await context.services.exec.run({ executable: { kind: 'systemTool', id: 'fixture.native' },
                    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(statePath)}, '{"phase":"running","control":"start"}')`] }, options);
                return { phase: 'running', readiness: 'not_reported', endpoint: null };
            },
            async restart(candidate, options, context) {
                if (!context || candidate.nativeResourceId !== instance.nativeResourceId) throw new Error('Exact lifecycle context unavailable');
                await context.services.exec.run({ executable: { kind: 'systemTool', id: 'fixture.native' },
                    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(statePath)}, '{"phase":"running","control":"restart"}')`] }, options);
                return { phase: 'running', readiness: 'not_reported', endpoint: null };
            },
            async inspect(candidate, options, context) {
                if (!context || candidate.nativeResourceId !== instance.nativeResourceId) throw new Error('Exact lifecycle context unavailable');
                const result = await context.services.exec.run({ executable: { kind: 'systemTool', id: 'fixture.native' },
                    args: ['-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(statePath)}, 'utf8'))`] }, options);
                const state: unknown = JSON.parse(new TextDecoder().decode(result.stdout));
                if (!state || typeof state !== 'object' || !('phase' in state) || state.phase !== 'running' && state.phase !== 'stopped') throw new Error('Malformed native observation');
                return { phase: state.phase, readiness: 'not_reported', endpoint: null };
            },
            async stop(candidate, options, context) {
                if (!context || candidate.nativeResourceId !== instance.nativeResourceId) throw new Error('Exact lifecycle context unavailable');
                await context.services.exec.run({ executable: { kind: 'systemTool', id: 'fixture.native' },
                    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(statePath)}, '{"phase":"stopped"}')`] }, options);
                return { status: 'stopped' };
            },
        };
        const createInvocationContext: ProjectNativeAdapterInvocationContextFactoryV1 = input => {
            if (input.machine) {
                expect(input.machine).toEqual(machine);
                expect(input).not.toHaveProperty('root');
            }
            const lifetime = createPluginInvocationLifetime(input.signal);
            const seed = { plugin: { id: pluginId, version: '1.0.0' },
                contribution: { id: 'native', qualifiedId: `${pluginId}/projectNativeAdapters/native` },
                occurrenceId: input.occurrenceId, correlationId: 'native-recovery-test', surface: 'cli' as const,
                signal: lifetime.signal, redactionLifetimeSignal: lifetime.redactionLifetimeSignal, isOccurrenceCurrent: input.isCurrent };
            return { context: { ...seed, invokedAtMs: lifetime.invokedAtMs, services: owners.createOperationServices(seed, {
                filesystemRoots: { pluginData: root, workspace: input.root, projects: new Map() }, hostAccessRequests: [],
            }) }, complete() { lifetime.complete(); } };
        };
        const activate = (generation: number) => activatePluginRuntimeRegistry({ contributes, generation,
            occurrenceIdsByPluginId: new Map([[pluginId, createPluginRuntimeOccurrenceId(pluginId)]]),
            resolveActivationSource: () => ({ kind: 'bundled', moduleId: `@acme/native/lifecycle-recovery/${generation}`,
                load: async () => ({ activate(api: PluginApi) { api.projectNativeAdapters.register('native', { nativeServiceLifecycle }); } }) }),
        });
        const original = await activate(1);
        let replacement: Awaited<ReturnType<typeof activate>> | undefined;
        const releases: Array<() => Promise<void>> = [];
        try {
            const unavailable = await resolveProjectNativeAdapter({ reference: instance.adapter, role: 'nativeServiceLifecycle', targets, registry: original });
            if (unavailable.kind !== 'ready') throw new Error(unavailable.code);
            const unavailableCapture = unavailable.lease.captureNativeServiceLifecycle(instance, { root });
            if (unavailableCapture.kind !== 'ready') throw new Error(unavailableCapture.code);
            await expect(unavailableCapture.lifecycle.inspect(instance)).rejects.toSatisfy((error: unknown) =>
                isPluginError(error) && error.code === 'native_adapter_invocation_unavailable');
            const selected = await resolveProjectNativeAdapter({ reference: instance.adapter, role: 'nativeServiceLifecycle', targets, registry: original, createInvocationContext });
            if (selected.kind !== 'ready') throw new Error(selected.code);
            const discovery = selected.lease.captureNativeServiceLifecycle(null, { machine });
            if (discovery.kind !== 'ready') throw new Error(discovery.code);
            releases.push(discovery.release);
            expect(discoveredMachines).toEqual([]);
            expect(accountingBatches).toEqual([]);
            await expect(discovery.lifecycle.discover?.({ ...machine, machineId: 'another-machine' }))
                .rejects.toMatchObject({ code: 'native_adapter_reference_mismatch' });
            const cancelled = new AbortController();
            cancelled.abort();
            await expect(discovery.lifecycle.discover?.(machine, { signal: cancelled.signal }))
                .rejects.toMatchObject({ code: 'native_adapter_cancelled' });
            expect(discoveredMachines).toEqual([]);
            expect(await discovery.lifecycle.discover?.(machine)).toMatchObject({ kind: 'ready', candidates: [
                { instance }, { instance: secondInstance },
            ] });
            expect(discoveredMachines).toEqual([machine]);
            await expect(discovery.lifecycle.start?.(instance)).rejects.toMatchObject({ code: 'native_adapter_reference_mismatch' });
            await expect(discovery.lifecycle.accounting?.([instance, secondInstance])).resolves.toMatchObject({ kind: 'sample', samples: [
                { instance, cpuPercent: 5 }, { instance: secondInstance, cpuPercent: 5 },
            ] });
            expect(accountingBatches).toEqual([[instance, secondInstance]]);
            await expect(discovery.lifecycle.accounting?.([{ ...instance, adapter: { pluginId: 'wrong.adapter', localId: 'native' } }]))
                .rejects.toMatchObject({ code: 'native_adapter_reference_mismatch' });
            expect(accountingBatches).toHaveLength(1);
            await expect(discovery.lifecycle.accounting?.([instance], { signal: cancelled.signal }))
                .rejects.toMatchObject({ code: 'native_adapter_cancelled' });
            expect(accountingBatches).toHaveLength(1);
            wrongDiscoveryAdapter = true;
            await expect(discovery.lifecycle.discover?.(machine)).rejects.toMatchObject({ code: 'native_adapter_reference_mismatch' });
            wrongDiscoveryAdapter = false;
            wrongAccountingResource = true;
            await expect(discovery.lifecycle.accounting?.([instance])).rejects.toMatchObject({ code: 'native_adapter_reference_mismatch' });
            wrongAccountingResource = false;
            expect(logReads).toBe(0);
            await discovery.release();
            await expect(discovery.lifecycle.discover?.(machine)).rejects.toMatchObject({ code: 'native_adapter_retired' });
            const captured = selected.lease.captureNativeServiceLifecycle(instance, { root });
            if (captured.kind !== 'ready') throw new Error(captured.code);
            expect(sourceCaptures).toEqual([]);
            expect(await captured.captureComposeDefinition?.([])).toMatchObject({ origin: {
                projectName: 'retained-project', dockerEndpoint: 'retained-engine', workingDirectory: root },
                services: ['app'], profiles: [], variables: [] });
            expect(sourceCaptures).toEqual([instance]);
            releases.push(captured.release);
            expect(await captured.lifecycle.inspect(instance)).toMatchObject({ phase: 'running' });
            expect(await captured.lifecycle.logs?.(instance, { kind: 'read', maxBytes: 8_192 })).toMatchObject({ kind: 'page', page: { text: '{"phase":"running"}' } });
            await expect(captured.lifecycle.logs?.({ ...instance, nativeResourceId: 'replacement' }, { kind: 'read', maxBytes: 8_192 }))
                .rejects.toMatchObject({ code: 'native_adapter_reference_mismatch' });
            await expect(captured.lifecycle.accounting?.([instance, secondInstance])).rejects.toMatchObject({ code: 'native_adapter_reference_mismatch' });
            expect(captured.lifecycle.start).toBeTypeOf('function');
            expect(captured.lifecycle.restart).toBeTypeOf('function');
            const retiringDiscovery = selected.lease.captureNativeServiceLifecycle(null, { machine });
            if (retiringDiscovery.kind !== 'ready') throw new Error(retiringDiscovery.code);
            releases.push(retiringDiscovery.release);
            await original.dispose();
            await expect(captured.captureComposeDefinition?.([])).rejects.toMatchObject({ code: 'native_adapter_retired' });
            expect(sourceCaptures).toEqual([instance]);
            await expect(captured.lifecycle.logs?.(instance, { kind: 'read', maxBytes: 8_192 })).rejects.toMatchObject({ code: 'native_adapter_retired' });
            await expect(retiringDiscovery.lifecycle.discover?.(machine)).rejects.toMatchObject({ code: 'native_adapter_retired' });
            await expect(retiringDiscovery.lifecycle.accounting?.([instance])).rejects.toMatchObject({ code: 'native_adapter_retired' });
            await expect(captured.lifecycle.start?.(instance)).rejects.toMatchObject({ code: 'native_adapter_retired' });
            await expect(captured.lifecycle.restart?.(instance)).rejects.toMatchObject({ code: 'native_adapter_retired' });
            await expect(captured.lifecycle.stop(instance)).rejects.toThrow();
            expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ phase: 'running' });
            replacement = await activate(2);
            const recovered = await resolveProjectNativeAdapter({ reference: instance.adapter, role: 'nativeServiceLifecycle', targets, registry: replacement, createInvocationContext });
            if (recovered.kind !== 'ready') throw new Error(recovered.code);
            const current = recovered.lease.captureNativeServiceLifecycle(instance, { root });
            if (current.kind !== 'ready') throw new Error(current.code);
            releases.push(current.release);
            expect(await current.lifecycle.inspect(instance)).toMatchObject({ phase: 'running' });
            expect(await current.lifecycle.stop(instance)).toEqual({ status: 'stopped' });
            expect(await current.lifecycle.inspect(instance)).toMatchObject({ phase: 'stopped' });
            for (const operation of ['start', 'restart'] as const) {
                await expect(current.lifecycle[operation]?.({ ...instance, nativeResourceId: 'replacement' }))
                    .rejects.toMatchObject({ code: 'native_adapter_reference_mismatch' });
                expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ phase: 'stopped' });
                const cancelled = new AbortController();
                cancelled.abort();
                await expect(current.lifecycle[operation]?.(instance, { signal: cancelled.signal }))
                    .rejects.toMatchObject({ code: 'native_adapter_cancelled' });
                expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ phase: 'stopped' });
                expect(await current.lifecycle[operation]?.(instance)).toMatchObject({ phase: 'running' });
                expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ phase: 'running', control: operation });
                expect(await current.lifecycle.stop(instance)).toEqual({ status: 'stopped' });
            }
        } finally {
            for (const release of releases) await release();
            await replacement?.dispose();
            await original.dispose();
            await owners.dispose();
            await rm(root, { recursive: true, force: true });
        }
    });
});
