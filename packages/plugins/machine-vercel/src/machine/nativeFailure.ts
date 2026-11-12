import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import { MachineProvisionerNativeCauseV1Schema, projectMachineProvisionerActionFailure, type MachineProvisionerNativeCauseV1 } from '@happier-dev/plugin-sdk/machine-provisioners';

export type VercelNativeFailure = Readonly<{
  kind: 'unavailable' | 'unknown' | 'refused'; code: string; nativeCause?: MachineProvisionerNativeCauseV1;
}>;

export function nativeFailureResult(failure: VercelNativeFailure) {
  return { kind: failure.kind === 'refused' ? 'refused' as const : 'unknown' as const, code: failure.code,
    ...(failure.nativeCause ? { nativeCause: failure.nativeCause } : {}) };
}

class VercelNativeError extends PluginError {}

export function fail(code: string, nativeCause?: MachineProvisionerNativeCauseV1): never {
  throw new VercelNativeError({ code, ...(nativeCause ? { details: { nativeCause } } : {}) });
}

export function caughtNativeFailure(error: unknown, fallback: string) {
  if (!(error instanceof VercelNativeError)) projectMachineProvisionerActionFailure(error, () => undefined);
  const cause = isPluginError(error) && error.details && typeof error.details === 'object' && 'nativeCause' in error.details
    ? MachineProvisionerNativeCauseV1Schema.safeParse(error.details.nativeCause) : undefined;
  return { kind: 'unknown' as const,
    code: error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : fallback,
    ...(cause?.success ? { nativeCause: cause.data } : {}) };
}
