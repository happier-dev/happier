import type { HostRuntimeControlServiceV1 } from '@happier-dev/plugin-sdk/experimental/runtime/session';

const SUPPORTED_PI_CONNECTED_SERVICE_IDS = new Set([
  'openai-codex',
  'openai',
  'claude-subscription',
  'anthropic',
]);

type ConnectedServiceBinding = Readonly<{
  source: 'native' | 'connected';
  selection: 'native' | 'profile' | 'group';
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
}>;

type ConnectedServiceSwitchContinuityParams = Readonly<{
  sessionId: string;
  agentId: string;
  serviceId: string;
  previousBinding: ConnectedServiceBinding | null;
  nextBinding: ConnectedServiceBinding;
  connectedServiceMaterializationIdentityV1?: unknown;
  vendorResumeId?: string | null;
  targetMaterializedRoot?: string | null;
  targetMaterializedEnv?: Readonly<Record<string, string>> | null;
  cwd?: string | null;
  candidatePersistedSessionFile?: string | null;
}>;

type ConnectedServiceSwitchContinuityResult = Readonly<{
  mode: 'hot_apply' | 'restart_same_home' | 'restart_shared_state_required' | 'unsupported';
  reason?: string;
  diagnostics?: unknown;
}>;

type SwitchContinuityInput = Readonly<{
  runtimeControl: HostRuntimeControlServiceV1;
  params: ConnectedServiceSwitchContinuityParams;
}>;

function supportsService(serviceId: string): boolean {
  return SUPPORTED_PI_CONNECTED_SERVICE_IDS.has(serviceId);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isConnectedToConnectedServiceSwitch(params: ConnectedServiceSwitchContinuityParams): boolean {
  return params.previousBinding?.source === 'connected' && params.nextBinding.source === 'connected';
}

function isExactSameConnectedServiceSelection(params: ConnectedServiceSwitchContinuityParams): boolean {
  return isConnectedToConnectedServiceSwitch(params)
    && params.previousBinding?.serviceId === params.nextBinding.serviceId
    && params.previousBinding.selection === params.nextBinding.selection
    && params.previousBinding.profileId === params.nextBinding.profileId
    && params.previousBinding.groupId === params.nextBinding.groupId;
}

function isSameConnectedServiceAuthGroup(params: ConnectedServiceSwitchContinuityParams): boolean {
  return isConnectedToConnectedServiceSwitch(params)
    && params.previousBinding?.selection === 'group'
    && params.nextBinding.selection === 'group'
    && params.previousBinding.serviceId === params.nextBinding.serviceId
    && params.previousBinding.groupId !== null
    && params.previousBinding.groupId === params.nextBinding.groupId;
}

function hasExactConnectedServiceRestartContinuityContext(
  params: ConnectedServiceSwitchContinuityParams,
): boolean {
  return Boolean(params.connectedServiceMaterializationIdentityV1)
    && typeof params.vendorResumeId === 'string'
    && params.vendorResumeId.trim().length > 0;
}

function providerSessionStateUnavailableForResume(diagnostics?: unknown): ConnectedServiceSwitchContinuityResult {
  return {
    mode: 'unsupported',
    reason: 'provider_session_state_unavailable_for_resume',
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export async function resolvePiConnectedServiceSwitchContinuity(
  input: SwitchContinuityInput,
): Promise<ConnectedServiceSwitchContinuityResult> {
  const { params } = input;
  if (!supportsService(params.serviceId)) {
    return { mode: 'unsupported', reason: 'unsupported_service' };
  }

  if (isSameConnectedServiceAuthGroup(params) || isExactSameConnectedServiceSelection(params)) {
    if (!hasExactConnectedServiceRestartContinuityContext(params)) {
      return providerSessionStateUnavailableForResume();
    }

    const targetMaterializedRoot = asNonEmptyString(params.targetMaterializedRoot);
    const vendorResumeId = asNonEmptyString(params.vendorResumeId);
    const cwd = asNonEmptyString(params.cwd);
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
      agentId: 'pi',
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

    const value = readRecord(reachability.value);
    return value?.ok === true
      ? { mode: 'restart_same_home' }
      : providerSessionStateUnavailableForResume(value?.continuityDiagnostics);
  }

  if (isConnectedToConnectedServiceSwitch(params)) {
    return {
      mode: 'restart_shared_state_required',
      reason: 'pi_exact_connected_service_selection_required',
    };
  }
  return { mode: 'restart_shared_state_required', reason: 'pi_session_state_sharing_required' };
}
