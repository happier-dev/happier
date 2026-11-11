import { isPluginError } from '../errors.js';

/**
 * Keep machine Action failures on the canonical contributed-Action projection.
 * Provider PluginErrors retain their code, details, remediation and recovery;
 * non-typed native failures may keep their operation-specific fallback.
 */
export function projectMachineProvisionerActionFailure<T>(error: unknown, fallback: () => T | PromiseLike<T>): T | PromiseLike<T> {
  if (isPluginError(error)) throw error;
  return fallback();
}
