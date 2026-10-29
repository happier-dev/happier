import * as React from 'react';
import { Platform } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createLayoutChangeEvent } from '@/dev/testkit/fixtures/nativeEventFixtures';
import { readHitArea } from '@/dev/testkit/harness/hitFrameReach';

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!Array.isArray(style)) {
        return style && typeof style === 'object' ? style as Record<string, unknown> : {};
    }
    return Object.assign({}, ...style.map(flattenStyle));
}

describe('CheckpointCodeRollbackDialog', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('disables conversation choices when conversation rollback is unsupported', async () => {
        const onConfirm = vi.fn();
        const { CheckpointCodeRollbackDialog } = await import('./CheckpointCodeRollbackDialog');

        const screen = await renderScreen(
            <CheckpointCodeRollbackDialog
                visible
                conversationRollbackSupported={false}
                onCancel={() => undefined}
                onConfirm={onConfirm}
            />,
        );

        expect(screen.findByTestId('checkpoint-rollback-choice:conversation_only')?.props.accessibilityState?.disabled).toBe(true);
        expect(screen.findByTestId('checkpoint-rollback-choice:conversation_and_code_without_stash')?.props.accessibilityState?.disabled).toBe(true);
        expect(screen.findByTestId('checkpoint-rollback-choice:code_only_without_stash')).toBeNull();
        await screen.pressByTestIdAsync('checkpoint-rollback-show-advanced');
        expect(screen.findByTestId('checkpoint-rollback-choice:code_only_without_stash')?.props.accessibilityState?.disabled).toBe(false);
        await screen.unmount();
    });

    it('puts its title in the shared modal title band, not in the body', async () => {
        const setChrome = vi.fn();
        const { CheckpointCodeRollbackDialog } = await import('./CheckpointCodeRollbackDialog');
        const screen = await renderScreen(
            <CheckpointCodeRollbackDialog
                visible
                conversationRollbackSupported
                onCancel={() => undefined}
                onConfirm={() => undefined}
                setChrome={setChrome}
            />,
        );

        expect(setChrome).toHaveBeenLastCalledWith(expect.objectContaining({
            kind: 'card',
            title: 'session.rollback.checkpointCode.title',
        }));
        expect(screen.getTextContent()).not.toContain('session.rollback.checkpointCode.title');
        await screen.unmount();
    });

    it('requires explicit transcript-divergence confirmation before confirming code-only rollback', async () => {
        const onConfirm = vi.fn();
        const { CheckpointCodeRollbackDialog } = await import('./CheckpointCodeRollbackDialog');
        const screen = await renderScreen(
            <CheckpointCodeRollbackDialog
                visible
                conversationRollbackSupported={false}
                onCancel={() => undefined}
                onConfirm={onConfirm}
            />,
        );

        expect(screen.findByTestId('checkpoint-rollback-choice:code_only_without_stash')).toBeNull();
        await screen.pressByTestIdAsync('checkpoint-rollback-show-advanced');
        await screen.pressByTestIdAsync('checkpoint-rollback-choice:code_only_without_stash');
        expect(screen.findByTestId('checkpoint-rollback-confirm')?.props.accessibilityState?.disabled).toBe(true);

        await screen.pressByTestIdAsync('checkpoint-rollback-code-only-confirmation');
        await screen.pressByTestIdAsync('checkpoint-rollback-confirm');

        expect(onConfirm).toHaveBeenCalledWith({
            mode: 'code_only_without_stash',
            backupMode: 'happier_checkpoint_only',
            codeOnlyTranscriptDivergenceConfirmed: true,
        });
        await screen.unmount();
    });

    it('keeps every rollback action semantically named, drawn at its content and reaching 48dp on Android by hit area', async () => {
        const previousPlatform = Platform.OS;
        (Platform as { OS: string }).OS = 'android';
        try {
            const { CheckpointCodeRollbackDialog } = await import('./CheckpointCodeRollbackDialog');
            const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
            const screen = await renderScreen(
                <HappierUiPlatformProvider platform={{ platform: 'android', colorScheme: 'light' }}>
                    <CheckpointCodeRollbackDialog
                        visible
                        conversationRollbackSupported={false}
                        onCancel={() => undefined}
                        onConfirm={() => undefined}
                    />
                </HappierUiPlatformProvider>,
            );

            const advancedAction = screen.findByTestId('checkpoint-rollback-show-advanced');
            expect(advancedAction?.props.accessibilityRole).toBe('button');
            expect(flattenStyle(advancedAction?.props.style).minHeight).toBeUndefined();
            await act(async () => { advancedAction!.props.onLayout(createLayoutChangeEvent({ x: 0, y: 0, width: 140, height: 34 })); });
            expect(readHitArea(screen.findHostByTestId('checkpoint-rollback-show-advanced')!, { width: 140, height: 34 }).height).toBe(48);

            await screen.pressByTestIdAsync('checkpoint-rollback-show-advanced');
            await screen.pressByTestIdAsync('checkpoint-rollback-choice:code_only_without_stash');

            for (const testID of [
                'checkpoint-rollback-choice:code_only_without_stash',
                'checkpoint-rollback-code-only-confirmation',
                'checkpoint-rollback-cancel',
                'checkpoint-rollback-confirm',
            ]) {
                const action = screen.findByTestId(testID);
                expect(action?.props.accessibilityRole).toBeTruthy();
                expect(flattenStyle(action?.props.style).minHeight).toBeUndefined();
            }
            await screen.unmount();
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });

    it('opens through the app Modal pattern instead of inline screen state', async () => {
        const showSpy = vi.fn();
        vi.doMock('@/modal', () => ({
            Modal: {
                show: showSpy,
            },
        }));
        vi.resetModules();

        const { showCheckpointCodeRollbackDialog } = await import('./CheckpointCodeRollbackDialog');
        const result = showCheckpointCodeRollbackDialog({ conversationRollbackSupported: true });

        expect(showSpy).toHaveBeenCalledWith(expect.objectContaining({
            component: expect.anything(),
            props: expect.objectContaining({
                conversationRollbackSupported: true,
            }),
        }));
        showSpy.mock.calls[0]?.[0]?.props?.onCancel?.();
        await expect(result).resolves.toBeNull();
    });
});
