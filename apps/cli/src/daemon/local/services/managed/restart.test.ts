import { describe, expect, it } from 'vitest';

import { resolveManagedLocalServiceRestartRequest } from './restart';

describe('resolveManagedLocalServiceRestartRequest', () => {
    it('fails closed while restart policies are not enabled for managed local services', () => {
        expect(resolveManagedLocalServiceRestartRequest({
            serviceId: 'plugin:web',
            policy: { kind: 'never' },
        })).toEqual({
            ok: false,
            reason: 'restart_not_configured',
            diagnostic: { code: 'restart_not_configured', severity: 'warning' },
        });
    });
});
