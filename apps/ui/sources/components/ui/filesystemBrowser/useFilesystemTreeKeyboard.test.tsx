import * as React from 'react';
import { Pressable } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit';
import { useFilesystemTreeKeyboard, type FilesystemTreeKeyboardNode } from './useFilesystemTreeKeyboard';

const folder = { path: 'src', depth: 0, type: 'directory', isExpanded: false } as const;
const file = { path: 'src/index.ts', depth: 1, type: 'file', isExpanded: false } as const;
const other = { path: 'readme.md', depth: 0, type: 'file', isExpanded: false } as const;
// A row reads its tab-stop answer from the tree's active-path source, as mounted rows do.
const rowProps = (keyboard: ReturnType<typeof useFilesystemTreeKeyboard>, node: FilesystemTreeKeyboardNode, onDisclosure?: () => void, pin?: () => void) =>
    keyboard.getRowProps(node, keyboard.activePath.get() === node.path, onDisclosure, pin);

describe('filesystem tree keyboard', () => {
    it('repairs collapsed focus through explicit parents, even when keys do not encode ancestry', async () => {
        const first = { path: 'unrelated', parentPath: null, depth: 0, type: 'directory', isExpanded: false };
        const parent = { path: 'folder', parentPath: null, depth: 0, type: 'directory', isExpanded: true };
        const child = { path: 'opaque:file', parentPath: 'folder', depth: 1, type: 'file', isExpanded: false };
        let focusedPath: string | null = null;
        let keyboard!: ReturnType<typeof useFilesystemTreeKeyboard>;
        function Tree({ nodes }: { nodes: readonly FilesystemTreeKeyboardNode[] }) {
            keyboard = useFilesystemTreeKeyboard(nodes);
            return <>{nodes.map(node => <Pressable key={node.path} testID={node.path}
                ref={rowProps(keyboard, node).pressableRef} />)}</>;
        }
        // Physical focus is the native host boundary; refs, traversal and repair stay real.
        const screen = await renderScreen(<Tree nodes={[first, parent, child]} />, {
            createNodeMock: element => ({ focus: () => {
                focusedPath = typeof element.props.testID === 'string' ? element.props.testID : null;
            } }),
        });
        focusedPath = child.path;
        await act(async () => { rowProps(keyboard, child).onFocus?.(); });
        await screen.update(<Tree nodes={[first, { ...parent, isExpanded: false }]} />);
        expect(keyboard.activePath.get()).toBe('folder');
        expect(focusedPath).toBe(parent.path);
    });

    it('does not treat a sibling path prefix as a parent when repairing removed focus', async () => {
        const first = { path: 'src', depth: 0, type: 'directory', isExpanded: false };
        const sibling = { path: 'src-other', depth: 0, type: 'directory', isExpanded: true };
        const child = { path: 'src-other/file.ts', depth: 1, type: 'file', isExpanded: false };
        const hook = await renderHook((nodes: readonly FilesystemTreeKeyboardNode[]) => useFilesystemTreeKeyboard(nodes), {
            initialProps: [first, sibling, child],
        });
        await act(async () => { rowProps(hook.getCurrent(), child).onFocus?.(); });
        await hook.rerender([first, { ...sibling, isExpanded: false }]);
        expect(hook.getCurrent().activePath.get()).toBe('src-other');
    });

    it('expands, traverses children, returns to parent and retains one active row after collapse', async () => {
        const activate = vi.fn();
        const pin = vi.fn();
        const hook = await renderHook((nodes: readonly FilesystemTreeKeyboardNode[]) => useFilesystemTreeKeyboard(nodes), { initialProps: [folder, other] as readonly FilesystemTreeKeyboardNode[] });
        const key = async (node: FilesystemTreeKeyboardNode, value: string, shiftKey = false) => {
            await act(async () => rowProps(hook.getCurrent(), node, activate, pin).onKeyDown?.({ key: value, shiftKey, preventDefault: vi.fn() }));
        };
        expect(rowProps(hook.getCurrent(), folder, activate).accessibilityExpanded).toBe(false);
        const rootLeftDefault = vi.fn();
        await act(async () => rowProps(hook.getCurrent(), folder, activate).onKeyDown?.({ key: 'ArrowLeft', preventDefault: rootLeftDefault }));
        expect(rootLeftDefault).toHaveBeenCalledOnce();
        await key(folder, 'ArrowRight');
        expect(activate).toHaveBeenCalledOnce();
        const expanded = { ...folder, isExpanded: true };
        await hook.rerender([expanded, file, other]);
        await key(expanded, 'ArrowRight');
        expect(rowProps(hook.getCurrent(), file, activate).webTabIndex).toBe(0);
        expect(rowProps(hook.getCurrent(), file, activate).accessibilityLevel).toBe(2);
        await key(file, 'p');
        expect(pin).toHaveBeenCalledOnce();
        const printDefault = vi.fn();
        await act(async () => rowProps(hook.getCurrent(), file, activate, pin).onKeyDown?.({ key: 'p', ctrlKey: true, preventDefault: printDefault }));
        expect(pin).toHaveBeenCalledOnce();
        expect(printDefault).not.toHaveBeenCalled();
        const enterDefault = vi.fn();
        await act(async () => rowProps(hook.getCurrent(), file, activate, pin).onKeyDown?.({ key: 'Enter', preventDefault: enterDefault }));
        expect(enterDefault).not.toHaveBeenCalled();
        expect(pin).toHaveBeenCalledOnce();
        expect(activate).toHaveBeenCalledOnce();
        await key(file, 'ArrowLeft');
        expect(rowProps(hook.getCurrent(), expanded, activate).webTabIndex).toBe(0);
        await key(expanded, 'ArrowDown');
        await hook.rerender([folder, other]);
        expect(rowProps(hook.getCurrent(), folder, activate).webTabIndex).toBe(0);
        expect(rowProps(hook.getCurrent(), other, activate).webTabIndex).toBe(-1);
        await key(folder, 'End');
        expect(rowProps(hook.getCurrent(), other, activate).webTabIndex).toBe(0);
    });
});
