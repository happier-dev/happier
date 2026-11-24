import { expect, it } from 'vitest';
import * as github from '@happier-dev/plugins-scm-github';
import * as gitlab from '@happier-dev/plugins-scm-gitlab';

import { createDaemonPluginDevelopmentRootsOwner } from '@/plugins/daemon/developmentRoots';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { createHostScmHostingProviderRegistry } from '@/scm/hostingProviders/hostRegistry';
import { createDaemonPluginRegistryRuntimeLifecycle } from './registryRuntimeLifecycle';

it('keeps bundled GitHub activation and authentication current across unchanged admission refreshes', async () => {
    const pluginId = github.manifest.id;
    const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: [pluginId] } });
    try {
        const { controller, registry, happyHomeDir } = fixture;
        const occurrenceId = controller.readCurrentPluginOccurrenceId?.(pluginId);
        expect(occurrenceId).toBeTruthy();
        const service = { pluginId, localId: 'github-account' };
        const incumbent = await registry.resolveConnectedAccountRuntime?.(service);
        expect(incumbent?.isCurrent()).toBe(true);
        const store = createPluginRegistryStateStore({
            happyHomeDir,
            runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController: controller }),
        });
        await store.refreshRuntime([pluginId]);
        await store.refreshRuntime([pluginId]);
        const current = await controller.acquireRuntimeRegistry();
        try {
            expect(controller.readCurrentPluginOccurrenceId?.(pluginId)).toBe(occurrenceId);
            expect(incumbent?.isCurrent()).toBe(true);
            const successor = await current.registry.resolveConnectedAccountRuntime?.(service);
            expect(successor?.isCurrent()).toBe(true);
            expect(successor?.runtime).toBe(incumbent?.runtime);
            expect(current.registry.targetActivationFacts?.filter(fact => fact.pluginId === pluginId))
                .toEqual(registry.targetActivationFacts.filter(fact => fact.pluginId === pluginId));
        } finally { await current.release(); }
    } finally { await fixture.dispose(); }
});

it.each(['before preparation', 'during publication', 'as publication resumes'] as const)(
    'keeps GitHub clone target discovery when demand arrives %s of an unrelated plugin update',
    async (timing) => {
        const pluginId = github.manifest.id;
        const contribution = github.manifest.contributes.scmHostingProviders[0];
        const providerId = `${pluginId}/${contribution.id}`;
        const demand = [{ pluginId, family: 'scmHostingProviders' as const, localId: contribution.id }];
        const fixture = await createAdmittedPluginRuntimeFixture({
            runtimeOptions: {
                contributes: await resolveMergedContributionRegistry({ pluginIds: [pluginId, gitlab.manifest.id] }),
            },
        });
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const { controller, registry, happyHomeDir } = fixture;
        const occurrence = controller.readCurrentPluginOccurrenceId?.(pluginId);
        const activateIncumbent = async () => {
            const activation = await registry.activateContributionsOnDemand(demand);
            expect(createHostScmHostingProviderRegistry(registry).getRepositoryClone(providerId),
                JSON.stringify(activation)).toBeDefined();
        };
        const roots = createDaemonPluginDevelopmentRootsOwner({
            happyHomeDir,
            submitObservation: async () => { throw new Error('Unexpected source observation'); },
        });
        const store = createPluginRegistryStateStore({
            happyHomeDir,
            runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({
                happyHomeDir,
                reloadController: controller,
                resolveDevelopmentSourceAuthority: roots.resolveDevelopmentSourceAuthority,
                beforePublish: async (_candidate, publish) => {
                    entered.resolve();
                    await release.promise;
                    publish();
                },
            }),
        });
        let mutation: ReturnType<typeof store.setEnabledWithResult> | undefined;
        let incumbentActivation: Promise<PromiseSettledResult<void>[]> | undefined;
        try {
            expect(occurrence).toBeTruthy();
            expect(createHostScmHostingProviderRegistry(registry).getRepositoryClone(providerId)).toBeUndefined();
            if (timing === 'before preparation') await activateIncumbent();
            mutation = store.setEnabledWithResult(gitlab.manifest.id, false);
            await Promise.race([
                entered.promise,
                mutation.then(() => { throw new Error('Expected the peer publication to pause'); }),
            ]);
            if (timing === 'during publication') await activateIncumbent();
            if (timing === 'as publication resumes') {
                incumbentActivation = Promise.allSettled([activateIncumbent()]);
            }
            release.resolve();
            await expect(mutation).resolves.toMatchObject({ transaction: { status: 'committed', applied: true } });
            expect(controller.readCurrentPluginOccurrenceId?.(pluginId)).toBe(occurrence);

            const current = await controller.acquireRuntimeRegistry();
            try {
                const hostingProviders = createHostScmHostingProviderRegistry(current.registry);
                if (timing !== 'as publication resumes') expect(hostingProviders.getRepositoryClone(providerId)).toBeDefined();
                const successorActivation = await current.registry.activateContributionsOnDemand(demand);
                expect(hostingProviders.getRepositoryClone(providerId), JSON.stringify(successorActivation)).toBeDefined();
                if (incumbentActivation) expect(await incumbentActivation).toEqual([{ status: 'fulfilled', value: undefined }]);
            } finally { await current.release(); }
        } finally {
            release.resolve();
            try { await Promise.all([mutation, incumbentActivation]); } finally {
                await fixture.dispose();
                await roots.stop();
            }
        }
    },
);
