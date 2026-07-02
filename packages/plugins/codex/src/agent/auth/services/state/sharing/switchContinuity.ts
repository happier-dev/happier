import { AGENTS_CORE } from '@happier-dev/agents';

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
  const supportedServiceIds = AGENTS_CORE.codex.connectedServices?.supportedServiceIds as readonly string[] | undefined;
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
