import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { storage } from '@/sync/domains/state/storage';
import { localSettingsDefaults, localSettingsParse } from '@/sync/domains/settings/localSettings';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const originalState = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(originalState, true); });

describe('right panel separation Action (calm-shell R4-2, R11-3)', () => {
    it('is a device layout preference an agent reads and sets without approval, Shadow by default (owner 11-01)', async () => {
        expect(localSettingsDefaults.rightPanelPlacement).toBe('shadow');
        const account = await createSecretSettingsTestHarness({});
        try {
            const executor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => null });
            const context = { surface: 'agent', serverId: account.scope.serverId, authority: 'account_automation', actionCaller: { kind: 'host' } } as const;
            await act(async () => {
                expect(await executor.execute('settings.get', { anchor: 'appearance.rightPanelPlacement' }, context))
                    .toMatchObject({ ok: true, result: expect.objectContaining({ value: 'shadow' }) });
            });
            for (const value of ['line', 'shadow', 'separate'] as const) {
                await act(async () => {
                    expect(await executor.execute('settings.set', { anchor: 'appearance.rightPanelPlacement', value }, context)).toMatchObject({ ok: true });
                });
                expect(storage.getState().localSettings.rightPanelPlacement).toBe(value);
            }
            // The retired values and anything else are refused; the stored choice stays.
            for (const value of ['sheet', 'canvas', 'floating']) {
                await act(async () => {
                    expect(await executor.execute('settings.set', { anchor: 'appearance.rightPanelPlacement', value }, context)).toMatchObject({ ok: false });
                });
            }
            expect(storage.getState().localSettings.rightPanelPlacement).toBe('separate');
            // A personal layout choice: no approval request was raised, no Account setting written.
            expect(account.artifacts.list()).toEqual([]);
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('reads a stored placement from before the separation choice: the canvas stays Separate, the sheet becomes Line', () => {
        expect(localSettingsParse({ rightPanelPlacement: 'canvas' }).rightPanelPlacement).toBe('separate');
        expect(localSettingsParse({ rightPanelPlacement: 'sheet' }).rightPanelPlacement).toBe('line');
        expect(localSettingsParse({ rightPanelPlacement: 'shadow' }).rightPanelPlacement).toBe('shadow');
        // An unknown value reads as the default.
        expect(localSettingsParse({ rightPanelPlacement: 'sideways' }).rightPanelPlacement).toBe('shadow');
    });
});
