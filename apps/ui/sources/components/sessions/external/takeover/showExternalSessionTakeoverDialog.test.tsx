import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

function flattenPressableStyle(style: unknown): Record<string, unknown> {
    const resolved = typeof style === 'function'
        ? style({ pressed: false })
        : style;
    const entries = Array.isArray(resolved) ? resolved.flat(Infinity) : [resolved];
    return Object.assign({}, ...entries.filter((entry): entry is object => Boolean(entry)));
}

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

const target = {
    machineId: 'machine-linked-owner',
    machineHomeDir: '/Users/tester',
    initialDirectory: '/Users/tester/selected-workspace',
    serverId: 'server-1',
} as const;

describe('ExternalSessionTakeoverDialog accessibility', () => {
    it('names every takeover choice and cancel action as a button', async () => {
        const onResolve = vi.fn();
        const { ExternalSessionTakeoverDialog } = await import('./showExternalSessionTakeoverDialog');
        const screen = await renderScreen(
            <ExternalSessionTakeoverDialog
                canTakeOverDirect
                canTakeOverPersist
                target={target}
                onResolve={onResolve}
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
        expect(screen.findByTestId('direct-session-takeover-dialog-target-path')?.props).toMatchObject({
            children: '/Users/tester/selected-workspace',
            accessibilityLabel: '/Users/tester/selected-workspace',
        });
        expect(screen.findByTestId('direct-session-takeover-dialog-cancel')?.props).toMatchObject({
            accessibilityRole: 'button',
            accessibilityLabel: 'common.cancel',
        });

        screen.pressByTestId('direct-session-takeover-dialog-direct');
        screen.pressByTestId('direct-session-takeover-dialog-persist');
        screen.pressByTestId('direct-session-takeover-dialog-cancel');
        expect(onResolve.mock.calls).toEqual([
            [{ action: 'direct', targetDirectory: '/Users/tester/selected-workspace' }],
            [{ action: 'persisted', targetDirectory: '/Users/tester/selected-workspace' }],
            [{ action: null }],
        ]);
    });

    it('preserves a selected absolute POSIX target directory byte-for-byte', async () => {
        const onResolve = vi.fn();
        const { ExternalSessionTakeoverDialog } = await import('./showExternalSessionTakeoverDialog');
        const screen = await renderScreen(
            <ExternalSessionTakeoverDialog
                canTakeOverDirect
                canTakeOverPersist={false}
                target={{ ...target, initialDirectory: '/work/repo ' }}
                onResolve={onResolve}
                onClose={() => {}}
            />,
        );

        expect(screen.findByTestId('direct-session-takeover-dialog-target-path')?.props).toMatchObject({
            children: '/work/repo ',
            accessibilityLabel: '/work/repo ',
        });
        screen.pressByTestId('direct-session-takeover-dialog-direct');
        expect(onResolve).toHaveBeenCalledWith({
            action: 'direct',
            targetDirectory: '/work/repo ',
        });
    });

    it('does not trim a leading-space target into an actionable absolute path', async () => {
        const onResolve = vi.fn();
        const { ExternalSessionTakeoverDialog } = await import('./showExternalSessionTakeoverDialog');
        const screen = await renderScreen(
            <ExternalSessionTakeoverDialog
                canTakeOverDirect
                canTakeOverPersist
                target={{ ...target, initialDirectory: ' /work/repo' }}
                onResolve={onResolve}
                onClose={() => {}}
            />,
        );

        for (const testID of [
            'direct-session-takeover-dialog-direct',
            'direct-session-takeover-dialog-persist',
        ]) {
            expect(screen.findByTestId(testID)?.props).toMatchObject({
                disabled: true,
                accessibilityState: { disabled: true },
            });
        }
        expect(screen.findByTestId('direct-session-takeover-dialog-target-path')?.props).toMatchObject({
            children: ' /work/repo',
            accessibilityLabel: ' /work/repo',
        });
        screen.pressByTestId('direct-session-takeover-dialog-direct');
        screen.pressByTestId('direct-session-takeover-dialog-persist');
        expect(onResolve).not.toHaveBeenCalled();
    });

    it('disables both launch choices until a local absolute target is selected', async () => {
        const onResolve = vi.fn();
        const { ExternalSessionTakeoverDialog } = await import('./showExternalSessionTakeoverDialog');
        const screen = await renderScreen(
            <ExternalSessionTakeoverDialog
                canTakeOverDirect
                canTakeOverPersist
                target={{ ...target, initialDirectory: 'relative/workspace' }}
                onResolve={onResolve}
                onClose={() => {}}
            />,
        );

        for (const testID of [
            'direct-session-takeover-dialog-direct',
            'direct-session-takeover-dialog-persist',
        ]) {
            expect(screen.findByTestId(testID)?.props).toMatchObject({
                disabled: true,
                accessibilityState: { disabled: true },
            });
        }
        expect(screen.findByTestId('direct-session-takeover-dialog-target-path')?.props).toMatchObject({
            children: 'relative/workspace',
            accessibilityLabel: 'relative/workspace',
        });
        screen.pressByTestId('direct-session-takeover-dialog-direct');
        screen.pressByTestId('direct-session-takeover-dialog-persist');
        expect(onResolve).not.toHaveBeenCalled();
    });

    it('keeps every visible dialog action at the platform minimum target height', async () => {
        const { ExternalSessionTakeoverDialog } = await import('./showExternalSessionTakeoverDialog');
        const screen = await renderScreen(
            <ExternalSessionTakeoverDialog
                canTakeOverDirect
                canTakeOverPersist
                runningProcessPid={12_345}
                onResolve={() => {}}
                onClose={() => {}}
            />,
        );

        for (const testID of [
            'direct-session-takeover-dialog-direct',
            'direct-session-takeover-dialog-persist',
            'direct-session-takeover-dialog-recheck',
            'direct-session-takeover-dialog-cancel',
        ]) {
            const action = screen.findByTestId(testID);
            expect(flattenPressableStyle(action?.props.style).minHeight).toBeGreaterThanOrEqual(44);
        }
    });

    it('never offers a destructive stop control', async () => {
        const { ExternalSessionTakeoverDialog } = await import('./showExternalSessionTakeoverDialog');
        const screen = await renderScreen(
            <ExternalSessionTakeoverDialog
                canTakeOverDirect
                canTakeOverPersist={false}
                onResolve={() => {}}
                onClose={() => {}}
            />,
        );

        expect(screen.findByTestId('direct-session-takeover-dialog-force-stop')).toBeNull();
        expect(screen.getTextContent()).not.toContain('chatFooter.directTakeoverDialogForceStopTitle');
        expect(screen.getTextContent()).not.toContain('chatFooter.directTakeoverDialogForceStopBody');
    });

    it('shows bounded running-process guidance with no bypass and a Re-check action', async () => {
        const onResolve = vi.fn();
        const { ExternalSessionTakeoverDialog } = await import('./showExternalSessionTakeoverDialog');
        const screen = await renderScreen(
            <ExternalSessionTakeoverDialog
                canTakeOverDirect={false}
                canTakeOverPersist={false}
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
        });
    });
});
