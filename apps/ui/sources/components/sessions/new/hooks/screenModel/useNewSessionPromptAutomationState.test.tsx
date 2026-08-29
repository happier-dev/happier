import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import { act } from 'react-test-renderer';

// Live source-turn truth for the injected exact-turn reader.
const liveCurrentTurn = vi.hoisted(() => ({ value: 'turn-7' }));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            sessions: {
                'source-session': {
                    id: 'source-session',
                    serverId: 'server-1',
                    latestTurnId: liveCurrentTurn.value,
                    latestTurnStatus: 'in_progress',
                },
            },
        }),
    },
}));

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

    it('applies an explicit exact-turn retarget through the incumbent draft owner, preserving all other fields', async () => {
        const { useNewSessionPromptAutomationState } = await import('./useNewSessionPromptAutomationState');

        const seedDraft = {
            pendingAutomationId: 'pending-1',
            enabled: true,
            name: 'Drafted name',
            description: 'Drafted description',
            triggers: [
                {
                    clientId: 'schedule-row',
                    definition: {
                        kind: 'schedule',
                        enabled: true,
                        schedule: { kind: 'interval', scheduleExpr: null, everyMs: 60_000, timezone: null },
                    },
                },
                {
                    clientId: 'turn-row',
                    definition: {
                        kind: 'sessionLifecycle',
                        enabled: true,
                        event: 'parentTurnCompleted',
                        scope: { kind: 'exactTurn', sourceSessionId: 'source-session', sourceTurnId: 'turn-7' },
                        consumption: 'once',
                    },
                },
            ],
        } as const;
        let exactTurnRetargetRequest: {
            sourceSessionId: string;
            sourceTurnId: string;
            sourceServerId: string;
        } | null = null;
        const readExactTurn = (sourceSessionId: string) => (
            sourceSessionId === 'source-session'
                ? { sourceSessionId, sourceTurnId: liveCurrentTurn.value, sourceServerId: 'server-1' }
                : null
        );

        const hook = await renderHook(() => useNewSessionPromptAutomationState({
            prompt: undefined,
            dataId: undefined,
            automationParam: undefined,
            automationFeatureEnabled: true,
            persistedDraftEntryIntent: null,
            hydratedTempAuthoringDraft: { automation: seedDraft },
            hydratedPersistedAuthoringDraft: null,
            exactTurnRetargetRequest,
            readExactTurn,
        }));
        await flushHookEffects({ cycles: 2, turns: 1 });

        expect(hook.getCurrent().automationDraft.triggers[1]).toMatchObject({
            definition: { scope: { kind: 'exactTurn', sourceTurnId: 'turn-7' } },
        });

        // The user explicitly adopts the advanced current turn.
        liveCurrentTurn.value = 'turn-8';
        exactTurnRetargetRequest = {
            sourceSessionId: 'source-session',
            sourceTurnId: 'turn-8',
            sourceServerId: 'server-1',
        };
        await hook.rerender();
        await flushHookEffects({ cycles: 2, turns: 1 });

        const draft = hook.getCurrent().automationDraft;
        expect(draft.triggers[1]).toMatchObject({
            definition: { scope: { kind: 'exactTurn', sourceSessionId: 'source-session', sourceTurnId: 'turn-8' } },
        });
        // Every unrelated draft field and row survived the retarget untouched.
        expect(draft.name).toBe('Drafted name');
        expect(draft.description).toBe('Drafted description');
        expect(draft.enabled).toBe(true);
        expect(draft.triggers[0]).toMatchObject({ clientId: 'schedule-row', definition: { enabled: true } });

        // Without a new explicit request, a later live-turn advance never
        // retargets the draft silently.
        liveCurrentTurn.value = 'turn-9';
        await hook.rerender();
        await flushHookEffects({ cycles: 2, turns: 1 });
        expect(hook.getCurrent().automationDraft.triggers[1]).toMatchObject({
            definition: { scope: { sourceTurnId: 'turn-8' } },
        });
    });
});
