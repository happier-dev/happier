import type { ConnectedServiceRecoveryCapabilities } from '@/backends/types';

type PredictiveSoftSwitchCapability = 'supported' | 'unsupported';

/**
 * Resolves whether predictive (soft-threshold) account switches are allowed for a provider.
 *
 * A declared recovery-capability descriptor (P7/F13 minimum surface) always outranks
 * runtime-auth adapter inference: restart-only providers declare `unsupported` as a
 * contract instead of relying on their adapter returning `supported: false`. Providers
 * without a descriptor keep the legacy adapter inference. Any inference failure fails
 * closed to `unsupported`.
 */
export async function resolvePredictiveSoftSwitchCapability(input: Readonly<{
  declaredCapabilities: ConnectedServiceRecoveryCapabilities | null;
  inferFromRuntimeAuthAdapter: () => Promise<PredictiveSoftSwitchCapability>;
}>): Promise<PredictiveSoftSwitchCapability> {
  if (input.declaredCapabilities) {
    return input.declaredCapabilities.predictiveSoftSwitch.mode;
  }
  try {
    return await input.inferFromRuntimeAuthAdapter();
  } catch {
    return 'unsupported';
  }
}
