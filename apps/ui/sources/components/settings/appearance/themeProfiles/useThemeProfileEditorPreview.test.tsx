import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { mergeThemeProfileDocumentEdit, parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import type { ThemeEditorDraft } from './themeProfileEditorActions';
import { createThemeProfileDraft } from '@/theme/profiles/createThemeProfileDraft';
import { createThemeActionHarness } from '@/dev/testkit/harness/themeActionHarness';
import { useThemeProfileEditorPreview } from './useThemeProfileEditorPreview';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

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
    it('cancels a hidden editor settle and publishes only the latest draft when presented again', async () => {
        vi.useFakeTimers();
        const state = fixture();
        let presented = true;
        const onFailure = (error: unknown) => { throw error; };
        const wrapper = ({ children }: React.PropsWithChildren) => <PluginSurfaceFocusEligibilityProvider active={presented}>
            {children}
        </PluginSurfaceFocusEligibilityProvider>;
        const hook = await renderHook(({ document }) => useThemeProfileEditorPreview({ owner: state.owner,
            draft: { document, draft: document.profile, mode: 'light' }, preview: state.preview, onFailure }),
        { initialProps: { document: state.document }, wrapper });
        presented = false;
        await hook.rerender();
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        expect(state.previews()).toBe(0);
        let latest = state.document;
        for (let index = 0; index < 10; index++) {
            latest = mergeThemeProfileDocumentEdit(state.document, { name: `Hidden draft ${index}` });
            await hook.rerender({ document: latest });
        }
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        expect(state.previews()).toBe(0);
        presented = true;
        await hook.rerender();
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        expect(state.previews()).toBe(1);
        expect(state.owner.read()?.document).toBe(latest);
        expect(state.writes()).toBe(0);
        await hook.unmount();
        expect(state.owner.read()).toBeNull();
    });

    it('publishes once after the existing settle delay, then reverts its preview on unmount without persistence', async () => {
        vi.useFakeTimers();
        const state = fixture();
        const hook = await renderHook(() => useThemeProfileEditorPreview({ owner: state.owner,
            draft: { document: state.document, draft: state.document.profile, mode: 'light' }, preview: state.preview,
            onFailure: error => { throw error; } }));
        expect(state.owner.read()).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        expect(state.owner.read()?.document).toBe(state.document);
        expect(state.owner.readGlobalPresentation()).toBeNull();
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
        expect(state.owner.readGlobalPresentation()).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        expect(state.previews()).toBe(2);
        expect(state.owner.read()?.document?.profile.name).toBe('Changed draft');
        await hook.unmount();
    });

    it('reverts its preview when a pending Action resolves after the editor unmounts', async () => {
        vi.useFakeTimers();
        const state = fixture();
        // The mounted Action boundary can wait for library readiness before
        // publishing its preview and acknowledging the receipt.
        const admitted = createDeferred<void>();
        const preview = async (input: ThemeEditorDraft) => {
            await admitted.promise;
            return state.preview(input);
        };
        const hook = await renderHook(() => useThemeProfileEditorPreview({ owner: state.owner,
            draft: { document: state.document, draft: state.document.profile, mode: 'light' }, preview,
            onFailure: error => { throw error; } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        await hook.unmount();
        await act(async () => { admitted.resolve(); await admitted.promise; });
        expect(state.previews()).toBe(1);
        expect(state.owner.read()).toBeNull();
        expect(state.writes()).toBe(0);
    });

    it('reports a failed preview only while its editor draft remains presented', async () => {
        vi.useFakeTimers();
        const state = fixture();
        const previousAction = createDeferred<Awaited<ReturnType<typeof state.preview>>>();
        const currentAction = createDeferred<Awaited<ReturnType<typeof state.preview>>>();
        const dismissedFailure = new Error('Preview rejected after leaving the editor');
        const currentFailure = new Error('Preview rejected while the editor is open');
        let presented = true;
        const onFailure = vi.fn();
        const preview = vi.fn()
            .mockReturnValueOnce(previousAction.promise)
            .mockReturnValueOnce(currentAction.promise);
        const wrapper = ({ children }: React.PropsWithChildren) => (
            <PluginSurfaceFocusEligibilityProvider active={presented}>
                {children}
            </PluginSurfaceFocusEligibilityProvider>
        );
        const hook = await renderHook(() => useThemeProfileEditorPreview({ owner: state.owner,
            draft: { document: state.document, draft: state.document.profile, mode: 'light' },
            preview, onFailure }), { wrapper });
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        presented = false;
        await hook.rerender();
        await act(async () => { previousAction.reject(dismissedFailure); });
        expect(onFailure).not.toHaveBeenCalled();

        presented = true;
        await hook.rerender();
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        await act(async () => { currentAction.reject(currentFailure); });
        expect(onFailure).toHaveBeenCalledExactlyOnceWith(currentFailure);
        await hook.unmount();
    });

    it('preserves a newer shared preview when its stale Action receipt arrives after unmount', async () => {
        vi.useFakeTimers();
        const state = fixture();
        // The Action has applied this effect, but its acknowledgement is still
        // crossing the async execution boundary.
        const acknowledgement = createDeferred<void>();
        const preview = async (input: ThemeEditorDraft) => {
            const result = await state.preview(input);
            await acknowledgement.promise;
            return result;
        };
        const hook = await renderHook(() => useThemeProfileEditorPreview({ owner: state.owner,
            draft: { document: state.document, draft: state.document.profile, mode: 'light' }, preview,
            onFailure: error => { throw error; } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        await hook.unmount();
        const replacement = state.owner.begin({ document: state.document, mode: 'dark', origin: { kind: 'agent' } });
        await act(async () => { acknowledgement.resolve(); await acknowledgement.promise; });
        expect(state.owner.read()).toBe(replacement);
        expect(state.writes()).toBe(0);
    });
});
