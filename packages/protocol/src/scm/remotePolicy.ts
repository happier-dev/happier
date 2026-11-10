import { z } from '../zodRuntimePolicy.js';
import type { ScmCapabilities } from './workingSnapshot.js';
import type { ScmOperationOutcome } from './operationOutcome.js';

export const ScmRemotePolicyFields = {
  dirtyPolicy: z.optional(z.enum(['refuse', 'autostash', 'allow_git'])),
  reconcile: z.optional(z.enum(['ff_only', 'rebase', 'merge'])),
  pushMode: z.optional(z.enum(['ordinary', 'force_with_lease'])),
  expectedRemoteOid: z.optional(z.string().check(z.regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/))),
};
export type ScmRemotePolicy = {
  dirtyPolicy?: 'refuse' | 'autostash' | 'allow_git';
  reconcile?: 'ff_only' | 'rebase' | 'merge';
  pushMode?: 'ordinary' | 'force_with_lease';
  expectedRemoteOid?: string;
};

/** Non-default policy fields must never be sent to a backend that can silently ignore them. */
export function admitScmRemotePolicy(
  request: ScmRemotePolicy,
  capabilities?: Partial<Pick<ScmCapabilities, 'writeRemotePolicies' | 'writeRemoteForceWithLease'>>,
): Readonly<{ success: true }> | Readonly<{ success: false; errorCode: 'FEATURE_UNSUPPORTED'; error: string; outcome: ScmOperationOutcome }> {
  const advancedPolicy = (request.dirtyPolicy !== undefined && request.dirtyPolicy !== 'refuse')
    || (request.reconcile !== undefined && request.reconcile !== 'ff_only');
  if ((advancedPolicy && capabilities?.writeRemotePolicies !== true)
    || (request.pushMode === 'force_with_lease' && capabilities?.writeRemoteForceWithLease !== true)) {
    const error = 'The selected SCM backend does not support the requested remote policy';
    return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error,
      outcome: { v: 1, kind: 'failed', errorCode: 'FEATURE_UNSUPPORTED', nextActions: [], message: error } };
  }
  return { success: true };
}

export function validateScmRemoteLeaseAuthority(
  request: ScmRemotePolicy & { remote?: string; branch?: string },
): string | undefined {
  if (request.pushMode === 'force_with_lease') {
    if (!request.remote?.trim() || !request.branch?.trim() || !request.expectedRemoteOid) {
      return 'Force-with-lease requires an explicit remote, branch and expected remote object ID';
    }
  } else if (request.expectedRemoteOid !== undefined) {
    return 'An expected remote object ID is only valid for force-with-lease';
  }
  return undefined;
}
