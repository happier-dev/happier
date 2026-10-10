import { describe, expect, it } from 'vitest';

import { USAGE_SETTINGS } from './usageSettings';

describe('Usage Account Settings declarations', () => {
    it('admits model prices through the shared Account setting binding', () => {
        expect(Object.values(USAGE_SETTINGS.settings).find(setting => setting.anchor === 'usage.modelPrices'))
            .toMatchObject({ anchor: 'usage.modelPrices', storage: {
                scope: 'account', key: 'usageModelPriceOverridesV1', access: 'read_write',
            } });
    });
});
