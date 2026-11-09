import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { flushHookEffects, installBrowserClipboardBoundary, renderScreen } from '@/dev/testkit';
import { installSourceControlChangesCommonModuleMocks } from './sourceControlChangesTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.hoisted(() => vi.fn());
const setClipboardStringSafeSpy = vi.hoisted(() => vi.fn(async (_value: string) => true));

installSourceControlChangesCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { alert: modalAlertSpy } }).module;
    },
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: (value: string) => setClipboardStringSafeSpy(value),
}));

const { ItemRowActions } = await import('@/components/ui/lists/ItemRowActions');

describe('ScmChangeOverflowMenu', () => {
    beforeEach(() => {
        modalAlertSpy.mockClear();
        setClipboardStringSafeSpy.mockClear();
        setClipboardStringSafeSpy.mockResolvedValue(true);
        installBrowserClipboardBoundary(async text => { await setClipboardStringSafeSpy(text); });
    });

    it('includes copy-path action and optional reveal-in-tree action', async () => {
        const { ScmChangeOverflowMenu } = await import('./ScmChangeOverflowMenu');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ScmChangeOverflowMenu
                    filePath="src/a.ts"
                    title="a.ts"
                    onRevealInTree={() => {}}
                />)).tree;

        const node = tree!.findByType(ItemRowActions);
        expect(node.props.title).toBe('a.ts');
        expect(node.props.compactThreshold).toBe(Number.POSITIVE_INFINITY);
        expect(Array.isArray(node.props.actions)).toBe(true);

        const ids = node.props.actions.map((a: any) => a.id);
        expect(ids).toContain('copy_path');
        expect(ids).toContain('reveal_in_tree');
    });

    it('adds a destructive discard action when onDiscard is provided', async () => {
        const onDiscard = vi.fn();
        const { ScmChangeOverflowMenu } = await import('./ScmChangeOverflowMenu');

        const tree = (await renderScreen(<ScmChangeOverflowMenu
                    filePath="src/a.ts"
                    title="a.ts"
                    onRevealInTree={() => {}}
                    onDiscard={onDiscard}
                />)).tree;

        const node = tree!.findByType(ItemRowActions);
        const discard = node.props.actions.find((a: any) => a.id === 'discard');
        expect(discard).toBeTruthy();
        expect(discard.destructive).toBe(true);

        discard.onPress();
        expect(onDiscard).toHaveBeenCalledTimes(1);
    });

    it('omits the discard action when onDiscard is not provided', async () => {
        const { ScmChangeOverflowMenu } = await import('./ScmChangeOverflowMenu');

        const tree = (await renderScreen(<ScmChangeOverflowMenu
                    filePath="src/a.ts"
                    title="a.ts"
                />)).tree;

        const node = tree!.findByType(ItemRowActions);
        const ids = node.props.actions.map((a: any) => a.id);
        expect(ids).not.toContain('discard');
    });

    it('copies the path without opening a success modal', async () => {
        const onCopyPathSuccess = vi.fn();
        const { ScmChangeOverflowMenu } = await import('./ScmChangeOverflowMenu');

        const tree = (await renderScreen(<ScmChangeOverflowMenu
                    filePath="src/a.ts"
                    title="a.ts"
                    onCopyPathSuccess={onCopyPathSuccess}
                />)).tree;

        const node = tree!.findByType(ItemRowActions);
        const copyPath = node.props.actions.find((a: any) => a.id === 'copy_path');

        await act(async () => { copyPath.onPress(); });
        await flushHookEffects();

        expect(setClipboardStringSafeSpy).toHaveBeenCalledWith('src/a.ts');
        expect(onCopyPathSuccess).toHaveBeenCalledTimes(1);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });
});
