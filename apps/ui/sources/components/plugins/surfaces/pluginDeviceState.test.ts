import { expect, it } from 'vitest';
import { createPluginDeviceState } from './pluginDeviceState';

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
