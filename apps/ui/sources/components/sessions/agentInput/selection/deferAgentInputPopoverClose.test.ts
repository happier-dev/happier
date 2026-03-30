import { describe, expect, it, vi } from 'vitest';

describe('deferAgentInputPopoverClose', () => {
    it('defers close on web', async () => {
        vi.useFakeTimers();
        vi.resetModules();
        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                Platform: {
                    OS: 'web',
                    select: (value: any) => value.web ?? value.default ?? null,
                },
            });
        });

        const { deferAgentInputPopoverClose } = await import('./deferAgentInputPopoverClose');
        const onRequestClose = vi.fn();

        deferAgentInputPopoverClose(onRequestClose);
        expect(onRequestClose).not.toHaveBeenCalled();

        vi.runAllTimers();
        expect(onRequestClose).toHaveBeenCalledTimes(1);

        vi.useRealTimers();
    });

    it('closes synchronously on native', async () => {
        vi.resetModules();
        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                Platform: {
                    OS: 'ios',
                    select: (value: any) => value.ios ?? value.default ?? null,
                },
            });
        });

        const { deferAgentInputPopoverClose } = await import('./deferAgentInputPopoverClose');
        const onRequestClose = vi.fn();

        deferAgentInputPopoverClose(onRequestClose);
        expect(onRequestClose).toHaveBeenCalledTimes(1);
    });
});

