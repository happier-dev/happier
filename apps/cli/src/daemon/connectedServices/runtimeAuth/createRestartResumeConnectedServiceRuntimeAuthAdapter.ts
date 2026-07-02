import type {
  ConnectedServiceProviderRuntimeAuthAdapter,
  ConnectedServiceRuntimeFailureClassification,
  ConnectedServiceRuntimeFailureInput,
} from './types';

function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error ?? '');
}

function readSelectionRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function classifyGenericRuntimeAuthFailure(
  serviceId: string,
  input: ConnectedServiceRuntimeFailureInput,
): ConnectedServiceRuntimeFailureClassification | null {
  const message = readMessage(input.error).toLowerCase();
  const selection = readSelectionRecord(input.selection);
  const profileId = readString(selection?.activeProfileId ?? selection?.profileId);
  const groupId = readString(selection?.groupId);
  if (/usage\s*limit|rate\s*limit|quota|too many requests/.test(message)) {
    return {
      kind: /rate\s*limit|too many requests/.test(message) ? 'rate_limit' : 'usage_limit',
      serviceId,
      profileId,
      groupId,
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    };
  }
  if (/auth|credential|login|token/.test(message)) {
    return {
      kind: 'auth_expired',
      serviceId,
      profileId,
      groupId,
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    };
  }
  return null;
}

export function createRestartResumeConnectedServiceRuntimeAuthAdapter(
  serviceId: string,
): ConnectedServiceProviderRuntimeAuthAdapter {
  return {
    classifyRuntimeAuthFailure(input) {
      return classifyGenericRuntimeAuthFailure(serviceId, input);
    },
    async materializeActiveProfile() {
      return { supported: false, recovery: 'restart_resume' };
    },
    canHotApply() {
      return { supported: false, recovery: 'restart_resume' };
    },
    async hotApply() {
      return { applied: false, recovery: 'restart_resume' };
    },
    async recoverAfterRuntimeAuthSwitch(input) {
      const selection = readSelectionRecord(input.selection);
      const restartAndResume = selection?.restartAndResume;
      if (typeof restartAndResume !== 'function') {
        return { recovered: false, reason: 'missing_restart_resume' };
      }
      await restartAndResume();
      return { recovered: true, recovery: 'restart_resume' };
    },
    async verifyActiveAccount() {
      return { status: 'verified', reason: 'provider_restart_rematerialization_authoritative' };
    },
    async probeQuota() {
      return { status: 'unsupported' };
    },
    async refreshActiveProfile() {
      return { status: 'unsupported' };
    },
  };
}
