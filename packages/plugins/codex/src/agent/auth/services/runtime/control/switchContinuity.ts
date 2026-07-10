import type { HostRuntimeControlServiceV1 } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import {
  codexConnectedServiceSharedStateRequiredResult,
  resolveCodexConnectedServiceSwitchServiceSupport,
} from '../../state/sharing/switchContinuity.js';
import { createCodexConnectedServiceRuntimeAuthAdapter } from './runtimeAuthAdapter.js';

type Binding = Readonly<{
  source: 'native' | 'connected';
  selection: 'native' | 'profile' | 'group';
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
}>;

type SwitchContinuityParams = Readonly<{
  sessionId: string;
  agentId: string;
  serviceId: string;
  previousBinding: Binding | null;
  nextBinding: Binding;
  connectedServiceMaterializationIdentityV1?: unknown;
  vendorResumeId?: string | null;
  targetMaterializedRoot?: string | null;
  targetMaterializedEnv?: Readonly<Record<string, string>> | null;
  cwd?: string | null;
  candidatePersistedSessionFile?: string | null;
  runtimeAuthSelection?: unknown;
}>;

type SwitchContinuityInput = Readonly<{
  runtimeControl: HostRuntimeControlServiceV1;
  params: SwitchContinuityParams;
}>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isConnectedToConnectedServiceSwitch(params: SwitchContinuityParams): boolean {
  return params.previousBinding?.source === 'connected' && params.nextBinding.source === 'connected';
}

function isSameConnectedServiceAuthGroup(params: SwitchContinuityParams): boolean {
  return isConnectedToConnectedServiceSwitch(params)
    && params.previousBinding?.selection === 'group'
    && params.nextBinding.selection === 'group'
    && params.previousBinding.serviceId === params.nextBinding.serviceId
    && params.previousBinding.groupId !== null
    && params.previousBinding.groupId === params.nextBinding.groupId;
}

function providerSessionStateUnavailableForResume(diagnostics?: unknown) {
  return {
    mode: 'unsupported',
    reason: 'provider_session_state_unavailable_for_resume',
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function readReachability(value: unknown): Readonly<{
  ok?: unknown;
  continuityDiagnostics?: unknown;
}> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<{ ok?: unknown; continuityDiagnostics?: unknown }>
    : null;
}

export async function resolveCodexConnectedServiceSwitchContinuity(
  input: SwitchContinuityInput,
) {
  const { params } = input;
  const serviceSupport = resolveCodexConnectedServiceSwitchServiceSupport(params.serviceId);
  if (!serviceSupport.supported) {
    return serviceSupport.result;
  }

  if (params.previousBinding?.source === 'connected' && params.runtimeAuthSelection) {
    const hotApply = createCodexConnectedServiceRuntimeAuthAdapter().canHotApply({
      target: { agentId: params.agentId },
      selection: params.runtimeAuthSelection,
    });
    if (
      hotApply
      && typeof hotApply === 'object'
      && !Array.isArray(hotApply)
      && (hotApply as Record<string, unknown>).supported === true
    ) {
      return { mode: 'hot_apply' };
    }
  }

  if (isSameConnectedServiceAuthGroup(params)) {
    const targetMaterializedRoot = readString(params.targetMaterializedRoot);
    const vendorResumeId = readString(params.vendorResumeId);
    const cwd = readString(params.cwd);
    const materializationIdentity = params.connectedServiceMaterializationIdentityV1 ?? null;
    const targetMaterializedEnv = params.targetMaterializedEnv ?? null;
    if (
      !targetMaterializedRoot
      || !vendorResumeId
      || !cwd
      || !materializationIdentity
      || !targetMaterializedEnv
    ) {
      return providerSessionStateUnavailableForResume();
    }

    const reachability = await input.runtimeControl.reachability.verifyMaterializedState({
      agentId: 'codex',
      serviceId: params.serviceId,
      targetMaterializedRoot,
      targetMaterializedEnv,
      requestedStateMode: 'isolated',
      effectiveStateMode: 'isolated',
      materializationIdentity,
      vendorResumeId,
      cwd,
      candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
    });
    if (!reachability.ok) return providerSessionStateUnavailableForResume();
    const value = readReachability(reachability.value);
    return value?.ok === true
      ? { mode: 'restart_same_home' }
      : providerSessionStateUnavailableForResume(value?.continuityDiagnostics);
  }

  return codexConnectedServiceSharedStateRequiredResult;
}
