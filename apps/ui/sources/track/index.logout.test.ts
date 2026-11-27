import { beforeEach, describe, expect, it, vi } from 'vitest';

const resetMock = vi.hoisted(() => vi.fn());

vi.mock('./tracking', () => ({
  tracking: { reset: resetMock },
}));

import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import {
  loadAnalyticsPropertiesSent,
  saveAnalyticsPropertiesSent,
} from '@/sync/domains/state/analyticsSendState';

import { trackLogout } from './index';

describe('trackLogout', () => {
  beforeEach(() => {
    resetMock.mockReset();
    getPersistenceStorage().clearAll();
  });

  it('forgets which person and group properties this device sent, with the PostHog identity', () => {
    const sent = {
      subject: 'anon-1',
      fullSentAtMs: 1,
      properties: { acct_setting__analyticsOptOut: false },
    };
    saveAnalyticsPropertiesSent('person', sent);
    saveAnalyticsPropertiesSent('device_user', {
      ...sent,
      subject: 'anon-1:device',
    });

    trackLogout();

    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(loadAnalyticsPropertiesSent('person')).toBeNull();
    expect(loadAnalyticsPropertiesSent('device_user')).toBeNull();
  });
});
