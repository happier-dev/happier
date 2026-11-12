import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';

// Native observations retain their public code when an operation must throw.
// Result-bearing roles can project these observations without swallowing an
// independently authored host or plugin refusal.
export class MaritimeNativeError extends PluginError {}

export function projectMaritimeNativeFailure<T>(error: unknown, fallback: () => T | PromiseLike<T>): T | PromiseLike<T> {
  if (error instanceof MaritimeNativeError) return fallback();
  return projectMachineProvisionerActionFailure(error, fallback);
}
