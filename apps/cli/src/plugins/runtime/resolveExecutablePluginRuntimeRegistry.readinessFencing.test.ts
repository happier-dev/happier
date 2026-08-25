import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readPluginManifest } from '@/plugins/manifest/read';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';

import { hasBlockingPluginReloadDiagnostic } from './reload/controller';
import {
    type PluginRuntimeActivationRegistryLease,
    resolveExecutablePluginRuntimeRegistry,
} from './resolveExecutablePluginRuntimeRegistry';

const PLUGIN_ID = 'acme.readiness-fencing';

async function seedFixture(): Promise<Readonly<{ happyHomeDir: string; pluginRoot: string }>> {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-readiness-fencing-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-readiness-fencing-plugin-'));
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
        },
    }), 'utf8');
    await writeFile(
        join(pluginRoot, 'daemon.mjs'),
        'export function activate(api) { api.hooks.register("resolve-prerequisites", async () => ({ decision: "abstain" })); }\n',
        'utf8',
    );
    await seedCurrentLocalPathPluginFixture({
        happyHomeDir,
        pluginRoot,
        pluginId: PLUGIN_ID,
        manifestVersion: '1.0.0',
    });
    return Object.freeze({ happyHomeDir, pluginRoot });
}

async function resolveFixtureRuntimeInputs(happyHomeDir: string) {
    const generationAuthority = await readCurrentCommittedPluginGenerations(
        resolvePluginStorePaths({ happyHomeDir }),
        { bundledArtifacts: [], isolateInvalidInstalledGenerations: false },
    );
    const admitted = generationAuthority?.generations.get(PLUGIN_ID);
    if (!generationAuthority || !admitted) {
        throw new Error('Expected the admitted immutable fixture generation');
    }
    const manifestPath = join(admitted.rootPath, ...admitted.record.manifestRelativePath.split('/'));
    const immutableManifest = await readPluginManifest({
        sourceProvenance: 'registryCustodied',
        manifestPath,
        manifestAuthority: 'external',
        enforceEngineCompatibility: true,
    });
    if (!immutableManifest.ok) {
        throw new Error(immutableManifest.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
    }
    const sourceSpec = {
        kind: 'path' as const,
        locator: admitted.rootPath,
        trustPolicy: 'local_trusted' as const,
        installPolicy: 'link' as const,
        resolvedVersion: '1.0.0',
    };
    return Object.freeze({
        generationAuthority,
        contributes: createResolvedContributionRegistry({
            activationTargets: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: PLUGIN_ID,
                manifestPath,
                daemonEntryPath: join(admitted.rootPath, 'daemon.mjs'),
                sourceSpec,
                activationEvents: ['startup'],
                manifest: immutableManifest.manifest,
            }],
        }),
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
            expect(
                (runtime.retainActivationRegistryComponentsExcluding?.(new Set()) ?? [])
                    .flatMap((lease) => [...lease.pluginIds]),
            ).toEqual([PLUGIN_ID]);

            await runtime.recordPluginActivationFailure?.(
                PLUGIN_ID,
                'cold-start daemon database preparation failed: database file is read-only',
            );
            expect(runtime.activatedPluginIds.has(PLUGIN_ID)).toBe(false);

            retained = runtime.retainActivationRegistryComponentsExcluding?.(new Set()) ?? [];
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
