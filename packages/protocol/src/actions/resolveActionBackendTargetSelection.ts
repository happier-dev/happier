import { convertBackendTargetRefV2ToV1, readBackendTargetRefV2, type BackendTargetRefV2 } from '../backendTargets/backendTargetRefV2.js';
import type { BackendTargetRefV1 } from '../backendTargets/backendTargetRef.js';
import {
  hasLegacyCustomAcpConcreteBackendId,
  isLegacyConfiguredAcpCompatible,
  isLegacyConfiguredAcpFlavorCarrier,
  isLegacyCustomAcpId,
} from '../backendTargets/compat/customAcp.js';
import { isBuiltInBackendAgentId } from '../profiles/builtInBackendProfiles.js';
import { ExternalSessionsProviderIdSchema } from '../sessions/external/sourceCatalog.js';

type ActionBackendTargetSelectionInput = Readonly<{
  agentId?: string;
  backendTargetKey?: string;
}>;

export type ActionBackendTargetSelection = Readonly<{
  agentId: string | null;
  backendTargetKey: string | null;
  backendTarget: BackendTargetRefV1 | null;
  canonicalBackendTarget: BackendTargetRefV2 | null;
}>;

export type ActionBackendTargetSelectionResult =
  | Readonly<{
      ok: true;
      selection: ActionBackendTargetSelection;
    }>
  | Readonly<{
      ok: false;
      message: string;
      path: 'agentId' | 'backendTargetKey';
    }>;

function normalizeValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function canInferRuntimeCarrierFromCanonicalBackendId(backendId: string): boolean {
  return ExternalSessionsProviderIdSchema.safeParse(backendId).success || isBuiltInBackendAgentId(backendId);
}

function deriveAgentIdForConcreteBackendTarget(target: BackendTargetRefV2): string | null {
  return target.sourceKind === 'configured' || Boolean(target.configuredBackendId)
    ? null
    : target.backendId;
}

export function resolveActionBackendTargetSelection(
  input: ActionBackendTargetSelectionInput,
): ActionBackendTargetSelectionResult {
  const agentId = normalizeValue(input.agentId);
  const backendTargetKey = normalizeValue(input.backendTargetKey);

  if (!backendTargetKey) {
    if (
      isLegacyCustomAcpId(agentId)
      || isLegacyConfiguredAcpFlavorCarrier(agentId)
      || hasLegacyCustomAcpConcreteBackendId({ backendId: agentId })
    ) {
      return {
        ok: false,
        message: 'backendTargetKey is required for legacy configured-backend carriers',
        path: 'backendTargetKey',
      };
    }

    return {
      ok: true,
      selection: {
        agentId,
        backendTargetKey: null,
        backendTarget: null,
        canonicalBackendTarget: null,
      },
    };
  }

  let canonicalBackendTarget: BackendTargetRefV2;
  try {
    canonicalBackendTarget = readBackendTargetRefV2(backendTargetKey);
  } catch {
    return {
      ok: false,
      message: 'backendTargetKey must identify a concrete backend; use the exact key returned by listAgentBackends',
      path: 'backendTargetKey',
    };
  }
  const backendTarget = convertBackendTargetRefV2ToV1(canonicalBackendTarget);
  if (hasLegacyCustomAcpConcreteBackendId(canonicalBackendTarget)) {
    return {
      ok: false,
      message: 'backendTargetKey must identify a concrete backend; use the exact key returned by listAgentBackends',
      path: 'backendTargetKey',
    };
  }

  const isConfiguredTarget = canonicalBackendTarget.sourceKind === 'configured' || Boolean(canonicalBackendTarget.configuredBackendId);
  const isCanonicalBackendKey = backendTargetKey.startsWith('backend:');
  const strictDerivedAgentId = deriveAgentIdForConcreteBackendTarget(canonicalBackendTarget);
  const canInferRuntimeCarrier = !isConfiguredTarget && canInferRuntimeCarrierFromCanonicalBackendId(canonicalBackendTarget.backendId);
  const isLegacyCompatCarrier = isLegacyCustomAcpId(agentId) || isLegacyConfiguredAcpFlavorCarrier(agentId);
  if (agentId && isLegacyCompatCarrier && !isConfiguredTarget) {
    return {
      ok: false,
      message: 'agentId must not use legacy ACP carriers for non-configured backendTargetKey',
      path: 'agentId',
    };
  }
  if (isCanonicalBackendKey && !isConfiguredTarget && !agentId && !canInferRuntimeCarrier) {
    return {
      ok: false,
      message: 'agentId is required when backendTargetKey needs an explicit runtime carrier',
      path: 'agentId',
    };
  }
  const derivedAgentId = agentId ?? (isCanonicalBackendKey && !isConfiguredTarget && !canInferRuntimeCarrier ? null : strictDerivedAgentId);
  const requiresStrictMatch = !isCanonicalBackendKey || isConfiguredTarget;
  const configuredBackendId = canonicalBackendTarget.configuredBackendId ?? canonicalBackendTarget.backendId;
  const isCompatibleConfiguredLegacyAgent = isConfiguredTarget
    && isLegacyConfiguredAcpCompatible({
      legacyAgent: agentId,
      configuredBackendId,
    });
  if (agentId && requiresStrictMatch && !isCompatibleConfiguredLegacyAgent && agentId !== strictDerivedAgentId) {
    return {
      ok: false,
      message: 'agentId must match backendTargetKey when both are provided',
      path: 'agentId',
    };
  }

  return {
    ok: true,
    selection: {
      // Legacy ACP carrier ids are ingress-only; never re-emit them into canonical action selection.
      agentId: isConfiguredTarget && isLegacyCompatCarrier ? null : (agentId ?? derivedAgentId),
      backendTargetKey,
      backendTarget,
      canonicalBackendTarget,
    },
  };
}
