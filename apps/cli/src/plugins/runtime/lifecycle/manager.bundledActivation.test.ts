import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

import { listDeclaredPluginContributionFamilies } from '@happier-dev/protocol';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { createBundledActivationSourceResolver } from '@/plugins/runtime/bundledActivationSource';
import { bindPluginRuntimeSourceAuthority } from '@/plugins/runtime/sourceAuthority';

import { shouldActivateTargetAtStartup } from './activation/targets';
import type { TargetInvocationServiceOwner } from './contributions/targetHooks';
import { activatePluginRuntimeRegistry } from './manager';

describe('bundled PluginApi parity', () => {
    it('activates the real frozen bundled Agent on first demand through canonical source custody', async () => {
        const repoDir = fileURLToPath(new URL('../../../../../../', import.meta.url));
        const outputDir = await mkdtemp('/var/tmp/happier-frozen-first-demand-');
        try {
            // The repository build script is a genuinely untyped development boundary.
            const { buildSourceRuntimeBundle } = await import(/* @vite-ignore */ pathToFileURL(join(repoDir, 'apps/stack/scripts/build/build_source_runtime.mjs')).href);
            const runtime = await buildSourceRuntimeBundle({ repoDir, outputDir: join(outputDir, 'runtime'), component: 'daemon' });
            const entry = join(outputDir, 'firstDemand.ts');
            const owner = (path: string) => JSON.stringify(join(repoDir, 'apps/cli/src', path));
            await writeFile(entry, `
                import assert from 'node:assert/strict';
                import {activatePluginRuntimeRegistry} from ${owner('plugins/runtime/lifecycle/manager.ts')};
                import {createDaemonPluginDevelopmentRootsOwner} from ${owner('plugins/daemon/developmentRoots.ts')};
                import {createBundledActivationSourceResolver} from ${owner('plugins/runtime/bundledActivationSource.ts')};
                import {createResolvedContributionRegistry} from ${owner('plugins/projection/registry/createResolvedContributionRegistry.ts')};
                import {resolveBuiltInContributions} from ${owner('plugins/projection/registry/resolveBuiltInContributions.ts')};
                export async function verify() {
                    const contributes = createResolvedContributionRegistry(resolveBuiltInContributions());
                    const roots = createDaemonPluginDevelopmentRootsOwner({
                        happyHomeDir: ${JSON.stringify(join(outputDir, 'home'))},
                        submitObservation: async () => {throw new Error('Frozen demand cannot prepare moving source');},
                        startCollectionObserver: async () => {throw new Error('Frozen demand cannot start watchers');},
                        startSourceObserver: async () => {throw new Error('Frozen demand cannot start watchers');},
                    });
                    const resolver = createBundledActivationSourceResolver({
                        bundledPackageNames: contributes.activationTargets.flatMap(target => target.daemonEntryPath ? [target.daemonEntryPath] : []),
                        resolveDevelopmentSourceAuthority: roots.resolveDevelopmentSourceAuthority,
                    });
                    const activated = await activatePluginRuntimeRegistry({
                        contributes, generation: 1, resolveActivationSource: resolver,
                        invocationServices: {
                            createOrdinaryServiceBinding() {throw new Error('First demand must not invoke a service');},
                            createServices() {throw new Error('First demand must not invoke a service');},
                            resolveInvocationHostPolicy() {throw new Error('First demand must not invoke a service');},
                        },
                    });
                    try {
                        const agent = contributes.agents.find(entry => entry.pluginId === 'happier.agent.codex');
                        assert.ok(agent?.identity);
                        assert.equal(activated.activatedPluginIds.has(agent.pluginId), false);
                        const demand = [{pluginId:agent.pluginId,family:'agents',localId:agent.identity.localId}];
                        await activated.activateContributionsOnDemand(demand);
                        assert.equal(activated.activatedPluginIds.has(agent.pluginId), true);
                        assert.deepEqual(activated.pluginDiagnosticsByPluginId[agent.pluginId] ?? [], []);
                        assert.equal(activated.readPluginSourceCustody(agent.pluginId)?.kind, 'development');
                        assert.equal(activated.agentRuntimesByAgentId.has(agent.identity.localId), true);
                        await activated.activateContributionsOnDemand(demand);
                        assert.equal(activated.targetActivationFacts.filter(fact => fact.pluginId === agent.pluginId && fact.status === 'active').length, 1);
                    } finally { await activated.dispose(); await roots.stop(); }
                }
            `);
            const harnessDir = join(runtime.cliDir, 'src/chunks');
            await mkdir(harnessDir, { recursive: true });
            await build({
                configFile: join(repoDir, 'apps/cli/vitest.config.ts'), logLevel: 'silent',
                build: {
                    outDir: harnessDir, emptyOutDir: false, minify: false,
                    lib: { entry, formats: ['es'], fileName: () => 'firstDemand.mjs' },
                    rollupOptions: { external: (id) => id.startsWith('node:') || builtinModules.includes(id)
                        || (!id.startsWith('.') && !isAbsolute(id) && !id.startsWith('@/') && !id.startsWith('@happier-dev/') && !id.startsWith('#') && !id.startsWith('\0')) },
                },
            });
            const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `await (await import(${JSON.stringify(pathToFileURL(join(harnessDir, 'firstDemand.mjs')).href)})).verify();`], {
                env: { ...process.env, ...runtime.env, HAPPIER_HOME_DIR: join(outputDir, 'home') }, encoding: 'utf8',
            });
            expect(child.status, child.stderr).toBe(0);
        } finally {
            await rm(outputDir, { recursive: true, force: true });
        }
    }, 120_000);

    it('keeps ordinary bundled Agents cold and activates one exactly once on first Agent demand', async () => {
        const contributes = createResolvedContributionRegistry(resolveBuiltInContributions());
        const resolveBundledActivationSource = createBundledActivationSourceResolver({
            bundledPackageNames: BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES,
            resolveDevelopmentSourceAuthority: ({ rootPath }) => {
                const authority = bindPluginRuntimeSourceAuthority({
                    custody: {
                        kind: 'development',
                        registeredRootId: rootPath,
                    },
                    resolvedRoot: rootPath,
                    observedRevision: 1,
                });
                return authority.kind === 'development' ? authority : null;
            },
        });
        let auggiePrepareCalls = 0;
        const activated = await activatePluginRuntimeRegistry({
            contributes,
            generation: 1,
            invocationServices: {
                createOrdinaryServiceBinding() {
                    throw new Error('Bundled activation parity does not invoke services');
                },
                createServices() {
                    throw new Error('Bundled activation parity does not invoke services');
                },
                resolveInvocationHostPolicy() {
                    throw new Error('Bundled activation parity does not invoke services');
                },
            } satisfies TargetInvocationServiceOwner,
            resolveActivationSource(target) {
                const source = resolveBundledActivationSource(target);
                if (!source) return source;
                if (target.pluginId !== 'happier.agent.auggie') return source;
                return {
                    ...source,
                    async prepare() {
                        auggiePrepareCalls += 1;
                        if (auggiePrepareCalls === 1) {
                            throw new Error('aggregate source-dev preparation selected package isolation');
                        }
                        await source.prepare?.();
                    },
                };
            },
        });

        const diagnostics = Object.fromEntries(Object.entries(activated.pluginDiagnosticsByPluginId)
            .filter(([, entries]) => entries.length > 0));
        expect(diagnostics).toEqual({});
        // Daemon cold start activates only registrations that still have a
        // synchronous host consumer. A plugin that starts activating here for
        // another reason is a cold-start regression: decide its demand
        // boundary rather than widening this list.
        const startupTargets = contributes.activationTargets.filter(shouldActivateTargetAtStartup);
        const expectedStartupPluginIds = new Set(startupTargets.map((target) => target.pluginId));
        expect([...expectedStartupPluginIds]).toEqual([
            'happier.channel.discord',
            'happier.channels',
            'happier.posthog',
            'happier.scm.forge.github',
            'happier.sentry',
        ]);
        expect(startupTargets.map((target) => listDeclaredPluginContributionFamilies(
            target.manifest.contributes as unknown as Readonly<Record<string, unknown>>,
        ))).toEqual(expect.arrayContaining([
            expect.arrayContaining(['backgroundServices']),
        ]));
        expect(activated.activatedPluginIds).toEqual(expectedStartupPluginIds);
        expect(activated.targetRegistrations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: 'happier.channels',
                registration: expect.objectContaining({
                    family: 'resources',
                    localId: 'connections-v1',
                }),
            }),
        ]));
        expect(activated.pluginDiagnosticsByPluginId['happier.voice.google'] ?? []).toEqual([]);
        expect(activated.activatedPluginIds.has('happier.voice.google')).toBe(false);

        const agent = contributes.agents.find((entry) => entry.pluginId === 'happier.agent.auggie');
        expect(agent).toBeDefined();
        if (!agent?.pluginId || !agent.identity) {
            throw new Error('Expected bundled Auggie Agent contribution identity');
        }
        const agentPluginIds = new Set(contributes.agents.flatMap((entry) => (
            entry.pluginId ? [entry.pluginId] : []
        )));
        expect(agentPluginIds.size).toBeGreaterThan(0);
        for (const pluginId of agentPluginIds) {
            expect(activated.activatedPluginIds.has(pluginId), pluginId).toBe(false);
        }

        const agentDemand = [{
            pluginId: agent.pluginId,
            family: 'agents',
            localId: agent.identity.localId,
        }];
        await activated.activateContributionsOnDemand(agentDemand);

        expect(auggiePrepareCalls).toBe(2);
        expect(activated.activatedPluginIds.has(agent.pluginId)).toBe(true);
        expect(activated.targetActivationFacts.filter((fact) => (
            fact.pluginId === agent.pluginId && fact.status === 'active'
        ))).toHaveLength(1);
        for (const pluginId of agentPluginIds) {
            if (pluginId !== agent.pluginId) {
                expect(activated.activatedPluginIds.has(pluginId)).toBe(false);
            }
        }

        const reviewAgent = contributes.agents.find((entry) => (
            entry.pluginId === 'happier.review.coderabbit'
        ));
        expect(reviewAgent?.identity).toBeDefined();
        if (!reviewAgent?.pluginId || !reviewAgent.identity) {
            throw new Error('Expected bundled CodeRabbit review Agent contribution identity');
        }
        await activated.activateContributionsOnDemand([{
            pluginId: reviewAgent.pluginId,
            family: 'agents',
            localId: reviewAgent.identity.localId,
        }]);
        expect(activated.activatedPluginIds.has(reviewAgent.pluginId)).toBe(true);

        const scmDemands = [
            ...(contributes.scmBackends ?? []).flatMap((entry) => entry.pluginId ? [{
                pluginId: entry.pluginId,
                family: 'scmBackends',
                localId: entry.definition.id,
            }] : []),
            ...(contributes.scmHostingProviders ?? []).flatMap((entry) => entry.pluginId ? [{
                pluginId: entry.pluginId,
                family: 'scmHostingProviders',
                localId: entry.definition.id,
            }] : []),
        ];
        const scmPluginIds = new Set(scmDemands.map((demand) => demand.pluginId));
        expect(scmPluginIds.size).toBeGreaterThan(0);
        const coldScmPluginIds = new Set([...scmPluginIds].filter((pluginId) => (
            !expectedStartupPluginIds.has(pluginId)
        )));
        expect(coldScmPluginIds.size).toBeGreaterThan(0);
        for (const pluginId of coldScmPluginIds) {
            expect(activated.activatedPluginIds.has(pluginId)).toBe(false);
        }

        await activated.activateContributionsOnDemand(scmDemands);

        for (const pluginId of scmPluginIds) {
            expect(activated.activatedPluginIds.has(pluginId)).toBe(true);
            expect(activated.pluginDiagnosticsByPluginId[pluginId] ?? []).toEqual([]);
        }
        for (const [pluginId, localId] of [
            ['happier.scm.forge.github', 'triage/verify-github-review-workspace'],
            ['happier.scm.forge.github', 'github/pull-request/submit-review'],
            ['happier.scm.forge.github', 'github/pull-request/review-comment-create'],
            ['happier.scm.forge.github', 'github/pull-request/thread-reply'],
            ['happier.scm.forge.github', 'github/issue/comment'],
            ['happier.scm.forge.gitlab', 'triage/verify-gitlab-review-workspace'],
            ['happier.scm.forge.gitlab', 'triage/read-gitlab-raw-diff'],
            ['happier.scm.forge.gitlab', 'gitlab/merge-request/submit-review'],
            ['happier.scm.forge.gitlab', 'gitlab/merge-request/review-comment-create'],
            ['happier.scm.forge.gitlab', 'gitlab/merge-request/thread-reply'],
            ['happier.scm.forge.gitlab', 'gitlab/issue/comment'],
            ['happier.scm.forge.bitbucket', 'triage-verify-review-workspace'],
            ['happier.scm.forge.bitbucket', 'pull-request-submit-review'],
            ['happier.scm.forge.bitbucket', 'pull-request-review-comment-create'],
            ['happier.scm.forge.bitbucket', 'pull-request-thread-reply'],
            ['happier.scm.forge.azure-devops', 'triage-verify-review-workspace'],
            ['happier.scm.forge.azure-devops', 'pull-request-submit-review'],
            ['happier.scm.forge.azure-devops', 'pull-request-thread-comment-create'],
            ['happier.scm.forge.azure-devops', 'pull-request-thread-reply'],
        ] as const) {
            expect(activated.targetRegistrations).toContainEqual(expect.objectContaining({
                pluginId,
                registration: expect.objectContaining({ family: 'actions', localId }),
            }));
        }
        expect(activated.targetRegistrations).not.toContainEqual(expect.objectContaining({
            pluginId: 'happier.scm.forge.github',
            registration: expect.objectContaining({
                family: 'actions',
                localId: 'triage/list-github-comments',
            }),
        }));

        await activated.activateContributionsOnDemand([
            { pluginId: 'happier.sentry', family: 'actions', localId: 'sentry/get-issue' },
            { pluginId: 'happier.posthog', family: 'actions', localId: 'posthog/get' },
        ]);
        for (const [pluginId, localId] of [
            ['happier.sentry', 'sentry/list-issue-events'],
            ['happier.posthog', 'posthog/issue-activity'],
            ['happier.posthog', 'posthog/code-variables'],
        ] as const) {
            expect(activated.activatedPluginIds.has(pluginId)).toBe(true);
            expect(activated.pluginDiagnosticsByPluginId[pluginId] ?? []).toEqual([]);
            expect(activated.targetRegistrations).toContainEqual(expect.objectContaining({
                pluginId,
                registration: expect.objectContaining({ family: 'actions', localId }),
            }));
        }

        // A bundled Composer attachment is reached the same way: its plugin is
        // cold until the exact staged attachment is demanded.
        const attachment = (contributes.composerAttachments ?? []).find((entry) => (
            entry.pluginId === 'happier.triage'
            && entry.identity.localId === 'entry'
            && entry.definition.runtime !== undefined
        ));
        expect(attachment?.pluginId).toBeDefined();
        if (!attachment?.pluginId) {
            throw new Error('Expected a bundled Composer attachment contribution with a runtime role');
        }
        expect(activated.activatedPluginIds.has(attachment.pluginId)).toBe(false);

        await activated.activateContributionsOnDemand([{
            pluginId: attachment.pluginId,
            family: 'composerAttachments',
            localId: attachment.identity.localId,
        }]);

        expect(activated.activatedPluginIds.has(attachment.pluginId)).toBe(true);
        expect(activated.pluginDiagnosticsByPluginId[attachment.pluginId] ?? []).toEqual([]);
        expect(activated.targetRegistrations).toContainEqual(expect.objectContaining({
            pluginId: 'happier.triage',
            registration: expect.objectContaining({
                family: 'actions',
                localId: 'sessions/start-pull-request-review-v1',
            }),
        }));

        await activated.dispose();
    }, 120_000);
});
