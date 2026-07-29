/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { installModalComponentCommonModuleMocks } from './modalComponentTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installModalComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: <T,>(values: { web?: T; default?: T }) => values.web ?? values.default,
            },
            View: (props: React.HTMLAttributes<HTMLDivElement>) => React.createElement('div', props, props.children),
        });
    },
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: createUseLocalSettingMock(),
    });
});

vi.mock('@/utils/web/radixCjs', () => ({
    requireRadixDismissableLayer: () => ({
        Branch: (props: React.PropsWithChildren<Record<string, unknown>>) => (
            React.createElement(React.Fragment, null, props.children)
        ),
    }),
}));

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: React.PropsWithChildren<Record<string, unknown>>) => (
        React.createElement('div', props, props.children)
    ),
}));

describe('BaseModal (web focus)', () => {
    it('keeps Tab and Shift+Tab focus traversal inside the active dialog', async () => {
        const { BaseModal } = await import('./BaseModal');
        const backgroundButton = document.createElement('button');
        backgroundButton.textContent = 'Background';
        document.body.appendChild(backgroundButton);

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        try {
            backgroundButton.focus();
            await act(async () => {
                root.render(
                    <BaseModal visible closeOnBackdrop={false}>
                        <button data-testid="first-dialog-action">First</button>
                        <button data-testid="last-dialog-action">Last</button>
                    </BaseModal>,
                );
            });

            const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
            const firstAction = document.querySelector<HTMLButtonElement>('[data-testid="first-dialog-action"]');
            const lastAction = document.querySelector<HTMLButtonElement>('[data-testid="last-dialog-action"]');
            expect(dialog).not.toBeNull();
            expect(firstAction).not.toBeNull();
            expect(lastAction).not.toBeNull();
            expect(dialog?.contains(document.activeElement)).toBe(true);

            lastAction?.focus();
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Tab',
                bubbles: true,
                cancelable: true,
            }));
            expect(document.activeElement).toBe(firstAction);

            firstAction?.focus();
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Tab',
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            }));
            expect(document.activeElement).toBe(lastAction);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
            backgroundButton.remove();
        }
    });
});
