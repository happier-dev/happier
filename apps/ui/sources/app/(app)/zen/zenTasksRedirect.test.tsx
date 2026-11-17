import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTriageEntryRouteSegmentV1 } from '@happier-dev/triage-protocol/v1';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability/v1';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarationProjection';
import triageManifest from '../../../../../../packages/plugins/triage/.happier-plugin/plugin.json';
import { normalizePluginInstalledUiDeclarations } from '@/sync/domains/plugins/ui/projection';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { storage } from '@/sync/domains/state/storageStore';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { renderScreen, standardCleanup } from '@/dev/testkit';

const routeState = vi.hoisted(() => ({ params: {} as Record<string, string | string[]>, segments: [] as string[] }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: () => routeState.params, segments: () => routeState.segments }).module;
});

let disposeProjection: () => void;
beforeEach(() => {
    // Admit the real Tasks page declarations, including their retained aliases.
    const declarations = projectPluginPortableUiDeclarationsV1(PluginPortableReleaseManifestV1Schema.parse(triageManifest));
    const projection = normalizePluginInstalledUiDeclarations(declarations, 'web');
    const previousScope = storage.getState().profileScope;
    const previousApplied = getAppliedActiveServerSnapshot();
    const previouslyAvailable = isAppliedActiveServerRuntimeAvailable();
    const scope = { serverId: 'zen-home', accountId: 'zen-account' };
    storage.setState({ profileScope: scope });
    publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://zen.example', generation: 1 });
    const dispose = publishCommittedAppShellPluginUiProjection(input => input?.declarationsOnly
        && input.scope.serverId === scope.serverId && input.scope.accountId === scope.accountId ? projection : null);
    disposeProjection = () => {
        dispose();
        storage.setState({ profileScope: previousScope });
        publishAppliedActiveServerSnapshot(previousApplied, previouslyAvailable);
    };
});

afterEach(() => {
    standardCleanup();
    disposeProjection();
    routeState.params = {};
    routeState.segments = [];
});

describe('retained Zen links', () => {
    it.each(['view', 'id'])('preserves the exact selected task from %s through the public route codec', async (path) => {
        const Route = (path === 'view' ? await import('./view') : await import('./[id]')).default;
        routeState.params.id = 'task,with / unicode 界';
        routeState.segments = ['(app)', 'zen', path === 'view' ? 'view' : '[id]'];
        const screen = await renderScreen(React.createElement(Route));
        const href = screen.findAll((node) => (node.type as unknown) === 'Redirect')[0]?.props.href;
        expect(href).toEqual(expect.stringContaining('/plugins/happier.triage/tasks/'));
        const segment = decodeURIComponent(href.slice(href.lastIndexOf('/') + 1));
        expect(readTriageEntryRouteSegmentV1(segment)).toEqual({
            source: { pluginId: 'happier.triage', localId: 'internal' },
            kindId: 'task', collisionScope: 'personal', entryId: routeState.params.id,
        });
    });

    it.each(['./index', './new'])('opens the existing Tasks page from %s', async (path) => {
        const Route = (path === './index' ? await import('./index') : await import('./new')).default;
        routeState.segments = ['(app)', 'zen', ...(path === './new' ? ['new'] : [])];
        const screen = await renderScreen(React.createElement(Route));
        expect(screen.findAll((node) => (node.type as unknown) === 'Redirect')[0]?.props.href)
            .toBe('/plugins/happier.triage/tasks');
    });
});
