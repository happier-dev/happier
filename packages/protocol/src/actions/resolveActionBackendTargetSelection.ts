import {
  BackendTargetKeyV2Schema,
  BackendTargetRefV2Schema,
  buildBackendTargetKeyV2,
  convertBackendTargetRefV2ToV1,
  parseBackendTargetKeyV2,
  readBackendTargetRefV2,
  type BackendTargetRefV2,
} from '../backends/targets/backendTargetRefV2.js';
import { BackendTargetKeySchema, buildBackendTargetKey, type BackendTargetRefV1 } from '../backends/targets/backendTargetRef.js';
import {
  hasLegacyCustomAcpConcreteBackendId,
  isLegacyConfiguredAcpCompatible,
  isLegacyConfiguredAcpFlavorCarrier,
  isLegacyCustomAcpId,
} from '../backends/targets/compat/customAcp.js';
import { isBuiltInBackendAgentId } from '../profiles/builtInBackendProfiles.js';
import { EXTERNAL_SESSIONS_AGENT_IDS } from '../sessions/external/sourceCatalog.js';
import type { RuntimeDescriptorV1 } from '../sessions/metadata/runtimeDescriptorV1.js';

type ActionBackendTargetSelectionInput = Readonly<{
  agentId?: string;
  backendTargetKey?: string;
  backendTarget?: BackendTargetRefV2 | null;
  runtimeDescriptorV1?: RuntimeDescriptorV1 | null;
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
      path: 'agentId' | 'backendTargetKey' | 'backendTarget' | 'runtimeDescriptorV1';
    }>;

/** Canonical option-value translation shared by Action dispatch and Workflow admission. */
export function resolveExecutionBackendTargetSelectionForValue(value: string): ActionBackendTargetSelection | null {
  const normalizedValue = value.trim();
  if (!normalizedValue) return null;
  const isExplicitTargetKey = BackendTargetKeySchema.safeParse(normalizedValue).success
    || BackendTargetKeyV2Schema.safeParse(normalizedValue).success;
  const candidateKey = isExplicitTargetKey ? normalizedValue
    : normalizedValue.includes('/')
      ? buildBackendTargetKeyV2({ kind: 'backend', backendId: normalizedValue, sourceKind: 'built_in' })
      : buildBackendTargetKey({ kind: 'builtInAgent', agentId: normalizedValue });
  const resolved = resolveActionBackendTargetSelection({
    backendTargetKey: candidateKey, ...(!isExplicitTargetKey ? { agentId: normalizedValue } : {}),
  });
  if (!resolved.ok) return null;
  const selection = resolved.selection;
  return selection.canonicalBackendTarget
    ? { ...selection, backendTargetKey: buildBackendTargetKeyV2(selection.canonicalBackendTarget) }
    : selection;
}

function normalizeValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function canInferRuntimeCarrierFromCanonicalBackendId(backendId: string): boolean {
  return EXTERNAL_SESSIONS_AGENT_IDS.some((agentId) => agentId === backendId)
    || isBuiltInBackendAgentId(backendId);
}

function deriveAgentIdForConcreteBackendTarget(target: BackendTargetRefV2): string | null {
  return target.sourceKind === 'configured' || Boolean(target.configuredBackendId)
    ? null
    : target.backendId;
}

function doBackendTargetCarriersAgree(params: Readonly<{
  backendTargetKey: string;
  keyedTarget: BackendTargetRefV2;
  structuredTarget: BackendTargetRefV2;
}>): boolean {
  if (!BackendTargetKeyV2Schema.safeParse(params.backendTargetKey).success) {
    return buildBackendTargetKey(convertBackendTargetRefV2ToV1(params.structuredTarget)) === params.backendTargetKey;
  }
  return buildBackendTargetKeyV2(params.keyedTarget) === buildBackendTargetKeyV2(params.structuredTarget);
}

function isRoutableAgentTargetKey(key: string | null): boolean {
  if (!key) return false;
  try {
    readBackendTargetRefV2(key);
    return true;
  } catch {
    return false;
  }
}

export function resolveActionBackendTargetSelection(
  input: ActionBackendTargetSelectionInput,
): ActionBackendTargetSelectionResult {
  const agentId = normalizeValue(input.agentId);
  const backendTargetKey = normalizeValue(input.backendTargetKey);
  const runtimeDescriptorAgentId = normalizeValue(input.runtimeDescriptorV1?.agentId);
  if (
    input.runtimeDescriptorV1
    && runtimeDescriptorAgentId !== input.runtimeDescriptorV1.agentId
  ) {
    return {
      ok: false,
      message: 'runtimeDescriptorV1.agentId must be a canonical non-empty Agent id',
      path: 'runtimeDescriptorV1',
    };
  }
  if (
    runtimeDescriptorAgentId
    && (
      isLegacyCustomAcpId(runtimeDescriptorAgentId)
      || isLegacyConfiguredAcpFlavorCarrier(runtimeDescriptorAgentId)
      || hasLegacyCustomAcpConcreteBackendId({ backendId: runtimeDescriptorAgentId })
    )
  ) {
    return {
      ok: false,
      message: 'runtimeDescriptorV1.agentId must identify a concrete runtime Agent',
      path: 'runtimeDescriptorV1',
    };
  }

  const parsedBackendTargetKey = backendTargetKey
    ? BackendTargetKeyV2Schema.safeParse(backendTargetKey)
    : null;
  const parsedTarget = parsedBackendTargetKey?.success
    ? parseBackendTargetKeyV2(parsedBackendTargetKey.data)
    : null;
  // A bundled Agent's canonical key is also `agent:`-qualified, but it routes by
  // its bundled id; only an Agent the protocol cannot route needs a carrier.
  const qualifiedAgentIdentity = parsedTarget?.kind === 'agent' && !isRoutableAgentTargetKey(backendTargetKey)
    ? parsedTarget.identity
    : null;
  if (qualifiedAgentIdentity) {
    if (input.backendTarget !== undefined && input.backendTarget !== null) {
      return {
        ok: false,
        message: 'backendTarget must not accompany a qualified Agent contribution target',
        path: 'backendTarget',
      };
    }
    if (!agentId) {
      return {
        ok: false,
        message: 'agentId is required for a qualified Agent contribution target',
        path: 'agentId',
      };
    }
    if (runtimeDescriptorAgentId && runtimeDescriptorAgentId !== agentId) {
      return {
        ok: false,
        message: 'runtimeDescriptorV1.agentId must match agentId when both are provided',
        path: 'runtimeDescriptorV1',
      };
    }
    return {
      ok: true,
      selection: {
        agentId,
        backendTargetKey,
        backendTarget: null,
        canonicalBackendTarget: null,
      },
    };
  }

  const structuredBackendTarget = (() => {
    if (input.backendTarget === undefined || input.backendTarget === null) {
      return { ok: true as const, value: null };
    }
    const parsed = BackendTargetRefV2Schema.safeParse(input.backendTarget);
    return parsed.success
      ? { ok: true as const, value: parsed.data }
      : { ok: false as const };
  })();
  if (!structuredBackendTarget.ok) {
    return {
      ok: false,
      message: 'backendTarget must identify a concrete backend',
      path: 'backendTarget',
    };
  }

  let keyedBackendTarget: BackendTargetRefV2 | null = null;
  if (backendTargetKey) {
    try {
      keyedBackendTarget = readBackendTargetRefV2(backendTargetKey);
    } catch {
      return {
        ok: false,
        message: 'backendTargetKey must identify a concrete backend; use the exact key returned by listAgentBackends',
        path: 'backendTargetKey',
      };
    }
  }

  if (
    backendTargetKey
    && keyedBackendTarget
    && structuredBackendTarget.value
    && !doBackendTargetCarriersAgree({
      backendTargetKey,
      keyedTarget: keyedBackendTarget,
      structuredTarget: structuredBackendTarget.value,
    })
  ) {
    return {
      ok: false,
      message: 'backendTarget must match backendTargetKey when both are provided',
      path: 'backendTarget',
    };
  }

  const canonicalBackendTarget = structuredBackendTarget.value ?? keyedBackendTarget;

  if (!canonicalBackendTarget) {
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
    if (agentId && runtimeDescriptorAgentId && agentId !== runtimeDescriptorAgentId) {
      return {
        ok: false,
        message: 'runtimeDescriptorV1.agentId must match agentId when both are provided',
        path: 'runtimeDescriptorV1',
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

  const backendTarget = convertBackendTargetRefV2ToV1(canonicalBackendTarget);
  if (hasLegacyCustomAcpConcreteBackendId(canonicalBackendTarget)) {
    return {
      ok: false,
      message: backendTargetKey
        ? 'backendTargetKey must identify a concrete backend; use the exact key returned by listAgentBackends'
        : 'backendTarget must identify a concrete backend',
      path: backendTargetKey ? 'backendTargetKey' : 'backendTarget',
    };
  }

  const isConfiguredTarget = canonicalBackendTarget.sourceKind === 'configured' || Boolean(canonicalBackendTarget.configuredBackendId);
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
  if (
    backendTargetKey
    && !isConfiguredTarget
    && !agentId
    && !runtimeDescriptorAgentId
    && !canInferRuntimeCarrier
  ) {
    return {
      ok: false,
      message: 'agentId is required when backendTargetKey needs an explicit runtime carrier',
      path: 'agentId',
    };
  }

  if (
    agentId
    && runtimeDescriptorAgentId
    && agentId !== runtimeDescriptorAgentId
    && !(isConfiguredTarget && isLegacyCompatCarrier)
  ) {
    return {
      ok: false,
      message: 'runtimeDescriptorV1.agentId must match agentId when both are provided',
      path: 'runtimeDescriptorV1',
    };
  }

  const runtimeDescriptorIsSolePluginCarrier = Boolean(
    runtimeDescriptorAgentId
    && !isConfiguredTarget
    && !canInferRuntimeCarrier,
  );
  const derivedAgentId = agentId ?? (
    backendTargetKey
    && !runtimeDescriptorIsSolePluginCarrier
      ? strictDerivedAgentId
      : null
  );
  const requiresStrictMatch = isConfiguredTarget || canInferRuntimeCarrier;
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
  if (
    runtimeDescriptorAgentId
    && !isConfiguredTarget
    && requiresStrictMatch
    && runtimeDescriptorAgentId !== strictDerivedAgentId
  ) {
    return {
      ok: false,
      message: 'runtimeDescriptorV1.agentId must match the concrete built-in backend target',
      path: 'runtimeDescriptorV1',
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
