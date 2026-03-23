import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        getNewSessionAgentInputExtraActionChips: () => [] as AgentInputExtraActionChip[],
    };
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
        getState: () => ({}),
    },
});
});

vi.mock('@/components/sessions/agentInput/sessionActions/buildNewSessionActionShortcutChips', () => ({
    buildNewSessionActionShortcutChips: () => [],
}));

describe('useNewSessionAgentInputExtraActionChips', () => {
    it('creates the automation chip as a shared content popover instead of a collapsed toggle action', async () => {
        const { useNewSessionAgentInputExtraActionChips } = await import('./useNewSessionAgentInputExtraActionChips');

        let chips: ReadonlyArray<AgentInputExtraActionChip> = [];

        function Probe() {
            chips = useNewSessionAgentInputExtraActionChips({
                agentId: 'claude',
                agentOptionState: null,
                setAgentOptionState: vi.fn(),
                showAutomationActionChips: true,
                automationDraft: {
                    enabled: false,
                    name: '',
                    description: '',
                    scheduleKind: 'interval',
                    everyMinutes: 60,
                    cronExpr: '0 * * * *',
                    timezone: null,
                },
                automationLabel: 'Automate',
                onAutomationChange: vi.fn(),
                showServerPickerChip: false,
                targetServerId: null,
                targetServerName: 'Server A',
                directSessionsFeatureEnabled: false,
                supportsDirectTranscriptStorage: false,
                transcriptStorage: 'persisted',
                onTranscriptStorageChange: vi.fn(),
                selectedMachineIsWindows: false,
                windowsRemoteSessionLaunchMode: null,
                windowsTerminalAvailable: false,
                onWindowsRemoteSessionLaunchModeChange: vi.fn(),
                onActionShortcutPress: vi.fn(),
            });
            return null;
        }

        await renderScreen(<Probe />);

        const automationChip = chips.find((chip) => chip.key === 'new-session-automate');
        expect(automationChip?.controlId).toBe('automation');
        expect(automationChip?.collapsedContentPopover).toEqual(expect.objectContaining({
            renderContent: expect.any(Function),
            scrollEnabled: true,
            boundaryRef: null,
        }));
        expect(automationChip?.collapsedAction).toBeUndefined();
    });

    it('publishes transcript storage as a shared options popover with synced and direct explanations', async () => {
        const { useNewSessionAgentInputExtraActionChips } = await import('./useNewSessionAgentInputExtraActionChips');
        const onTranscriptStorageChange = vi.fn();

        let chips: ReadonlyArray<AgentInputExtraActionChip> = [];

        function Probe() {
            chips = useNewSessionAgentInputExtraActionChips({
                agentId: 'codex',
                agentOptionState: null,
                setAgentOptionState: vi.fn(),
                showAutomationActionChips: false,
                automationDraft: {
                    enabled: false,
                    name: '',
                    description: '',
                    scheduleKind: 'interval',
                    everyMinutes: 60,
                    cronExpr: '0 * * * *',
                    timezone: null,
                },
                automationLabel: 'Automate',
                onAutomationChange: vi.fn(),
                showServerPickerChip: false,
                targetServerId: null,
                targetServerName: 'Server A',
                directSessionsFeatureEnabled: true,
                supportsDirectTranscriptStorage: true,
                transcriptStorage: 'persisted',
                onTranscriptStorageChange,
                selectedMachineIsWindows: false,
                windowsRemoteSessionLaunchMode: null,
                windowsTerminalAvailable: false,
                onWindowsRemoteSessionLaunchModeChange: vi.fn(),
                onActionShortcutPress: vi.fn(),
            });
            return null;
        }

        await renderScreen(<Probe />);

        const storageChip = chips.find((chip) => chip.key === 'new-session-storage');
        expect(storageChip?.collapsedAction).toBeUndefined();
        expect(storageChip?.collapsedOptionsPopover?.selectedOptionId).toBe('persisted');
        expect(storageChip?.collapsedOptionsPopover?.title).toBeTruthy();
        expect(storageChip?.collapsedOptionsPopover?.options).toHaveLength(2);
        expect(storageChip?.collapsedOptionsPopover?.options.map((option) => option.id)).toEqual([
            'persisted',
            'direct',
        ]);
        expect(storageChip?.collapsedOptionsPopover?.options.every((option) =>
            typeof option.subtitle === 'string' && option.subtitle.length > 0,
        )).toBe(true);

        storageChip?.collapsedOptionsPopover?.onSelect('direct');
        expect(onTranscriptStorageChange).toHaveBeenCalledWith('direct');
    });
});
