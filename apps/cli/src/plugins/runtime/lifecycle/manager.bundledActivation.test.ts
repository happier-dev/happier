import { describe, expect, it } from 'vitest';

import { listDeclaredPluginContributionFamilies } from '@happier-dev/protocol';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { createBundledActivationSourceResolver } from '@/plugins/runtime/bundledActivationSource';

import { shouldActivateTargetAtStartup } from './activation/targets';
import type { TargetInvocationServiceOwner } from './contributions/targetHooks';
import { activatePluginRuntimeRegistry } from './manager';

describe('bundled PluginApi parity', () => {
    it('keeps ordinary bundled Agents cold and activates one exactly once on first Agent demand', async () => {
        const contributes = createResolvedContributionRegistry(resolveBuiltInContributions());
        const resolveBundledActivationSource = createBundledActivationSourceResolver({
            bundledPackageNames: BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES,
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
        // Daemon cold start activates a bundled plugin only for a declared
        // machine-runtime service. Every other contribution family this
        // product ships is demand-ready, so a plugin that starts activating
        // here for another reason is a cold-start regression: decide its
        // demand boundary rather than widening this list.
        const startupTargets = contributes.activationTargets.filter(shouldActivateTargetAtStartup);
        const expectedStartupPluginIds = new Set(startupTargets.map((target) => target.pluginId));
        expect([...expectedStartupPluginIds]).toEqual([
            'happier.channel.discord',
            'happier.channels',
            'happier.scm.forge.github',
        ]);
        for (const target of startupTargets) {
            expect(listDeclaredPluginContributionFamilies(
                target.manifest.contributes as unknown as Readonly<Record<string, unknown>>,
            ), target.pluginId).toContain('backgroundServices');
        }
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
            ['happier.scm.forge.bitbucket', 'pull-request-review-comment-reply'],
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
