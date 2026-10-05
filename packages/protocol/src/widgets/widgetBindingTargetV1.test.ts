import { expect, it } from 'vitest';
import { resolveWidgetBindingsV1 } from './widgetInstanceV1.js';

it('projects bound Session intent before viewer fields can be admitted by its runtime', () => {
    const session = { serverId: 'home', sessionId: 'B' };
    expect(resolveWidgetBindingsV1({
        instance: { v: 1, id: 'copy', definition: { kind: 'installed', surface: { pluginId: 'acme.metrics', localId: 'widget' } },
            bindings: { session: { kind: 'context', slot: 'session' }, connection: { kind: 'viewer', purpose: 'read' } } },
        fields: [{ path: 'session', title: 'Session', widget: 'select', required: true },
            { path: 'connection', title: 'Connection', widget: 'select', required: true, connectedAccountOptions: true }],
        context: { session: [session] }, viewerValues: {}, validateValue: () => ({ status: 'valid' }),
        resolvePaths: ['session'],
    })).toEqual({ status: 'ready', input: { session } });
});
