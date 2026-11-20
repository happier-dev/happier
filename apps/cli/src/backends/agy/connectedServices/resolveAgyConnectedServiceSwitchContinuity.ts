import type { ConnectedServiceSwitchContinuityParams, ConnectedServiceSwitchContinuityResult } from '@/backends/types';
import {
  isConnectedToConnectedServiceSwitch,
  isExactSameConnectedServiceSelection,
  providerSessionStateUnavailableForResume,
} from '@/backends/connectedServices/switchContinuityContext';
import { verifyResumeReachableAgy } from './verifyResumeReachableAgy';

export async function resolveAgyConnectedServiceSwitchContinuity(params: ConnectedServiceSwitchContinuityParams): Promise<ConnectedServiceSwitchContinuityResult> {
  if (params.serviceId !== 'antigravity') return { mode: 'unsupported', reason: 'unsupported_service' };
  // Native login runs `agy acp` while connected accounts run the pinned server; neither can load the other's conversations.
  if (!isConnectedToConnectedServiceSwitch(params)) {
    return { mode: 'unsupported', reason: 'agy_native_connected_switch_unsupported' };
  }
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
