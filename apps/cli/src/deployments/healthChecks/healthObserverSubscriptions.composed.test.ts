import { expect, it } from 'vitest';
import { plugin } from '../../../../../packages/plugins/machine-services/src/manifest';
import { createHealthCheckSourceAdapter } from '../../../../../packages/plugins/machine-services/src/healthObserver';
import { createPluginInvocationPluginEventsService, createStablePluginEventsBroker } from '@/plugins/runtime/invocation/services/events';

it('starts saved health observation with the authored subscriptions through host admission', () => {
    const controller = new AbortController();
    const pluginId = plugin.manifest.id;
    const events = createPluginInvocationPluginEventsService({
        seed: { plugin: { id: pluginId, version: plugin.manifest.version },
            contribution: { id: 'health-observer', qualifiedId: `${pluginId}/backgroundServices/health-observer` },
            occurrenceId: 'health-observer', correlationId: 'health-subscriptions', surface: 'background',
            signal: controller.signal, isOccurrenceCurrent: () => !controller.signal.aborted },
        broker: createStablePluginEventsBroker(),
        declarationsByPluginId: new Map([[pluginId, plugin.manifest.contributes?.events ?? []]]),
        activePluginIds: new Set([pluginId]),
    });
    try {
        const adapter = createHealthCheckSourceAdapter(Date.now, undefined, events);
        const subscription = adapter.subscribeWake?.(async () => {});
        expect(subscription).toBeDefined();
        subscription?.dispose();
    } finally { controller.abort(); }
});
