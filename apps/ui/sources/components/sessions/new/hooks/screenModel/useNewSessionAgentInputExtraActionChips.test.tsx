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
                onToggleTranscriptStorage: vi.fn(),
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
});
