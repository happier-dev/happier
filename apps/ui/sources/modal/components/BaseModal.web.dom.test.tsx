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

vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return await createRadixCjsRealModule();
});

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: React.PropsWithChildren<Record<string, unknown>>) => (
        React.createElement('div', props, props.children)
    ),
}));

// Prepare the real modal graph after its SDK boundaries, outside the behavioral budget.
const { BaseModal } = await import('./BaseModal');
const { PopoverScrollSourceProvider, usePopoverScrollSourceRef } = await import('@/components/ui/popover/PopoverScrollSource');

describe('BaseModal (web focus)', () => {
    it('keeps Escape, focus containment, and thumbnail focus return when the stage owns motion', async () => {
        const trigger = document.createElement('button');
        document.body.appendChild(trigger);
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const close = vi.fn();
        try {
            trigger.focus();
            await act(async () => root.render(<BaseModal visible motion="none" placement="fullscreen" showBackdrop={false}
                focusReturnRef={{ current: trigger }} onClose={close}><button>Photo</button></BaseModal>));
            expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
            await act(async () => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            });
            expect(close).toHaveBeenCalledOnce();
            await act(async () => root.unmount());
            expect(document.activeElement).toBe(trigger);
        } finally {
            await act(async () => root.unmount());
            trigger.remove(); container.remove();
        }
    });
    it('steps back on Escape when the sheet pushed a view inside itself, without closing it', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const close = vi.fn();
        const back = vi.fn();
        try {
            await act(async () => root.render(<BaseModal visible placement="bottom" onClose={close} onBack={back}>
                <button>Direct</button></BaseModal>));
            await act(async () => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            });
            expect(back).toHaveBeenCalledOnce();
            expect(close).not.toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    it('returns focus to the pre-open trigger when its portal dialog unmounts', async () => {
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
                        <button data-testid="dialog-action">Action</button>
                    </BaseModal>,
                );
            });

            expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'));

            await act(async () => {
                root.unmount();
            });

            expect(document.activeElement).toBe(backgroundButton);
        } finally {
            await act(async () => { root.unmount(); });
            container.remove();
            backgroundButton.remove();
        }
    });

    it('keeps Tab and Shift+Tab focus traversal inside the active dialog', async () => {
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
    // L77: a modal opened from a scrolling page is not scrolled by that page. A list inside it follows the modal's
    // own scroller (overlay host) or, when its content owns the scrolling, none - never the page behind.
    it.each([
        ['overlay', 'dialog'],
        ['body', null],
    ] as const)('replaces the page scroll source for its content with the %s scroller', async (scrollHost, expected) => {
        const pageScroller = { page: true };
        let seen: React.RefObject<unknown> | null | undefined;
        function SourceProbe() { seen = usePopoverScrollSourceRef(); return null; }
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => {
                root.render(
                    <PopoverScrollSourceProvider scrollSourceRef={{ current: pageScroller }}>
                        <BaseModal visible closeOnBackdrop={false} scrollHost={scrollHost} placement="bottom">
                            <SourceProbe />
                        </BaseModal>
                    </PopoverScrollSourceProvider>,
                );
            });
            const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
            expect(dialog).not.toBeNull();
            expect(seen?.current ?? null).toBe(expected === 'dialog' ? dialog : null);
        } finally {
            await act(async () => { root.unmount(); });
            container.remove();
        }
    });
});
