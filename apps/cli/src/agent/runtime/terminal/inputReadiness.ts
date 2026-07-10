import type {
  TerminalHostLivenessV1,
  TerminalInputInjectionResult,
  TerminalInputReadinessV1,
  TerminalInputState,
} from '@happier-dev/agents';

import type { TerminalTurnState } from './_types';

export type ResolveTerminalInputReadinessParams = Readonly<{
  turnState: TerminalTurnState;
  hostLiveness?: TerminalHostLivenessV1 | null;
  inputState?: TerminalInputState | null;
  observedAt: number;
  providerSessionId?: string;
  hostKind?: TerminalInputReadinessV1['hostKind'];
  hostSessionName?: string;
  paneId?: string;
  permissionBlocked?: boolean;
  finalizing?: boolean;
  providerStarting?: boolean;
  awaitingProviderAcceptance?: boolean;
  lastInjectionResult?: TerminalInputInjectionResult | null;
}>;

function baseReadiness(
  params: ResolveTerminalInputReadinessParams,
): Omit<TerminalInputReadinessV1, 'status'> {
  const activeTurnId =
    params.turnState.state === 'running' || params.turnState.state === 'blocked_on_permission'
      ? params.turnState.turnId ?? undefined
      : undefined;
  return {
    observedAt: params.observedAt,
    ...(activeTurnId ? { activeTurnId } : {}),
    ...(params.providerSessionId ? { providerSessionId: params.providerSessionId } : {}),
    ...(params.hostKind ? { hostKind: params.hostKind } : {}),
    ...(params.hostSessionName ? { hostSessionName: params.hostSessionName } : {}),
    ...(params.paneId ? { paneId: params.paneId } : {}),
    ...(params.hostLiveness ? { liveness: params.hostLiveness } : {}),
  };
}

function readiness(
  params: ResolveTerminalInputReadinessParams,
  status: TerminalInputReadinessV1['status'],
  extra?: Omit<Partial<TerminalInputReadinessV1>, 'status'>,
): TerminalInputReadinessV1 {
  return {
    ...baseReadiness(params),
    status,
    ...extra,
  };
}

function readinessFromInjectionFailure(
  params: ResolveTerminalInputReadinessParams,
  result: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
): TerminalInputReadinessV1 {
  if (result.duplicateRisk !== 'none' || result.reason === 'ambiguous_provider_acceptance') {
    return readiness(params, 'failed_ambiguous', {
      reason: result.reason,
      recoverable: result.recoverable,
      duplicateRisk: result.duplicateRisk,
    });
  }
  if (result.recoverable) {
    return readiness(params, 'failed_retryable', {
      reason: result.reason,
      recoverable: true,
      duplicateRisk: result.duplicateRisk,
    });
  }
  return readiness(params, 'failed_terminal', {
    reason: result.reason,
    recoverable: false,
    duplicateRisk: result.duplicateRisk,
  });
}

export function resolveTerminalInputReadiness(params: ResolveTerminalInputReadinessParams): TerminalInputReadinessV1 {
  const lastInjectionResult = params.lastInjectionResult;
  if (lastInjectionResult?.status === 'failed') {
    return readinessFromInjectionFailure(params, lastInjectionResult);
  }
  if (params.awaitingProviderAcceptance === true) return readiness(params, 'awaiting_provider_acceptance');
  if (params.finalizing === true) return readiness(params, 'defer_finalizing');
  if (params.permissionBlocked === true || params.turnState.state === 'blocked_on_permission') {
    return readiness(params, 'defer_permission');
  }
  if (params.providerStarting === true) return readiness(params, 'defer_provider_starting');

  const liveness = params.hostLiveness;
  if (!liveness) return readiness(params, 'defer_host_not_ready');
  if (liveness.paneDead === true) return readiness(params, 'failed_terminal', { recoverable: false });
  if (liveness.paneAlive !== true) return readiness(params, 'defer_liveness_uncertain');

  const inputState = params.inputState;
  if (!inputState) return readiness(params, 'defer_host_not_ready');
  if (!inputState.stable) return readiness(params, 'defer_user_typing');

  return readiness(params, 'writable');
}
