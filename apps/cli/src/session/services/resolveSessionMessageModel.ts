import { resolveModelSelectionIntentFromSessionMetadata } from '@happier-dev/agents';
import {
  buildBackendTargetKeyV2,
  type ModelSelectionApplyPolicy,
  ProviderBoundModelRefSchema,
  ProviderConnectionIdSchema,
  readSessionProviderBindingMetadataV1,
  SessionModelSelectionResolutionError,
  SessionModelSelectionV1Schema,
  type SessionModelSelectionV1,
} from '@happier-dev/protocol';

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
    || Object.prototype.hasOwnProperty.call(record, 'modelOverrideV1')
  ));
}

/** Resolve structured session identity before projecting any providerless compatibility field. */
export type SessionMessageModelSelectionInput = Readonly<{
  providerConnectionId?: string | null;
  modelId: string | null;
}>;

export type SessionMessageModelResolution = Readonly<{
  modelId: string;
  selection: SessionModelSelectionV1 | null;
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
  const backendTarget = resolveBackendTargetFromSessionMetadata(metadata);
  const agentTargetKey = backendTarget ? buildBackendTargetKeyV2(backendTarget) : null;

  if (params.modelSelectionInput !== undefined) {
    if (!agentTargetKey) {
      throw new SessionModelSelectionResolutionError('model_selection_agent_target_unknown');
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
    const currentIntent = resolveModelSelectionIntentFromSessionMetadata(metadata, agentTargetKey);
    const currentProviderConnectionId = params.sessionActive === true
      ? readSessionProviderBindingMetadataV1(metadata)?.connectionId ?? null
      : currentIntent?.selection?.providerConnectionId ?? null;
    const providerConnectionId = hasExplicitProviderConnectionId
      ? requestedProviderConnectionId
      : currentProviderConnectionId;
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
    return { modelId: modelId === 'default' ? '' : modelId, selection: null };
  }

  if (!agentTargetKey) {
    if (hasPersistedModelIntent(metadata)) {
      throw new SessionModelSelectionResolutionError('model_selection_agent_target_unknown');
    }
    return { modelId: '', selection: null };
  }
  const intent = resolveModelSelectionIntentFromSessionMetadata(metadata, agentTargetKey);
  return {
    modelId: intent?.selection?.modelId ?? '',
    selection: intent?.selection
      ? SessionModelSelectionV1Schema.parse({
          v: 1,
          updatedAt: intent.updatedAt,
          ref: intent.selection,
        })
      : null,
  };
}
