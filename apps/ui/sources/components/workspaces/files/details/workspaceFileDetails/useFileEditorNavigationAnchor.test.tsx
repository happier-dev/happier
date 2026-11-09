import { afterEach, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { computeLineContentHash } from '@/utils/text/lineContentHash';
import { useFileEditorNavigationAnchor } from './useFileEditorNavigationAnchor';

afterEach(standardCleanup);
type Input = Parameters<typeof useFileEditorNavigationAnchor>[0];
const text = Array.from({ length: 56 }, (_, index) => `line ${index + 1}`).join('\n');
function scene(overrides: Partial<Input> = {}): Input {
    return { filePath: 'a.ts', anchorKey: 'a.ts:18', anchor: { kind: 'fileLine', startLine: 18 }, source: 'file',
        active: true, editing: true, enteringEdit: false, editor: null, ...overrides };
}
function engine() {
    return { getValue: vi.fn(() => text), flushPendingChange: async () => {}, revealLine: vi.fn() };
}

it('keeps the latest anchor pending until the active editor is ready, then reads and reveals exactly once', async () => {
    const editor = engine();
    const hook = await renderHook(useFileEditorNavigationAnchor, { initialProps: scene() });
    await hook.rerender(scene({ anchorKey: 'a.ts:52', anchor: { kind: 'fileLine', startLine: 52 }, active: false, editor }));
    expect(editor.getValue).not.toHaveBeenCalled();
    await hook.rerender(scene({ anchorKey: 'a.ts:52', anchor: { kind: 'fileLine', startLine: 52 }, editor }));
    expect(editor.revealLine).toHaveBeenCalledExactlyOnceWith(52, { focus: true });
    editor.getValue.mockClear(); editor.revealLine.mockClear();
    for (let render = 0; render < 5; render++) {
        await hook.rerender(scene({ anchorKey: 'a.ts:52', anchor: { kind: 'fileLine', startLine: 52 }, editor }));
    }
    await hook.rerender(scene({ anchorKey: 'a.ts:52', anchor: { kind: 'fileLine', startLine: 52 }, active: false, editor }));
    await hook.rerender(scene({ anchorKey: 'a.ts:52', anchor: { kind: 'fileLine', startLine: 52 }, editor }));
    expect(editor.getValue).not.toHaveBeenCalled();
    expect(editor.revealLine).not.toHaveBeenCalled();
    await hook.rerender(scene({ editor }));
    expect(editor.getValue).toHaveBeenCalledTimes(1);
    expect(editor.revealLine).toHaveBeenCalledExactlyOnceWith(18, { focus: true });
});

it('leaves a View anchor behind when the reader later enters Edit, including an engine remount', async () => {
    const editor = engine();
    const hook = await renderHook(useFileEditorNavigationAnchor, { initialProps: scene({ editing: false }) });
    await hook.rerender(scene({ editor }));
    expect(editor.revealLine).not.toHaveBeenCalled();
    await hook.rerender(scene({ anchorKey: 'a.ts:52', anchor: { kind: 'fileLine', startLine: 52 }, editor }));
    expect(editor.revealLine).toHaveBeenCalledExactlyOnceWith(52, { focus: true });
    const replacement = engine();
    await hook.rerender(scene({ anchorKey: 'a.ts:52', anchor: { kind: 'fileLine', startLine: 52 }, editor: replacement }));
    expect(replacement.revealLine).not.toHaveBeenCalled();
});

it('retains a fresh Edit-route anchor while its mode and engine mount', async () => {
    const editor = engine();
    const hook = await renderHook(useFileEditorNavigationAnchor, { initialProps: scene({ editing: false, enteringEdit: true }) });
    await hook.rerender(scene({ enteringEdit: true, editor }));
    expect(editor.revealLine).toHaveBeenCalledExactlyOnceWith(18, { focus: true });
});

it('uses the shared anchor resolver for moved text and refuses stale or foreign anchors', async () => {
    const editor = engine();
    const hook = await renderHook(useFileEditorNavigationAnchor, { initialProps: scene({ editor,
        anchor: { kind: 'fileLine', startLine: 17, lineHash: computeLineContentHash('line 18') } }) });
    expect(editor.revealLine).toHaveBeenCalledExactlyOnceWith(18, { focus: true });
    editor.revealLine.mockClear();
    await hook.rerender(scene({ editor, anchorKey: 'stale', anchor: { kind: 'fileLine', startLine: 18, lineHash: computeLineContentHash('removed') } }));
    await hook.rerender(scene({ editor, anchorKey: 'foreign', anchor: { kind: 'line', filePath: 'b.ts', line: 18 } }));
    expect(editor.revealLine).not.toHaveBeenCalled();
});
