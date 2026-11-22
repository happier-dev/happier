import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type { DetailsTabState } from '../workspace/detailsWorkspaceTypes';
import { DetailsSurfaceHost } from './DetailsSurfaceHost';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

const tab: DetailsTabState = {
    key: 'demo:1',
    kind: 'demo',
    title: 'Demo',
    isPinned: true,
    isPreview: false,
    resource: { kind: 'demo', id: '1' },
};

describe('DetailsSurfaceHost', () => {
    it('resolves available surfaces through deterministic renderer ordering and scope checks', async () => {
        const renderCalls: string[] = [];
        const screen = await renderScreen(
            <DetailsSurfaceHost paneScopeId="session:session-1"
                tab={tab}
                scope={{ kind: 'session', sessionId: 'session-1' }}
                region="details"
                descriptor={{
                    surfaceId: 'session:session-1:details:demo:1',
                    resourceKey: 'demo:1',
                    scope: { kind: 'session', sessionId: 'session-1' },
                    region: 'details',
                    status: 'available',
                    order: 0,
                    pinned: true,
                    preview: false,
                }}
                renderers={[
                    {
                        id: 'z-session-demo',
                        owner: 'session',
                        order: 10,
                        canRender: (input) => input.scope.kind === 'session',
                        render: () => {
                            renderCalls.push('z');
                            return React.createElement('ResolvedSurface', { testID: 'resolved-z' });
                        },
                    },
                    {
                        id: 'a-session-demo',
                        owner: 'session',
                        order: 10,
                        canRender: (input) => input.scope.kind === 'session',
                        render: () => {
                            renderCalls.push('a');
                            return React.createElement('ResolvedSurface', { testID: 'resolved-a' });
                        },
                    },
                    {
                        id: 'workspace-demo',
                        owner: 'workspace',
                        order: 0,
                        canRender: (input) => input.scope.kind === 'workspace',
                        render: () => React.createElement('ResolvedSurface', { testID: 'wrong-scope' }),
                    },
                ]}
            />,
        );

        expect(screen.findByTestId('resolved-a')).not.toBeNull();
        expect(screen.findByTestId('resolved-z')).toBeNull();
        expect(screen.findByTestId('wrong-scope')).toBeNull();
        expect(renderCalls).toEqual(['a']);
    });

    it('renders typed fallback states instead of blank panes for unavailable resources', async () => {
        const screen = await renderScreen(
            <DetailsSurfaceHost paneScopeId="session:session-1"
                tab={tab}
                scope={{ kind: 'workspace', workspaceRefId: 'wr_1', serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' }}
                region="details"
                descriptor={{
                    surfaceId: 'workspace:wr_1:details:demo:missing',
                    resourceKey: 'demo:missing',
                    scope: { kind: 'workspace', workspaceRefId: 'wr_1', serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' },
                    region: 'details',
                    status: 'missing',
                    disabledReason: 'resource_missing',
                }}
                renderers={[]}
            />,
        );

        expect(screen.findByTestId('details-surface-fallback-missing')).not.toBeNull();
        expect(screen.getTextContent()).toContain('errors.fileNotFound');
        expect(screen.getTextContent()).not.toContain('session.detailsPanel.unsupportedTab');
    });

    it('explains a policy-disabled details destination without exposing its code as primary copy', async () => {
        const screen = await renderScreen(
            <DetailsSurfaceHost paneScopeId="session:session-1"
                tab={tab}
                scope={{ kind: 'session', sessionId: 'session-1' }}
                region="details"
                descriptor={{
                    surfaceId: 'session:session-1:details:demo:1',
                    resourceKey: 'demo:1',
                    scope: { kind: 'session', sessionId: 'session-1' },
                    region: 'details',
                    status: 'disabled',
                    disabledReason: 'details_destination_policy_unavailable',
                }}
                renderers={[]}
            />,
        );
        expect(screen.getTextContent()).toContain('pluginRuntime.disabledByPolicy');
        expect(screen.getTextContent()).not.toContain('details_destination_policy_unavailable');
    });

    it('contains renderer crashes in the host fallback boundary', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        let broken = true;
        const BrokenSurface = () => {
            if (broken) throw new Error('boom');
            return React.createElement('RecoveredSurface', { testID: 'recovered-details-surface' });
        };

        try {
            const screen = await renderScreen(
                <DetailsSurfaceHost paneScopeId="session:session-1"
                    tab={tab}
                    scope={{ kind: 'session', sessionId: 'session-1' }}
                    region="details"
                    descriptor={{
                        surfaceId: 'session:session-1:details:demo:1',
                        resourceKey: 'demo:1',
                        scope: { kind: 'session', sessionId: 'session-1' },
                        region: 'details',
                        status: 'available',
                    }}
                    renderers={[
                        {
                            id: 'broken',
                            owner: 'session',
                            canRender: () => true,
                            render: () => React.createElement(BrokenSurface),
                        },
                    ]}
                />,
            );

            expect(screen.findByTestId('details-surface-fallback-renderer-error')).not.toBeNull();
            broken = false;
            await pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' }), 'retry details surface');
            expect(screen.findByTestId('recovered-details-surface')).not.toBeNull();
        } finally {
            consoleError.mockRestore();
        }
    });
    it('does not re-render its content when the parent re-renders with unchanged inputs', async () => {
        // The Details panel re-renders on every pane, store and presentation commit and rebuilds this element each
        // time; the tab's page (a file with its header and body) must only render when the tab or its renderers change.
        let renders = 0;
        const scope = { kind: 'session', sessionId: 'session-1' } as const;
        const renderers = [{
            id: 'demo',
            owner: 'session' as const,
            order: 0,
            canRender: () => true,
            render: () => { renders += 1; return React.createElement('ResolvedSurface'); },
        }];
        const element = () => <DetailsSurfaceHost paneScopeId="session:session-1" tab={tab} scope={scope} region="details" renderers={renderers} />;
        const screen = await renderScreen(element());
        const afterMount = renders;
        await act(async () => { screen.update(element()); });
        await act(async () => { screen.update(element()); });
        expect(afterMount).toBeGreaterThan(0);
        expect(renders).toBe(afterMount);
    });
});
