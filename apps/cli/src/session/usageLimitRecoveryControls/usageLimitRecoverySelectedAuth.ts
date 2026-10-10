import {
  ConnectedServiceIdSchema,
  ConnectedServiceBindingsV1Schema,
  type ConnectedServiceId,
  type SessionRuntimeIssueV1,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';

import { isNativeLocalCredentialUsageSourceProfileId } from '@/daemon/connectedServices/accountUsage/nativeSourceIdentity';

function readConnectedServiceId(value: unknown): ConnectedServiceId | null {
  const parsed = ConnectedServiceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

export function resolveUsageLimitRecoverySelectedAuthFromIssue(input: Readonly<{
  issue: SessionRuntimeIssueV1;
  defaultNativeServiceId?: ConnectedServiceId | null;
  requiredConnectedServiceId?: ConnectedServiceId | null;
  /** Null means known absence; omission preserves inference without binding evidence. */
  connectedServices?: unknown;
}>): SessionUsageLimitRecoveryV1['selectedAuth'] | null {
  const connectedService = input.issue.usageLimit?.connectedService;
  const connectedServiceId = readConnectedServiceId(connectedService?.serviceId);
  if (input.requiredConnectedServiceId && connectedServiceId !== input.requiredConnectedServiceId) {
    return null;
  }

  const serviceId = connectedServiceId ?? input.defaultNativeServiceId ?? null;
  const groupId = readString(connectedService?.groupId);
  const profileId = readString(connectedService?.profileId);
  if (groupId && serviceId) {
    return {
      kind: 'group',
      serviceId,
      groupId,
      profileId,
    };
  }
  const currentBindings = input.connectedServices !== undefined
    ? ConnectedServiceBindingsV1Schema.safeParse(input.connectedServices ?? { v: 1, bindingsByServiceId: {} })
    : null;
  const currentBinding = currentBindings?.success && serviceId ? currentBindings.data.bindingsByServiceId[serviceId] : null;
  const nativeQuotaSource = profileId && isNativeLocalCredentialUsageSourceProfileId(profileId)
    && currentBindings?.success
    && !(currentBinding?.source === 'connected' && currentBinding.selection === 'profile' && currentBinding.profileId === profileId);
  if (profileId && serviceId && !nativeQuotaSource) {
    return {
      kind: 'profile',
      serviceId,
      profileId,
    };
  }
  return serviceId ? { kind: 'native', serviceId } : { kind: 'native' };
}
