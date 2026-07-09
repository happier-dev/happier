import type {
    BrowserViewTargetV1,
    LocalServiceLauncherSnapshotV1,
} from '@happier-dev/protocol';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    applyLocalServiceLauncherSnapshot,
    createLocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import { createLocalServicePreviewState } from '@/sync/domains/local/services/preview/store';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/browser/frame/engines/DesktopWebViewEngine', () => ({
    DesktopWebViewEngine: (props: Readonly<Record<string, unknown>>) => React.createElement('View', {
        testID: props.testID ?? 'desktop-webview',
    }),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string) => ({
        featureId,
        state: 'enabled',
        blockedBy: null,
        blockerCode: 'none',
        diagnostics: [],
        evaluatedAt: 1_000,
        scope: { scopeKind: 'runtime' },
    }),
}));

const runningTarget = {
    kind: 'localServicePreview',
    targetId: 'preview_vite',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: {
        title: 'Vite app',
        addressLabel: 'localhost:5173',
    },
} satisfies BrowserViewTargetV1;

const runningLauncherSnapshot = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    updatedAt: 1_000,
    targets: [{
        id: 'launcher_preview',
        source: 'registered_preview',
        machineId: 'machine_1',
        sessionId: 'session_1',
        title: 'Vite app',
        subtitle: 'localhost:5173',
        kind: 'vite',
        confidence: 'high',
        state: 'available',
        actions: ['open_preview'],
        browserTarget: runningTarget,
    }],
} satisfies LocalServiceLauncherSnapshotV1;

describe('SessionRightPanelBrowserView', () => {
    it('forwards the live launchpad feed into the reusable browser host', async () => {
        const { SessionRightPanelBrowserView } = await import('./SessionRightPanelBrowserView');
        const launcherState = applyLocalServiceLauncherSnapshot(
            createLocalServiceLauncherState(),
            runningLauncherSnapshot,
        );

        const screen = await renderScreen(
            <SessionRightPanelBrowserView
                sessionId="session_1"
                overrides={{
                    machineId: 'machine_1',
                    serverId: 'server_1',
                    platform: 'web',
                    launcherState,
                    localServicePreviewState: createLocalServicePreviewState(),
                    nowMs: () => 1_500,
                }}
            />,
        );

        expect(
            screen.findByTestId('session-rightpanel-browser-launchpad-card:localService:launcher_preview-available'),
        ).not.toBeNull();
    });
});
