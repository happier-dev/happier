import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { renderScreen } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { SessionInitialTriggerV1Schema, type SessionInitialTriggerV1 } from '@happier-dev/protocol';
import { act } from 'react-test-renderer';

import { installNewSessionScreenModelCommonModuleMocks } from '../newSessionScreenModelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionScreenModelCommonModuleMocks({
    storage: async () => createStorageModuleStub({
        storage: {
            getState: () => ({}),
        },
    }),
});

// Overlay portals are a platform boundary; the shared editor and draft state remain real.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal, { maxHeight: 640, maxWidth: 380, placement: 'bottom' });
});

describe('useNewSessionAgentInputExtraActionChips', () => {
    it('shows a saved-workflow prerequisite when the session targets another Home while still allowing an inline trigger', async () => {
        const { createNewSessionTriggersActionChip } = await import('../../components/NewSessionTriggersActionChip');
        let draft: SessionInitialTriggerV1[] = [];
        function Probe() {
            const [initialTriggers, setInitialTriggers] = React.useState<SessionInitialTriggerV1[]>([]);
            draft = initialTriggers;
            const chip = createNewSessionTriggersActionChip({ initialTriggers, onInitialTriggersChange: setInitialTriggers,
                machineId: 'machine-other', serverId: 'other-home' });
            return chip.renderCollapsedPopover?.({ anchorRef: React.createRef(), onRequestClose: vi.fn() }) ?? null;
        }
        const screen = await renderScreen(<Probe />);
        expect(screen.findByTestId('new-session-triggers-library-unavailable')).not.toBeNull();
        await act(async () => screen.changeTextByTestId('new-session-trigger-popover-prompt', 'Prepare workspace'));
        await screen.pressByTestIdAsync('new-session-trigger-popover-submit');
        expect(draft).toMatchObject([{ target: { kind: 'inline' }, trigger: { events: ['sessionStarted'] } }]);
    });
    it('edits a trigger locally through the shared popover without losing its policy or execution context', async () => {
        const { createNewSessionTriggersActionChip } = await import('../../components/NewSessionTriggersActionChip');
        const { buildTriggerTarget } = await import('@/components/workflows/triggers/sessionTriggerForm');
        let draft: SessionInitialTriggerV1[] = [];
        const initial = SessionInitialTriggerV1Schema.array().parse([{
            trigger: { kind: 'sessionLifecycle', enabled: true, events: ['sessionStarted'], policy: { kind: 'firstMatch' } },
            target: buildTriggerTarget({ kind: 'sendPrompt', prompt: 'Prepare workspace' }), executionTarget: { kind: 'session' },
        }]);
        function Probe() {
            const [initialTriggers, setInitialTriggers] = React.useState(initial);
            draft = initialTriggers;
            const chip = createNewSessionTriggersActionChip({ initialTriggers, onInitialTriggersChange: setInitialTriggers,
                machineId: 'machine-a', serverId: null });
            return chip.renderCollapsedPopover?.({ anchorRef: React.createRef(), onRequestClose: vi.fn() }) ?? null;
        }
        const screen = await renderScreen(<Probe />);
        await screen.pressByTestIdAsync('new-session-trigger-draft:0');
        await act(async () => screen.changeTextByTestId('new-session-trigger-popover-prompt', 'Review workspace'));
        await screen.pressByTestIdAsync('new-session-trigger-popover-submit');
        expect(draft).toMatchObject([{
            executionTarget: { kind: 'session' }, trigger: { policy: { kind: 'firstMatch' }, events: ['sessionStarted'] },
            target: { kind: 'inline', definition: { defaults: { conversation: { kind: 'origin_session' } },
                blocks: [{ document: { text: 'Review workspace' } }] } },
        }]);
        expect(draft[0]?.trigger).not.toHaveProperty('sourceSessionId');
    });
    it('offers a Triggers chip beside the New Session controls without loading its closed popover', async () => {
        const { useNewSessionAgentInputExtraActionChips } = await import('./useNewSessionAgentInputExtraActionChips');
        let chips: ReadonlyArray<AgentInputExtraActionChip> = [];
        function Probe() {
            chips = useNewSessionAgentInputExtraActionChips({
                agentId: 'claude', agentOptionState: null, setAgentOptionState: vi.fn(),
                selectedMachineId: 'machine-a', showAutomationActionChips: false,
                automationLabel: 'Automate', onOpenAutomationEditor: vi.fn(),
                showInitialTriggers: true, initialTriggers: [], onInitialTriggersChange: vi.fn(),
                showServerPickerChip: false, targetServerId: null, targetServerName: 'Server A',
                externalSessionsFeatureEnabled: false, supportsDirectTranscriptStorage: false,
                transcriptStorage: 'persisted', onTranscriptStorageChange: vi.fn(),
                selectedMachineIsWindows: false, windowsRemoteSessionLaunchMode: null, windowsTerminalAvailable: false,
                onWindowsRemoteSessionLaunchModeChange: vi.fn(), onActionShortcutPress: vi.fn(),
            });
            const triggers = chips.find((chip) => chip.key === 'new-session-triggers');
            return triggers?.render({ chipStyle: () => ({}), showLabel: true, iconColor: '#000',
                textStyle: {}, countTextStyle: {}, popoverAnchorRef: React.createRef(),
                toggleCollapsedPopover: vi.fn() }) ?? null;
        }
        const screen = await renderScreen(<Probe />);
        expect(screen.findByTestId('new-session-triggers-chip')).not.toBeNull();
        expect(screen.getTextContent()).toContain('workflows.triggers.section.title');
        expect(screen.findByTestId('new-session-trigger-popover')).toBeNull();
    });
    it('places organization controls after checkout and before Automation controls', async () => {
        const { useNewSessionAgentInputExtraActionChips } = await import('./useNewSessionAgentInputExtraActionChips');
        let chips: ReadonlyArray<AgentInputExtraActionChip> = [];
        const chip = (key: string): AgentInputExtraActionChip => ({ key, render: () => null });

        function Probe() {
            chips = useNewSessionAgentInputExtraActionChips({
                agentId: 'claude',
                agentOptionState: null,
                setAgentOptionState: vi.fn(),
                selectedMachineId: 'machine-a',
                showAutomationActionChips: true,
                automationLabel: 'Automate',
                onOpenAutomationEditor: vi.fn(),
                checkoutActionChip: chip('checkout'),
                organizationPlacementActionChips: [chip('organization-folder'), chip('organization-tags')],
                showServerPickerChip: false,
                targetServerId: null,
                targetServerName: 'Server A',
                externalSessionsFeatureEnabled: false,
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
        expect(chips.map((item) => item.key)).toEqual([
            'checkout',
            'organization-folder',
            'organization-tags',
            'new-session-automate',
        ]);
    });

    it('composes the one Session access chip so New Session and in-Session share the factory', async () => {
        const { useNewSessionAgentInputExtraActionChips } = await import('./useNewSessionAgentInputExtraActionChips');
        let chips: ReadonlyArray<AgentInputExtraActionChip> = [];

        function Probe() {
            chips = useNewSessionAgentInputExtraActionChips({
                agentId: 'claude',
                agentOptionState: null,
                setAgentOptionState: vi.fn(),
                selectedMachineId: 'machine-a',
                showAutomationActionChips: false,
                automationLabel: 'Automate',
                onOpenAutomationEditor: vi.fn(),
                showServerPickerChip: false,
                targetServerId: null,
                targetServerName: 'Server A',
                externalSessionsFeatureEnabled: false,
                supportsDirectTranscriptStorage: false,
                transcriptStorage: 'persisted',
                onTranscriptStorageChange: vi.fn(),
                selectedMachineIsWindows: false,
                windowsRemoteSessionLaunchMode: null,
                windowsTerminalAvailable: false,
                onWindowsRemoteSessionLaunchModeChange: vi.fn(),
                onActionShortcutPress: vi.fn(),
                sessionAccess: { label: 'Private', accessibilityLabel: 'Session access', popoverContent: null },
            });
            return null;
        }

        await renderScreen(<Probe />);
        const access = chips.find((item) => item.key === 'session-access');
        expect(access?.controlId).toBe('sessionAccess');
        // Session access is never the per-message recipient control.
        expect(chips.some((item) => item.controlId === 'recipient')).toBe(false);
    });

    it('creates the automation chip as draft-preserving navigation instead of a second settings editor', async () => {
        const { useNewSessionAgentInputExtraActionChips } = await import('./useNewSessionAgentInputExtraActionChips');

        let chips: ReadonlyArray<AgentInputExtraActionChip> = [];

        function Probe() {
            chips = useNewSessionAgentInputExtraActionChips({
                agentId: 'claude',
                agentOptionState: null,
                setAgentOptionState: vi.fn(),
                selectedMachineId: 'machine-a',
                showAutomationActionChips: true,
                automationLabel: 'Automate',
                onOpenAutomationEditor: vi.fn(),
                showServerPickerChip: false,
                targetServerId: null,
                targetServerName: 'Server A',
                externalSessionsFeatureEnabled: false,
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
        // The chip hands the composed draft to the shared Automation editor; it
        // no longer embeds a full trigger/settings popover of its own.
        expect(automationChip?.collapsedContentPopover).toBeUndefined();
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
                selectedMachineId: 'machine-a',
                showAutomationActionChips: false,
                automationLabel: 'Automate',
                onOpenAutomationEditor: vi.fn(),
                showServerPickerChip: false,
                targetServerId: null,
                targetServerName: 'Server A',
                externalSessionsFeatureEnabled: true,
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
        const storageOptions = storageChip?.collapsedOptionsPopover?.rootStep?.sections
            .flatMap((section) => section.kind === 'static' ? section.options : []) ?? [];
        expect(storageOptions).toHaveLength(2);
        expect(storageOptions.map((option) => option.id)).toEqual([
            'persisted',
            'direct',
        ]);
        expect(storageOptions.every((option) =>
            typeof option.subtitle === 'string' && option.subtitle.length > 0,
        )).toBe(true);

        storageOptions.find((option) => option.id === 'direct')?.onSelect?.();
        expect(onTranscriptStorageChange).toHaveBeenCalledWith('direct');
    });

    it('passes compact server popover height through instead of forcing the minimum cap', async () => {
        const { useNewSessionAgentInputExtraActionChips } = await import('./useNewSessionAgentInputExtraActionChips');

        let chips: ReadonlyArray<AgentInputExtraActionChip> = [];

        function Probe() {
            chips = useNewSessionAgentInputExtraActionChips({
                agentId: 'codex',
                agentOptionState: null,
                setAgentOptionState: vi.fn(),
                selectedMachineId: 'machine-a',
                showAutomationActionChips: false,
                automationLabel: 'Automate',
                onOpenAutomationEditor: vi.fn(),
                showServerPickerChip: true,
                targetServerId: 'server-a',
                targetServerName: 'Server A',
                externalSessionsFeatureEnabled: false,
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
        expect(serverChip?.collapsedContentPopover?.maxHeightCap).toBe(760);
        const renderContent = serverChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') {
            throw new Error('Expected server popover renderContent to be a function');
        }

        const renderedContent = renderContent({
            requestClose: vi.fn(),
            maxHeight: 300,
        });

        expect(React.isValidElement(renderedContent)).toBe(true);
        expect((renderedContent as React.ReactElement<{ maxHeight?: number }>).props.maxHeight).toBe(300);
    });
});
