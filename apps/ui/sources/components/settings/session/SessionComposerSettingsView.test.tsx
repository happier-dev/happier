import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';

const setNewSessionDraftEntryMode = vi.fn();

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSettingMutable: (name: string) => {
            if (name === 'newSessionDraftEntryMode') {
                return ['resumePrevious', setNewSessionDraftEntryMode];
            }
            const defaults: Record<string, unknown> = {
                sessionMessageSendMode: 'agent_queue',
                sessionBusySteerSendPolicy: 'steer_immediately',
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
    DropdownMenu: () => null,
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));

describe('SessionComposerSettingsView', () => {
    it('shows explicit resume and fresh ordinary-entry choices and persists the selection', async () => {
        const { SessionComposerSettingsView } = await import('./SessionComposerSettingsView');
        const screen = await renderSettingsView(React.createElement(SessionComposerSettingsView));

        expect(screen.findRow('settings-new-session-draft-entry-resume')?.props.rightElement).toBeTruthy();
        expect(screen.findRowByTitle('Resume previous draft')).toBeTruthy();
        expect(screen.findRowByTitle('Always start fresh')).toBeTruthy();

        screen.pressRowByTitle('Always start fresh');
        expect(setNewSessionDraftEntryMode).toHaveBeenCalledWith('alwaysFresh');
    });
});
