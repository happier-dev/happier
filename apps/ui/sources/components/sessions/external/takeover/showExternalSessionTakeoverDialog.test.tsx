import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/modal', () => ({
    Modal: { show: vi.fn() },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('ExternalSessionTakeoverDialog accessibility', () => {
    it('names every takeover choice and cancel action as a button', async () => {
        const { ExternalSessionTakeoverDialog } = await import('./showExternalSessionTakeoverDialog');
        const screen = await renderScreen(
            <ExternalSessionTakeoverDialog
                canTakeOverDirect
                canTakeOverPersist
                canForceStop={false}
                onResolve={() => {}}
                onClose={() => {}}
            />,
        );

        expect(screen.findByTestId('direct-session-takeover-dialog-direct')?.props).toMatchObject({
            accessibilityRole: 'button',
            accessibilityLabel: 'chatFooter.directTakeoverDialogDirectTitle',
            accessibilityHint: 'chatFooter.directTakeoverDialogDirectBody',
        });
        expect(screen.findByTestId('direct-session-takeover-dialog-persist')?.props).toMatchObject({
            accessibilityRole: 'button',
            accessibilityLabel: 'chatFooter.directTakeoverDialogPersistTitle',
            accessibilityHint: 'chatFooter.directTakeoverDialogPersistBody',
        });
        expect(screen.findByTestId('direct-session-takeover-dialog-cancel')?.props).toMatchObject({
            accessibilityRole: 'button',
            accessibilityLabel: 'common.cancel',
        });
    });

    it('names the force-stop switch and explains its effect', async () => {
        const { ExternalSessionTakeoverDialog } = await import('./showExternalSessionTakeoverDialog');
        const screen = await renderScreen(
            <ExternalSessionTakeoverDialog
                canTakeOverDirect
                canTakeOverPersist={false}
                canForceStop
                onResolve={() => {}}
                onClose={() => {}}
            />,
        );

        expect(screen.findByTestId('direct-session-takeover-dialog-force-stop')?.props).toMatchObject({
            accessibilityRole: 'switch',
            accessibilityLabel: 'chatFooter.directTakeoverDialogForceStopTitle',
            accessibilityHint: 'chatFooter.directTakeoverDialogForceStopBody',
        });
    });

    it('shows bounded running-process guidance with no bypass and a Re-check action', async () => {
        const onResolve = vi.fn();
        const { ExternalSessionTakeoverDialog } = await import('./showExternalSessionTakeoverDialog');
        const screen = await renderScreen(
            <ExternalSessionTakeoverDialog
                canTakeOverDirect={false}
                canTakeOverPersist={false}
                canForceStop={false}
                runningProcessPid={12_345}
                onResolve={onResolve}
                onClose={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain(
            'chatFooter.externalSessionProcessRunning',
        );
        expect(screen.getTextContent()).toContain('runs.detail.pid');
        expect(screen.findByTestId('direct-session-takeover-dialog-direct')).toBeNull();
        expect(screen.findByTestId('direct-session-takeover-dialog-persist')).toBeNull();
        expect(screen.findByTestId('direct-session-takeover-dialog-recheck')?.props).toMatchObject({
            accessibilityRole: 'button',
            accessibilityLabel: 'chatFooter.externalSessionRecheck',
            accessibilityHint: 'chatFooter.externalSessionTakeoverBlocked',
        });

        screen.pressByTestId('direct-session-takeover-dialog-recheck');
        expect(onResolve).toHaveBeenCalledWith({
            action: 'recheck',
            forceStop: false,
        });
    });
});
