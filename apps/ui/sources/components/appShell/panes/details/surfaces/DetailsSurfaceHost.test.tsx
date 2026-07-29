import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { DetailsTabState } from '../workspace/detailsWorkspaceTypes';

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
        const { DetailsSurfaceHost } = await import('./DetailsSurfaceHost');

        const renderCalls: string[] = [];
        const screen = await renderScreen(
            <DetailsSurfaceHost
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
        const { DetailsSurfaceHost } = await import('./DetailsSurfaceHost');

        const screen = await renderScreen(
            <DetailsSurfaceHost
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
    });

    it('contains renderer crashes in the host fallback boundary', async () => {
        const { DetailsSurfaceHost } = await import('./DetailsSurfaceHost');
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        const BrokenSurface = () => {
            throw new Error('boom');
        };

        try {
            const screen = await renderScreen(
                <DetailsSurfaceHost
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
        } finally {
            consoleError.mockRestore();
        }
    });
});
