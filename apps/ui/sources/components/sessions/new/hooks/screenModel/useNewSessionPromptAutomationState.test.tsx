import { describe, expect, it } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import { act } from 'react-test-renderer';

describe('useNewSessionPromptAutomationState', () => {
    it('does not treat empty automation seed params as explicit seeds (does not override user toggles)', async () => {
        const { useNewSessionPromptAutomationState } = await import('./useNewSessionPromptAutomationState');

        const hook = await renderHook(() => useNewSessionPromptAutomationState({
            prompt: undefined,
            dataId: undefined,
            automationParam: undefined,
            // Expo Router can provide present-but-empty params (e.g. `?automationEnabled=`). These must
            // not be treated as explicit seeds that override local user state.
            automationEnabledParam: '',
            automationNameParam: undefined,
            automationDescriptionParam: undefined,
            automationScheduleKindParam: undefined,
            automationEveryMinutesParam: undefined,
            automationCronExprParam: undefined,
            automationTimezoneParam: undefined,
            automationEditIdParam: undefined,
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
            automationEnabledParam: undefined,
            automationNameParam: undefined,
            automationDescriptionParam: undefined,
            automationScheduleKindParam: undefined,
            automationEveryMinutesParam: undefined,
            automationCronExprParam: undefined,
            automationTimezoneParam: undefined,
            automationEditIdParam: undefined,
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
