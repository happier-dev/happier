import {
  resolveAmbientProviderConnectionForModelIntent,
} from '@happier-dev/agents';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ModelSelectionApplyPolicy } from '@happier-dev/protocol';
import { isNativeAutomaticModelSelectionInputV1, ProviderBoundModelRefSchema, SessionModelSelectionResolutionError, SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { SessionModelSelectionV2Schema, isSessionModelRefSourceBound, type SessionModelRefV2, type SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import { resolveSessionModelSelectionFromMetadata } from '@happier-dev/agents/session/state/metadataReaders';

import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function hasPersistedModelIntent(metadata: unknown): boolean {
  const record = asRecord(metadata);
  return Boolean(record && (
    Object.prototype.hasOwnProperty.call(record, 'modelSelectionIntentV1')
    || Object.prototype.hasOwnProperty.call(record, 'modelSelectionIntentV2')
    || Object.prototype.hasOwnProperty.call(record, 'modelOverrideV1')
  ));
}

/** Resolve structured session identity before projecting any providerless compatibility field. */
export type SessionMessageModelSelectionInput = Readonly<{
  providerConnectionId?: string | null;
  modelId: string | null;
}> | SessionModelRefV2;

export type SessionMessageModelResolution = Readonly<{
  modelId: string;
  selection: SessionModelSelection | null;
}>;

export function resolveSessionMessageModel(params: Readonly<{
  metadata: unknown;
  sessionActive?: boolean;
  modelSelectionInput?: SessionMessageModelSelectionInput;
  legacyModelOverride?: string | null;
  agentPolicy?: ModelSelectionApplyPolicy;
  nowMs?: number;
}>): SessionMessageModelResolution {
  const metadata = asRecord(params.metadata);
  if (
    params.sessionActive === true
    && params.modelSelectionInput === undefined
    && params.legacyModelOverride === undefined
  ) {
    return { modelId: '', selection: null };
  }
  // Every sender shares the native reset semantics before ambient Provider
  // completion. A reset has no per-message structured ref; an explicitly named
  // Provider can still publish a literal model called `default`.
  if (params.modelSelectionInput !== undefined
    && !('source' in params.modelSelectionInput)
    && isNativeAutomaticModelSelectionInputV1(params.modelSelectionInput)) {
    return { modelId: '', selection: null };
  }
  const backendTarget = resolveBackendTargetFromSessionMetadata(metadata);
  const agentTargetKey = backendTarget ? buildBackendTargetKeyV2(backendTarget) : null;

  if (params.modelSelectionInput !== undefined) {
    if (!agentTargetKey) {
      throw new SessionModelSelectionResolutionError('model_selection_agent_target_unknown');
    }
    if ('source' in params.modelSelectionInput) {
      const selection = SessionModelSelectionV2Schema.parse({ v: 2,
        updatedAt: params.nowMs ?? Date.now(), ref: params.modelSelectionInput });
      if (selection.ref.agentTargetKey !== agentTargetKey) {
        throw new SessionModelSelectionResolutionError('model_selection_agent_target_unknown');
      }
      if (selection.ref.source === 'native' && isNativeAutomaticModelSelectionInputV1(selection.ref)) {
        return { modelId: '', selection: null };
      }
      return { modelId: selection.ref.modelId, selection };
    }
    const hasExplicitProviderConnectionId = Object.prototype.hasOwnProperty.call(
      params.modelSelectionInput,
      'providerConnectionId',
    );
    const requestedProviderConnectionId = params.modelSelectionInput.providerConnectionId == null
      ? null
      : ProviderConnectionIdSchema.parse(params.modelSelectionInput.providerConnectionId);
    const requestedModelId = params.modelSelectionInput.modelId;
    if (requestedProviderConnectionId !== null && requestedModelId === null) {
      throw new Error('Provider model selection requires a concrete model id');
    }
    let providerConnectionId: string | null;
    if (hasExplicitProviderConnectionId) {
      providerConnectionId = requestedProviderConnectionId;
    } else {
      const ambient = resolveAmbientProviderConnectionForModelIntent({
        metadata,
        agentTargetKey,
        sessionActive: params.sessionActive === true,
      });
      if (ambient.status === 'unreadable') {
        throw new SessionModelSelectionResolutionError(ambient.code);
      }
      providerConnectionId = ambient.providerConnectionId;
    }
    const selection = ProviderBoundModelRefSchema.parse({
      agentTargetKey,
      providerConnectionId,
      modelId: requestedModelId ?? 'default',
    });
    return {
      modelId: selection.modelId,
      selection: SessionModelSelectionV1Schema.parse({
        v: 1,
        updatedAt: params.nowMs ?? Date.now(),
        ref: selection,
      }),
    };
  }

  if (params.legacyModelOverride !== undefined) {
    const modelId = params.legacyModelOverride?.trim() ?? '';
    return { modelId: isNativeAutomaticModelSelectionInputV1({ modelId }) ? '' : modelId, selection: null };
  }

  if (!agentTargetKey) {
    if (hasPersistedModelIntent(metadata)) {
      throw new SessionModelSelectionResolutionError('model_selection_agent_target_unknown');
    }
    return { modelId: '', selection: null };
  }
  const selection = resolveSessionModelSelectionFromMetadata(metadata, agentTargetKey);
  if (selection && !isSessionModelRefSourceBound(selection.ref)
    && isNativeAutomaticModelSelectionInputV1(selection.ref)) {
    return { modelId: '', selection: null };
  }
  return {
    modelId: selection?.ref.modelId ?? '',
    selection,
  };
}
