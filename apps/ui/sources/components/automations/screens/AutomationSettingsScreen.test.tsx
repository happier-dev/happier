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
const activeAccountState = vi.hoisted(() => ({
    scope: { serverId: 'server-1', accountId: 'account-a' } as { serverId: string; accountId: string } | null,
    lifetime: null as null | Readonly<{
        scope: { serverId: string; accountId: string };
        isCurrent: () => boolean;
        onRetire: (cancel: () => void) => Readonly<{ dispose(): void }>;
    }>,
}));

function installActiveAccount(accountId: string) {
    const scope = { serverId: 'server-1', accountId };
    let current = true;
    const retirementCallbacks = new Set<() => void>();
    const lifetime = {
        scope,
        isCurrent: () => current,
        onRetire: (cancel: () => void) => {
            retirementCallbacks.add(cancel);
            return { dispose: () => retirementCallbacks.delete(cancel) };
        },
    };
    activeAccountState.scope = scope;
    activeAccountState.lifetime = lifetime;
    return {
        retire() {
            current = false;
            for (const callback of retirementCallbacks) callback();
            retirementCallbacks.clear();
        },
    };
}

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
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useActiveServerAccountScope: () => activeAccountState.scope,
        });
    },
});

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => activeAccountState.lifetime,
}));

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
        installActiveAccount('account-a');
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

    it('retires stale Account work and reloads settings for the newly active Account', async () => {
        const accountASettings = createDeferred<{ maxActiveRunsPerMachine: number; runRetention: 'thirtyDays' }>();
        const accountBSettings = { maxActiveRunsPerMachine: 2, runRetention: 'keepForever' as const };
        syncSpies.getAutomationSettings
            .mockReset()
            .mockReturnValueOnce(accountASettings.promise)
            .mockResolvedValueOnce(accountBSettings);
        const accountA = installActiveAccount('account-a');
        const { AutomationSettingsScreen } = await import('./AutomationSettingsScreen');

        const screen = await renderScreen(<AutomationSettingsScreen />);
        await flushHookEffects();
        expect(syncSpies.getAutomationSettings).toHaveBeenCalledTimes(1);

        accountA.retire();
        installActiveAccount('account-b');
        await screen.update(<AutomationSettingsScreen />);
        await flushHookEffects();

        expect(syncSpies.getAutomationSettings).toHaveBeenCalledTimes(2);
        expect(screen.findByProps({ testID: 'automation-settings-max-active-runs' }).props.detail).toBe('2');

        accountASettings.resolve({ maxActiveRunsPerMachine: 9, runRetention: 'thirtyDays' });
        await act(async () => {
            await accountASettings.promise;
            await Promise.resolve();
        });
        expect(screen.findByProps({ testID: 'automation-settings-max-active-runs' }).props.detail).toBe('2');
    });
});
