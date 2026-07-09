import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import type { BackendTargetRefV2 } from '@happier-dev/protocol';

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

    it('rejects stale persisted freeform models that do not match constrained provider prefixes', async () => {
        const geminiTarget = { kind: 'backend', backendId: 'gemini' } satisfies BackendTargetRefV2;
        const hook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'gemini',
            backendTargetKey: resolveBackendTargetKeyV2(geminiTarget),
            allowTargetlessDraftEngineSelection: false,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: {
                backendTarget: geminiTarget,
                modelId: 'gpt-5.5',
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
            },
            rememberedEngineSelection: null,
        }));

        expect(hook.getCurrent().modelMode).toBe(getAgentCore('gemini').model.defaultMode);
        expect(hook.getCurrent().modelMode).not.toBe('gpt-5.5');
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

    it('reconciles model and config state when the selected backend changes without picker setters', async () => {
        type Props = Parameters<typeof useNewSessionAgentAuthoringOptionsState>[0];
        const buildProps = (
            agentType: AgentId,
            rememberedEngineSelection: Props['rememberedEngineSelection'],
        ): Props => ({
            agentType,
            backendTargetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: agentType }),
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            rememberedEngineSelection,
        });

        const hook = await renderHook(
            (props: Props) => useNewSessionAgentAuthoringOptionsState(props),
            {
                initialProps: buildProps('codex', {
                    v: 1,
                    modelId: 'gpt-5.5',
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
                }),
            },
        );

        expect(hook.getCurrent().modelMode).toBe('gpt-5.5');
        expect(hook.getCurrent().acpSessionModeId).toBe('plan');
        expect(hook.getCurrent().sessionConfigOptionOverrides).not.toBeNull();

        await hook.rerender(buildProps('opencode', null));

        expect(hook.getCurrent().modelMode).toBe(getAgentCore('opencode').model.defaultMode);
        expect(hook.getCurrent().modelMode).not.toBe('gpt-5.5');
        expect(hook.getCurrent().acpSessionModeId).toBeNull();
        expect(hook.getCurrent().sessionConfigOptionOverrides).toBeNull();
    });

    it('ignores persisted draft engine state when the selected backend target differs', async () => {
        const codexTarget = { kind: 'backend', backendId: 'codex' } satisfies BackendTargetRefV2;
        const opencodeTarget = { kind: 'backend', backendId: 'opencode' } satisfies BackendTargetRefV2;
        const persistedCodexDraft = {
            backendTarget: codexTarget,
            modelId: 'gpt-5.5',
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
        } as const;

        const matchingHook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'codex',
            backendTargetKey: resolveBackendTargetKeyV2(codexTarget),
            allowTargetlessDraftEngineSelection: false,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: persistedCodexDraft,
            rememberedEngineSelection: null,
        }));

        expect(matchingHook.getCurrent().modelMode).toBe('gpt-5.5');
        expect(matchingHook.getCurrent().acpSessionModeId).toBe('plan');
        expect(matchingHook.getCurrent().sessionConfigOptionOverrides).toEqual(persistedCodexDraft.sessionConfigOptionOverrides);

        const mismatchedHook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'opencode',
            backendTargetKey: resolveBackendTargetKeyV2(opencodeTarget),
            allowTargetlessDraftEngineSelection: false,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: persistedCodexDraft,
            rememberedEngineSelection: null,
        }));

        expect(mismatchedHook.getCurrent().modelMode).toBe(getAgentCore('opencode').model.defaultMode);
        expect(mismatchedHook.getCurrent().modelMode).not.toBe('gpt-5.5');
        expect(mismatchedHook.getCurrent().acpSessionModeId).toBeNull();
        expect(mismatchedHook.getCurrent().sessionConfigOptionOverrides).toBeNull();
    });

    it('ignores targetless legacy draft engine state outside the draft agent backend target', async () => {
        const codexTarget = { kind: 'backend', backendId: 'codex' } satisfies BackendTargetRefV2;
        const geminiTarget = { kind: 'backend', backendId: 'gemini' } satisfies BackendTargetRefV2;
        const legacyCodexDraft = {
            agentId: 'codex',
            modelId: 'gpt-5.5',
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
        } as const;

        const matchingHook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'codex',
            backendTargetKey: resolveBackendTargetKeyV2(codexTarget),
            allowTargetlessDraftEngineSelection: true,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: legacyCodexDraft,
            rememberedEngineSelection: null,
        }));

        expect(matchingHook.getCurrent().modelMode).toBe('gpt-5.5');
        expect(matchingHook.getCurrent().acpSessionModeId).toBe('plan');

        const mismatchedHook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'gemini',
            backendTargetKey: resolveBackendTargetKeyV2(geminiTarget),
            allowTargetlessDraftEngineSelection: true,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: legacyCodexDraft,
            rememberedEngineSelection: {
                v: 1,
                modelId: 'gemini-2.5-pro',
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
                updatedAt: 456,
            },
        }));

        expect(mismatchedHook.getCurrent().modelMode).toBe('gemini-2.5-pro');
        expect(mismatchedHook.getCurrent().modelMode).not.toBe('gpt-5.5');
        expect(mismatchedHook.getCurrent().acpSessionModeId).toBeNull();
        expect(mismatchedHook.getCurrent().sessionConfigOptionOverrides).toBeNull();
    });

    it('reconciles mcp selection from target-scoped drafts when the selected backend changes', async () => {
        const claudeTarget = { kind: 'backend', backendId: 'claude' } satisfies BackendTargetRefV2;
        const codexTarget = { kind: 'backend', backendId: 'codex' } satisfies BackendTargetRefV2;
        const codexDraft = {
            backendTarget: codexTarget,
            modelId: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['server-codex'],
                forceExcludeServerIds: ['server-claude'],
            },
        } as const;
        type Props = Parameters<typeof useNewSessionAgentAuthoringOptionsState>[0];
        const buildProps = (
            agentType: AgentId,
            backendTarget: BackendTargetRefV2,
        ): Props => ({
            agentType,
            backendTargetKey: resolveBackendTargetKeyV2(backendTarget),
            allowTargetlessDraftEngineSelection: false,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: codexDraft,
            rememberedEngineSelection: null,
        });

        const hook = await renderHook(
            (props: Props) => useNewSessionAgentAuthoringOptionsState(props),
            { initialProps: buildProps('claude', claudeTarget) },
        );

        expect(hook.getCurrent().mcpSelection).toEqual({
            v: 1,
            managedServersEnabled: true,
            forceIncludeServerIds: [],
            forceExcludeServerIds: [],
        });

        await hook.rerender(buildProps('codex', codexTarget));

        expect(hook.getCurrent().mcpSelection).toEqual(codexDraft.mcpSelection);
    });
});
