import { describe, expect, it } from 'vitest';

import { localSettingsParse, type LocalSettings } from '@/sync/domains/settings/localSettings';
import type { SettingValue } from '@/components/settings/catalog/settingDeclarations';
import { notificationDeviceQuietHoursStorageBinding as binding } from './notificationPreferences';

function localQuietHoursBinding() {
    const owner = binding;
    if (owner.scope !== 'local' || !('kind' in owner) || owner.kind !== 'localOwner')
        throw new Error('Expected the canonical local quiet-hours authoring adapter');
    return owner;
}

describe('device quiet-hours authoring', () => {
    it.each<{ name: string; value: SettingValue }>([
        { name: 'unevaluable timezone', value: { mode: 'custom', timezone: 'Not/A_Timezone', windows: [] } },
        { name: 'missing schedule fields', value: { mode: 'custom' } },
        { name: 'unknown mode fields', value: { mode: 'disabled', timezone: 'UTC' } },
    ])('rejects $name without committing a defaulted or altered schedule', ({ value }) => {
        const owner = localQuietHoursBinding();
        const local = localSettingsParse({});
        const writes: Partial<LocalSettings>[] = [];
        expect(owner.parse(value)).toEqual({ success: false });
        owner.commit(local, value, delta => writes.push(delta));
        expect(writes).toEqual([]);
    });

    it('authors the same exact windows, days and timezone while retaining neighboring device preferences', () => {
        const owner = localQuietHoursBinding();
        const local = localSettingsParse({ sidebarCollapsed: true });
        const value: SettingValue = { mode: 'custom', timezone: 'Europe/Amsterdam', windows: [
            { startLocalTime: '22:30', endLocalTime: '06:45', days: ['mon', 'fri'] },
            { startLocalTime: '12:00', endLocalTime: '13:00' },
        ] };
        expect(owner.parse(value)).toEqual({ success: true, value });
        const writes: Partial<LocalSettings>[] = [];
        owner.commit(local, value, delta => writes.push(delta));
        expect(writes).toEqual([{ attentionDeviceOverridesV1: {
            ...local.attentionDeviceOverridesV1, quietHoursOverride: value,
        } }]);
        for (const mode of ['account', 'disabled']) expect(owner.parse({ mode })).toEqual({ success: true, value: { mode } });
        // Persisted predecessors remain readable; only new authoring is closed.
        expect(localSettingsParse({ attentionDeviceOverridesV1: { quietHoursOverride: { mode: 'custom' } } })
            .attentionDeviceOverridesV1.quietHoursOverride).toEqual({ mode: 'custom', timezone: 'UTC', windows: [] });
    });
});
