import * as React from 'react';
import { expect, it } from 'vitest';
import { type WidgetInputBindingsV1, type WidgetInstanceV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { ProjectBuiltinWidgetBody } from '@/components/projects/widgets/ProjectBuiltinWidgetBody';
import { WidgetSurface } from './WidgetSurface';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readWidgetDescriptor, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { Text } from '@/components/ui/text/Text';

installDisconnectedServerSocketBoundary();

it('renders a declared native app-read fixture and removes it when its Account read retires', async () => {
    const http = createHomeHubArtifactHttpBoundary('actor');
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://native-app-widget.test', accountId: 'actor', request: http.request });
    const scope: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'actor', owner: { kind: 'home' } };
    const instance: WidgetInstanceV1 = { v: 1, id: 'app-copy', definition: { kind: 'builtin', id: 'session_summary' }, bindings: { period: { kind: 'value', value: 7 } } };
    const descriptor: WidgetCandidate = { ...readWidgetDescriptor(null, instance.definition)!, target: 'app',
        inputs: { fields: [{ path: 'period', title: 'Period', widget: 'integer', required: true }] },
        inputSchema: { type: 'object', properties: { period: { type: 'integer' } }, required: ['period'], additionalProperties: false } };
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: null, serverId: null, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime() };
    let current = true;
    const body = () => <WidgetSurface scope={scope} instance={instance} descriptor={descriptor}
        providedContext={{}} appRuntime={runtime} presentation="content" recordRevision="same-instance" isCurrent={() => current}
        reference={<Text testID="native-app-read">7 days</Text>} testID="native-app-widget" />;
    const screen = await renderScreen(body());
    try {
        expect(screen.tree.root.findAllByProps({ testID: 'native-app-read' }).length).toBeGreaterThan(0);
        current = false;
        await screen.update(body());
        expect(screen.tree.root.findAllByProps({ testID: 'native-app-read' })).toHaveLength(0);
    } finally { await screen.unmount(); await connection.dispose(); }
});

it('does not mount native readers while the containing document admission is suspended', async () => {
    const http = createHomeHubArtifactHttpBoundary('actor');
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://native-widget.test', accountId: 'actor', request: http.request });
    const checkout = { id: 'checkout', serverId: connection.home.id, machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
    const scope: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'actor', owner: { kind: 'project', projectId: 'project' } };
    const instance: WidgetInstanceV1 = { v: 1, id: 'about', definition: { kind: 'builtin', id: 'project_about' },
        bindings: { checkout: { kind: 'context', slot: 'checkout' } } };
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: 'machine', serverId: connection.home.id, platform: 'web' as const,
        accountLifetime: captureActiveServerAccountScopeLifetime() };
    let current = true;
    let groupBindings: WidgetInputBindingsV1 | undefined;
    const body = () => <WidgetSurface scope={scope} instance={instance} descriptor={readWidgetDescriptor(null, instance.definition)}
        providedContext={{ checkout: [checkout] }} appRuntime={runtime} presentation="content" recordRevision="same-instance"
        groupBindings={groupBindings}
        isCurrent={() => current} testID="native-widget" />;
    const screen = await renderScreen(body());
    try {
        expect(screen.tree.root.findAllByType(ProjectBuiltinWidgetBody)).toHaveLength(1);
        groupBindings = { checkout: { kind: 'value', value: { ...checkout, rootPath: '/forged' } } };
        await screen.update(body());
        expect(screen.tree.root.findAllByType(ProjectBuiltinWidgetBody)).toHaveLength(0);
        groupBindings = { checkout: { kind: 'value', value: checkout } };
        await screen.update(body());
        expect(screen.tree.root.findAllByType(ProjectBuiltinWidgetBody)).toHaveLength(1);
        current = false;
        await screen.update(body());
        expect(screen.tree.root.findAllByType(ProjectBuiltinWidgetBody)).toHaveLength(0);
        current = true;
        await screen.update(body());
        expect(screen.tree.root.findAllByType(ProjectBuiltinWidgetBody)).toHaveLength(1);
    } finally { await screen.unmount(); await connection.dispose(); }
});
