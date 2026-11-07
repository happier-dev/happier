import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { renderHook, renderScreen, renderSettingsView, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { useSettingActionWriter } from './useSettingActionWriter';
import { getPreferredLanguage, setPreferredLanguageFromSettings } from '@/text/i18n';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
// Expo's native OTA/reload API is a platform boundary; the language and Settings owners stay real.
vi.mock('expo-updates', () => ({ useUpdates: () => ({}), reloadAsync: vi.fn() }));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { LanguageSettingsScreen } = await import('@/app/(app)/settings/language');
const { WorkspaceRouteBody: FeaturesSettingsScreen } = await import('@/app/(app)/settings/features');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { SettingsView } = await import('@/components/settings/SettingsView');
const { default: DevScreen } = await import('@/app/(app)/dev');
const { HomesDeviceScreen } = await import('@/components/settings/server/collection/HomesDeviceScreen');
const { HomesCollectionProvider } = await import('@/components/settings/server/collection/HomesCollection');
const originalState = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(originalState, true); setPreferredLanguageFromSettings('en'); vi.unstubAllGlobals(); });

const choices = [
    { anchor: 'settings.developerMode', value: true, read: () => storage.getState().localSettings.devModeEnabled },
    { anchor: 'diagnosis.debugMode', value: true, read: () => storage.getState().localSettings.debugMode },
    { anchor: 'servers.standardOnly', value: true, read: () => storage.getState().localSettings.homeApplicationCarrierEligibility === 'standard_only' },
] as const;

describe('remaining preference Action ingress', () => {
    it.each(choices)('the mounted $anchor control uses its declared preference ingress', async choice => {
        const baseline = settingsParse({ actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } });
        const account = await createSecretSettingsTestHarness({ mode: 'e2ee', settings: baseline });
        storage.getState().applyLocalSettings({ devModeEnabled: false, debugMode: false, homeApplicationCarrierEligibility: 'automatic' });
        try {
            const screen = await renderSettingsView(<InjectedAuthProvider credentials={account.credentials}>
                {choice.anchor === 'settings.developerMode' ? <SettingsView />
                    : choice.anchor === 'diagnosis.debugMode' ? <DevScreen />
                        : <HomesCollectionProvider><HomesDeviceScreen /></HomesCollectionProvider>}
            </InjectedAuthProvider>);
            const change = async () => {
                if (choice.anchor === 'settings.developerMode') {
                    await vi.waitFor(() => expect(screen.tree.findAll(node => node.props.setting?.anchor === 'settings.version'
                        && typeof node.props.onPress === 'function').length).toBeGreaterThan(0));
                    for (let click = 0; click < 10; click++) {
                        await act(async () => { screen.tree.findAll(node => node.props.setting?.anchor === 'settings.version'
                            && typeof node.props.onPress === 'function')[0]!.props.onPress(); });
                    }
                } else if (choice.anchor === 'diagnosis.debugMode') {
                    await act(async () => { screen.tree.findAll(node => node.props.title === 'Debug Mode'
                        && node.props.rightElement)[0]!.props.rightElement.props.onValueChange(true); });
                } else {
                    await act(async () => { screen.tree.findAll(node => node.props.testID === 'settings.server.standardOnly.switch'
                        && typeof node.props.onValueChange === 'function')[0]!.props.onValueChange(true); });
                }
            };
            await change();
            expect(choice.read()).toBe(false);
            await act(async () => { account.replaceSettings(settingsParse({ ...baseline,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            await change();
            await vi.waitFor(() => expect(choice.read()).toBe(true));
            if (choice.anchor === 'settings.developerMode') expect(screen.tree.findAll(node =>
                node.props.setting?.anchor === 'settings.supportUs').length).toBeGreaterThan(0);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it.each(choices)('$anchor obeys Off, Ask reject/approve and Allowed through real Settings wiring', async choice => {
        const baseline = settingsParse({ actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } });
        const account = await createSecretSettingsTestHarness({ settings: baseline });
        storage.getState().applyLocalSettings({ devModeEnabled: false, debugMode: false, homeApplicationCarrierEligibility: 'automatic', uiFontScale: 1 });
        try {
            const hook = await renderHook(() => useSettingActionWriter());
            const write = () => hook.getCurrent()({ anchor: choice.anchor }, choice.value);
            await act(async () => { expect(await write()).toMatchObject({ ok: false }); });
            expect(choice.read()).toBe(false);
            await act(async () => { account.replaceSettings(settingsParse({ ...baseline,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
            })); });
            await act(async () => { void write(); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(choice.read()).toBe(false);
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'reject');
            expect(choice.read()).toBe(false);
            await act(async () => { void write(); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(2));
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[1]!.id, 'approve');
            await vi.waitFor(() => expect(choice.read()).toBe(true));
            expect(storage.getState().localSettings.uiFontScale).toBe(1);
            await act(async () => { account.replaceSettings(settingsParse({ ...baseline,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui', 'agent', 'mcp'] } },
            })); });
            await act(async () => { expect(await hook.getCurrent()({ anchor: choice.anchor }, false)).toMatchObject({ ok: true }); });
            expect(choice.read()).toBe(false);
            await act(async () => { expect(await hook.getCurrent()({ anchor: choice.anchor }, 'true')).toMatchObject({ ok: false }); });
            expect(choice.read()).toBe(false);
            const executor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => null });
            for (const surface of ['agent', 'mcp'] as const) {
                const value = surface === 'agent';
                await act(async () => { expect(await executor.execute('settings.set', { anchor: choice.anchor, value }, {
                    surface, serverId: account.scope.serverId, authority: 'account_automation', actionCaller: { kind: 'host' },
                })).toMatchObject({ ok: true }); });
                expect(choice.read()).toBe(value);
            }
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it.each(['language', 'experiments', 'feature'] as const)('mounted %s control retains state until admission and applies the real preference', async control => {
        const baseline = settingsParse({ preferredLanguage: 'en', experiments: false, featureToggles: { voice: false },
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        });
        const account = await createSecretSettingsTestHarness({ settings: baseline,
            features: createRootLayoutFeaturesResponse({ features: { voice: { enabled: true } } }) });
        try {
            const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}>
                {control === 'language' ? <LanguageSettingsScreen /> : <FeaturesSettingsScreen />}
            </InjectedAuthProvider>);
            const id = control === 'language' ? 'settings-language-option-fr'
                : control === 'experiments' ? 'settings-feature-experiments-toggle' : 'settings-feature-toggle-voice';
            const change = () => {
                const node = screen.tree.findAll(node => node.props.testID === id &&
                    typeof node.props[control === 'language' ? 'onPress' : 'onValueChange'] === 'function')[0]!;
                return control === 'language' ? node.props.onPress() : node.props.onValueChange(true);
            };
            const read = () => control === 'language' ? account.persistedSettings.preferredLanguage
                : control === 'experiments' ? account.persistedSettings.experiments : account.persistedSettings.featureToggles.voice ?? false;
            const before = control === 'language' ? 'en' : false;
            const after = control === 'language' ? 'fr' : true;
            await act(async () => { await change(); });
            expect(read()).toBe(before);
            expect(getPreferredLanguage()).toBe('en');
            await act(async () => { account.replaceSettings(settingsParse({ ...baseline,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
            })); });
            await act(async () => { void change(); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(read()).toBe(before);
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'reject');
            expect(read()).toBe(before);
            await act(async () => { void change(); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(2));
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[1]!.id, 'approve');
            await vi.waitFor(() => expect(read()).toBe(after));
            if (control === 'language') await vi.waitFor(() => expect(getPreferredLanguage()).toBe('fr'));
            expect(account.persistedSettings.memoryUseInNewSessions).toBe(baseline.memoryUseInNewSessions);
            await act(async () => { account.replaceSettings(settingsParse({ ...baseline,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            await act(async () => { await change(); });
            await vi.waitFor(() => expect(read()).toBe(after));
            // Standard default-on Subagents has no Experiments-owned stored choice (1174c0aa03).
            if (control === 'experiments') expect(account.persistedSettings.featureToggles).not.toHaveProperty('execution.runs');
        } finally { standardCleanup(); await account.dispose(); }
    });
});
