import { isPluginError, PluginError } from '../errors.js';
import type { MachineProvisionerNativeCauseV1, MachineProvisionerOptionsResultV1 } from '../machineProvisioners.js';

/**
 * Keep machine Action failures on the canonical contributed-Action projection.
 * Provider PluginErrors retain their code, details, remediation and recovery;
 * non-typed native failures may keep their operation-specific fallback.
 */
export function projectMachineProvisionerActionFailure<T>(error: unknown, fallback: () => T | PromiseLike<T>): T | PromiseLike<T> {
  if (isPluginError(error)) throw error;
  // The native Lima reader adds an inspection error while retaining the
  // authored refusal in the standard Error cause carrier.
  if (error instanceof Error && isPluginError(error.cause)) throw error.cause;
  return fallback();
}

/** Options transports a credential refusal as the same check finding in the Action failure. */
export function projectMachineProvisionerOptionsFailure(code: string | undefined,
  nativeCause?: MachineProvisionerNativeCauseV1): MachineProvisionerOptionsResultV1 {
  if (code === 'credential_unavailable') {
    const refusal = { available: false, code };
    throw new PluginError({ code, details: nativeCause ? { ...refusal, nativeCause } : refusal });
  }
  return { dimensions: { size: [], image: [], location: [], network: [], duration: [] }, code: 'provider_unavailable',
    ...(nativeCause ? { nativeCause } : {}) };
}
