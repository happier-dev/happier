import type { RuntimeDescriptorV1 } from '@happier-dev/protocol';

/** Host-private inputs retained by the connected-service state owner. */
export type VerifyResumeReachableInput = Readonly<{
  targetMaterializedRoot: string;
  vendorResumeId: string | null;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
}>;

export type VerifyResumeReachableResult =
  | Readonly<{ ok: true; resolvedPath: string }>
  | Readonly<{ ok: false; reason: string }>;

export const REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON = 'reachability_check_not_implemented' as const;
