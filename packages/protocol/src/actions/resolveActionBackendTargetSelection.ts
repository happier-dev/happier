import { parseBackendTargetKey, type BackendTargetRefV1 } from '../backendTargets/backendTargetRef.js';

type ActionBackendTargetSelectionInput = Readonly<{
  agentId?: string;
  backendTargetKey?: string;
}>;

export type ActionBackendTargetSelection = Readonly<{
  agentId: string | null;
  backendTargetKey: string | null;
  backendTarget: BackendTargetRefV1 | null;
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

export function resolveActionBackendTargetSelection(
  input: ActionBackendTargetSelectionInput,
): ActionBackendTargetSelectionResult {
  const agentId = normalizeValue(input.agentId);
  const backendTargetKey = normalizeValue(input.backendTargetKey);

  if (!backendTargetKey) {
    if (agentId === 'customAcp') {
      return {
        ok: false,
        message: 'backendTargetKey is required for customAcp',
        path: 'backendTargetKey',
      };
    }

    return {
      ok: true,
      selection: {
        agentId,
        backendTargetKey: null,
        backendTarget: null,
      },
    };
  }

  const backendTarget = parseBackendTargetKey(backendTargetKey);
  if (backendTarget.kind === 'builtInAgent' && backendTarget.agentId === 'customAcp') {
    return {
      ok: false,
      message: 'backendTargetKey must identify a concrete backend; use acpBackend:<id> for configured ACP backends',
      path: 'backendTargetKey',
    };
  }

  const derivedAgentId = backendTarget.kind === 'builtInAgent' ? backendTarget.agentId : 'customAcp';
  if (agentId && agentId !== derivedAgentId) {
    return {
      ok: false,
      message: 'agentId must match backendTargetKey when both are provided',
      path: 'agentId',
    };
  }

  return {
    ok: true,
    selection: {
      agentId: agentId ?? derivedAgentId,
      backendTargetKey,
      backendTarget,
    },
  };
}
