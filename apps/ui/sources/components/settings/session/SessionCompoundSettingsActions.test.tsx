import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { renderSettingsView, type SettingsViewHarness } from '@/dev/testkit/harness/settingsViewHarness';
import { standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { getCurrentAuth, setCurrentAuth } from '@/auth/context/currentAuth';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { SessionHandoffSettingsView } = await import('./SessionHandoffSettingsView');
const { ToolRenderingSettingsView } = await import('./ToolRenderingSettingsView');
const { SessionProviderLimitsSettingsView } = await import('./SessionProviderLimitsSettingsView');
const { ProviderUsageGaugeSettingsGroup } = await import('@/components/settings/connectedServices/ProviderUsageGaugeSettingsGroup');

const originalState = storage.getState();
let previousAuth: ReturnType<typeof getCurrentAuth>;
beforeEach(() => { previousAuth = getCurrentAuth(); });
afterEach(() => { standardCleanup(); setCurrentAuth(previousAuth); storage.setState(originalState, true); });

function control(screen: SettingsViewHarness, testID: string, handler: string): ReactTestInstance {
    const match = screen.findAll(node => (node.props.testID === testID || node.props.itemTrigger?.itemProps?.testID === testID)
        && typeof node.props[handler] === 'function')[0];
    if (!match) throw new Error(`Missing ${testID} ${handler} control`);
    return match;
}

function expectPreferences(actual: Settings, expected: Readonly<Record<string, unknown>>) {
    for (const [key, value] of Object.entries(expected)) expect(actual[key as keyof Settings], key).toEqual(value);
}

function ConnectedServicesGauge() {
    return <ProviderUsageGaugeSettingsGroup />;
}

const handoffDefaults = {
    v: 1, workspaceSyncMode: 'keep_synced', includeIgnoredMode: 'include_selected',
    ignoredIncludeGlobs: ['dist/**'], directTargetMode: 'keep_direct',
} as const;
const recoveryDefaults = {
    v: 1, mode: 'ask', promptMode: 'standard', resumePromptMode: 'custom', customResumePrompt: 'Keep the current task.',
} as const;

type Scenario = Readonly<{
    name: string;
    Component: React.ComponentType;
    initial: Readonly<Record<string, unknown>>;
    changed: Readonly<Record<string, unknown>>;
    neighborChanged: Readonly<Record<string, unknown>>;
    choose(screen: SettingsViewHarness): void;
    neighbor(screen: SettingsViewHarness): void;
}>;

const scenarios: readonly Scenario[] = [
    {
        name: 'Handoff defaults', Component: SessionHandoffSettingsView,
        initial: { sessionHandoffDefaultsV1: handoffDefaults },
        changed: { sessionHandoffDefaultsV1: { ...handoffDefaults, workspaceSyncMode: 'copy_once' } },
        neighborChanged: { sessionHandoffDefaultsV1: { ...handoffDefaults, workspaceSyncMode: 'copy_once', directTargetMode: 'convert_to_persisted' } },
        choose: screen => { control(screen, 'session-handoff-workspace-sync-mode-trigger', 'onChange').props.onChange('copy_once'); },
        neighbor: screen => { control(screen, 'session-handoff-direct-target-mode', 'onChange').props.onChange('convert_to_persisted'); },
    },
    {
        name: 'collapsed tool detail overrides', Component: ToolRenderingSettingsView,
        initial: { toolViewDetailLevelByToolName: { Bash: 'summary', Read: 'title' }, toolViewExpandedDetailLevelByToolName: { Read: 'summary' } },
        changed: { toolViewDetailLevelByToolName: { Bash: 'full', Read: 'title' }, toolViewExpandedDetailLevelByToolName: { Read: 'summary' } },
        neighborChanged: { toolViewDetailLevelByToolName: { Read: 'title' }, toolViewExpandedDetailLevelByToolName: { Read: 'summary' } },
        choose: screen => { control(screen, 'settings-tool-rendering-collapsed-Bash', 'onSelect').props.onSelect('full'); },
        neighbor: screen => { control(screen, 'settings-tool-rendering-collapsed-Bash', 'onSelect').props.onSelect('default'); },
    },
    {
        name: 'expanded tool detail overrides', Component: ToolRenderingSettingsView,
        initial: { toolViewDetailLevelByToolName: { Bash: 'title' }, toolViewExpandedDetailLevelByToolName: { Bash: 'summary', Read: 'summary' } },
        changed: { toolViewDetailLevelByToolName: { Bash: 'title' }, toolViewExpandedDetailLevelByToolName: { Bash: 'full', Read: 'summary' } },
        neighborChanged: { toolViewDetailLevelByToolName: { Bash: 'title' }, toolViewExpandedDetailLevelByToolName: { Read: 'summary' } },
        choose: screen => { control(screen, 'settings-tool-rendering-expanded-Bash', 'onChange').props.onChange('full'); },
        neighbor: screen => { control(screen, 'settings-tool-rendering-expanded-Bash', 'onChange').props.onChange('default'); },
    },
    {
        name: 'Provider recovery', Component: SessionProviderLimitsSettingsView,
        initial: { usageLimitRecoverySettingsV1: recoveryDefaults },
        changed: { usageLimitRecoverySettingsV1: { ...recoveryDefaults, mode: 'auto_wait' } },
        neighborChanged: { usageLimitRecoverySettingsV1: { ...recoveryDefaults, mode: 'auto_wait', resumePromptMode: 'off' } },
        choose: screen => { control(screen, 'settings-session-usage-limit-recovery', 'onPress').props.onPress(); },
        neighbor: screen => { control(screen, 'settings-session-usage-limit-recovery-resume-prompt', 'onChange').props.onChange('off'); },
    },
    ...[ProviderUsageGaugeSettingsGroup, ConnectedServicesGauge].map(Component => ({
        name: Component === ProviderUsageGaugeSettingsGroup ? 'Sessions gauge windows' : 'Connected Services gauge windows', Component,
        initial: { sessionProviderUsageGaugeWindowModes: ['daily'], sessionUsageGaugeLabels: true, usageRoutingHintsEnabled: true },
        changed: { sessionProviderUsageGaugeWindowModes: ['daily', 'weekly'], sessionUsageGaugeLabels: true, usageRoutingHintsEnabled: true },
        neighborChanged: { sessionProviderUsageGaugeWindowModes: ['daily', 'weekly'], sessionUsageGaugeLabels: false, usageRoutingHintsEnabled: true },
        choose: (screen: SettingsViewHarness) => { control(screen, 'settings-session-providerUsageGauge-window-trigger', 'onCommit').props.onCommit(['daily', 'weekly']); },
        neighbor: (screen: SettingsViewHarness) => { control(screen, 'settings-session-providerUsageGauge-labels', 'onPress').props.onPress(); },
    })),
];

describe('compound Session preference Action ingress', () => {
    it('keeps both tool choices when another row is changed before the first Action settles', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            toolViewDetailLevelByToolName: { Bash: 'summary', Read: 'title' },
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        try {
            const screen = await renderSettingsView(<ToolRenderingSettingsView />);
            await act(async () => {
                control(screen, 'settings-tool-rendering-collapsed-Bash', 'onSelect').props.onSelect('full');
                control(screen, 'settings-tool-rendering-collapsed-Read', 'onSelect').props.onSelect('full');
            });
            await vi.waitFor(() => expect(account.persistedSettings.toolViewDetailLevelByToolName).toEqual({ Bash: 'full', Read: 'full' }));
            expect(storage.getState().settings.toolViewDetailLevelByToolName).toEqual({ Bash: 'full', Read: 'full' });
        } finally { standardCleanup(); await account.dispose(); }
    });

    it.each(scenarios)('admits $name under Off, Ask/rejection/approval and Allowed without replacing neighbors', async scenario => {
        const account = await createSecretSettingsTestHarness({
            settings: settingsParse({ ...scenario.initial, actionsSettingsV1: { v: 1,
                actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } }),
            features: createRootLayoutFeaturesResponse({ features: { sessions: { usageLimitRecovery: { enabled: true } } } }),
        });
        try {
            const screen = await renderSettingsView(<scenario.Component />);
            await act(async () => { scenario.choose(screen); });
            expectPreferences(account.persistedSettings, scenario.initial);
            expect(account.settingsWrites).toEqual([]);

            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
            })); });
            await act(async () => { scenario.choose(screen); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expectPreferences(account.persistedSettings, scenario.initial);
            await act(async () => { await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'reject'); });
            expectPreferences(account.persistedSettings, scenario.initial);
            expect(account.settingsWrites).toEqual([]);

            await act(async () => { scenario.choose(screen); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(2));
            await act(async () => { await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[1]!.id, 'approve'); });
            await vi.waitFor(() => expectPreferences(account.persistedSettings, scenario.changed));
            expectPreferences(storage.getState().settings, scenario.changed);

            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            await act(async () => { scenario.neighbor(screen); });
            await vi.waitFor(() => expectPreferences(account.persistedSettings, scenario.neighborChanged));
            expectPreferences(storage.getState().settings, scenario.neighborChanged);
            expect(account.artifacts.list()).toHaveLength(2);
        } finally { standardCleanup(); await account.dispose(); }
    });
});
