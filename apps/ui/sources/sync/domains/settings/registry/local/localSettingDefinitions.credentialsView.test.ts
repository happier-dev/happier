import { describe, expect, it } from 'vitest';

import { localSettingsParse } from '@/sync/domains/settings/localSettings';

describe('LOCAL_SETTING_DEFINITIONS credentials view', () => {
    it('shows Credentials as cards on a device that never chose, and keeps a chosen list (R7)', () => {
        expect(localSettingsParse({}).connectedServicesIndexViewV1).toBe('grid');
        expect(localSettingsParse({ connectedServicesIndexViewV1: 'unknown' }).connectedServicesIndexViewV1).toBe('grid');
        expect(localSettingsParse({ connectedServicesIndexViewV1: 'list' }).connectedServicesIndexViewV1).toBe('list');
    });
});
