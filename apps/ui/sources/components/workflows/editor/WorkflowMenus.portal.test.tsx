/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Keep the real menu, rows, focus and modal owners; mock native/platform adapters only.
vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return createRadixCjsRealModule();
});
vi.mock('@/utils/web/reactDomCjs', async () => {
    const dom = await import('react-dom');
    return { requireReactDOM: () => dom };
});
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('div', props),
}));

import { BaseModal } from '@/modal/components/BaseModal';
import { WorkflowBlockActionsMenu, type WorkflowBlockAction } from './WorkflowBlockActionsMenu';

afterEach(() => vi.restoreAllMocks());

async function mountMenu(actions: readonly WorkflowBlockAction[], trigger?: 'caret') {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 200, height: 40, top: 100, left: 100, right: 300, bottom: 140, toJSON: () => ({}),
    });
    await act(async () => {
        root.render(<BaseModal visible onClose={() => {}}>
            <WorkflowBlockActionsMenu blockLabel="Review" actions={actions} trigger={trigger} testID="workflow-actions" />
        </BaseModal>);
    });
    return {
        element: (id: string) => {
            const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
            expect(element).not.toBeNull();
            return element!;
        },
        async open() {
            const button = document.querySelector<HTMLElement>('[data-testid="workflow-actions"]')!;
            button.focus();
            await act(async () => button.click());
            await vi.waitFor(async () => {
                await act(async () => {});
                expect(document.querySelector('[data-testid="workflow-actions-remove"]')).not.toBeNull();
            });
            return button;
        },
        async key(key: string) {
            await act(async () => {
                document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
            });
        },
        async dispose() {
            await act(async () => root.unmount());
            container.remove();
        },
    };
}

describe('Workflow block menu at the real modal/menu boundary', () => {
    it('navigates available actions with arrows, Home/End and prefix, returning focus on Escape', async () => {
        const selected = vi.fn();
        const menu = await mountMenu([
            { id: 'duplicate', label: 'Duplicate', onSelect: selected },
            { id: 'moveDown', label: 'Move down', onSelect: selected },
            { id: 'remove', label: 'Remove', destructive: true, onSelect: selected },
        ]);
        try {
            const button = await menu.open();
            const duplicate = menu.element('workflow-actions-duplicate');
            duplicate.focus();
            await menu.key('ArrowDown');
            expect(document.activeElement).toBe(menu.element('workflow-actions-moveDown'));
            await menu.key('ArrowUp');
            expect(document.activeElement).toBe(duplicate);
            await menu.key('End');
            expect(document.activeElement).toBe(menu.element('workflow-actions-remove'));
            await menu.key('Home');
            expect(document.activeElement).toBe(duplicate);
            await menu.key('r');
            expect(document.activeElement).toBe(menu.element('workflow-actions-remove'));
            expect(document.querySelector('[data-testid="workflow-actions-moveUp"]')).toBeNull();
            expect(menu.element('workflow-actions-remove').closest('[data-happy-modal-portal-host]')).not.toBeNull();
            await menu.key('Escape');
            expect(document.querySelector('[data-testid="workflow-actions-remove"]')).toBeNull();
            expect(document.activeElement).toBe(button);
            expect(button.getAttribute('aria-expanded')).toBe('false');
            expect(selected).not.toHaveBeenCalled();
        } finally { await menu.dispose(); }
    });

    it.each(['pointer', 'press'] as const)('commits a destructive action once using %s and closes before its callback', async (input) => {
        let closedBeforeCallback = false;
        const selected = vi.fn(() => {
            closedBeforeCallback = document.querySelector('[data-testid="workflow-actions-remove"]') === null;
        });
        const menu = await mountMenu([{ id: 'remove', label: 'Remove', destructive: true, onSelect: selected }], 'caret');
        try {
            const button = await menu.open();
            expect(button.getAttribute('aria-expanded')).toBe('true');
            const remove = menu.element('workflow-actions-remove');
            await act(async () => {
                if (input === 'pointer') {
                    remove.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
                    remove.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
                }
                remove.click();
            });
            await vi.waitFor(async () => {
                await act(async () => {});
                expect(selected).toHaveBeenCalledTimes(1);
            });
            expect(closedBeforeCallback).toBe(true);
            expect(button.getAttribute('aria-expanded')).toBe('false');
        } finally { await menu.dispose(); }
    });

    it('omits the trigger when no action is available', async () => {
        const menu = await mountMenu([]);
        try { expect(document.querySelector('[data-testid="workflow-actions"]')).toBeNull(); }
        finally { await menu.dispose(); }
    });
});
