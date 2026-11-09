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

describe('needs-you highlight Action (owner ruling 2026-11-01, calm session list)', () => {
    it('is a device-local preference an agent reads and sets without approval, Dot by default', async () => {
        expect(localSettingsDefaults.sessionListNeedsYouHighlight).toBe('dot');
        const account = await createSecretSettingsTestHarness({});
        try {
            const executor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => null });
            const context = { surface: 'agent', serverId: account.scope.serverId, authority: 'account_automation', actionCaller: { kind: 'host' } } as const;
            const anchor = 'appearance.sessionListNeedsYouHighlight';
            await act(async () => {
                expect(await executor.execute('settings.get', { anchor }, context))
                    .toMatchObject({ ok: true, result: expect.objectContaining({ value: 'dot' }) });
            });
            for (const value of ['accent', 'glint', 'shimmer', 'pulse', 'dot'] as const) {
                await act(async () => {
                    expect(await executor.execute('settings.set', { anchor, value }, context)).toMatchObject({ ok: true });
                });
                expect(storage.getState().localSettings.sessionListNeedsYouHighlight).toBe(value);
            }
            await act(async () => {
                expect(await executor.execute('settings.set', { anchor, value: 'confetti' }, context)).toMatchObject({ ok: false });
            });
            expect(storage.getState().localSettings.sessionListNeedsYouHighlight).toBe('dot');
            expect(account.artifacts.list()).toEqual([]);
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('reads an unknown stored value as the default', () => {
        expect(localSettingsParse({ sessionListNeedsYouHighlight: 'confetti' }).sessionListNeedsYouHighlight).toBe('dot');
        expect(localSettingsParse({ sessionListNeedsYouHighlight: 'shimmer' }).sessionListNeedsYouHighlight).toBe('shimmer');
    });
});
