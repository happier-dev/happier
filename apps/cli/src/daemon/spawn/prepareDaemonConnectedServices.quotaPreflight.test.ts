import { describe, expect, it } from 'vitest';

import { buildConnectedServiceQuotaPreflightIncompleteSpawnErrorResult } from './prepareDaemonConnectedServices';

describe('connected-service quota spawn preflight', () => {
    it('returns a stable spawn validation failure for incomplete hard quota evidence', () => {
        expect(buildConnectedServiceQuotaPreflightIncompleteSpawnErrorResult()).toEqual({
            type: 'error',
            errorCode: 'SPAWN_VALIDATION_FAILED',
            errorMessage: 'connected_service_quota_preflight_incomplete',
        });
    });
});
