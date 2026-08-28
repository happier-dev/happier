import { describe, expect, it } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import { act } from 'react-test-renderer';

describe('useNewSessionPromptAutomationState', () => {
    it('keeps a forced automation route enabled when Expo supplies empty seed params', async () => {
        const { useNewSessionPromptAutomationState } = await import('./useNewSessionPromptAutomationState');

        const hook = await renderHook(() => useNewSessionPromptAutomationState({
            prompt: undefined,
            dataId: undefined,
            automationParam: '1',
            automationFeatureEnabled: true,
            persistedDraftEntryIntent: null,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
        }));

        await flushHookEffects({ cycles: 2, turns: 1 });

        expect(hook.getCurrent().automationDraft.enabled).toBe(true);
    });

    it('does not treat empty automation seed params as explicit seeds (does not override user toggles)', async () => {
        const { useNewSessionPromptAutomationState } = await import('./useNewSessionPromptAutomationState');

        const hook = await renderHook(() => useNewSessionPromptAutomationState({
            prompt: undefined,
            dataId: undefined,
            automationParam: undefined,
            automationFeatureEnabled: true,
            persistedDraftEntryIntent: null,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
        }));

        expect(hook.getCurrent().automationDraft.enabled).toBe(false);

        await act(async () => {
            hook.getCurrent().setAutomationDraft((prev) => ({ ...prev, enabled: true }));
        });
        await flushHookEffects({ cycles: 2, turns: 1 });

        expect(hook.getCurrent().automationDraft.enabled).toBe(true);
    });

    it('keeps live user-typed prompt text when hydrated persisted draft state refreshes later', async () => {
        const { useNewSessionPromptAutomationState } = await import('./useNewSessionPromptAutomationState');

        let hydratedPersistedAuthoringDraft: { displayText?: string | null; automation?: unknown } | null = {
            displayText: 'restored draft text',
            automation: null,
        };

        const hook = await renderHook(() => useNewSessionPromptAutomationState({
            prompt: undefined,
            dataId: undefined,
            automationParam: undefined,
            automationFeatureEnabled: true,
            persistedDraftEntryIntent: null,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft,
        }));

        expect(hook.getCurrent().promptStore.getPrompt()).toBe('restored draft text');

        // User keeps typing on top of the restored draft.
        await act(async () => {
            hook.getCurrent().setSessionPrompt('restored draft text plus live typing');
        });
        await flushHookEffects({ cycles: 2, turns: 1 });
        expect(hook.getCurrent().promptStore.getPrompt()).toBe('restored draft text plus live typing');

        // A stale persisted-draft snapshot (e.g. debounced auto-persist echo, focus reload,
        // or a second mounted new-session screen writing the shared scope key) re-hydrates.
        // It must NOT clobber the user's live text.
        hydratedPersistedAuthoringDraft = {
            displayText: 'restored draft text plus',
            automation: null,
        };

        await hook.rerender();
        await flushHookEffects({ cycles: 2, turns: 1 });
        expect(hook.getCurrent().promptStore.getPrompt()).toBe('restored draft text plus live typing');
    });

    it('still applies late async draft hydration when the user has not typed yet', async () => {
        const { useNewSessionPromptAutomationState } = await import('./useNewSessionPromptAutomationState');

        let hydratedPersistedAuthoringDraft: { displayText?: string | null; automation?: unknown } | null = null;

        const hook = await renderHook(() => useNewSessionPromptAutomationState({
            prompt: undefined,
            dataId: undefined,
            automationParam: undefined,
            automationFeatureEnabled: true,
            persistedDraftEntryIntent: null,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft,
        }));

        expect(hook.getCurrent().promptStore.getPrompt()).toBe('');

        hydratedPersistedAuthoringDraft = {
            displayText: 'late loaded draft',
            automation: null,
        };

        await hook.rerender();
        await flushHookEffects({ cycles: 2, turns: 1 });
        expect(hook.getCurrent().promptStore.getPrompt()).toBe('late loaded draft');
    });

    it('keeps a user-enabled automation draft when hydrated persisted draft state refreshes later', async () => {
        const { useNewSessionPromptAutomationState } = await import('./useNewSessionPromptAutomationState');

        let hydratedPersistedAuthoringDraft: { displayText?: string | null; automation?: unknown } | null = {
            displayText: '',
            automation: null,
        };

        const hook = await renderHook(() => useNewSessionPromptAutomationState({
            prompt: undefined,
            dataId: undefined,
            automationParam: undefined,
            automationFeatureEnabled: true,
            persistedDraftEntryIntent: null,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft,
        }));

        expect(hook.getCurrent().automationDraft.enabled).toBe(false);

        await act(async () => {
            hook.getCurrent().setAutomationDraft((prev) => ({ ...prev, enabled: true }));
        });
        await flushHookEffects({ cycles: 2, turns: 1 });
        expect(hook.getCurrent().automationDraft.enabled).toBe(true);

        hydratedPersistedAuthoringDraft = {
            displayText: '',
            automation: null,
        };

        await hook.rerender();
        expect(hook.getCurrent().automationDraft.enabled).toBe(true);
    });
});
