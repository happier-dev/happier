/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import { createThemeProfileDraft } from '@/theme/profiles/createThemeProfileDraft';
import { prepareThemeCssAsync } from '@/theme/css/prepareThemeCss';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import type { ThemeEditorView } from './themeProfileEditorViewTypes';
import { useThemeProfileEditorCss } from './useThemeProfileEditorCss';
vi.mock('react-native', async () => import('@/platform/shims/reactNativeWebShim'));

it('projects only demanded CSS facts and inserts after the confirmed engine buffer, preserving diagnostics', async () => {
    const draft = { ...createThemeProfileDraft({ id: 'css-editor', name: 'Ink', now: '2026-11-17T00:00:00.000Z' }),
        css: '[data-surface="sidebar"] { display: none; }\n.arbitrary { color: red; }\n@import url("https://example.com/theme.css");' };
    const parsed = parseThemeProfileDocument(draft);
    if (!parsed.ok) throw new Error(parsed.error);
    let buffer = draft.css + '\n/* buffered edit */';
    const onChange = vi.fn();
    const onViewChange = vi.fn();
    const onQueryChange = vi.fn();
    const setDecorations = vi.fn();
    // CodeEditor is a platform engine boundary; preserve the real CSS/editor projection beneath it.
    const editor: CodeEditorHandle = {
        getValue: () => buffer, flushPendingChange: async () => {}, revealLine: vi.fn(), runCommand: vi.fn(),
        subscribeHistory: () => () => {}, setDecorations, removeDecoration: vi.fn(), onDecorationPress: () => () => {},
    };
    const editorRef = { current: editor };
    let model!: ReturnType<typeof useThemeProfileEditorCss>;
    function Harness({ view, presented }: { view: ThemeEditorView; presented: boolean }) {
        model = useThemeProfileEditorCss({ draft, mode: 'light', view, presented, readonly: false,
            document: () => parsed.document, editorRef, onChange, onViewChange, onQueryChange });
        return null;
    }
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<Harness view="colors" presented />));
        expect(model.css.coverage).toBeUndefined();
        expect(model.css.surfaces).toBeUndefined();
        const painted = document.createElement('div');
        painted.dataset.surface = 'session-row'; painted.dataset.part = 'meta'; painted.dataset.state = 'default';
        host.append(painted);
        await act(async () => model.picker?.onToggle());
        await act(async () => painted.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(onViewChange).toHaveBeenCalledWith('colors');
        expect(onQueryChange).toHaveBeenCalledWith('');
        expect(model.pickedTokenIds).toEqual(['text.secondary']);
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        expect(model.picker?.active).toBe(false);
        expect(model.pickedTokenIds).toBeUndefined();
        await act(async () => { await prepareThemeCssAsync(draft.css); root.render(<Harness view="css" presented />); });
        expect(model.css.coverage).toEqual({ total: 2, native: 1, webOnly: 1 });
        expect(model.css.webOnlyRules).toEqual([{ line: 2, selector: '.arbitrary' }]);
        expect(model.css.surfaces?.some(surface => surface.id === 'sidebar')).toBe(true);
        expect(setDecorations.mock.lastCall?.[1]).toContainEqual(expect.objectContaining({ layer: 'diagnostic', startLine: 2 }));
        expect(setDecorations.mock.lastCall?.[1]).toContainEqual(expect.objectContaining({ severity: 'warning', startLine: 3 }));
        await act(async () => { await model.css.onInsertSelector('composer'); });
        expect(onChange).toHaveBeenCalledWith(buffer + '\n[data-surface="composer"] {\n  \n}\n');
        await act(async () => root.render(<Harness view="css" presented={false} />));
        expect(model.css.coverage).toBeUndefined();
        expect(model.css.surfaces).toBeUndefined();
        expect(setDecorations.mock.lastCall).toEqual(['diagnostic', []]);
    } finally { await act(async () => root.unmount()); host.remove(); }
});
