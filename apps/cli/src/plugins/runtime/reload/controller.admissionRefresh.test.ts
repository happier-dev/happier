import { describe, expect, it } from 'vitest';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from './controller';

describe('Account admission and committed Machine publication', () => {
    it.each(['account-first', 'machine-first'] as const)('settles both publications at the committed revision: %s', async order => {
        const controller = createPluginReloadController();
        const createRegistry = () => resolveExecutablePluginRuntimeRegistry({
            contributes: createResolvedContributionRegistry({}), pluginIds: [],
        });
        try {
            // The commit notifies durable currentness before its asynchronous
            // adoption. An Account push can reach publication in that interval.
            controller.publishDurableRunningSessionDisposition({
                durableRevision: 1, changedPluginIds: [], runningSessionDisposition: 'retainRunningSessions',
            });
            const machine = await createRegistry();
            const account = await createRegistry();
            const adoptMachine = () => controller.adoptPreparedRuntimeRegistry({
                registry: machine, durableRevision: 1, changedPluginIds: [], runningSessionDisposition: 'retainRunningSessions',
            });
            const adoptAccount = () => controller.adoptPreparedRuntimeRegistry({
                registry: account, durableRevision: 1, admissionRefresh: true, changedPluginIds: [],
                runningSessionDisposition: 'retainRunningSessions',
            });
            if (order === 'account-first') {
                await expect(adoptAccount()).resolves.toMatchObject({ ok: true });
                await expect(adoptMachine()).resolves.toMatchObject({ ok: true });
            } else {
                await expect(adoptMachine()).resolves.toMatchObject({ ok: true });
                await expect(adoptAccount()).resolves.toMatchObject({ ok: true });
            }
            expect(controller.getState().generation).toBe(2);
            // Account refreshes do not relax duplicate Machine or stale-state
            // rejection by the currentness owner.
            await expect(controller.adoptPreparedRuntimeRegistry({
                registry: await createRegistry(), durableRevision: 1, changedPluginIds: [], runningSessionDisposition: 'retainRunningSessions',
            })).rejects.toThrow(/not newer than observed revision 1/);
            await expect(controller.adoptPreparedRuntimeRegistry({
                registry: await createRegistry(), durableRevision: 0, admissionRefresh: true, changedPluginIds: [],
                runningSessionDisposition: 'retainRunningSessions',
            })).rejects.toThrow(/not newer than observed revision 1/);
        } finally {
            await controller.shutdown();
        }
    });
});
