import { describe, expect, it } from 'vitest';

import { mapPeerDirectPolicyDenyReasonToLiveStreamDisabledReason } from './disabledReasons';

describe('mapPeerDirectPolicyDenyReasonToLiveStreamDisabledReason', () => {
    it('maps direct-route policy denial into live-stream disabled reason codes', () => {
        expect(mapPeerDirectPolicyDenyReasonToLiveStreamDisabledReason('blocked_by_server_policy')).toBe(
            'server_direct_disabled',
        );
        expect(mapPeerDirectPolicyDenyReasonToLiveStreamDisabledReason('blocked_by_daemon_policy')).toBe(
            'daemon_policy_disabled',
        );
        expect(mapPeerDirectPolicyDenyReasonToLiveStreamDisabledReason('disabled_by_account_preference')).toBe(
            'account_preference_disabled',
        );
        expect(mapPeerDirectPolicyDenyReasonToLiveStreamDisabledReason('grant_missing')).toBe('grant_rejected');
        expect(mapPeerDirectPolicyDenyReasonToLiveStreamDisabledReason('grant_expired')).toBe('grant_rejected');
        expect(mapPeerDirectPolicyDenyReasonToLiveStreamDisabledReason('grant_scope_mismatch')).toBe('grant_rejected');
    });
});
