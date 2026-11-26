import type { ConnectedServiceSwitchContinuityParams, ConnectedServiceSwitchContinuityResult } from '@/backends/types';
import { isExactSameConnectedServiceSelection, providerSessionStateUnavailableForResume } from '@/backends/connectedServices/switchContinuityContext';
import { verifyResumeReachableAgy } from './verifyResumeReachableAgy';

export async function resolveAgyConnectedServiceSwitchContinuity(params: ConnectedServiceSwitchContinuityParams): Promise<ConnectedServiceSwitchContinuityResult> {
  if (params.serviceId !== 'antigravity') return { mode: 'unsupported', reason: 'unsupported_service' };
  if (!isExactSameConnectedServiceSelection(params)) {
    return { mode: 'restart_shared_state_required', reason: 'agy_shared_state_required' };
  }
  if (!params.targetMaterializedRoot || !params.targetMaterializedEnv || !params.vendorResumeId || !params.cwd || !params.connectedServiceMaterializationIdentityV1) {
    return providerSessionStateUnavailableForResume();
  }
  const reachable = await verifyResumeReachableAgy({
    targetMaterializedRoot: params.targetMaterializedRoot, targetMaterializedEnv: params.targetMaterializedEnv,
    vendorResumeId: params.vendorResumeId, cwd: params.cwd, targetStrict: true,
  });
  return reachable.ok ? { mode: 'restart_same_home' } : providerSessionStateUnavailableForResume();
}
