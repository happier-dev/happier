/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { BaseModal } from './BaseModal';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// This must render React Native Web's real primitives: its deprecated
// pointerEvents prop warning cannot be observed through the usual host shim.
vi.mock('react-native', async () => await vi.importActual('react-native-web'));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useLocalSetting: createUseLocalSettingMock() });
});

vi.mock('@/utils/web/radixCjs', () => ({
    requireRadixDismissableLayer: () => ({
        Branch: (props: React.PropsWithChildren) => props.children,
    }),
}));

vi.mock('react-native-keyboard-controller', async () => {
    const { View } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return { KeyboardAvoidingView: View };
});

describe('BaseModal web pointer-events ownership', () => {
    it('keeps the real-RNW modal interactive without using the deprecated prop', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        const onAction = vi.fn();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const originalMatchMedia = window.matchMedia;
        const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
        const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

        Object.defineProperty(window, 'matchMedia', {
            configurable: true,
            value: () => ({
                matches: true,
                addEventListener: () => {},
                removeEventListener: () => {},
            }),
        });
        globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => setTimeout(
            () => callback(performance.now()),
            0,
        )) as unknown as typeof requestAnimationFrame;
        globalThis.cancelAnimationFrame = ((handle: number) => clearTimeout(handle)) as typeof cancelAnimationFrame;

        try {
            act(() => {
                root.render(
                    <BaseModal visible closeOnBackdrop={false} accessibilityLabel="Plugin action dialog">
                        <button data-testid="plugin-action" type="button" onClick={onAction}>Run action</button>
                    </BaseModal>,
                );
            });

            const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
            const action = document.body.querySelector<HTMLButtonElement>('[data-testid="plugin-action"]');
            expect(dialog).not.toBeNull();
            expect(action).not.toBeNull();

            act(() => {
                action!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
            expect(onAction).toHaveBeenCalledTimes(1);

            const deprecatedPointerEventsWarnings = warning.mock.calls.filter(([message]) => (
                String(message).includes('props.pointerEvents is deprecated. Use style.pointerEvents')
            ));
            expect(deprecatedPointerEventsWarnings).toEqual([]);
        } finally {
            act(() => {
                root.unmount();
            });
            warning.mockRestore();
            Object.defineProperty(window, 'matchMedia', {
                configurable: true,
                value: originalMatchMedia,
            });
            globalThis.requestAnimationFrame = originalRequestAnimationFrame;
            globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
            container.remove();
        }
    });
});
