import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { useMachineVitalsRange } = await import('./MachineVitalsRangeBar');
const { storage } = await import('@/sync/domains/state/storageStore');
const { clearPersistenceStorage, getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');

beforeEach(() => { clearPersistenceStorage(); storage.setState(storage.getInitialState(), true); });
afterEach(() => { standardCleanup(); storage.setState(storage.getInitialState(), true); clearPersistenceStorage(); });

it('shares and remembers the global device range without changing Settings snapshots or version', async () => {
    const first = await renderHook(useMachineVitalsRange);
    const second = await renderHook(useMachineVitalsRange);
    const before = storage.getState();
    const device = getPersistenceStorage();
    const localBytes = device.getString('local-settings');
    const accountBytes = device.getString('settings');
    expect(first.getCurrent()[0]).toBe('1h');
    expect(second.getCurrent()[0]).toBe('1h');
    await act(async () => first.getCurrent()[1]('24h'));
    expect(first.getCurrent()[0]).toBe('24h');
    expect(second.getCurrent()[0]).toBe('24h');
    expect(storage.getState().localSettings).toBe(before.localSettings);
    expect(storage.getState().settings).toBe(before.settings);
    expect(storage.getState().settingsVersion).toBe(before.settingsVersion);
    expect(device.getString('local-settings')).toBe(localBytes);
    expect(device.getString('settings')).toBe(accountBytes);
    await first.unmount(); await second.unmount();
    const reopened = await renderHook(useMachineVitalsRange);
    expect(reopened.getCurrent()[0]).toBe('24h');
    await reopened.unmount();
});
