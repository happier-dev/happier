import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { useNewSessionAgentAuthoringOptionsState } from './useNewSessionAgentAuthoringOptionsState';

describe('useNewSessionAgentAuthoringOptionsState', () => {
    it('seeds model, session mode, and config options from a remembered engine selection when no draft exists', async () => {
        const hook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'claude',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            rememberedEngineSelection: {
                v: 1,
                modelId: 'claude-sonnet-4-5',
                acpSessionModeId: 'plan',
                sessionConfigOptionOverrides: {
                    v: 1,
                    updatedAt: 123,
                    overrides: {
                        reasoning_effort: {
                            updatedAt: 123,
                            value: 'high',
                        },
                    },
                },
                updatedAt: 123,
            },
        } as any));

        expect(hook.getCurrent().modelMode).toBe('claude-sonnet-4-5');
        expect(hook.getCurrent().acpSessionModeId).toBe('plan');
        expect(hook.getCurrent().sessionConfigOptionOverrides).toEqual({
            v: 1,
            updatedAt: 123,
            overrides: {
                reasoning_effort: {
                    updatedAt: 123,
                    value: 'high',
                },
            },
        });
    });

    it('seeds a remembered dynamic backend model even when the static catalog is stale', async () => {
        const hook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'codex',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            rememberedEngineSelection: {
                v: 1,
                modelId: 'gpt-5.5',
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
                updatedAt: 123,
            },
        } as any));

        expect(hook.getCurrent().modelMode).toBe('gpt-5.5');
    });

    it('keeps explicit persisted draft values ahead of remembered engine selections', async () => {
        const hook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'claude',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: {
                modelId: 'persisted-model',
                acpSessionModeId: 'persisted-mode',
                sessionConfigOptionOverrides: {
                    v: 1,
                    updatedAt: 456,
                    overrides: {
                        speed: {
                            updatedAt: 456,
                            value: 'fast',
                        },
                    },
                },
            },
            rememberedEngineSelection: {
                v: 1,
                modelId: 'remembered-model',
                acpSessionModeId: 'remembered-mode',
                sessionConfigOptionOverrides: {
                    v: 1,
                    updatedAt: 123,
                    overrides: {
                        reasoning_effort: {
                            updatedAt: 123,
                            value: 'high',
                        },
                    },
                },
                updatedAt: 123,
            },
        } as any));

        expect(hook.getCurrent().modelMode).toBe('persisted-model');
        expect(hook.getCurrent().acpSessionModeId).toBe('persisted-mode');
        expect(hook.getCurrent().sessionConfigOptionOverrides).toEqual({
            v: 1,
            updatedAt: 456,
            overrides: {
                speed: {
                    updatedAt: 456,
                    value: 'fast',
                },
            },
        });
    });
});
