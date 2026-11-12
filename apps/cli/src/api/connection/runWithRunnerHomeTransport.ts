import { acquireTerminalAuthEnrollmentRuntime } from '@/auth/terminalAuthEnrollmentRuntime';
import { resolveCurrentCliHomeTarget } from '@/server/homeTarget';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';

/** A primary runner holds its own Account-client carrier until its command ends.
 * It never registers or borrows the daemon's persisted Machine EndpointId. */
export async function runWithRunnerHomeTransport<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const target = await resolveCurrentCliHomeTarget();
  // Released URL-only Homes retain the configured invocation route.
  if (!target.descriptor) return await run();
  const acquired = await acquireTerminalAuthEnrollmentRuntime(target.descriptor, target.preferredTransport, signal);
  if (!acquired.ok) throw acquired.error;
  const unpublish = publishServerHttpRuntimeOrigin(acquired.runtime.runtimeOrigin, acquired.runtime.carrier);
  try {
    return await run();
  } finally {
    unpublish();
    await acquired.close();
  }
}
