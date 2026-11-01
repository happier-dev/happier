import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';

import { hasBlockingPluginReloadDiagnostic } from './reload/controller';
import { executeContributedAction } from './invocation/actions/executeContributedAction';
import {
    resolveExecutablePluginRuntimeRegistry,
} from './resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeActivationRegistryLease } from './composition/activationAssembly';

const PLUGIN_ID = 'acme.readiness-fencing';

async function seedFixture(options?: Readonly<{
    /** Adds one finite background service and an independent Action. */
    settlingBackgroundService?: boolean;
    /** Makes activation cleanup observable outside the loaded module graph. */
    activationCleanup?: boolean;
}>): Promise<Readonly<{ happyHomeDir: string; pluginRoot: string; cleanupMarkerPath: string }>> {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-readiness-fencing-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-readiness-fencing-plugin-'));
    const cleanupMarkerPath = join(pluginRoot, 'activation-cleaned');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
        schemaVersion: 2,
        id: PLUGIN_ID,
        version: '1.0.0',
        displayName: 'Readiness fencing fixture',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        activation: { events: [{ kind: 'startup' }] },
        hostAccess: { required: [], optional: [] },
        contributes: {
            hooks: [{
                hookApiVersion: 1,
                id: 'resolve-prerequisites',
                on: 'agent.resolvePrerequisites',
                category: 'decision',
                executionKind: 'decide',
                scope: 'agent',
            }],
            ...(options?.settlingBackgroundService
                ? {
                    backgroundServices: [{ id: 'watcher' }],
                    actions: [{
                        id: 'status', title: 'Status', scopes: ['global'], surfaces: ['cli'],
                        execution: { target: 'daemon' }, dangerLevel: 'safe',
                        placementBindings: ['primary'],
                    }],
                }
                : {}),
        },
    }), 'utf8');
    await writeFile(
        join(pluginRoot, 'daemon.mjs'),
        'let completed = false; export function activate(api) { api.hooks.register("resolve-prerequisites", async () => ({ decision: "abstain" }));'
        + (options?.settlingBackgroundService
            ? ' api.backgroundServices.register("watcher", async () => { completed = true; }); api.actions.register("status", async () => ({ completed }));'
            : '')
        + (options?.activationCleanup
            ? ` return async () => { const { appendFile } = await import("node:fs/promises"); await appendFile(${JSON.stringify(cleanupMarkerPath)}, "cleaned\\n", "utf8"); };`
            : '')
        + ' }\n',
        'utf8',
    );
    await seedCurrentLocalPathPluginFixture({
        happyHomeDir,
        pluginRoot,
        pluginId: PLUGIN_ID,
        manifestVersion: '1.0.0',
    });
    return Object.freeze({ happyHomeDir, pluginRoot, cleanupMarkerPath });
}

async function resolveFixtureRuntimeInputs(happyHomeDir: string) {
    const generationAuthority = await readCurrentCommittedPluginGenerations(
        resolvePluginStorePaths({ happyHomeDir }),
        { isolateInvalidInstalledGenerations: false },
    );
    const admitted = generationAuthority?.generations.get(PLUGIN_ID);
    if (!generationAuthority || !admitted) {
        throw new Error('Expected the admitted immutable fixture generation');
    }
    return Object.freeze({
        generationAuthority,
        contributes: createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }),
            provenance: 'external',
            existingAgentIds: new Set(),
        })),
    });
}

describe('executable plugin readiness fencing', () => {
    // Cold startup isolates a readiness participant that rejects, but isolation
    // alone would leave the rejected plugin advertised as ready. The fence must
    // make every reader agree it is not: the activated set, the one activation
    // fact the catalog projects, the blocking-diagnostic owner the reload path
    // already uses, and the plugin's live consumer generation. Every pre-fence
    // assertion is the falsification half — a healthy activated plugin keeps
    // serving, undiagnosed and unfenced.
    it('fences an activated plugin whose readiness was rejected and stops advertising it as active', async () => {
        const fixture = await seedFixture();
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;

        try {
            const inputs = await resolveFixtureRuntimeInputs(fixture.happyHomeDir);
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir: fixture.happyHomeDir,
                contributes: inputs.contributes,
                generationAuthority: inputs.generationAuthority,
            });

            expect(runtime.activatedPluginIds.has(PLUGIN_ID)).toBe(true);
            expect(runtime.pluginFinalPolicyCurrentRuntimesById?.get(PLUGIN_ID)?.applied)
                .toBe(true);
            expect(hasBlockingPluginReloadDiagnostic(runtime, [PLUGIN_ID])).toBe(false);
            expect(runtime.targetActivationFacts?.filter((fact) => fact.pluginId === PLUGIN_ID))
                .toEqual([expect.objectContaining({ status: 'active' })]);
            const handler = (runtime.hookHandlersByHookId.get('agent.resolvePrerequisites') ?? [])
                .find((entry) => entry.pluginId === PLUGIN_ID);
            if (!handler) throw new Error('Expected the activated fixture hook handler');

            await runtime.recordPluginActivationFailure?.(
                PLUGIN_ID,
                'cold-start daemon database preparation failed: database file is read-only',
            );

            expect(runtime.activatedPluginIds.has(PLUGIN_ID)).toBe(false);
            expect(runtime.pluginFinalPolicyCurrentRuntimesById?.get(PLUGIN_ID)?.applied)
                .toBe(false);
            // Exactly one typed diagnostic, and exactly one activation fact: an
            // inactive target may never keep publishing bound contributions.
            expect(runtime.pluginDiagnosticsByPluginId[PLUGIN_ID]).toEqual([{
                code: 'plugin_activation_failed',
                message: 'cold-start daemon database preparation failed: database file is read-only',
            }]);
            expect(runtime.targetActivationFacts?.filter((fact) => fact.pluginId === PLUGIN_ID))
                .toEqual([expect.objectContaining({
                    status: 'unavailable',
                    bound: [],
                    diagnostics: [{
                        code: 'plugin_activation_failed',
                        message:
                            'cold-start daemon database preparation failed: database file is read-only',
                    }],
                })]);
            expect(hasBlockingPluginReloadDiagnostic(runtime, [PLUGIN_ID])).toBe(true);
            // Genuinely fenced, not merely unadvertised: the retired generation
            // refuses its own registered handler without calling plugin code.
            await expect(handler.handler(undefined, {}))
                .rejects.toThrow(`Plugin '${PLUGIN_ID}' hook handler is no longer active`);
        } finally {
            await runtime?.dispose();
            await rm(fixture.happyHomeDir, { recursive: true, force: true });
            await rm(fixture.pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it('settles a failed readiness participant activation component before returning from the fence', async () => {
        const fixture = await seedFixture({ activationCleanup: true });
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        const runtimeDisposableCalls: string[] = [];

        try {
            const inputs = await resolveFixtureRuntimeInputs(fixture.happyHomeDir);
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir: fixture.happyHomeDir,
                contributes: inputs.contributes,
                generationAuthority: inputs.generationAuthority,
            });
            runtime.addRuntimeDisposable?.(PLUGIN_ID, Object.freeze({
                dispose: async () => { runtimeDisposableCalls.push('disposed'); },
            }));
            const handler = (runtime.hookHandlersByHookId.get('agent.resolvePrerequisites') ?? [])
                .find((entry) => entry.pluginId === PLUGIN_ID);
            if (!handler) throw new Error('Expected the activated fixture hook handler');

            await runtime.recordPluginActivationFailure?.(
                PLUGIN_ID,
                'cold-start primary Agent runtime construction failed: runtime rejected',
            );

            await expect(handler.handler(undefined, {}))
                .rejects.toThrow(`Plugin '${PLUGIN_ID}' hook handler is no longer active`);
            expect(await readFile(fixture.cleanupMarkerPath, 'utf8')).toBe('cleaned\n');
            expect(runtimeDisposableCalls).toEqual(['disposed']);
            expect(runtime.retainPluginActivationComponent?.(PLUGIN_ID) ?? null).toBeNull();

            await runtime.dispose();
            expect(await readFile(fixture.cleanupMarkerPath, 'utf8')).toBe('cleaned\n');
            expect(runtimeDisposableCalls).toEqual(['disposed']);
            runtime = null;
        } finally {
            await runtime?.dispose();
            await rm(fixture.happyHomeDir, { recursive: true, force: true });
            await rm(fixture.pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);
    it('keeps independent Actions available after a background service normally completes', async () => {
        const fixture = await seedFixture({ settlingBackgroundService: true });
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;

        try {
            const inputs = await resolveFixtureRuntimeInputs(fixture.happyHomeDir);
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir: fixture.happyHomeDir,
                contributes: inputs.contributes,
                generationAuthority: inputs.generationAuthority,
            });

            expect(runtime.activatedPluginIds.has(PLUGIN_ID)).toBe(true);
            expect(runtime.pluginFinalPolicyCurrentRuntimesById?.get(PLUGIN_ID)?.applied)
                .toBe(true);
            const handler = (runtime.hookHandlersByHookId.get('agent.resolvePrerequisites') ?? [])
                .find((entry) => entry.pluginId === PLUGIN_ID);
            if (!handler) throw new Error('Expected the activated fixture hook handler');

            const active = runtime;
            const invokeStatus = () => executeContributedAction({
                runtimeRegistry: active,
                actionId: `${PLUGIN_ID}/status`,
                input: {},
                context: { surface: 'cli' },
            });
            await expect(invokeStatus()).resolves.toMatchObject({
                matched: true, result: { ok: true, result: { completed: false } },
            });
            active.startAdoptedBackgroundServices?.();
            // Drain the finite runner and its settlement callbacks before invoking again.
            await new Promise<void>((resolve) => setImmediate(resolve));
            await expect(invokeStatus()).resolves.toMatchObject({
                matched: true, result: { ok: true, result: { completed: true } },
            });
            expect(active.activatedPluginIds.has(PLUGIN_ID)).toBe(true);
            expect(active.pluginFinalPolicyCurrentRuntimesById?.get(PLUGIN_ID)?.applied).toBe(true);
            await expect(handler.handler({}, {}))
                .resolves.toEqual({ decision: 'abstain' });
        } finally {
            await runtime?.dispose();
            await rm(fixture.happyHomeDir, { recursive: true, force: true });
            await rm(fixture.pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);
    // A fence that the next reload silently undoes is not a fence. The reload
    // path retains every activation component whose plugin did not change, and
    // a plugin fenced at cold start did not change — so the fence itself is the
    // only thing that can keep its component out of the successor registry.
    it('does not donate a fenced plugin activation component to a successor registry', async () => {
        const fixture = await seedFixture();
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let successor: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let retained: readonly PluginRuntimeActivationRegistryLease[] = [];

        try {
            const inputs = await resolveFixtureRuntimeInputs(fixture.happyHomeDir);
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir: fixture.happyHomeDir,
                contributes: inputs.contributes,
                generationAuthority: inputs.generationAuthority,
            });
            expect(runtime.activatedPluginIds.has(PLUGIN_ID)).toBe(true);
            // Falsification half: an unfenced healthy plugin must still be
            // donated, or this assertion would pass by donating nothing at all.
            const donated = runtime.retainPluginActivationComponent?.(PLUGIN_ID) ?? null;
            expect(donated ? [...donated.pluginIds] : []).toEqual([PLUGIN_ID]);
            await donated?.release();

            await runtime.recordPluginActivationFailure?.(
                PLUGIN_ID,
                'cold-start daemon database preparation failed: database file is read-only',
            );
            expect(runtime.activatedPluginIds.has(PLUGIN_ID)).toBe(false);

            const retainedComponent = runtime.retainPluginActivationComponent?.(PLUGIN_ID) ?? null;
            retained = retainedComponent ? [retainedComponent] : [];
            successor = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir: fixture.happyHomeDir,
                contributes: inputs.contributes,
                generationAuthority: inputs.generationAuthority,
                pluginIds: [],
                retainedActivationRegistryLeases: retained,
            });

            expect(successor.activatedPluginIds.has(PLUGIN_ID)).toBe(false);
            // Resurrection would re-merge the component's registered handlers,
            // so the successor must not expose one for the fenced plugin.
            expect(
                (successor.hookHandlersByHookId.get('agent.resolvePrerequisites') ?? [])
                    .map((entry) => entry.pluginId),
            ).toEqual([]);
        } finally {
            await successor?.dispose();
            await Promise.all(retained.map((lease) => lease.release()));
            await runtime?.dispose();
            await rm(fixture.happyHomeDir, { recursive: true, force: true });
            await rm(fixture.pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);
});
