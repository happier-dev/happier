import { describe, expect, it } from 'vitest';

import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { buildNativeProviderAccountUsageSourceProfileId } from '@/daemon/connectedServices/accountUsage/nativeSourceIdentity';

import { resolveUsageLimitRecoverySelectedAuthFromIssue } from './usageLimitRecoverySelectedAuth';

function failure(profileId: string, groupId: string | null = null): SessionRuntimeIssueV1 {
  return { v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit', occurredAt: 100,
    usageLimit: { v: 1, resetAtMs: 200, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait',
      connectedService: { serviceId: 'claude-subscription', profileId, groupId } } };
}

describe('resolveUsageLimitRecoverySelectedAuthFromIssue', () => {
  it('keeps generated native quota-source identities outside connected profile selection', () => {
    const sourceId = buildNativeProviderAccountUsageSourceProfileId({ kind: 'localCredential', providerId: 'claude', material: '/native/config' });
    expect(resolveUsageLimitRecoverySelectedAuthFromIssue({ issue: failure(sourceId), connectedServices: null }))
      .toEqual({ kind: 'native', serviceId: 'claude-subscription' });
  });

  it('keeps an explicitly bound connected profile with the same identifier and preserves inference without binding context', () => {
    const sourceId = buildNativeProviderAccountUsageSourceProfileId({ kind: 'localCredential', providerId: 'claude', material: '/native/config' });
    const expected = { kind: 'profile', serviceId: 'claude-subscription', profileId: sourceId };
    expect(resolveUsageLimitRecoverySelectedAuthFromIssue({ issue: failure(sourceId) })).toEqual(expected);
    expect(resolveUsageLimitRecoverySelectedAuthFromIssue({ issue: failure(sourceId), connectedServices: {
      v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: sourceId } },
    } })).toEqual(expected);
  });

  it('preserves ordinary connected profiles that share the native prefix', () => {
    expect(resolveUsageLimitRecoverySelectedAuthFromIssue({ issue: failure('native:my-profile') }))
      .toEqual({ kind: 'profile', serviceId: 'claude-subscription', profileId: 'native:my-profile' });
  });

  it('preserves explicit group authority and service filtering', () => {
    const sourceId = buildNativeProviderAccountUsageSourceProfileId({ kind: 'localCredential', providerId: 'claude', material: '/native/config' });
    expect(resolveUsageLimitRecoverySelectedAuthFromIssue({ issue: failure(sourceId, 'group-1') }))
      .toEqual({ kind: 'group', serviceId: 'claude-subscription', profileId: sourceId, groupId: 'group-1' });
    expect(resolveUsageLimitRecoverySelectedAuthFromIssue({ issue: failure(sourceId), requiredConnectedServiceId: 'anthropic' })).toBeNull();
  });
});
