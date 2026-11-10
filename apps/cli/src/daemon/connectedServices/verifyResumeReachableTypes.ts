import type { RuntimeDescriptorV1 } from '@happier-dev/protocol';

/** Host-private inputs retained by the connected-service state owner. */
export type VerifyResumeReachableInput = Readonly<{
  targetMaterializedRoot: string;
  vendorResumeId: string | null;
  candidatePersistedSessionFile?: string | null;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  /** Prepared launch values, not a request to acquire/materialize credentials. */
  nativeInspection?: Readonly<{
    cwd: string;
    environment: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  }>;
}>;

export type VerifyResumeReachableResult =
  | Readonly<{
      ok: true;
      resolvedPath: string;
      /** Exact host-verified companion files/subtrees required by the Agent. */
      requiredPaths?: readonly string[];
      proof?: never;
    }>
  | Readonly<{ ok: true; proof: 'native_session' }>
  | Readonly<{ ok: false; reason: string }>;

export const REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON = 'reachability_check_not_implemented' as const;
