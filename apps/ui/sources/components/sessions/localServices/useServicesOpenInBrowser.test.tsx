import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LocalServiceLaunchTargetV1 } from '@happier-dev/protocol';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';

import { useServicesOpenInBrowser } from './useServicesOpenInBrowser';

vi.mock('@/sync/domains/local/services/preview/useLocalServicePreviewState', () => ({
    useLocalServicePreviewState: () => null,
}));

const openableTarget: LocalServiceLaunchTargetV1 = {
    id: 'preview:open-feed',
    source: 'registered_preview',
    machineId: 'machine-a',
    sessionId: 'session-a',
    title: 'Open feed preview',
    subtitle: 'localhost:5173',
    confidence: 'high',
    state: 'available',
    actions: [],
    browserTarget: {
        kind: 'localServicePreview',
        targetId: 'preview-open',
        sessionId: 'session-a',
        machineId: 'machine-a',
    },
};

const unmappableTarget: LocalServiceLaunchTargetV1 = {
    ...openableTarget,
    id: 'preview:unmappable',
    machineId: '',
    browserTarget: undefined,
};

type Captured = {
    open: ((target: LocalServiceLaunchTargetV1) => void) | null;
};

function HookProbe(props: Readonly<{
    scopeId: string;
    captured: Captured;
    onAfterOpen?: () => void;
}>) {
    const pane = useAppPaneScope(props.scopeId);
    const open = useServicesOpenInBrowser({
        scopeId: props.scopeId,
        scope: 'sessionDetails',
        machineId: 'machine-a',
        serverId: 'server-a',
        sessionId: 'session-a',
        onAfterOpen: props.onAfterOpen,
    });
    props.captured.open = open ?? null;

    return React.createElement('HookProbe', {
        detailsTabKinds: (pane.scopeState?.details.tabs ?? []).map((tab) => tab.kind),
    });
}

describe('useServicesOpenInBrowser', () => {
    beforeEach(() => {
        standardCleanup();
    });

    it('opens a browser-surface details tab in the pane scope for a mappable service target', async () => {
        const captured: Captured = { open: null };
        const screen = await renderScreen(
            <AppPaneProvider>
                <HookProbe scopeId="session:s1:details" captured={captured} />
            </AppPaneProvider>,
        );

        expect(captured.open).toBeTypeOf('function');
        await act(async () => {
            captured.open?.(openableTarget);
        });

        const probe = screen.tree.findByType('HookProbe' as never);
        expect(probe.props.detailsTabKinds).toContain('browser-view');
    });

    it('invokes onAfterOpen only when the target is mappable', async () => {
        const onAfterOpen = vi.fn();
        const captured: Captured = { open: null };
        await renderScreen(
            <AppPaneProvider>
                <HookProbe scopeId="session:s2:details" captured={captured} onAfterOpen={onAfterOpen} />
            </AppPaneProvider>,
        );

        await act(async () => {
            captured.open?.(unmappableTarget);
        });
        expect(onAfterOpen).not.toHaveBeenCalled();

        await act(async () => {
            captured.open?.(openableTarget);
        });
        expect(onAfterOpen).toHaveBeenCalledTimes(1);
    });

    it('does not open a tab for an unmappable target', async () => {
        const captured: Captured = { open: null };
        const screen = await renderScreen(
            <AppPaneProvider>
                <HookProbe scopeId="session:s3:details" captured={captured} />
            </AppPaneProvider>,
        );

        await act(async () => {
            captured.open?.(unmappableTarget);
        });

        const probe = screen.tree.findByType('HookProbe' as never);
        expect(probe.props.detailsTabKinds).not.toContain('browser-view');
    });
});
