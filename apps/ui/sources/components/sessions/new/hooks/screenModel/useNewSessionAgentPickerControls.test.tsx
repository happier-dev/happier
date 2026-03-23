import * as React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';

import { useNewSessionAgentPickerControls } from './useNewSessionAgentPickerControls';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

const modalMockState = vi.hoisted(() => ({
    alert: vi.fn(),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const modalMock = createModalModuleMock();
    modalMock.spies.alert.mockImplementation((...args: unknown[]) => modalMockState.alert(...args));
    return modalMock.module;
});

vi.mock('@/components/sessions/new/components/NewSessionEngineOptionDetail', () => ({
    NewSessionEngineOptionDetail: (props: Record<string, unknown>) => React.createElement('NewSessionEngineOptionDetail', props),
}));

describe('useNewSessionAgentPickerControls', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('keeps all backend options visible, suppresses redundant compatible subtitles, and disables entries that are incompatible with the selected profile', async () => {
        const setBackendTarget = vi.fn();

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: true,
            selectedProfileId: 'profile-1',
            profileMap: new Map([[
                'profile-1',
                { id: 'profile-1', name: 'Profile 1' } as any,
            ]]),
            resolvedBackendEntries: [
                {
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                    subtitle: 'Claude',
                } as any,
                {
                    target: { kind: 'builtInAgent', agentId: 'codex' },
                    targetKey: 'agent:codex',
                    title: 'Codex',
                    subtitle: 'Codex',
                } as any,
            ],
            getCompatibleProfileBackendEntries: () => ([
                {
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                    subtitle: 'Claude',
                } as any,
            ]),
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: {
                target: { kind: 'builtInAgent', agentId: 'claude' },
                targetKey: 'agent:claude',
                title: 'Claude',
                subtitle: 'Claude',
            } as any,
            selectedBackendTargetKey: 'agent:claude',
            setBackendTarget,
            modelMode: 'default',
            setModelMode: vi.fn() as any,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn() as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn() as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            settings: {} as any,
        }));

        expect(modalMockState.alert).not.toHaveBeenCalled();
        expect(setBackendTarget).not.toHaveBeenCalled();
        expect(hook.getCurrent().agentPickerOptions?.map((option) => ({
            id: option.id,
            disabled: option.disabled ?? false,
            subtitle: option.subtitle ?? null,
        }))).toEqual([
            { id: 'agent:claude', disabled: false, subtitle: null },
            { id: 'agent:codex', disabled: true, subtitle: 'newSession.aiBackendNotCompatibleWithSelectedProfile' },
        ]);
    });

    it('publishes engine detail selection changes immediately for the focused backend option', async () => {
        const setBackendTarget = vi.fn();
        const setModelMode = vi.fn();
        const setAcpSessionModeId = vi.fn();
        const setSessionConfigOptionOverrides = vi.fn();

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [
                {
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                    subtitle: null,
                } as any,
                {
                    target: { kind: 'builtInAgent', agentId: 'codex' },
                    targetKey: 'agent:codex',
                    title: 'Codex',
                    subtitle: null,
                } as any,
            ],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: {
                target: { kind: 'builtInAgent', agentId: 'claude' },
                targetKey: 'agent:claude',
                title: 'Claude',
                subtitle: null,
            } as any,
            selectedBackendTargetKey: 'agent:claude',
            setBackendTarget,
            modelMode: 'default',
            setModelMode: setModelMode as any,
            acpSessionModeId: null,
            setAcpSessionModeId: setAcpSessionModeId as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: setSessionConfigOptionOverrides as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            settings: {} as any,
        }));

        const codexOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'agent:codex');
        const detailElement = codexOption?.renderDetailContent?.() as React.ReactElement<{
            onSelectionChange?: (selection: {
                modelId: string;
                sessionModeId: string;
                configOverrides: Readonly<Record<string, string>>;
            }) => void;
        }> | undefined;

        expect(detailElement?.props?.onSelectionChange).toBeTypeOf('function');

        detailElement?.props?.onSelectionChange?.({
            modelId: 'gpt-5.4',
            sessionModeId: 'plan',
            configOverrides: { reasoning_effort: 'high', speed: 'fast' },
        });

        expect(setBackendTarget).toHaveBeenCalledWith({ kind: 'builtInAgent', agentId: 'codex' });
        expect(setModelMode).toHaveBeenCalledWith('gpt-5.4');
        expect(setAcpSessionModeId).toHaveBeenCalledWith('plan');
        expect(setSessionConfigOptionOverrides).toHaveBeenCalledWith(expect.objectContaining({
            overrides: {
                reasoning_effort: {
                    updatedAt: expect.any(Number),
                    value: 'high',
                },
                speed: {
                    updatedAt: expect.any(Number),
                    value: 'fast',
                },
            },
        }));
    });

    it('does not expose an explicit apply action for detailed engine options', async () => {
        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [
                {
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                    subtitle: null,
                } as any,
                {
                    target: { kind: 'builtInAgent', agentId: 'codex' },
                    targetKey: 'agent:codex',
                    title: 'Codex',
                    subtitle: null,
                } as any,
            ],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: {
                target: { kind: 'builtInAgent', agentId: 'claude' },
                targetKey: 'agent:claude',
                title: 'Claude',
                subtitle: null,
            } as any,
            selectedBackendTargetKey: 'agent:claude',
            setBackendTarget: vi.fn(),
            modelMode: 'default',
            setModelMode: vi.fn() as any,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn() as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn() as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            settings: {} as any,
        }));

        const codexOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'agent:codex');

        expect(codexOption?.renderDetailContent).toBeTypeOf('function');
        expect(codexOption?.onApply).toBeUndefined();
    });

    it('restores the cached per-backend engine selection when a backend is reselected', async () => {
        const setBackendTarget = vi.fn();
        const setModelMode = vi.fn();
        const setAcpSessionModeId = vi.fn();
        const setSessionConfigOptionOverrides = vi.fn();

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [
                {
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                    subtitle: null,
                } as any,
                {
                    target: { kind: 'builtInAgent', agentId: 'codex' },
                    targetKey: 'agent:codex',
                    title: 'Codex',
                    subtitle: null,
                } as any,
            ],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: {
                target: { kind: 'builtInAgent', agentId: 'claude' },
                targetKey: 'agent:claude',
                title: 'Claude',
                subtitle: null,
            } as any,
            selectedBackendTargetKey: 'agent:claude',
            setBackendTarget,
            modelMode: 'default',
            setModelMode: setModelMode as any,
            acpSessionModeId: null,
            setAcpSessionModeId: setAcpSessionModeId as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: setSessionConfigOptionOverrides as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            settings: {} as any,
        }));

        const codexOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'agent:codex');
        const detailElement = codexOption?.renderDetailContent?.() as React.ReactElement<{
            onSelectionChange?: (selection: {
                modelId: string;
                sessionModeId: string;
                configOverrides: Readonly<Record<string, string>>;
            }) => void;
        }> | undefined;

        detailElement?.props?.onSelectionChange?.({
            modelId: 'gpt-5.4',
            sessionModeId: 'plan',
            configOverrides: { reasoning_effort: 'high' },
        });

        vi.clearAllMocks();

        hook.getCurrent().handleAgentPickerSelect('agent:codex');

        expect(setBackendTarget).toHaveBeenCalledWith({ kind: 'builtInAgent', agentId: 'codex' });
        expect(setModelMode).toHaveBeenCalledWith('gpt-5.4');
        expect(setAcpSessionModeId).toHaveBeenCalledWith('plan');
        expect(setSessionConfigOptionOverrides).toHaveBeenCalledWith(expect.objectContaining({
            overrides: {
                reasoning_effort: {
                    updatedAt: expect.any(Number),
                    value: 'high',
                },
            },
        }));
    });
});
