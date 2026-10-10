import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
    ResolvedContributionRegistry,
    ResolvedActivatedHookRegistration,
} from '@/plugins/projection/registry/types';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolvePluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

describe('executable plugin hook activation ownership', () => {
    it('activates the exact bundled Codex hook demand and projects its registered handler', async () => {
        const runtime = await resolveExecutablePluginRuntimeRegistry();

        try {
            expect(runtime.activatedPluginIds.has('happier.agent.codex')).toBe(false);

            await runtime.activateContributionsOnDemand([{
                pluginId: 'happier.agent.codex',
                family: 'hooks',
                localId: 'resolve-prerequisites',
            }]);

            expect(runtime.activatedPluginIds.has('happier.agent.codex')).toBe(true);
            expect(
                runtime.hookHandlersByHookId.get('agent.resolvePrerequisites'),
            ).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    pluginId: 'happier.agent.codex',
                    localId: 'resolve-prerequisites',
                    handler: expect.any(Function),
                }),
            ]));
        } finally {
            await runtime.dispose();
        }
    });

    it.each(['demand', 'validation'] as const)('retains bound consumers when activation facts are unchanged (%s)', async (mode) => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-warm-activation-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-warm-activation-plugin-'));
        const pluginId = 'acme.warm-activation';
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        try {
            await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
            await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture({
                id: pluginId,
                contributes: {
                    actions: [{ id: 'run', title: 'Run', scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe',
                        inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }],
                    hooks: [{ id: 'after-spawn', on: 'session.spawned', category: 'lifecycle', scope: 'session', executionKind: 'observe' }],
                },
            })), 'utf8');
            await writeFile(join(pluginRoot, 'daemon.mjs'), `export function activate(api) {
                api.actions.register('run', async (input) => input);
                api.hooks.register('after-spawn', async () => ({}));
            }`, 'utf8');
            await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: '1.0.0' });
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes: createResolvedContributionRegistry(await resolvePluginContributes({ happyHomeDir })),
            });
            expect(runtime.activatedPluginIds.has(pluginId)).toBe(false);
            const demand = [{ pluginId, family: 'hooks' as const, localId: 'after-spawn' }];
            await runtime.activateContributionsOnDemand(demand);
            expect(runtime.targetActionInvocations?.has(pluginId, 'run')).toBe(true);
            const publishedHandlers = runtime.hookHandlersByHookId.get('session.spawned');
            expect(publishedHandlers).toEqual([expect.objectContaining({ pluginId, localId: 'after-spawn' })]);
            const activeRuntime = runtime;
            const startedAt = performance.now();
            for (let iteration = 0; iteration < 20; iteration += 1) {
                if (mode === 'demand') await activeRuntime.activateContributionsOnDemand(demand);
                else await activeRuntime.activatePluginsForValidation!([pluginId]);
            }
            if (process.env.HAPPIER_RUN_DAEMON_STALL_BENCH === '1') {
                console.log(JSON.stringify({ mode, warmDemands: 20, elapsedMs: performance.now() - startedAt }));
            }
            // A no-op activation must retain the bound consumer projection,
            // rather than allocate wrappers and rebuild unrelated registries.
            expect(runtime.hookHandlersByHookId.get('session.spawned')).toBe(publishedHandlers);
        } finally {
            await runtime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });

    it('does not import or bind a manifest-static hook export outside named activation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-static-hook-deny-'));
        const daemonEntryPath = join(root, 'daemon.mjs');
        await writeFile(daemonEntryPath, [
            'globalThis.__HAPPIER_STATIC_HOOK_IMPORTED = true;',
            'export async function legacyHook() { return { decision: "abstain" }; }',
        ].join('\n'), 'utf8');
        const registration: ResolvedActivatedHookRegistration = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.static-hook',
            manifestPath: join(root, 'happier.plugin.json'),
            daemonEntryPath,
            sourceSpec: {
                kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link',
            },
            definition: {
                hookApiVersion: 1,
                id: 'agent.resolvePrerequisites',
                category: 'decision',
                scope: 'agent',
                executionKind: 'decide',
            },
        };
        const contributes = {
            uiViewsV2: [], uiRenderersV2: [], uiTranslationsV2: [],
            agents: [], actions: [], tools: [], commands: [], resources: [],
            activationTargets: [], hookRegistrations: [registration],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const globalWithMarker = globalThis as typeof globalThis & {
            __HAPPIER_STATIC_HOOK_IMPORTED?: boolean;
        };
        delete globalWithMarker.__HAPPIER_STATIC_HOOK_IMPORTED;

        try {
            const runtime = await resolveExecutablePluginRuntimeRegistry({
                contributes,
                generation: 1,
            });

            expect(globalWithMarker.__HAPPIER_STATIC_HOOK_IMPORTED).toBeUndefined();
            expect(runtime.hookHandlersByHookId.get('agent.resolvePrerequisites')).toBeUndefined();
            await runtime.dispose();
        } finally {
            delete globalWithMarker.__HAPPIER_STATIC_HOOK_IMPORTED;
        }
    });
});
