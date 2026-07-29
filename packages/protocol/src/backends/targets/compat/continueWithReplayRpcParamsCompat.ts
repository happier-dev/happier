import { z } from 'zod';

import {
  hasLegacyCustomAcpConcreteBackendId,
  isLegacyConfiguredAcpCompatible,
  readLegacyCustomAcpAgentCarrier,
} from './customAcp.js';

type ContinueWithReplayCompatBackendTarget = Readonly<{
  kind: 'backend';
  backendId: string;
  configuredBackendId?: string;
  sourceKind: 'built_in' | 'configured';
}>;

function normalizeLegacyContinueWithReplayAgent(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readLegacyContinueWithReplayCompatBackendTargetInput(
  legacyAgent: unknown,
): ContinueWithReplayCompatBackendTarget | null {
  const normalizedLegacyAgent = normalizeLegacyContinueWithReplayAgent(legacyAgent);
  if (!normalizedLegacyAgent) {
    return null;
  }

  const carrier = readLegacyCustomAcpAgentCarrier(normalizedLegacyAgent);
  if (carrier?.kind === 'custom_acp_placeholder') {
    return null;
  }
  if (carrier?.kind === 'configured_backend') {
    return {
      kind: 'backend',
      backendId: carrier.configuredBackendId,
      configuredBackendId: carrier.configuredBackendId,
      sourceKind: 'configured',
    };
  }
  if (hasLegacyCustomAcpConcreteBackendId({ backendId: normalizedLegacyAgent })) {
    return null;
  }

  return {
    kind: 'backend',
    backendId: normalizedLegacyAgent,
    sourceKind: 'built_in',
  };
}

export function normalizeLegacyContinueWithReplayRpcParamsInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (record.backendTarget !== undefined) {
    return value;
  }

  const legacyAgent = normalizeLegacyContinueWithReplayAgent(record.agent);
  if (!legacyAgent) {
    return value;
  }

  const compatBackendTarget = readLegacyContinueWithReplayCompatBackendTargetInput(legacyAgent);
  if (!compatBackendTarget) {
    return value;
  }

  return {
    ...record,
    backendTarget: compatBackendTarget,
  };
}

export function validateLegacyContinueWithReplayRpcParamsCompat(
  value: Readonly<{
    agent?: unknown;
    backendTarget?: Readonly<Record<string, unknown>> | undefined;
  }>,
  ctx: z.RefinementCtx,
): void {
  const legacyAgent = normalizeLegacyContinueWithReplayAgent(value.agent);
  if (!legacyAgent) {
    return;
  }

  const backendTarget = value.backendTarget;
  const carrier = readLegacyCustomAcpAgentCarrier(legacyAgent);
  if (carrier?.kind === 'custom_acp_placeholder' && !backendTarget) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'backendTarget is required for legacy configured-backend carriers',
      path: ['backendTarget'],
    });
    return;
  }

  if (!backendTarget || typeof backendTarget.backendId !== 'string' || backendTarget.backendId.trim().length === 0) {
    return;
  }

  const backendId = backendTarget.backendId.trim();
  const configuredBackendId =
    typeof backendTarget.configuredBackendId === 'string' && backendTarget.configuredBackendId.trim().length > 0
      ? backendTarget.configuredBackendId.trim()
      : backendId;
  const isConfiguredLegacyAgent = backendTarget.sourceKind === 'configured'
    && isLegacyConfiguredAcpCompatible({ legacyAgent, configuredBackendId });

  if (legacyAgent !== backendId && !isConfiguredLegacyAgent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'agent must match backendTarget when both are provided',
      path: ['agent'],
    });
  }
}
