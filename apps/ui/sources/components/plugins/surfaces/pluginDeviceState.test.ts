import { MMKV } from 'react-native-mmkv';
import { expect, it, vi } from 'vitest';
import { createPluginDeviceState } from './pluginDeviceState';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});

it('keeps deliberate device drafts in the mounted Home/Account/occurrence namespace and removes explicitly', () => {
    // Persistent storage is the system boundary; domain namespacing and operations remain real.
    const values = new Map<string, string>();
    const storage = { getString: (key: string) => values.get(key), set: (key: string, value: string) => { values.set(key, value); }, delete: (key: string) => { values.delete(key); } };
    const own = createPluginDeviceState(storage, ['home', 'account', 'plugin', 'workbench']);
    const other = createPluginDeviceState(storage, ['home', 'other-account', 'plugin', 'workbench']);
    own({ operation: 'write', key: 'target', value: { sql: 'select 1', history: [] } });
    expect(own({ operation: 'read', key: 'target' })).toEqual({ status: 'ready', value: { sql: 'select 1', history: [] } });
    expect(other({ operation: 'read', key: 'target' })).toEqual({ status: 'ready', value: null });
    own({ operation: 'remove', key: 'target' });
    expect(own({ operation: 'read', key: 'target' })).toEqual({ status: 'ready', value: null });
});

it('keeps a structured draft written by an existing native client readable and removable', () => {
    const storage = new MMKV({ id: 'plugin-device-state-native-test' });
    const namespace = ['home', 'account', 'plugin', 'workbench'];
    const key = JSON.stringify(['database-console', 'machine', { kind: 'manual' }]);
    const previousNativeKey = `plugin-device-state:${JSON.stringify([...namespace, key])}`;
    const draft = { sql: 'select 1', history: [{ sql: 'select 1' }] };
    storage.set(previousNativeKey, JSON.stringify(draft));

    const request = createPluginDeviceState(storage, namespace);
    expect(request({ operation: 'read', key })).toEqual({ status: 'ready', value: draft });
    request({ operation: 'remove', key });
    expect(storage.getString(previousNativeKey)).toBeUndefined();
});
