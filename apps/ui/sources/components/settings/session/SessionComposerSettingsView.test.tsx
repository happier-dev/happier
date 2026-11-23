import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';

const setNewSessionDraftEntryMode = vi.fn();
const setSessionInactiveResumePolicy = vi.fn();
const setSessionUsageGaugeLabels = vi.fn();
const applySettings = vi.fn();
const storedSendSettings: Record<string, unknown> = {
    sessionMessageSendMode: 'agent_queue',
    sessionBusySteerSendPolicy: 'steer_immediately',
};

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettings,
    useApplyLocalSettings: () => vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSettingMutable: (name: string) => {
            if (name === 'newSessionDraftEntryMode') {
                return ['resumePrevious', setNewSessionDraftEntryMode];
            }
            if (name === 'sessionUsageGaugeLabels') {
                return [false, setSessionUsageGaugeLabels];
            }
            if (name === 'sessionInactiveResumePolicy') {
                return ['online_only', setSessionInactiveResumePolicy];
            }
            const defaults: Record<string, unknown> = {
                ...storedSendSettings,
                sessionNonSteerableSendPrompt: 'ask',
                sessionPendingQueueDrainMode: 'one_at_a_time',
                sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
                agentInputEnterToSend: true,
                agentInputEnterToSendNative: false,
                agentInputHistoryScope: 'perSession',
                agentInputActionBarLayout: 'auto',
                agentInputChipDensity: 'auto',
                alwaysShowContextSize: true,
                composerSurfaceStyle: 'standard',
                sessionComposerRememberBannerVisibility: false,
            };
            return [defaults[name], vi.fn()];
        },
    });
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('ItemGroup', props, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));

describe('SessionComposerSettingsView', () => {
    it('offers optional usage gauge labels and persists the choice', async () => {
        const { SessionComposerSettingsView } = await import('./SessionComposerSettingsView');
        const screen = await renderSettingsView(React.createElement(SessionComposerSettingsView));
        const toggle = screen.findRow('settings-session-usage-gauge-labels')?.props.rightElement;

        expect(toggle?.props.value).toBe(false);
        toggle?.props.onValueChange(true);
        expect(setSessionUsageGaugeLabels).toHaveBeenCalledWith(true);
    });

    it('shows explicit resume and fresh ordinary-entry choices and persists the selection', async () => {
        const { SessionComposerSettingsView } = await import('./SessionComposerSettingsView');
        const screen = await renderSettingsView(React.createElement(SessionComposerSettingsView));

        expect(screen.findRow('settings-new-session-draft-entry-resume')?.props.rightElement).toBeTruthy();
        expect(screen.findRowByTitle('Resume previous draft')).toBeTruthy();
        expect(screen.findRowByTitle('Always start fresh')).toBeTruthy();

        screen.pressRowByTitle('Always start fresh');
        expect(setNewSessionDraftEntryMode).toHaveBeenCalledWith('alwaysFresh');
    });

    it('renders the inactive-session resume policy dropdown and persists changes', async () => {
        const { SessionComposerSettingsView } = await import('./SessionComposerSettingsView');
        const screen = await renderSettingsView(React.createElement(SessionComposerSettingsView));
        const menu = screen.findAllByType('DropdownMenu').find((candidate) => (
            candidate.props.itemTrigger?.title === 'Automatic resume after sending'
        ));

        expect(menu?.props).toMatchObject({
            selectedId: 'online_only',
            itemTrigger: {
                title: 'Automatic resume after sending',
            },
        });
        expect(menu?.props.items.map((item: { id: string }) => item.id)).toEqual([
            'when_available',
            'online_only',
            'manual',
        ]);

        menu?.props.onSelect('when_available');
        expect(setSessionInactiveResumePolicy).toHaveBeenCalledWith('when_available');
    });

    it('offers one busy-send choice that maps every stored combination and writes both keys together', async () => {
        const { SessionComposerSettingsView } = await import('./SessionComposerSettingsView');
        const checkedBusySendRows = async () => {
            const screen = await renderSettingsView(React.createElement(SessionComposerSettingsView));
            return {
                screen,
                checked: ['add_to_turn', 'wait_for_turn', 'interrupt']
                    .filter((id) => screen.findRow(`settings-busy-send-${id}`)?.props.rightElement),
            };
        };

        // Legacy "Queue in agent" + steer and the default "Pending until ready" + steer behave identically.
        for (const mode of ['agent_queue', 'server_pending']) {
            storedSendSettings.sessionMessageSendMode = mode;
            storedSendSettings.sessionBusySteerSendPolicy = 'steer_immediately';
            expect((await checkedBusySendRows()).checked).toEqual(['add_to_turn']);
            storedSendSettings.sessionBusySteerSendPolicy = 'server_pending';
            expect((await checkedBusySendRows()).checked).toEqual(['wait_for_turn']);
        }
        storedSendSettings.sessionMessageSendMode = 'interrupt';
        const { screen, checked } = await checkedBusySendRows();
        expect(checked).toEqual(['interrupt']);

        // The separate steer-capable group is gone: one setting controls mid-turn sends.
        expect(screen.findRowByTitle('Steer immediately')).toBeNull();

        applySettings.mockClear();
        screen.findRow('settings-busy-send-add_to_turn')?.props.onPress();
        expect(applySettings).toHaveBeenLastCalledWith({
            sessionMessageSendMode: 'server_pending',
            sessionBusySteerSendPolicy: 'steer_immediately',
        });
        screen.findRow('settings-busy-send-wait_for_turn')?.props.onPress();
        expect(applySettings).toHaveBeenLastCalledWith({
            sessionMessageSendMode: 'server_pending',
            sessionBusySteerSendPolicy: 'server_pending',
        });
        screen.findRow('settings-busy-send-interrupt')?.props.onPress();
        expect(applySettings).toHaveBeenLastCalledWith({ sessionMessageSendMode: 'interrupt' });
        expect(applySettings).toHaveBeenCalledTimes(3);
    });
});
