import { describe, expect, it, vi } from 'vitest';

import { createResolvedAgentCatalogEntryFixture } from '@/dev/testkit/fixtures/agentCatalogFixtures';
import { renderHook } from '@/dev/testkit';
import { formatBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/selection/v1';
import type { SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import { SessionModelSelectionV2Schema } from '@happier-dev/protocol/providers/selection/v2';

import { useNewSessionAgentPickerEngineSelectionState as useActualNewSessionAgentPickerEngineSelectionState } from './useNewSessionAgentPickerEngineSelectionState';
import { canRetainNewSessionModelSelection } from './useNewSessionTeamCredentialModelState';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';

function useNewSessionAgentPickerEngineSelectionState(params: Omit<Parameters<typeof useActualNewSessionAgentPickerEngineSelectionState>[0], 'modelSelectionIsExplicit'>) {
    return useActualNewSessionAgentPickerEngineSelectionState({ modelSelectionIsExplicit: true, ...params });
}

function createBuiltInBackendEntry(backendId: 'claude' | 'codex' | 'kimi' | 'gemini', title: string): ResolvedBackendCatalogEntry {
    const backendTarget = { kind: 'backend' as const, backendId };
    const agentId = `happier.agent.${backendId}/${backendId}`;
    const agentCatalogEntry = createResolvedAgentCatalogEntryFixture({ agentId: backendId });
    return {
        agentCatalogEntry,
        backendTarget,
        backendTargetKey: formatBackendTargetKeyV2(backendTarget),
        kind: 'builtInAgent',
        backendId,
        agentId,
        catalogAgentId: agentCatalogEntry.catalogAgentId,
        builtInAgentId: agentCatalogEntry.catalogAgentId,
        iconAgentId: agentCatalogEntry.catalogAgentId,
        title,
        subtitle: null,
        cliAuthBackgroundCheckSafe: false,
    };
}

describe('useNewSessionAgentPickerEngineSelectionState', () => {
    it('retires a V2 Team model without reviving an older native cache on Agent switch-back', async () => {
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex');
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude');
        const nativeSelection = SessionModelSelectionV1Schema.parse({ v: 1, updatedAt: 123,
            ref: { agentTargetKey: codexEntry.backendTargetKey, providerConnectionId: null, modelId: 'old-native-model' } });
        let team: TeamCredentialProviderModelSelectionV1 | null = null;
        type Props = Parameters<typeof useNewSessionAgentPickerEngineSelectionState>[0];
        const baseProps: Props = {
            selectedBackendEntry: codexEntry, selectedBackendTargetKey: codexEntry.backendTargetKey,
            modelMode: nativeSelection.ref.modelId, modelSelection: nativeSelection,
            acpSessionModeId: null, sessionConfigOptionOverrides: null,
            setBackendTarget: vi.fn(), setModelMode: vi.fn(), setAcpSessionModeId: vi.fn(),
            setSessionConfigOptionOverrides: vi.fn(),
            canRetainModelSelection: selection => canRetainNewSessionModelSelection(team, selection),
        };
        const hook = await renderHook((props: Props) => useNewSessionAgentPickerEngineSelectionState(props), { initialProps: baseProps });
        try {
            team = { kind: 'team_credential_provider_model', teamId: 'team-a', resourceId: 'resource-a',
                expectedResourceRevision: 0, deliveryMode: 'brokered', agentTargetKey: codexEntry.backendTargetKey,
                modelId: 'gpt-6-luna' };
            // A source-bearing V2 Team choice intentionally has no native V1 carrier.
            const sourceSelection = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 124, ref: {
                source: 'team_resource', teamId: team.teamId, resourceId: team.resourceId,
                expectedResourceRevision: team.expectedResourceRevision, deliveryMode: team.deliveryMode,
                agentTargetKey: team.agentTargetKey, modelId: team.modelId,
            } });
            await hook.rerender({ ...baseProps, modelMode: team.modelId,
                sessionConfigOptionOverrides: { v: 1, updatedAt: 124,
                    overrides: { reasoning_effort: { value: 'high', updatedAt: 124 } } },
                modelSelection: sourceSelection });
            team = null;
            await hook.rerender({ ...baseProps, selectedBackendEntry: claudeEntry,
                selectedBackendTargetKey: claudeEntry.backendTargetKey, modelMode: 'default', modelSelection: null });
            expect(hook.getCurrent().getEngineSelectionForTargetKey(codexEntry.backendTargetKey).modelId).toBe('default');
            expect(hook.getCurrent().getEngineSelectionForTargetKey(codexEntry.backendTargetKey).configOverrides)
                .toEqual({ reasoning_effort: 'high' });
        } finally { await hook.unmount(); }
    });

    it('does not retain a source-backed model as a native engine selection', async () => {
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex');
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude');
        const modelSelection = SessionModelSelectionV1Schema.parse({
            v: 1, updatedAt: 123,
            ref: { agentTargetKey: codexEntry.backendTargetKey, providerConnectionId: null, modelId: 'team-only-model' },
        });
        const remembered: Array<SessionModelSelection | null> = [];
        type Props = Parameters<typeof useNewSessionAgentPickerEngineSelectionState>[0];
        const baseProps: Props = {
            selectedBackendEntry: codexEntry, selectedBackendTargetKey: codexEntry.backendTargetKey,
            modelMode: modelSelection.ref.modelId, modelSelection,
            acpSessionModeId: null, sessionConfigOptionOverrides: null,
            setBackendTarget: vi.fn(), setModelMode: vi.fn(), setAcpSessionModeId: vi.fn(),
            setSessionConfigOptionOverrides: vi.fn(),
            onRememberEngineSelection: (_target, selection) => { remembered.push(selection.modelSelection); },
            ...{ canRetainModelSelection: (selection: Props['modelSelection']) => selection?.ref.modelId !== 'team-only-model' },
        };
        const hook = await renderHook((props: Props) => useNewSessionAgentPickerEngineSelectionState(props), { initialProps: baseProps });
        try {
            expect(hook.getCurrent().getEngineSelectionForTargetKey(codexEntry.backendTargetKey).modelSelection).toEqual(modelSelection);
            hook.getCurrent().selectEngineSelection(codexEntry, {
                modelId: modelSelection.ref.modelId, modelSelection, sessionModeId: null,
                configOverrides: { reasoning_effort: 'high' },
            });
            expect(remembered).toEqual([]);
            await hook.rerender({ ...baseProps, selectedBackendEntry: claudeEntry,
                selectedBackendTargetKey: claudeEntry.backendTargetKey, modelMode: 'default', modelSelection: null });
            expect(hook.getCurrent().getEngineSelectionForTargetKey(codexEntry.backendTargetKey).modelId).toBe('default');
        } finally { await hook.unmount(); }
    });

    it('preserves provider connection identity when reapplying the focused model selection', async () => {
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex');
        const modelSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 123,
            ref: {
                agentTargetKey: codexEntry.backendTargetKey,
                providerConnectionId: 'pc_01J00000000000000000000000',
                modelId: 'openai/gpt-5.5',
            },
        });
        const setEngineSelectionForBackendTarget = vi.fn();
        const hook = await renderHook(() => useNewSessionAgentPickerEngineSelectionState({
            selectedBackendEntry: codexEntry,
            selectedBackendTargetKey: codexEntry.backendTargetKey,
            modelMode: modelSelection.ref.modelId,
            modelSelection,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            setBackendTarget: vi.fn(),
            setModelMode: vi.fn() as any,
            setAcpSessionModeId: vi.fn() as any,
            setSessionConfigOptionOverrides: vi.fn() as any,
            setEngineSelectionForBackendTarget,
        }));

        hook.getCurrent().selectEngineSelection(codexEntry, {
            modelId: modelSelection.ref.modelId,
            modelSelection,
            sessionModeId: null,
            configOverrides: {},
        });

        expect(setEngineSelectionForBackendTarget).toHaveBeenCalledWith(
            codexEntry.backendTargetKey,
            expect.objectContaining({ modelSelection }),
        );
    });

    it('preserves a provider-bound model literally named default', async () => {
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex');
        const modelSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 123,
            ref: {
                agentTargetKey: codexEntry.backendTargetKey,
                providerConnectionId: 'pc_01J00000000000000000000000',
                modelId: 'default',
            },
        });
        const setEngineSelectionForBackendTarget = vi.fn();
        const hook = await renderHook(() => useNewSessionAgentPickerEngineSelectionState({
            selectedBackendEntry: codexEntry,
            selectedBackendTargetKey: codexEntry.backendTargetKey,
            modelMode: 'default',
            modelSelection,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            setBackendTarget: vi.fn(),
            setModelMode: vi.fn() as any,
            setAcpSessionModeId: vi.fn() as any,
            setSessionConfigOptionOverrides: vi.fn() as any,
            setEngineSelectionForBackendTarget,
        }));

        hook.getCurrent().selectEngineSelection(codexEntry, {
            modelId: 'default',
            modelSelection,
            sessionModeId: null,
            configOverrides: {},
        });

        expect(setEngineSelectionForBackendTarget).toHaveBeenCalledWith(
            codexEntry.backendTargetKey,
            expect.objectContaining({ modelSelection }),
        );
    });

    it('does not let lagging same-id native props overwrite a pending provider selection', async () => {
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex');
        const providerSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 123,
            ref: {
                agentTargetKey: codexEntry.backendTargetKey,
                providerConnectionId: 'pc_01J00000000000000000000000',
                modelId: 'shared-id',
            },
        });
        type Props = Parameters<typeof useNewSessionAgentPickerEngineSelectionState>[0];
        const baseProps: Props = {
            selectedBackendEntry: codexEntry,
            selectedBackendTargetKey: codexEntry.backendTargetKey,
            modelMode: 'shared-id',
            modelSelection: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            setBackendTarget: vi.fn(),
            setModelMode: vi.fn() as any,
            setAcpSessionModeId: vi.fn() as any,
            setSessionConfigOptionOverrides: vi.fn() as any,
        };
        const hook = await renderHook(
            (props: Props) => useNewSessionAgentPickerEngineSelectionState(props),
            { initialProps: baseProps },
        );

        hook.getCurrent().selectEngineSelection(codexEntry, {
            modelId: 'shared-id',
            modelSelection: providerSelection,
            sessionModeId: null,
            configOverrides: {},
        });
        await hook.rerender({ ...baseProps });

        expect(hook.getCurrent().getEngineSelectionForTargetKey(codexEntry.backendTargetKey).modelSelection)
            .toEqual(providerSelection);
    });

    it.each([null, 'default'] as const)('preserves remembered mode %s without inventing an override for a fresh engine', async (sessionModeId) => {
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude');
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex');
        const kimiEntry = createBuiltInBackendEntry('kimi', 'Kimi');
        const hook = await renderHook(() => useNewSessionAgentPickerEngineSelectionState({
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            modelMode: 'default',
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            setBackendTarget: vi.fn(),
            setModelMode: vi.fn(),
            setAcpSessionModeId: vi.fn(),
            setSessionConfigOptionOverrides: vi.fn(),
            rememberEngineSelectionsEnabled: true,
            rememberedEngineSelectionServerId: 'server-1',
            rememberedEngineSelectionsByScope: {
                [`server-1:${codexEntry.backendTargetKey}`]: {
                    v: 1,
                    modelSelection: null,
                    acpSessionModeId: sessionModeId,
                    updatedAt: 123,
                },
            },
        }));

        expect(hook.getCurrent().getEngineSelectionForTargetKey(claudeEntry.backendTargetKey).sessionModeId).toBeNull();
        expect(hook.getCurrent().getEngineSelectionForTargetKey(codexEntry.backendTargetKey)).toEqual({
            modelId: 'default',
            modelSelection: null,
            sessionModeId,
            configOverrides: {},
        });
        expect(hook.getCurrent().getEngineSelectionForTargetKey(kimiEntry.backendTargetKey).sessionModeId).toBeNull();
    });

    it('hydrates non-focused engine selections from remembered account preferences', async () => {
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude');
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex');

        const hook = await renderHook(() => useNewSessionAgentPickerEngineSelectionState({
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            modelMode: 'default',
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            setBackendTarget: vi.fn(),
            setModelMode: vi.fn() as any,
            setAcpSessionModeId: vi.fn() as any,
            setSessionConfigOptionOverrides: vi.fn() as any,
            rememberEngineSelectionsEnabled: true,
            rememberedEngineSelectionsByScope: {
                [`server-1:${codexEntry.backendTargetKey}`]: {
                    v: 1,
                    modelSelection: {
                        v: 1,
                        updatedAt: 123,
                        ref: {
                            agentTargetKey: codexEntry.backendTargetKey,
                            providerConnectionId: null,
                            modelId: 'gpt-5.4',
                        },
                    },
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
            },
            rememberedEngineSelectionServerId: 'server-1',
        } as any));

        expect(hook.getCurrent().getEngineSelectionForTargetKey(codexEntry.backendTargetKey)).toEqual({
            modelId: 'gpt-5.4',
            modelSelection: {
                v: 1,
                updatedAt: 123,
                ref: {
                    agentTargetKey: codexEntry.backendTargetKey,
                    providerConnectionId: null,
                    modelId: 'gpt-5.4',
                },
            },
            sessionModeId: 'plan',
            configOverrides: {
                reasoning_effort: 'high',
            },
        });
    });

    it('publishes applied engine selections for account-synced remembering', async () => {
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude');
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex');
        const onRememberEngineSelection = vi.fn();

        const hook = await renderHook(() => useNewSessionAgentPickerEngineSelectionState({
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            modelMode: 'default',
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            setBackendTarget: vi.fn(),
            setModelMode: vi.fn() as any,
            setAcpSessionModeId: vi.fn() as any,
            setSessionConfigOptionOverrides: vi.fn() as any,
            onRememberEngineSelection,
        } as any));

        hook.getCurrent().selectEngineSelection(codexEntry, {
            modelId: 'gpt-5.4',
            sessionModeId: 'plan',
            configOverrides: {
                reasoning_effort: 'high',
            },
        });

        expect(onRememberEngineSelection).toHaveBeenCalledWith(codexEntry.backendTarget, {
            modelSelection: {
                v: 1,
                updatedAt: expect.any(Number),
                ref: {
                    agentTargetKey: codexEntry.backendTargetKey,
                    providerConnectionId: null,
                    modelId: 'gpt-5.4',
                },
            },
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: expect.objectContaining({
                overrides: {
                    reasoning_effort: {
                        updatedAt: expect.any(Number),
                        value: 'high',
                    },
                },
            }),
        });
    });

    it('clears ACP session mode when selecting a backend that does not expose session modes', async () => {
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude');
        const geminiEntry = createBuiltInBackendEntry('gemini', 'Gemini');
        const setAcpSessionModeId = vi.fn();
        const onRememberEngineSelection = vi.fn();

        const hook = await renderHook(() => useNewSessionAgentPickerEngineSelectionState({
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            modelMode: 'default',
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: null,
            setBackendTarget: vi.fn(),
            setModelMode: vi.fn() as any,
            setAcpSessionModeId: setAcpSessionModeId as any,
            setSessionConfigOptionOverrides: vi.fn() as any,
            onRememberEngineSelection,
        } as any));

        hook.getCurrent().selectEngineSelection(geminiEntry, {
            modelId: 'gemini-3-pro',
            sessionModeId: 'default',
            configOverrides: {},
        });

        expect(setAcpSessionModeId).toHaveBeenCalledWith(null);
        expect(onRememberEngineSelection).toHaveBeenCalledWith(geminiEntry.backendTarget, {
            modelSelection: {
                v: 1,
                updatedAt: expect.any(Number),
                ref: {
                    agentTargetKey: geminiEntry.backendTargetKey,
                    providerConnectionId: null,
                    modelId: 'gemini-3-pro',
                },
            },
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
        });
    });
});
