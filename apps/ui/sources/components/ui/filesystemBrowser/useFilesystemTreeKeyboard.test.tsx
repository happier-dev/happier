import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { useFilesystemTreeKeyboard, type FilesystemTreeKeyboardNode } from './useFilesystemTreeKeyboard';

const folder = { path: 'src', depth: 0, type: 'directory', isExpanded: false } as const;
const file = { path: 'src/index.ts', depth: 1, type: 'file', isExpanded: false } as const;
const other = { path: 'readme.md', depth: 0, type: 'file', isExpanded: false } as const;

describe('filesystem tree keyboard', () => {
    it('repairs collapsed focus through explicit parents, even when keys do not encode ancestry', async () => {
        const first = { path: 'unrelated', parentPath: null, depth: 0, type: 'directory', isExpanded: false };
        const parent = { path: 'folder', parentPath: null, depth: 0, type: 'directory', isExpanded: true };
        const child = { path: 'opaque:file', parentPath: 'folder', depth: 1, type: 'file', isExpanded: false };
        const hook = await renderHook((nodes: readonly FilesystemTreeKeyboardNode[]) => useFilesystemTreeKeyboard(nodes), {
            initialProps: [first, parent, child],
        });
        const parentFocus = vi.fn();
        const childFocus = vi.fn();
        // Physical focus is the native host boundary; traversal and repair stay real.
        const focusTarget = (focus: () => void) => ({ focus, blur: vi.fn(), measure: vi.fn(),
            measureInWindow: vi.fn(), measureLayout: vi.fn(), setNativeProps: vi.fn() });
        await act(async () => {
            const bindParent = hook.getCurrent().getRowProps(parent).pressableRef;
            const bindChild = hook.getCurrent().getRowProps(child).pressableRef;
            if (typeof bindParent === 'function') bindParent(focusTarget(parentFocus));
            if (typeof bindChild === 'function') bindChild(focusTarget(childFocus));
        });
        await act(async () => { hook.getCurrent().getRowProps(child).onFocus?.(); });
        await act(async () => {
            const unbindChild = hook.getCurrent().getRowProps(child).pressableRef;
            if (typeof unbindChild === 'function') unbindChild(null);
        });
        await hook.rerender([first, { ...parent, isExpanded: false }]);
        expect(hook.getCurrent().activePath).toBe('folder');
        expect(parentFocus).toHaveBeenCalledOnce();
    });

    it('does not treat a sibling path prefix as a parent when repairing removed focus', async () => {
        const first = { path: 'src', depth: 0, type: 'directory', isExpanded: false };
        const sibling = { path: 'src-other', depth: 0, type: 'directory', isExpanded: true };
        const child = { path: 'src-other/file.ts', depth: 1, type: 'file', isExpanded: false };
        const hook = await renderHook((nodes: readonly FilesystemTreeKeyboardNode[]) => useFilesystemTreeKeyboard(nodes), {
            initialProps: [first, sibling, child],
        });
        await act(async () => { hook.getCurrent().getRowProps(child).onFocus?.(); });
        await hook.rerender([first, { ...sibling, isExpanded: false }]);
        expect(hook.getCurrent().activePath).toBe('src-other');
    });

    it('expands, traverses children, returns to parent and retains one active row after collapse', async () => {
        const activate = vi.fn();
        const pin = vi.fn();
        const hook = await renderHook((nodes: readonly FilesystemTreeKeyboardNode[]) => useFilesystemTreeKeyboard(nodes), { initialProps: [folder, other] as readonly FilesystemTreeKeyboardNode[] });
        const key = async (node: FilesystemTreeKeyboardNode, value: string, shiftKey = false) => {
            await act(async () => hook.getCurrent().getRowProps(node, activate, pin).onKeyDown?.({ key: value, shiftKey, preventDefault: vi.fn() }));
        };
        expect(hook.getCurrent().getRowProps(folder, activate).accessibilityExpanded).toBe(false);
        const rootLeftDefault = vi.fn();
        await act(async () => hook.getCurrent().getRowProps(folder, activate).onKeyDown?.({ key: 'ArrowLeft', preventDefault: rootLeftDefault }));
        expect(rootLeftDefault).toHaveBeenCalledOnce();
        await key(folder, 'ArrowRight');
        expect(activate).toHaveBeenCalledOnce();
        const expanded = { ...folder, isExpanded: true };
        await hook.rerender([expanded, file, other]);
        await key(expanded, 'ArrowRight');
        expect(hook.getCurrent().getRowProps(file, activate).webTabIndex).toBe(0);
        expect(hook.getCurrent().getRowProps(file, activate).accessibilityLevel).toBe(2);
        await key(file, 'p');
        expect(pin).toHaveBeenCalledOnce();
        const printDefault = vi.fn();
        await act(async () => hook.getCurrent().getRowProps(file, activate, pin).onKeyDown?.({ key: 'p', ctrlKey: true, preventDefault: printDefault }));
        expect(pin).toHaveBeenCalledOnce();
        expect(printDefault).not.toHaveBeenCalled();
        const enterDefault = vi.fn();
        await act(async () => hook.getCurrent().getRowProps(file, activate, pin).onKeyDown?.({ key: 'Enter', preventDefault: enterDefault }));
        expect(enterDefault).not.toHaveBeenCalled();
        expect(pin).toHaveBeenCalledOnce();
        expect(activate).toHaveBeenCalledOnce();
        await key(file, 'ArrowLeft');
        expect(hook.getCurrent().getRowProps(expanded, activate).webTabIndex).toBe(0);
        await key(expanded, 'ArrowDown');
        await hook.rerender([folder, other]);
        expect(hook.getCurrent().getRowProps(folder, activate).webTabIndex).toBe(0);
        expect(hook.getCurrent().getRowProps(other, activate).webTabIndex).toBe(-1);
        await key(folder, 'End');
        expect(hook.getCurrent().getRowProps(other, activate).webTabIndex).toBe(0);
    });
});
