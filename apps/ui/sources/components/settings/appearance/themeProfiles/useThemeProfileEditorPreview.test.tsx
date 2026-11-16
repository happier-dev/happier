import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { mergeThemeProfileDocumentEdit, parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import type { ThemeEditorDraft } from './themeProfileEditorActions';
import { createThemeProfileDraft } from '@/theme/profiles/createThemeProfileDraft';
import { createThemeActionHarness } from '@/dev/testkit/harness/themeActionHarness';
import { useThemeProfileEditorPreview } from './useThemeProfileEditorPreview';

afterEach(() => { standardCleanup(); vi.useRealTimers(); });

function fixture() {
    const parsed = parseThemeProfileDocument(createThemeProfileDraft({ id: 'draft', name: 'Draft', now: '2026-11-16T12:00:00.000Z' }));
    if (!parsed.ok) throw new Error(parsed.error);
    const document = parsed.document;
    const { owner, writes } = createThemeActionHarness();
    let previews = 0;
    const preview = async (input: ThemeEditorDraft) => {
        previews++;
        const active = owner.begin({ document: input.document, mode: input.mode, origin: { kind: 'editor' } });
        return { previewRef: active.previewRef, compatibility: document.compatibility,
            coverage: { total: 0, native: 0, webOnly: 0, affectedSurfaces: [], hides: [] } };
    };
    return { document, owner, preview, writes, previews: () => previews };
}

describe('useThemeProfileEditorPreview', () => {
    it('publishes once after the existing settle delay, then reverts its preview on unmount without persistence', async () => {
        vi.useFakeTimers();
        const state = fixture();
        const hook = await renderHook(() => useThemeProfileEditorPreview({ owner: state.owner,
            draft: { document: state.document, draft: state.document.profile, mode: 'light' }, preview: state.preview,
            onFailure: error => { throw error; } }));
        expect(state.owner.read()).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        expect(state.owner.read()?.document).toBe(state.document);
        expect(state.previews()).toBe(1);
        await hook.unmount();
        expect(state.owner.read()).toBeNull();
        expect(state.writes()).toBe(0);
    });

    it('leaves a replacement from another surface active when this editor unmounts', async () => {
        vi.useFakeTimers();
        const state = fixture();
        const hook = await renderHook(() => useThemeProfileEditorPreview({ owner: state.owner,
            draft: { document: state.document, draft: state.document.profile, mode: 'light' }, preview: state.preview,
            onFailure: error => { throw error; } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        const replacement = state.owner.begin({ document: state.document, mode: 'dark', origin: { kind: 'agent' } });
        await hook.unmount();
        expect(state.owner.read()).toBe(replacement);
        expect(state.writes()).toBe(0);
    });

    it('does not republish for an unrelated editor render but publishes one changed draft', async () => {
        vi.useFakeTimers();
        const state = fixture();
        const onFailure = (error: unknown) => { throw error; };
        const hook = await renderHook(({ document }) => useThemeProfileEditorPreview({ owner: state.owner,
            draft: { document, draft: document.profile, mode: 'light' }, preview: state.preview, onFailure }),
        { initialProps: { document: state.document } });
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        expect(state.previews()).toBe(1);
        await hook.rerender();
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        expect(state.previews()).toBe(1);
        const changed = mergeThemeProfileDocumentEdit(state.document, { name: 'Changed draft' });
        await hook.rerender({ document: changed });
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        expect(state.previews()).toBe(2);
        expect(state.owner.read()?.document?.profile.name).toBe('Changed draft');
        await hook.unmount();
    });
});
