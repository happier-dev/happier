import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { renderHook, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
    Dimensions: { get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }) },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

import { useSessionWorkOpeners } from './useSessionWorkOpeners';
import type { WorkItem } from './workProjection';

const report = {
    key: 'session:report', kind: 'session', title: 'Report', agentId: null,
    facts: [], parentKey: null, level: 0, progress: null,
    status: { bucket: 'idle', tone: 'neutral', word: 'Ready' },
    open: { kind: 'session', sessionId: 'report' },
} satisfies WorkItem;

describe('phone Work navigation', () => {
    afterEach(standardCleanup);

    it('opens a report as a full Session while preserving the lead’s explicit Home', async () => {
        const push = vi.fn();
        function Wrapper({ children }: React.PropsWithChildren) {
            return <AppPaneProvider>
                <DestinationInstanceHost tabId="phone-lead" ref={{ kind: 'session', params: { id: 'lead' } }} pathname="/session/lead" focused visible
                    navigation={{ push, replace: () => {}, back: () => {} }}>
                    {children}
                </DestinationInstanceHost>
            </AppPaneProvider>;
        }
        const hook = await renderHook((serverId: string) => useSessionWorkOpeners({
            sessionId: 'lead', serverId, scopeId: 'session:lead', subagents: [],
        }), { wrapper: Wrapper, initialProps: 'report-home' });

        hook.getCurrent().openItem(report);

        expect(push).toHaveBeenCalledWith('/session/report?serverId=report-home');

        await hook.rerender('other-home');
        hook.getCurrent().openItem(report);
        expect(push).toHaveBeenLastCalledWith('/session/report?serverId=other-home');

        hook.getCurrent().openItem({
            ...report, key: 'workflow:run/7', kind: 'workflow_run',
            open: { kind: 'workflow_run', runId: 'run/7' },
        });
        expect(push).toHaveBeenLastCalledWith('/workflows/runs/run%2F7?serverId=other-home');
    });
});
