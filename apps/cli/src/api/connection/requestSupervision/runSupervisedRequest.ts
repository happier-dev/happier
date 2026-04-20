import type { ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';

import { assertManagedConnectionReadyForRequest } from './assertManagedConnectionReadyForRequest';
import { reportRequestOutcomeToSupervisor } from './reportRequestOutcomeToSupervisor';

export async function runSupervisedRequest<T>(params: Readonly<{
  supervisor: ManagedConnectionSupervisor;
  requireAuth?: boolean;
  requireOnline?: boolean;
  request: () => Promise<T>;
  readStatusCode?: (result: T) => number | null;
}>): Promise<T> {
  const requireAuth = params.requireAuth !== false;
  assertManagedConnectionReadyForRequest(params.supervisor.getState(), {
    requireAuth,
    requireOnline: params.requireOnline,
  });
  const probeReportScope = params.supervisor.captureProbeReportScope?.();

  try {
    const result = await params.request();
    reportRequestOutcomeToSupervisor({
      supervisor: params.supervisor,
      statusCode: params.readStatusCode?.(result) ?? null,
      hadAuth: requireAuth,
      scope: probeReportScope,
    });
    return result;
  } catch (error) {
    reportRequestOutcomeToSupervisor({
      supervisor: params.supervisor,
      error,
      hadAuth: requireAuth,
      scope: probeReportScope,
    });
    throw error;
  }
}
