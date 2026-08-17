import { AGENT_DEFINITION } from '../../../../definition.js';

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

export function resolveCodexConnectedServiceSwitchServiceSupport(
  serviceId: string,
): CodexConnectedServiceSwitchServiceSupport {
  const supportsService = AGENT_DEFINITION.core.connectedServices.supportedServiceIds
    .some((supportedServiceId) => supportedServiceId === serviceId);
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
