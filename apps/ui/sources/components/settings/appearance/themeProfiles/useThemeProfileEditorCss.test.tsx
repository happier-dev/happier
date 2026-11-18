/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createThemeProfileDraft } from '@/theme/profiles/createThemeProfileDraft';
import { prepareThemeCssAsync } from '@/theme/css/prepareThemeCss';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import type { ThemeEditorView } from './themeProfileEditorViewTypes';
import { useThemeProfileEditorCss } from './useThemeProfileEditorCss';
import { t } from '@/text';
vi.mock('react-native', async () => import('@/platform/shims/reactNativeWebShim'));

it('projects only demanded CSS facts and inserts after the confirmed engine buffer, preserving diagnostics', async () => {
    const draft = { ...createThemeProfileDraft({ id: 'css-editor', name: 'Ink', now: '2026-11-17T00:00:00.000Z' }), name: '',
        css: '[data-surface="sidebar"] { display: none; }\n.arbitrary { color: red; }\n@import url("https://example.com/theme.css");' };
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
            editorRef, onChange, onViewChange, onQueryChange });
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

it('preserves fixed and derived paint provenance without inventing editable colors', async () => {
    const draft = { ...createThemeProfileDraft({ id: 'pick-provenance', name: 'Ink', now: '2026-11-17T00:00:00.000Z' }),
        overrides: { light: { 'message.user.background': '#303030' }, dark: {} } };
    let model!: ReturnType<typeof useThemeProfileEditorCss>;
    function Harness() {
        model = useThemeProfileEditorCss({ draft, mode: 'light', view: 'colors', presented: true, readonly: false,
            editorRef: { current: null },
            onChange: vi.fn(), onViewChange: vi.fn(), onQueryChange: vi.fn() });
        return null;
    }
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const pick = async (surface: string, part: string, state = 'default') => {
        const painted = document.createElement('div');
        painted.dataset.surface = surface; painted.dataset.part = part; painted.dataset.state = state;
        host.append(painted);
        await act(async () => painted.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        painted.remove();
    };
    try {
        await act(async () => root.render(<Harness />));
        await act(async () => model.picker?.onToggle());
        await pick('session-row', 'meta');
        expect(model.pickedTokenIds).toEqual(['text.secondary']);
        const { THEME_PROFILE_TOKEN_DEFINITIONS_BY_ID: tokens } = await import('@/theme/profiles/themeProfileTokenRegistry');
        const label = (id: string) => tokens[id]!.labelKey ? t(tokens[id]!.labelKey!) : tokens[id]!.label;
        expect(model.picker?.target?.roleLabel).toBe(label('text.secondary'));
        await pick('button', 'icon', 'selected');
        expect.soft(model.picker?.target?.roleLabel).toBe(t('settingsAppearance.themeProfiles.pickFixedColor'));
        expect.soft(model.pickedTokenIds).toBeUndefined();
        await pick('user-bubble', 'root');
        expect(model.pickedTokenIds).toEqual(['message.user.background', 'surface.selected']);
        expect(model.picker?.target?.roleLabel).toBe(t('settingsAppearance.themeProfiles.pickDerivedFrom', {
            roles: ['message.user.background', 'surface.selected'].map(label).join(' · '),
        }));
    } finally { await act(async () => root.unmount()); host.remove(); }
});
