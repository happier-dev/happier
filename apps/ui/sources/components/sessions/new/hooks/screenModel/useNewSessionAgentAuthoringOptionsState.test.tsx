import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol';

import { useNewSessionAgentAuthoringOptionsState } from './useNewSessionAgentAuthoringOptionsState';

function nativeSelection(agentTargetKey: string, modelId: string, updatedAt: number) {
    return SessionModelSelectionV1Schema.parse({
        v: 1,
        updatedAt,
        ref: { agentTargetKey, providerConnectionId: null, modelId },
    });
}

describe('useNewSessionAgentAuthoringOptionsState', () => {
    it('reconciles config overrides for a backend target switch without a passive follow-up commit', async () => {
        const commitPhases: string[] = [];
        const wrapper = (props: React.PropsWithChildren) => (
            <React.Profiler
                id="authoring-options"
                onRender={(_id, phase) => {
                    commitPhases.push(phase);
                }}
            >
                {props.children}
            </React.Profiler>
        );
        const buildProps = (agentType: AgentId, value: string | null) => ({
            agentType,
            backendTargetKey: `agent:happier.agent.${agentType}/${agentType}`,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: value === null ? null : {
                agentTarget: {
                    kind: 'agent' as const,
                    identity: { pluginId: `happier.agent.${agentType}`, localId: agentType },
                },
                sessionConfigOptionOverrides: {
                    v: 1 as const,
                    updatedAt: 123,
                    overrides: {
                        service_tier: { updatedAt: 123, value },
                    },
                },
            },
            rememberedEngineSelection: null,
        });
        const hook = await renderHook(
            (props: ReturnType<typeof buildProps>) => useNewSessionAgentAuthoringOptionsState(props),
            { initialProps: buildProps('codex', 'fast'), wrapper },
        );
        commitPhases.length = 0;

        await hook.rerender(buildProps('opencode', null));

        expect(commitPhases).toEqual(['update']);
        expect(hook.getCurrent().sessionConfigOptionOverrides).toBeNull();
    });

    it('keeps an unbacked external Agent model control neutral', async () => {
        const hook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'acme.review.backend',
            backendTargetKey: 'backend:acme.review.backend',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            rememberedEngineSelection: null,
        }));

        expect(hook.getCurrent().modelMode).toBe('default');
        expect(hook.getCurrent().modelSelection).toBeNull();
    });

    it('preserves a provider-bound draft selection instead of reconstructing it as native', async () => {
        const modelSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 123,
            ref: {
                agentTargetKey: 'agent:happier.agent.claude/claude',
                providerConnectionId: 'pc_01J00000000000000000000000',
                modelId: 'provider/claude-sonnet',
            },
        });
        const hook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'claude',
            backendTargetKey: 'agent:happier.agent.claude/claude',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                modelSelection,
            },
            rememberedEngineSelection: null,
        }));

        expect(hook.getCurrent().modelMode).toBe('provider/claude-sonnet');
        expect(hook.getCurrent().modelSelection).toEqual(modelSelection);
    });

    it('preserves a provider-bound model literally named default instead of treating it as Automatic', async () => {
        const modelSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 123,
            ref: {
                agentTargetKey: 'agent:happier.agent.opencode/opencode',
                providerConnectionId: 'pc_01J00000000000000000000000',
                modelId: 'default',
            },
        });
        const hook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'opencode',
            backendTargetKey: 'agent:happier.agent.opencode/opencode',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' } },
                modelSelection,
            },
            rememberedEngineSelection: null,
        }));

        expect(hook.getCurrent().modelMode).toBe('default');
        expect(hook.getCurrent().modelSelection).toEqual(modelSelection);
    });

    it('seeds model, session mode, and config options from a remembered engine selection when no draft exists', async () => {
        const hook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'claude',
            backendTargetKey: 'agent:happier.agent.claude/claude',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            rememberedEngineSelection: {
                v: 1,
                modelSelection: nativeSelection('agent:happier.agent.claude/claude', 'claude-sonnet-4-5', 123),
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
            backendTargetKey: 'agent:happier.agent.codex/codex',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            rememberedEngineSelection: {
                v: 1,
                modelSelection: nativeSelection('agent:happier.agent.codex/codex', 'gpt-5.5', 123),
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
                updatedAt: 123,
            },
        } as any));

        expect(hook.getCurrent().modelMode).toBe('gpt-5.5');
    });

    it('rejects stale persisted freeform models that do not match constrained provider prefixes', async () => {
        const geminiTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.gemini', localId: 'gemini' } } as const;
        const hook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'gemini',
            backendTargetKey: resolveBackendTargetKeyV2(geminiTarget),
            allowTargetlessDraftEngineSelection: false,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.gemini', localId: 'gemini' } },
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
                modelSelection: nativeSelection('agent:happier.agent.claude/claude', 'remembered-model', 123),
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

    it('uses implicit profile model intent after explicit drafts but before remembered selection', async () => {
        const profileSelection = SessionModelSelectionV1Schema.parse({
            v: 1, updatedAt: 200,
            ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: 'pc_profile', modelId: 'profile-model' },
        });
        const implicitHook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'claude', backendTargetKey: 'agent:happier.agent.claude/claude',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            implicitProfileModelSelection: profileSelection,
            rememberedEngineSelection: {
                v: 1, modelSelection: nativeSelection('agent:happier.agent.claude/claude', 'remembered-model', 100),
                acpSessionModeId: null, sessionConfigOptionOverrides: null, updatedAt: 100,
            },
        }));
        expect(implicitHook.getCurrent().modelSelection).toEqual(profileSelection);

        const explicitSelection = nativeSelection('agent:happier.agent.claude/claude', 'draft-model', 300);
        const explicitHook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'claude', backendTargetKey: 'agent:happier.agent.claude/claude',
            hydratedTempAuthoringDraft: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                modelSelection: explicitSelection,
            },
            hydratedPersistedAuthoringDraft: null,
            implicitProfileModelSelection: profileSelection,
            rememberedEngineSelection: null,
        }));
        expect(explicitHook.getCurrent().modelSelection).toEqual(explicitSelection);
    });

    it('can stage an exact provider selection for a profile-preferred backend before that backend renders', async () => {
        type Props = Parameters<typeof useNewSessionAgentAuthoringOptionsState>[0];
        const claudeTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' });
        const codexTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' });
        const profileSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 200,
            ref: {
                agentTargetKey: claudeTargetKey,
                providerConnectionId: 'pc_profile',
                modelId: 'profile-model',
            },
        });
        const buildProps = (agentType: AgentId): Props => ({
            agentType,
            backendTargetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: agentType }),
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            rememberedEngineSelection: null,
        });
        const hook = await renderHook(
            (props: Props) => useNewSessionAgentAuthoringOptionsState(props),
            { initialProps: buildProps('codex') },
        );

        await act(async () => {
            hook.getCurrent().setModelSelectionForBackendTarget(claudeTargetKey, profileSelection);
        });
        await hook.rerender(buildProps('claude'));

        expect(hook.getCurrent().modelSelection).toEqual(profileSelection);
        expect(hook.getCurrent().modelMode).toBe('profile-model');
        expect(codexTargetKey).not.toBe(claudeTargetKey);
    });

    it('reconciles model and config state when the selected backend changes without picker setters', async () => {
        type Props = Parameters<typeof useNewSessionAgentAuthoringOptionsState>[0];
        const buildProps = (
            agentType: AgentId,
            rememberedEngineSelection: Props['rememberedEngineSelection'],
        ): Props => ({
            agentType,
            backendTargetKey: resolveBackendTargetKeyV2({
                kind: 'agent',
                identity: { pluginId: `happier.agent.${agentType}`, localId: agentType },
            }),
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            rememberedEngineSelection,
        });

        const hook = await renderHook(
            (props: Props) => useNewSessionAgentAuthoringOptionsState(props),
            {
                initialProps: buildProps('codex', {
                    v: 1,
                    modelSelection: SessionModelSelectionV1Schema.parse({
                        v: 1,
                        updatedAt: 123,
                        ref: {
                            agentTargetKey: 'agent:happier.agent.codex/codex',
                            providerConnectionId: null,
                            modelId: 'gpt-5.5',
                        },
                    }),
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
        const codexTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
        const opencodeTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' } } as const;
        const persistedCodexDraft = {
            agentTarget: codexTarget,
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

    it('ignores a targetless draft instead of inferring retired Agent identity fields', async () => {
        const codexTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
        const geminiTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.gemini', localId: 'gemini' } } as const;
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

        expect(matchingHook.getCurrent().modelMode).toBe(getAgentCore('codex').model.defaultMode);
        expect(matchingHook.getCurrent().acpSessionModeId).toBeNull();

        const mismatchedHook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'gemini',
            backendTargetKey: resolveBackendTargetKeyV2(geminiTarget),
            allowTargetlessDraftEngineSelection: true,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: legacyCodexDraft,
            rememberedEngineSelection: {
                v: 1,
                modelSelection: SessionModelSelectionV1Schema.parse({
                    v: 1,
                    updatedAt: 456,
                    ref: {
                        agentTargetKey: 'agent:happier.agent.gemini/gemini',
                        providerConnectionId: null,
                        modelId: 'gemini-2.5-pro',
                    },
                }),
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
        const claudeTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } as const;
        const codexTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
        const codexDraft = {
            agentTarget: codexTarget,
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
            backendTarget: typeof claudeTarget | typeof codexTarget,
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
