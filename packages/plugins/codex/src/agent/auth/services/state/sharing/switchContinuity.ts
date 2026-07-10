import { getProviderConnectedServicesAdapter } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

export type CodexConnectedServiceSwitchContinuityUnsupportedResult = Readonly<{
  mode: 'unsupported';
  reason: 'unsupported_service' | 'codex_api_key_switch_continuity_unsupported';
}>;

export type CodexConnectedServiceSwitchServiceSupport =
  | Readonly<{ supported: true }>
  | Readonly<{
    supported: false;
    result: CodexConnectedServiceSwitchContinuityUnsupportedResult;
  }>;

export const codexConnectedServiceSharedStateRequiredResult = {
  mode: 'restart_shared_state_required',
  reason: 'codex_shared_state_required',
} as const;

function readSupportedConnectedServiceIds(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const supportedServiceIds = (value as Readonly<{ supportedServiceIds?: unknown }>).supportedServiceIds;
  if (!Array.isArray(supportedServiceIds)) return [];
  return supportedServiceIds.filter((serviceId): serviceId is string => typeof serviceId === 'string');
}

export function resolveCodexConnectedServiceSwitchServiceSupport(
  serviceId: string,
): CodexConnectedServiceSwitchServiceSupport {
  const supportedServiceIds = readSupportedConnectedServiceIds(
    getProviderConnectedServicesAdapter('codex')?.connectedServices,
  );
  const supportsService = supportedServiceIds?.includes(serviceId) === true;
  if (!supportsService) {
    return {
      supported: false,
      result: { mode: 'unsupported', reason: 'unsupported_service' },
    };
  }
  if (serviceId !== 'openai-codex') {
    return {
      supported: false,
      result: { mode: 'unsupported', reason: 'codex_api_key_switch_continuity_unsupported' },
    };
  }
  return { supported: true };
}
