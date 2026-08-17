import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { renderScreen } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

import { installNewSessionScreenModelCommonModuleMocks } from '../newSessionScreenModelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionScreenModelCommonModuleMocks({
    storage: async () => createStorageModuleStub({
        storage: {
            getState: () => ({}),
        },
    }),
});

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        getNewSessionAgentInputExtraActionChips: () => [] as AgentInputExtraActionChip[],
    };
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
        }));
        expect(automationChip?.collapsedContentPopover?.boundaryRef).toBeUndefined();
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
        expect(storageChip?.collapsedOptionsPopover?.presentation).toBe('list');
        expect(storageChip?.collapsedOptionsPopover?.selectedOptionId).toBe('persisted');
        expect(storageChip?.collapsedOptionsPopover?.title).toBeTruthy();
        // Lane F-redo migrated the storage chip from flat `options` to `presentation: 'list' + rootStep`.
        // The `'list'` branch of the discriminated union forbids `options`, so we walk the rootStep's
        // single section to assert the same legacy contract (id order + subtitle presence).
        type StorageOption = Readonly<{ id: string; label: string; subtitle?: string }>;
        const storageRootStep = storageChip?.collapsedOptionsPopover?.presentation === 'list'
            ? storageChip.collapsedOptionsPopover.rootStep
            : null;
        expect(storageRootStep?.sections).toHaveLength(1);
        const storageSection = storageRootStep?.sections[0];
        const storageOptions = (storageSection && storageSection.kind === 'static'
            ? storageSection.options
            : []) as ReadonlyArray<StorageOption>;
        expect(storageOptions).toHaveLength(2);
        expect(storageOptions.map((option) => option.id)).toEqual([
            'persisted',
            'direct',
        ]);
        expect(storageOptions.every((option) =>
            typeof option.subtitle === 'string' && option.subtitle.length > 0,
        )).toBe(true);

        // RV-1 (F1): the storage chip routes mutations through per-option
        // SelectionListOption.onSelect callbacks (the canonical action source
        // for `presentation: 'list'` chips). The descriptor-level onSelect is
        // a documented close-only no-op for parity with the picker contract.
        const directOption = storageOptions.find((option) => option.id === 'direct') as
            (StorageOption & { onSelect?: () => void }) | undefined;
        expect(typeof directOption?.onSelect).toBe('function');
        directOption!.onSelect!();
        expect(onTranscriptStorageChange).toHaveBeenCalledWith('direct');
    });

    it('passes the available server popover height through without imposing a minimum', async () => {
        const { useNewSessionAgentInputExtraActionChips } = await import('./useNewSessionAgentInputExtraActionChips');

        let chips: ReadonlyArray<AgentInputExtraActionChip> = [];

        function Probe() {
            chips = useNewSessionAgentInputExtraActionChips({
                agentId: 'claude',
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
                showServerPickerChip: true,
                targetServerId: 'server-a',
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

        const serverChip = chips.find((chip) => chip.key === 'new-session-target-server');
        const renderContent = serverChip?.collapsedContentPopover?.renderContent;
        expect(typeof renderContent).toBe('function');
        const renderedContent = typeof renderContent === 'function'
            ? renderContent({ requestClose: vi.fn(), maxHeight: 300 })
            : null;

        expect(React.isValidElement(renderedContent)).toBe(true);
        expect((renderedContent as React.ReactElement<{ maxHeight: number }>).props.maxHeight).toBe(300);
    });

    it('emits a supplied source-context chip first so its composer badge leads the attachment row', async () => {
        const { useNewSessionAgentInputExtraActionChips } = await import('./useNewSessionAgentInputExtraActionChips');

        const sourceContextChip = {
            key: 'session-source-context',
            composerAttachmentBadge: { key: 'session-source-context', label: 'From that session' },
            render: () => null,
        } as unknown as AgentInputExtraActionChip;

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
                sourceContextChip,
            });
            return null;
        }

        await renderScreen(<Probe />);

        expect(chips[0]).toBe(sourceContextChip);
        expect(chips.filter((chip) => chip.key === 'session-source-context')).toHaveLength(1);
    });

    it('emits no source-context chip for an ordinary new Session', async () => {
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

        expect(chips.some((chip) => chip.key === 'session-source-context')).toBe(false);
    });
});
