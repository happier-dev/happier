import { Session } from 'node:inspector/promises';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';

// Opt-in offline measurement: no executable plugin activation, native probes or Account reads.
it.skipIf(process.env.HAPPIER_PROJECTION_BENCHMARK !== '1')('profiles the real bundled contribution projection', async () => {
    // Ordinary unit-suite collection must not load the entire first-party graph.
    // Load the shared graph sequentially instead of competing test-loader entrypoints.
    const { createResolvedContributionRegistry } = await import('../createResolvedContributionRegistry');
    const { resolveBuiltInContributions } = await import('../resolveBuiltInContributions');
    const { BUNDLED_FIRST_PARTY_PLUGIN_METADATA } = await import('../sources/generatedBundledPluginManifests');
    const { buildPluginProjectionV2 } = await import('./v2');
    const { resolveDeclarativeProjectionModels } = await import('../ui/declarativeModels');
    console.log('PROJECTION_BENCHMARK_MODULES_READY');
    // Keep generated evidence outside the source synchronization tree.
    const artifactDir = await mkdtemp(join(tmpdir(), 'happier-projection-build-'));
    const session = new Session();
    session.connect();
    try {
        await session.post('Profiler.enable');
        await session.post('Profiler.start');
        const setupStarted = performance.now();
        const contributions = resolveBuiltInContributions();
        const contributionsMs = performance.now() - setupStarted;
        const registryStarted = performance.now();
        const registry = createResolvedContributionRegistry({
            ...contributions,
            immutableGenerationIdsByPluginId: Object.fromEntries(BUNDLED_FIRST_PARTY_PLUGIN_METADATA.map(({ pluginId }) => [pluginId, `generation:${pluginId}`])),
            occurrenceIdsByPluginId: Object.fromEntries(BUNDLED_FIRST_PARTY_PLUGIN_METADATA.map(({ pluginId }) => [pluginId, `occurrence:${pluginId}`])),
        });
        const registryMs = performance.now() - registryStarted;
        const setupMs = performance.now() - setupStarted;
        const started = performance.now();
        const failures: string[] = [];
        const modelsByRendererKey = resolveDeclarativeProjectionModels({
            registry, readPluginOccurrenceId: pluginId => registry.occurrenceIdsByPluginId?.[pluginId] ?? null,
            onRendererModelUnavailable: ({ pluginId, rendererId, error }) => failures.push(`${pluginId}/${rendererId}: ${String(error)}`),
        });
        const modelsMs = performance.now() - started;
        const projection = buildPluginProjectionV2({ registry, generation: 1, requestedLocale: 'en',
            pluginUiHostRuntime: { declarative: { modelsByRendererKey } } });
        const response = { protocolVersion: 1, projection };
        const buildMs = performance.now() - started;
        const { profile } = await session.post('Profiler.stop');
        const coreStarted = performance.now();
        buildPluginProjectionV2({ registry, generation: 1, requestedLocale: 'en' });
        const coreMs = performance.now() - coreStarted;
        const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
        const sections = Object.fromEntries(Object.entries(projection).map(([key, value]) => [key, bytes(value)]));
        const families = Object.fromEntries(Object.entries(projection.familiesById).map(([key, value]) => [key, bytes(value)]));
        const uiKinds: Record<string, number> = {};
        const uiPlugins: Record<string, number> = {};
        for (const entry of Object.values(projection.familiesById.pluginUi?.entriesById ?? {})) {
            uiKinds[entry.contributionKind] = (uiKinds[entry.contributionKind] ?? 0) + bytes(entry);
            uiPlugins[entry.pluginId] = (uiPlugins[entry.pluginId] ?? 0) + bytes(entry);
        }
        const nodes = new Map(profile.nodes.map(node => [node.id, node]));
        const parent = new Map<number, number>();
        for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
        const self = new Map<string, number>();
        const inclusive = new Map<string, number>();
        const key = (id: number) => { const frame = nodes.get(id)!.callFrame; return `${frame.functionName} ${frame.url}:${frame.lineNumber + 1}`; };
        for (const [i, sample] of (profile.samples ?? []).entries()) {
            const ms = (profile.timeDeltas?.[i] ?? 0) / 1000;
            self.set(key(sample), (self.get(key(sample)) ?? 0) + ms);
            const seen = new Set<string>();
            for (let id: number | undefined = sample; id !== undefined; id = parent.get(id)) {
                const frame = key(id);
                if (!seen.has(frame)) inclusive.set(frame, (inclusive.get(frame) ?? 0) + ms);
                seen.add(frame);
            }
        }
        const top = (entries: Map<string, number>) => [...entries].sort((a, b) => b[1] - a[1]).slice(0, 25);
        const measurement = { artifactDir, environment: { node: process.version, platform: process.platform, arch: process.arch },
            setupMs, contributionsMs, registryMs, modelsMs, buildMs, coreMs, failures, models: Object.keys(modelsByRendererKey).length, payloadBytes: bytes(response), plugins: BUNDLED_FIRST_PARTY_PLUGIN_METADATA.length,
            agents: registry.agents.length, actions: registry.actions.length, sections, families, uiKinds, uiPlugins };
        await writeFile(join(artifactDir, 'build.cpuprofile'), JSON.stringify(profile));
        await writeFile(join(artifactDir, 'measurement.json'), JSON.stringify(measurement, null, 2));
        await writeFile(join(artifactDir, 'profile-summary.json'), JSON.stringify({ self: top(self), inclusive: top(inclusive) }, null, 2));
        console.log('PROJECTION_BENCHMARK', JSON.stringify(measurement));
        console.log('PROJECTION_PROFILE', JSON.stringify({ self: top(self), inclusive: top(inclusive) }));
        expect(Object.keys(projection.agentsById)).toContain('codex');
        expect(Object.keys(projection.actionsById).length).toBeGreaterThan(0);
    } finally {
        session.disconnect();
    }
});

// The real runtime uses the CLI harness's empty per-process home, not any live daemon.
it.skipIf(process.env.HAPPIER_PROJECTION_BENCHMARK !== 'handler')('profiles the real runtime projection handler', async () => {
    const { resolveExecutablePluginRuntimeRegistry } = await import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry');
    const { registerDaemonContributionRegistryProjectionHandler, invalidateDaemonContributionRegistryProjectionCache } = await import('@/rpc/handlers/daemonContributionRegistryProjection');
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { configuration } = await import('@/configuration');
    const artifactDir = await mkdtemp(join(tmpdir(), 'happier-projection-handler-'));
    const session = new Session();
    session.connect();
    let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
    try {
        await session.post('Profiler.enable');
        await session.post('Profiler.start');
        const started = performance.now();
        runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: configuration.happyHomeDir, generation: 1 });
        const runtimeMs = performance.now() - started;
        const currentRuntime = runtime;
        const handlers = new Map<string, (input: unknown) => unknown>();
        registerDaemonContributionRegistryProjectionHandler({
            registerHandler<TRequest, TResponse>(method: string, handler: import('@/api/rpc/types').RpcHandler<TRequest, TResponse>) {
                // RPC transport fixture: the registered handler owns wire-input parsing.
                handlers.set(method, input => handler(input as TRequest));
            },
        }, {
            resolveRuntimeRegistry: async () => currentRuntime,
            resolveRegistry: async () => currentRuntime.contributes,
            resolveGeneration: async () => currentRuntime.generation,
            // This isolated home has no installed packages; bundled entries remain registry-owned.
            resolveInstalledPackages: async () => [],
        });
        invalidateDaemonContributionRegistryProjectionCache();
        const describe = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!;
        const buildStarted = performance.now();
        const response = await describe({ locale: 'en' });
        const coldDescribeMs = performance.now() - buildStarted;
        const warmStarted = performance.now();
        const warmResponse = await describe({ locale: 'en' });
        const warmDescribeMs = performance.now() - warmStarted;
        const measurement = { artifactDir, runtimeMs, coldDescribeMs, warmDescribeMs,
            payloadBytes: Buffer.byteLength(JSON.stringify(response)), sameCachedResponse: warmResponse === response,
            activatedPluginIds: [...currentRuntime.activatedPluginIds] };
        await writeFile(join(artifactDir, 'measurement.json'), JSON.stringify(measurement, null, 2));
        console.log('PROJECTION_HANDLER_BENCHMARK', JSON.stringify(measurement));
        expect(warmResponse).toBe(response);
    } finally {
        const { profile } = await session.post('Profiler.stop');
        await writeFile(join(artifactDir, 'build.cpuprofile'), JSON.stringify(profile));
        console.log('PROJECTION_HANDLER_PROFILE', artifactDir);
        session.disconnect();
        await runtime?.dispose();
    }
});
