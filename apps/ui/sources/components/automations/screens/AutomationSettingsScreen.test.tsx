import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createPassThroughComponent, createPassThroughModule } from '@/dev/testkit/mocks/components';

import { installAutomationScreensCommonModuleMocks } from './automationScreensTestHelpers';

const syncSpies = vi.hoisted(() => ({
    getAutomationSettings: vi.fn(),
    updateAutomationSettings: vi.fn(),
}));
const modalPromptSpy = vi.hoisted(() => vi.fn());
const modalAlertSpy = vi.hoisted(() => vi.fn());

installAutomationScreensCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: modalPromptSpy,
                alert: modalAlertSpy,
            },
        }).module;
    },
});

vi.mock('@/sync/sync', () => ({ sync: syncSpies }));
vi.mock('@/components/ui/lists/Item', () => createPassThroughModule(['Item']));
vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));
vi.mock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemList']));
vi.mock('@/components/ui/forms/Switch', () => createPassThroughModule(['Switch']));
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({
    ActivitySpinner: createPassThroughComponent('ActivitySpinner'),
}));
vi.mock('@/components/ui/surfaces/SurfaceStateCard', () => ({
    SurfaceStateCard: createPassThroughComponent('SurfaceStateCard'),
}));

describe('AutomationSettingsScreen', () => {
    beforeEach(() => {
        syncSpies.getAutomationSettings.mockReset();
        syncSpies.getAutomationSettings.mockResolvedValue({
            maxActiveRunsPerMachine: 4,
            runRetention: 'thirtyDays',
        });
        syncSpies.updateAutomationSettings.mockReset();
        syncSpies.updateAutomationSettings.mockImplementation(async (settings) => settings);
        modalPromptSpy.mockReset();
        modalPromptSpy.mockResolvedValue('2');
        modalAlertSpy.mockReset();
    });

    it('loads the server settings projection and applies both controls through the canonical Sync owner', async () => {
        const { AutomationSettingsScreen } = await import('./AutomationSettingsScreen');

        const screen = await renderScreen(<AutomationSettingsScreen />);
        await flushHookEffects();

        expect(syncSpies.getAutomationSettings).toHaveBeenCalledOnce();
        const maxActiveRuns = screen.findByProps({ testID: 'automation-settings-max-active-runs' });
        expect(maxActiveRuns.props.detail).toBe('4');

        await act(async () => {
            maxActiveRuns.props.onPress();
            await Promise.resolve();
        });

        expect(modalPromptSpy).toHaveBeenCalledWith(
            'automations.settings.maxActiveRunsPerMachine',
            'automations.settings.maxActiveRunsPerMachinePrompt',
            expect.objectContaining({ defaultValue: '4', inputType: 'numeric' }),
        );
        expect(syncSpies.updateAutomationSettings).toHaveBeenCalledWith({
            maxActiveRunsPerMachine: 2,
            runRetention: 'thirtyDays',
        });

        const retentionItem = screen.findByProps({ testID: 'automation-settings-run-retention' });
        const retentionSwitch = retentionItem.props.rightElement as React.ReactElement<{ onValueChange: (value: boolean) => void }>;
        await act(async () => {
            retentionSwitch.props.onValueChange(true);
            await Promise.resolve();
        });

        expect(syncSpies.updateAutomationSettings).toHaveBeenLastCalledWith({
            maxActiveRunsPerMachine: 2,
            runRetention: 'keepForever',
        });
    });

    it('does not commit a prompt result after the route has retired', async () => {
        const prompt = createDeferred<string | null>();
        modalPromptSpy.mockReturnValueOnce(prompt.promise);
        const { AutomationSettingsScreen } = await import('./AutomationSettingsScreen');

        const screen = await renderScreen(<AutomationSettingsScreen />);
        await flushHookEffects();
        const maxActiveRuns = screen.findByProps({ testID: 'automation-settings-max-active-runs' });

        await act(async () => {
            maxActiveRuns.props.onPress();
            await Promise.resolve();
        });
        await screen.unmount();

        prompt.resolve('2');
        await act(async () => {
            await prompt.promise;
            await Promise.resolve();
        });

        expect(syncSpies.updateAutomationSettings).not.toHaveBeenCalled();
    });
});
