import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';

it('resolves the exact runner bootstrap without discovering unrelated plugins', async () => {
    // This offline bootstrap has no bearer, Account files or Agent executable.
    // Keep the real private-file reader, declaration projection and engine owner.
    const home = await mkdtemp(join(tmpdir(), 'happier-runner-bootstrap-'));
    const profiling = process.env.HAPPIER_SPAWN_BOOTSTRAP_BENCHMARK === '1';
    const profiler = new Session();
    const started = performance.now();
    profiler.connect();
    try {
        await profiler.post('Profiler.enable');
        await profiler.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
        if (profiling) {
            await profiler.post('Profiler.start');
        }
        const { createRunnerAgentSessionRuntimeBootstrap } = await import('../session/process/runnerAgentSessionRuntimeSource');
        const { resolveCliEngineRegistry, resolveBackendEngineAdapterResolution } = await import('./engineRegistry');
        const modulesMs = performance.now() - started;
        const bootstrapFilePath = join(home, 'bootstrap.json');
        await writeFile(bootstrapFilePath, JSON.stringify({
            v: 1,
            descriptor: {
                v: 1, pluginId: 'happier.agent.codex', pluginVersion: '1.0.0',
                agentId: 'codex', backendId: 'codex', occurrenceId: 'offline-bootstrap',
                sourceCustody: { kind: 'managed', immutableGenerationId: 'offline-generation', installSource: 'localPath' },
                agentDeclaration: {
                    provenance: 'first_party', source: { kind: 'bundled' },
                    definition: {
                        id: 'codex', title: { key: 'agents.codex.title', fallback: 'Codex' },
                        runtime: { kind: 'custom' }, primary: 'sessions',
                        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                    },
                },
            },
        }), { mode: 0o600 });
        const bootstrapStarted = performance.now();
        const source = await createRunnerAgentSessionRuntimeBootstrap({
            happyHomeDir: home, publicReleaseRing: 'publicdev', bootstrapFilePath,
            authorityFilePath: join(home, 'authority-must-not-be-read.json'),
        });
        expect(source).not.toBeNull();
        if (!source) throw new Error('Offline runner bootstrap was rejected');
        const bootstrapMs = performance.now() - bootstrapStarted;
        const engineStarted = performance.now();
        const registry = await resolveCliEngineRegistry({
            happyHomeDir: home, backendId: source.identity.backendId,
            requireRunnerAgentSessionRuntimeSource: true, runnerAgentSessionRuntimeSource: source,
        });
        const engineMs = performance.now() - engineStarted;
        const resolutionStarted = performance.now();
        const resolution = await registry.resolveForBackendId(source.identity.backendId);
        const resolutionMs = performance.now() - resolutionStarted;
        const coverage = await profiler.post('Profiler.takePreciseCoverage');
        const manifestIngestFunctions = coverage.result
            .filter((script) => script.url.endsWith('/packages/protocol/src/plugins/manifest/ingest.ts'))
            .flatMap((script) => script.functions)
            .filter((fn) => fn.functionName === 'ingestPluginManifestV2');
        expect(manifestIngestFunctions.length).toBeGreaterThan(0);
        const manifestIngestCount = manifestIngestFunctions
            .reduce((count, fn) => count + (fn.ranges[0]?.count ?? 0), 0);
        if (profiling) {
            const { profile } = await profiler.post('Profiler.stop');
            const artifactDir = await mkdtemp(join(tmpdir(), 'happier-spawn-profile-'));
            const measurement = { artifactDir, modulesMs, bootstrapMs, engineMs, resolutionMs,
                agents: registry.contributions.agents.length, actions: registry.contributions.actions.length, manifestIngestCount,
                node: process.version, platform: process.platform };
            await writeFile(join(artifactDir, 'bootstrap.cpuprofile'), JSON.stringify(profile));
            await writeFile(join(artifactDir, 'measurement.json'), JSON.stringify(measurement));
            console.log('SPAWN_BOOTSTRAP_BENCHMARK', JSON.stringify(measurement));
        }
        // Observe real admission work, not a mock of the manifest or catalog
        // owner: this Session already has its daemon-admitted declaration.
        expect(manifestIngestCount).toBe(0);
        expect(resolution?.agent).toBe(source.agentContribution);
        // Discovery remains bounded to the selected declaration rather than
        // the unrelated installed or bundled catalog.
        expect(registry.contributions.agents.map((agent) => agent.id)).toEqual([source.agentContribution.id]);
        expect(registry.contributions.agents[0]).toBe(source.agentContribution);
        expect(registry.contributions.actions).toHaveLength(0);
        // Exercise the entry point used by SessionHostBridge without giving it
        // an explicit discovery registry or an independently supplied target.
        const sessionResolution = await resolveBackendEngineAdapterResolution(source.identity.backendId, {
            happyHomeDir: home, requireRunnerAgentSessionRuntimeSource: true,
            runnerAgentSessionRuntimeSource: source,
        });
        expect(sessionResolution?.agent).toBe(source.agentContribution);
        await expect(source.createRuntime({ signal: new AbortController().signal })).rejects.toMatchObject({
            code: 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING',
        });
    } finally {
        profiler.disconnect();
        await rm(home, { recursive: true, force: true });
    }
}, 180_000);
