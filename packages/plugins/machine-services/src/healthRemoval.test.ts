import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { expect, it, vi } from 'vitest';
import { plugin } from './manifest.js';

it.each([false, true])('removes one check through the saved Workflow, with a sibling: %s', async (hasSibling) => {
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
    const automationId = 'production';
    const triggerId = 'health';
    const eventRef = { pluginId: plugin.manifest.id, localId: 'health-status' };
    const watcher = { machineId: 'observer', pluginId: plugin.manifest.id, materializationId: 'current' };
    const check = (checkId: string) => ({ checkId, kind: { ...eventRef, localId: 'tcp' },
        binding: { kind: 'healthCheck' }, config: { host: 'localhost', port: 5432 },
        periodMs: 60_000, consecutiveFailuresBeforeAlerting: 1 });
    const sourceConfig = { v: 1, subject: { kind: 'machineService', machineId: 'observer', serviceId: 'db' },
        checks: [check('remove'), ...(hasSibling ? [check('keep')] : [])], investigation: { mode: 'inbox' } };
    const trigger = { id: triggerId, kind: 'pluginEvent', eventRef, sourceContractVersion: 1,
        observation: { kind: 'checkpointedPull', watcher: { ...watcher, machineInstallationId: 'install' } } };
    const set = { automationId, revision: 9, enabled: true,
        observationOnly: { kind: 'observationOnly', templateVersion: 1 }, triggers: [trigger] };
    const definition = { v: 1, sourceInstanceId: 'health:db', sourceConfig, displayLabel: 'DB health',
        filter: null, maximumObservationAgeMs: 60_000 };
    // This is the SDK host Action transport. The registered plugin Action runs with its real schemas.
    const execute = vi.fn()
        .mockResolvedValueOnce({ sets: [set], triggerDefinition: { triggerId, definition } })
        .mockResolvedValueOnce({ set });
    const services = { actions: { execute, executeWithExecutionOrigin: vi.fn(), observe: vi.fn() } } satisfies PluginTestServicesFixture;
    try {
        await expect(kit.invokeAction('health/remove', { automationId, triggerId, checkId: 'remove' }, { surface: 'ui', services }))
            .resolves.toEqual({ status: 'removed' });
        expect(execute).toHaveBeenNthCalledWith(1, 'workflow.trigger.list', { automationId, triggerId }, expect.anything());
        if (hasSibling) {
            expect(execute).toHaveBeenNthCalledWith(2, 'workflow.trigger.update', {
                automationId, triggerId, expectedRevision: 9, patch: { trigger: {
                    kind: 'pluginEvent', eventRef, sourceContractVersion: 1,
                    sourceInstanceId: definition.sourceInstanceId, displayLabel: definition.displayLabel,
                    maximumObservationAgeMs: 60_000, filter: null,
                    observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: watcher },
                    sourceConfig: { ...sourceConfig, checks: [check('keep')] },
                } },
            }, expect.anything());
        } else {
            expect(execute).toHaveBeenNthCalledWith(2, 'workflow.trigger.update', {
                automationId, expectedRevision: 9, patch: { enabled: false },
            }, expect.anything());
        }
    } finally { await kit.dispose(); }
});
