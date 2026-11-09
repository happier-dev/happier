import { describe, expect, it } from 'vitest';

import type { ActivityNotificationEvent } from './activityNotificationEvent';
import { buildActivityNotificationContent } from './buildActivityNotificationContent';

describe('connected account notification presentation', () => {
  it.each<ActivityNotificationEvent>([
    { topic: 'connected_service_account_switch', sessionId: 'session', serviceId: 'service-internal',
      groupId: 'pool-internal', fromProfileId: 'from-internal', toProfileId: 'to-internal', reason: 'usage_limit' },
    { topic: 'connected_service_credential_health', sessionId: 'session', serviceId: 'service-internal',
      profileId: 'account-internal', status: 'reconnect_required' },
    { topic: 'connected_service_quota_recovered', sessionId: 'session', serviceId: 'service-internal',
      profileId: 'account-internal', groupId: 'pool-internal', issueFingerprint: 'reset', recoveryReason: 'automatic_quota_reset' },
  ])('does not present routing identifiers when labels are unavailable: $topic', (event) => {
    const content = buildActivityNotificationContent(event, { readyIncludeMessageText: false });
    expect(`${content.title} ${content.body}`).not.toMatch(/service-internal|pool-internal|from-internal|to-internal|account-internal/);
    // Routing still retains the identity needed to open the affected account.
    expect(content.data.serviceId).toBe('service-internal');
  });
});
