import { AGENTS_CORE } from '@happier-dev/agents';

import type {
  ConnectedServiceSwitchContinuityParams,
  ConnectedServiceSwitchContinuityResult,
} from '@/backends/types';
import {
  hasExactConnectedServiceRestartContinuityContext,
  isSameConnectedServiceAuthGroup,
  providerSessionStateUnavailableForResume,
} from '@/backends/connectedServices/switchContinuityContext';
import { canResumeFromMaterializedStateCore } from '@/daemon/connectedServices/stateSharing/canResumeFromMaterializedStateCore';
import { resolveConnectedServiceRestartContinuityAction } from '@/daemon/connectedServices/sessionAuthSwitch/continuity/resolveConnectedServiceSwitchAction';
import { codexConnectedServiceStateSharingDescriptor } from './codexConnectedServiceStateSharingDescriptor';
import { createCodexConnectedServiceRuntimeAuthAdapter } from './createCodexConnectedServiceRuntimeAuthAdapter';
import { verifyResumeReachableCodex } from './verifyResumeReachableCodex';

const CODEX_RESTART_REMATERIALIZE_REQUIRED_REASON = 'codex_restart_rematerialize_required';
const CODEX_SHARED_STATE_REQUIRED_REASON = 'codex_shared_state_required';

function supportsService(serviceId: string): boolean {
  return (AGENTS_CORE.codex.connectedServices.supportedServiceIds as readonly string[]).includes(serviceId);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function resolveCodexConnectedServiceSwitchContinuity(
  params: ConnectedServiceSwitchContinuityParams,
): Promise<ConnectedServiceSwitchContinuityResult> {
  if (!supportsService(params.serviceId)) {
    return { mode: 'unsupported', reason: 'unsupported_service' };
  }
  if (params.serviceId !== 'openai-codex') {
    return { mode: 'unsupported', reason: 'codex_api_key_switch_continuity_unsupported' };
  }

  if (params.runtimeAuthSelection) {
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
    if (readRecord(params.runtimeAuthSelection)?.requireDirectLiveHotApply === true) {
      return { mode: 'hot_apply' };
    }
  }

  if (isSameConnectedServiceAuthGroup(params)) {
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

    const reachability = await canResumeFromMaterializedStateCore({
      targetMaterializedRoot,
      targetMaterializedEnv,
      requestedStateMode: 'isolated',
      effectiveStateMode: 'isolated',
      materializationIdentity,
      vendorResumeId,
      cwd,
      candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
      verifyResumeReachable: verifyResumeReachableCodex,
    });
    return reachability.ok
      ? { mode: 'restart_same_home' }
      : providerSessionStateUnavailableForResume({
          diagnostics: reachability.continuityDiagnostics,
        });
  }

  return resolveConnectedServiceRestartContinuityAction({
    stateSharingDescriptor: codexConnectedServiceStateSharingDescriptor,
    restartReason: CODEX_RESTART_REMATERIALIZE_REQUIRED_REASON,
    sharedStateRequiredReason: CODEX_SHARED_STATE_REQUIRED_REASON,
  });
}
