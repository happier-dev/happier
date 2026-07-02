import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { formatBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

import { useNewSessionAgentPickerEngineSelectionState } from './useNewSessionAgentPickerEngineSelectionState';

function createBuiltInBackendEntry(backendId: 'claude' | 'codex' | 'kimi', title: string): ResolvedBackendCatalogEntry {
    const backendTarget = { kind: 'backend' as const, backendId };
    return {
        backendTarget,
        backendTargetKey: formatBackendTargetKeyV2(backendTarget),
        kind: 'builtInAgent',
        backendId,
        providerId: backendId,
        providerAgentId: backendId as any,
        builtInAgentId: backendId as any,
        iconAgentId: backendId as any,
        title,
        subtitle: null,
    };
}

describe('useNewSessionAgentPickerEngineSelectionState', () => {
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
                    modelId: 'gpt-5.4',
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
            modelId: 'gpt-5.4',
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
        const kimiEntry = createBuiltInBackendEntry('kimi', 'Kimi');
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

        hook.getCurrent().selectEngineSelection(kimiEntry, {
            modelId: 'kimi-code/kimi-for-coding',
            sessionModeId: 'default',
            configOverrides: {},
        });

        expect(setAcpSessionModeId).toHaveBeenCalledWith(null);
        expect(onRememberEngineSelection).toHaveBeenCalledWith(kimiEntry.backendTarget, {
            modelId: 'kimi-code/kimi-for-coding',
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
        });
    });
});
