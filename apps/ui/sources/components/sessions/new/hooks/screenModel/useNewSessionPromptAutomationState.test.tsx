import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { SessionInitialTriggerV1Schema } from '@happier-dev/protocol';

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
    it('keeps authored initial triggers over stale hydration and replaces them on draft reentry', async () => {
        const { useNewSessionPromptAutomationState } = await import('./useNewSessionPromptAutomationState');
        const original = SessionInitialTriggerV1Schema.array().parse([{
            trigger: { kind: 'sessionLifecycle', enabled: true, events: ['sessionStarted'], policy: { kind: 'everyMatch' } },
            target: { kind: 'workflow', ref: 'builtin:review-and-converge' },
        }]);
        let hydratedPersistedAuthoringDraft = { initialTriggers: original };
        let initialTriggersDraftKey = 'account-a:draft-a';
        const hook = await renderHook(() => useNewSessionPromptAutomationState({
            prompt: undefined, dataId: undefined, automationParam: undefined, persistedDraftEntryIntent: 'session',
            hydratedTempAuthoringDraft: null, hydratedPersistedAuthoringDraft, initialTriggersDraftKey,
        }));
        expect(hook.getCurrent().initialTriggers).toEqual(original);
        await act(async () => hook.getCurrent().setInitialTriggers([]));
        hydratedPersistedAuthoringDraft = { initialTriggers: original.map((entry) => ({ ...entry })) };
        await hook.rerender();
        expect(hook.getCurrent().initialTriggers).toEqual([]);
        initialTriggersDraftKey = 'account-b:draft-b';
        await hook.rerender();
        expect(hook.getCurrent().initialTriggers).toEqual(original);
    });
    it('never manufactures a fresh Automation draft from the route flag alone', async () => {
        // Creating an Automation is the shared wrapper's journey. A URL that
        // switched New Session into an Automation entry point produced a second
        // authoring surface with its own controls, validation and direct write.
        const { useNewSessionPromptAutomationState } = await import('./useNewSessionPromptAutomationState');

        const hook = await renderHook(() => useNewSessionPromptAutomationState({
            prompt: undefined,
            dataId: undefined,
            automationParam: '1',
            persistedDraftEntryIntent: null,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
        }));

        await flushHookEffects({ cycles: 2, turns: 1 });

        expect(hook.getCurrent().automationDraft.enabled).toBe(false);
    });

    /**
     * New Session does not write Automations. A draft saved before creation
     * moved to the shared Automation editor still hydrates with an enabled
     * inline Automation; that work is handed, once, to the shared editor, and
     * New Session keeps the prompt as an ordinary draft.
     */
    it('hands a hydrated pre-change Automation draft to the shared editor once', async () => {
        const { useNewSessionPromptAutomationState } = await import('./useNewSessionPromptAutomationState');
        const trigger = {
            clientId: 'nightly-schedule',
            definition: {
                kind: 'schedule' as const,
                enabled: true,
                schedule: { kind: 'interval' as const, everyMs: 3_600_000, scheduleExpr: null, timezone: null },
            },
        };
        const handOffLegacyAutomation = vi.fn();

        const hook = await renderHook(() => useNewSessionPromptAutomationState({
            prompt: undefined,
            dataId: undefined,
            automationParam: undefined,
            persistedDraftEntryIntent: 'session',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: {
                automation: { enabled: true, name: 'Nightly notes', description: 'Every night', triggers: [trigger] },
            },
            handOffLegacyAutomation,
        }));
        await flushHookEffects({ cycles: 2, turns: 1 });

        expect(handOffLegacyAutomation).toHaveBeenCalledTimes(1);
        expect(handOffLegacyAutomation).toHaveBeenCalledWith(expect.objectContaining({
            enabled: true,
            name: 'Nightly notes',
            description: 'Every night',
            triggers: [trigger],
        }));
        expect(hook.getCurrent().automationDraft.enabled).toBe(false);

        await hook.rerender();
        await flushHookEffects({ cycles: 2, turns: 1 });
        expect(handOffLegacyAutomation).toHaveBeenCalledTimes(1);
    });

    it('sends an old /new?automation=1 link to the shared editor, and leaves ordinary drafts alone', async () => {
        const { useNewSessionPromptAutomationState } = await import('./useNewSessionPromptAutomationState');
        const routeHandOff = vi.fn();
        await renderHook(() => useNewSessionPromptAutomationState({
            prompt: undefined,
            dataId: undefined,
            automationParam: '1',
            persistedDraftEntryIntent: null,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            handOffLegacyAutomation: routeHandOff,
        }));
        await flushHookEffects({ cycles: 2, turns: 1 });
        expect(routeHandOff).toHaveBeenCalledTimes(1);
        expect(routeHandOff).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));

        const ordinaryHandOff = vi.fn();
        await renderHook(() => useNewSessionPromptAutomationState({
            prompt: undefined,
            dataId: undefined,
            automationParam: undefined,
            persistedDraftEntryIntent: null,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            handOffLegacyAutomation: ordinaryHandOff,
        }));
        await flushHookEffects({ cycles: 2, turns: 1 });
        expect(ordinaryHandOff).not.toHaveBeenCalled();
    });

    it('still hydrates a genuinely persisted pre-change Automation draft', async () => {
        // Without an available hand-off (Automations unavailable) the persisted
        // draft is kept, not discarded, so the work survives until it can move.
        const { useNewSessionPromptAutomationState } = await import('./useNewSessionPromptAutomationState');

        const hook = await renderHook(() => useNewSessionPromptAutomationState({
            prompt: undefined,
            dataId: undefined,
            automationParam: '1',
            persistedDraftEntryIntent: 'automation',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: {
                automation: { enabled: true, name: 'Nightly notes', description: '', triggers: [] },
            },
        }));

        await flushHookEffects({ cycles: 2, turns: 1 });

        expect(hook.getCurrent().automationDraft.enabled).toBe(true);
        expect(hook.getCurrent().automationDraft.name).toBe('Nightly notes');
    });

    it('does not treat empty automation seed params as explicit seeds (does not override user toggles)', async () => {
        const { useNewSessionPromptAutomationState } = await import('./useNewSessionPromptAutomationState');

        const hook = await renderHook(() => useNewSessionPromptAutomationState({
            prompt: undefined,
            dataId: undefined,
            automationParam: undefined,
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
                        sourceSessionId: 'source-session',
                        events: ['parentTurnCompleted'],
                        policy: { kind: 'currentTurn', sourceTurnId: 'turn-7' },
                    },
                },
            ],
        } as const;
        let exactTurnRetargetRequest: {
            sourceSessionId: string;
            sourceTurnId: string;
            sourceServerId: string;
            events: readonly ['parentTurnCompleted'];
        } | null = null;
        const readExactTurn = (sourceSessionId: string) => (
            sourceSessionId === 'source-session'
                ? {
                    sourceSessionId,
                    sourceTurnId: liveCurrentTurn.value,
                    sourceServerId: 'server-1',
                    events: ['parentTurnCompleted'] as const,
                }
                : null
        );

        const hook = await renderHook(() => useNewSessionPromptAutomationState({
            prompt: undefined,
            dataId: undefined,
            automationParam: undefined,
            persistedDraftEntryIntent: null,
            hydratedTempAuthoringDraft: { automation: seedDraft },
            hydratedPersistedAuthoringDraft: null,
            exactTurnRetargetRequest,
            readExactTurn,
        }));
        await flushHookEffects({ cycles: 2, turns: 1 });

        expect(hook.getCurrent().automationDraft.triggers[1]).toMatchObject({
            definition: { policy: { kind: 'currentTurn', sourceTurnId: 'turn-7' } },
        });

        // The user explicitly adopts the advanced current turn.
        liveCurrentTurn.value = 'turn-8';
        exactTurnRetargetRequest = {
            sourceSessionId: 'source-session',
            sourceTurnId: 'turn-8',
            sourceServerId: 'server-1',
            events: ['parentTurnCompleted'],
        };
        await hook.rerender();
        await flushHookEffects({ cycles: 2, turns: 1 });

        const draft = hook.getCurrent().automationDraft;
        expect(draft.triggers[1]).toMatchObject({
            definition: {
                sourceSessionId: 'source-session',
                policy: { kind: 'currentTurn', sourceTurnId: 'turn-8' },
            },
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
            definition: { policy: { sourceTurnId: 'turn-8' } },
        });
    });
});
