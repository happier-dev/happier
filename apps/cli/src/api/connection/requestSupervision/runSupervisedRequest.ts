import type { ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';

import { assertManagedConnectionReadyForRequest } from './assertManagedConnectionReadyForRequest';
import type { RequestPurpose } from './_purpose';
import { gatingPolicyForPurpose } from './_purpose';
import { reportRequestOutcomeToSupervisor } from './reportRequestOutcomeToSupervisor';

export async function runSupervisedRequest<T>(params: Readonly<{
  supervisor: ManagedConnectionSupervisor;
  purpose?: RequestPurpose;
  requireAuth?: boolean;
  requireOnline?: boolean;
  request: () => Promise<T>;
  readStatusCode?: (result: T) => number | null;
}>): Promise<T> {
  let requireAuth: boolean;
  let requireOnline: boolean | undefined;

  if (params.purpose) {
    const policy = gatingPolicyForPurpose(params.purpose);
    requireAuth = params.requireAuth ?? policy.requireAuth;
    requireOnline = params.requireOnline ?? policy.requireOnline;
  } else {
    requireAuth = params.requireAuth !== false;
    requireOnline = params.requireOnline;
  }

  assertManagedConnectionReadyForRequest(params.supervisor.getState(), {
    requireAuth,
    requireOnline,
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
