import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import { useSettingMutable } from '@/sync/store/hooks';
import { getAgentCore } from '@/agents/catalog/catalog';
import { installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';

const confirm = vi.hoisted(() => vi.fn<(...args: Parameters<typeof import('@/modal').Modal.confirm>) => Promise<boolean>>());
installConnectedServicesCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { confirm } }).module;
    },
});

import { ConnectedServicesProviderStateSharingDisclosure } from './ConnectedServicesProviderStateSharingSettings';
import { ProviderStateSharingRows } from './ProviderStateSharingRow';

function SharingControls({ perAgent }: Readonly<{ perAgent: boolean }>) {
    const [settings, setSettings] = useSettingMutable('connectedServicesProviderStateSharingSettingsV1');
    return perAgent ? (
        <ProviderStateSharingRows
            agentId="codex"
            agentTitle="Codex"
            capability={getAgentCore('codex').connectedServices?.providerStateSharing}
            settings={settings}
            setSettings={setSettings}
        />
    ) : (
        <ConnectedServicesProviderStateSharingDisclosure settings={settings} setSettings={setSettings} agentIds={['codex']} />
    );
}

describe('provider state sharing consent', () => {
    let previousState: ReturnType<typeof storage.getState>;
    // Initialize and observe incumbent state; all Sync mutation and scheduling methods stay real.
    type RuntimeState = {
        pendingSettings: Partial<Settings>;
        pendingSettingsFlushTimer: ReturnType<typeof setTimeout> | null;
        pendingSettingsDirty: boolean;
    };
    let runtime: RuntimeState;
    let previousRuntimeState: RuntimeState;

    beforeEach(async () => {
        previousState = storage.getState();
        // The clock is the boundary: retain real debounce/pending logic without dispatching I/O.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        await loadSyncSingletonForTests();
        const { sync } = await import('@/sync/sync');
        runtime = sync as unknown as RuntimeState;
        previousRuntimeState = {
            pendingSettings: runtime.pendingSettings,
            pendingSettingsFlushTimer: runtime.pendingSettingsFlushTimer,
            pendingSettingsDirty: runtime.pendingSettingsDirty,
        };
        runtime.pendingSettings = {};
        runtime.pendingSettingsFlushTimer = null;
        runtime.pendingSettingsDirty = false;
        confirm.mockReset();
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockImplementation(confirm);
        storage.setState({
            settingsScope: { serverId: 'server-a', accountId: 'account-a' },
            settingsVersion: 1,
            settings: settingsParse({}),
        });
    });

    afterEach(() => {
        standardCleanup();
        vi.clearAllTimers();
        if (runtime) Object.assign(runtime, previousRuntimeState);
        vi.useRealTimers();
        storage.setState(previousState, true);
    });

    it.each([
        { surface: 'default', perAgent: false },
        { surface: 'per-agent', perAgent: true },
    ])('preserves concurrent settings while $surface consent is pending', async ({ perAgent }) => {
        const consent = createDeferred<boolean>();
        confirm.mockReturnValue(consent.promise);
        const screen = await renderScreen(<SharingControls perAgent={perAgent} />);
        if (!perAgent) await screen.pressByTestIdAsync('connected-services-provider-state-sharing-toggle');
        const rowId = perAgent
            ? 'connected-services-provider-state-sharing-agent-codex-state'
            : 'connected-services-provider-state-sharing-state-default';
        const row = screen.tree.root.findAllByProps({ testID: rowId })[0]!;
        let pending: Promise<void> | undefined;
        await act(async () => {
            pending = row.props.rightElement.props.onValueChange(true);
        });
        expect(confirm).toHaveBeenCalledOnce();

        await act(async () => {
            const current = storage.getState().settings.connectedServicesProviderStateSharingSettingsV1;
            storage.getState().applySettingsLocal({
                connectedServicesProviderStateSharingSettingsV1: {
                    ...current,
                    defaults: { configMode: 'copied', stateMode: 'isolated' },
                    byAgentId: { claude: { configMode: 'isolated' }, codex: { configMode: 'copied' } },
                    acknowledgedRisksByAgentId: { claude: { sharedStatePrivacy: true } },
                },
            });
        });
        await act(async () => {
            consent.resolve(true);
            await pending;
        });

        expect(storage.getState().settings.connectedServicesProviderStateSharingSettingsV1).toEqual({
            v: 1,
            defaults: { configMode: 'copied', stateMode: perAgent ? 'isolated' : 'shared' },
            byAgentId: {
                claude: { configMode: 'isolated' },
                codex: { configMode: 'copied', ...(perAgent ? { stateMode: 'shared' } : {}) },
            },
            acknowledgedRisksByAgentId: {
                claude: { sharedStatePrivacy: true },
                codex: { sharedStatePrivacy: true },
            },
        });
        expect(runtime.pendingSettings.connectedServicesProviderStateSharingSettingsV1)
            .toEqual(storage.getState().settings.connectedServicesProviderStateSharingSettingsV1);
    });

    it.each([
        { surface: 'default', perAgent: false },
        { surface: 'per-agent', perAgent: true },
    ])('keeps settings unchanged when $surface consent is declined', async ({ perAgent }) => {
        confirm.mockResolvedValue(false);
        const screen = await renderScreen(<SharingControls perAgent={perAgent} />);
        if (!perAgent) await screen.pressByTestIdAsync('connected-services-provider-state-sharing-toggle');
        const rowId = perAgent
            ? 'connected-services-provider-state-sharing-agent-codex-state'
            : 'connected-services-provider-state-sharing-state-default';
        const before = storage.getState().settings.connectedServicesProviderStateSharingSettingsV1;

        await act(async () => {
            await screen.tree.root.findAllByProps({ testID: rowId })[0]!.props.rightElement.props.onValueChange(true);
        });

        expect(confirm).toHaveBeenCalledOnce();
        expect(storage.getState().settings.connectedServicesProviderStateSharingSettingsV1).toBe(before);
        expect(runtime.pendingSettings).toEqual({});
    });
});
