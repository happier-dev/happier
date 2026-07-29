import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
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

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: (value: string) => setClipboardStringSafeSpy(value),
}));

describe('ScmChangeOverflowMenu', () => {
    beforeEach(() => {
        modalAlertSpy.mockClear();
        setClipboardStringSafeSpy.mockClear();
        setClipboardStringSafeSpy.mockResolvedValue(true);
    });

    it('includes copy-path action and optional reveal-in-tree action', async () => {
        const { ScmChangeOverflowMenu } = await import('./ScmChangeOverflowMenu');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ScmChangeOverflowMenu
                    filePath="src/a.ts"
                    title="a.ts"
                    onRevealInTree={() => {}}
                />)).tree;

        const node = tree!.findByType('ItemRowActions' as any);
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

        const node = tree!.findByType('ItemRowActions' as any);
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

        const node = tree!.findByType('ItemRowActions' as any);
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

        const node = tree!.findByType('ItemRowActions' as any);
        const copyPath = node.props.actions.find((a: any) => a.id === 'copy_path');

        await copyPath.onPress();

        expect(setClipboardStringSafeSpy).toHaveBeenCalledWith('src/a.ts');
        expect(onCopyPathSuccess).toHaveBeenCalledTimes(1);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });
});
