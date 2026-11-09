import type { ProviderErrorV1 } from '@happier-dev/protocol';

import type { ForegroundAgentRuntimeAdmissionResponseV1 } from '@/daemon/agentRuntime/foregroundAdmissionContract';

export class DirectProviderLaunchError extends Error {
  readonly providerError: ProviderErrorV1;

  constructor(providerError: ProviderErrorV1) {
    super(providerError.code);
    this.name = 'DirectProviderLaunchError';
    this.providerError = providerError;
  }
}

/** Adapt the admitted refusal vocabulary without reclassifying its cause. */
export function createForegroundAdmissionError(
  error: Extract<ForegroundAgentRuntimeAdmissionResponseV1, { ok: false }>['error'],
): Error {
  if ('kind' in error) {
    return Object.assign(new Error(`${error.code}: ${error.message}`), { code: error.code });
  }
  if (error.code === 'project_agent_launch_refused') {
    const reason = error.reason;
    const recovery = reason === 'child_required'
      ? 'Open this Project in its Devcontainer child.'
      : reason === 'project_setup_consent_required' || reason === 'project_setup_effect_changed'
        ? 'Review this Project’s setup before starting the Agent.'
        : 'Review this Project’s setup and native environment before trying again.';
    return new Error(`Project launch refused (${reason}). ${recovery}`);
  }
  return new DirectProviderLaunchError(error);
}
