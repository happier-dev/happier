import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';
import { classifyIrohHomeCarrierFailure, IrohError } from '@happier-dev/iroh-native/node';
import type { HomeCarrierPolicyFailureClassification } from '@happier-dev/cli-common/homeEnrollment';

import { logger } from '@/ui/logger';

type FailedReadinessProbeResult = Exclude<ReadinessProbeResult, Readonly<{ status: 'ready' }>>;

export class DaemonHomeReadinessError extends Error {
  constructor(
    readonly probe: FailedReadinessProbeResult,
  ) {
    super(probe.errorMessage ?? `Home transport readiness failed: ${probe.status}`);
  }
}

/** Adapt daemon readiness outcomes; native failure policy stays shared. */
export function classifyDaemonHomeCarrierFailure(error: unknown): HomeCarrierPolicyFailureClassification {
  if (error instanceof DaemonHomeReadinessError) {
    return { fallbackAllowed: error.probe.status !== 'auth_failed' };
  }
  const classification = classifyIrohHomeCarrierFailure(error);
  if (classification.fallbackAllowed) {
    const reason = error instanceof IrohError
      && error.code !== 'transport_closed' && error.code !== 'transport' && error.code !== 'unknown'
      ? error.code : 'transport_closed_unknown';
    logger.warn('[DAEMON RUN] Iroh Home acquisition unavailable; evaluating declared HTTPS', { reason });
  }
  return classification;
}
