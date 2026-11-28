import { isConnectedServiceAccountReadConsented } from '@/daemon/connectedServices/consent/isConnectedServiceAccountReadConsented';
import { ConnectedServiceCredentialRecordV1Schema } from '@happier-dev/protocol';
import type { ConnectedServiceProviderRuntimeAuthAdapter } from '@/daemon/connectedServices/runtimeAuth/types';
import { logger } from '@/ui/logger';
import { classifyAgyRuntimeFailure } from './classifyAgyRuntimeFailure';
import { createAgyQuotaFetcher } from './quotaFetcher';

export function createAgyConnectedServiceRuntimeAuthAdapter(): ConnectedServiceProviderRuntimeAuthAdapter {
  const fetcher = createAgyQuotaFetcher();
  return {
    classifyRuntimeAuthFailure: classifyAgyRuntimeFailure,
    async materializeActiveProfile() { return { supported: true }; },
    canHotApply() { return { supported: false, recovery: 'restart_rematerialize' }; },
    async hotApply() { return { applied: false, reason: 'hot_apply_unsupported' }; },
    async recoverAfterRuntimeAuthSwitch() { return { recovered: false, recovery: 'restart_rematerialize', reason: 'agy_provider_outcome_pending' }; },
    async verifyActiveAccount() { return { status: 'unavailable', retryable: true, reason: 'agy_provider_outcome_pending' }; },
    async probeQuota(input) {
      const selection = input.selection && typeof input.selection === 'object' && !Array.isArray(input.selection) ? input.selection as Record<string, unknown> : null;
      const parsed = ConnectedServiceCredentialRecordV1Schema.safeParse(selection?.record);
      if (!parsed.success || parsed.data.serviceId !== 'antigravity') return { status: 'unsupported', reason: 'missing_antigravity_oauth_record' };
      const groupId = typeof selection?.groupId === 'string' ? selection.groupId.trim() : '';
      if (!isConnectedServiceAccountReadConsented({ serviceId: 'antigravity', poolMember: groupId.length > 0 })) {
        return { status: 'unsupported', reason: 'pool_consent_required' };
      }
      try {
        return { status: 'available', quotaSnapshot: await fetcher.fetch({ record: parsed.data, now: Date.now(), signal: new AbortController().signal }) };
      } catch {
        logger.warn('[connected-services] Antigravity selected-account quota request failed');
        return { status: 'error', reason: 'antigravity_quota_request_failed' };
      }
    },
    async refreshActiveProfile() { return { status: 'unsupported' }; },
  };
}
