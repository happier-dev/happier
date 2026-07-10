import { resolveModelSelectionIntentFromSessionMetadata } from '@happier-dev/agents';
import {
  buildBackendTargetKeyV2,
  ProviderConnectionIdSchema,
  resolveSessionModelSelectionInputRefV1,
  SessionModelSelectionResolutionError,
} from '@happier-dev/protocol';

import {
  resolveBackendTargetFromSessionMetadata,
  resolveExplicitBackendTargetFromSessionMetadata,
} from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';

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

/** Resolve structured session identity, then expose only the final engine model selector. */
export type SessionMessageModelSelectionInput = Readonly<{
  providerConnectionId?: string | null;
  modelId: string | null;
}>;

export class SessionMessageProviderSwitchUnsupportedError extends Error {
  readonly code = 'provider_switch_unsupported' as const;

  constructor() {
    super('Changing provider connections requires restarting the session');
    this.name = 'SessionMessageProviderSwitchUnsupportedError';
  }
}

export function resolveSessionMessageModelId(params: Readonly<{
  metadata: unknown;
  modelSelectionInput?: SessionMessageModelSelectionInput;
  legacyModelOverride?: string | null;
}>): string {
  const metadata = asRecord(params.metadata);
  const backendTarget = params.modelSelectionInput !== undefined
    ? resolveExplicitBackendTargetFromSessionMetadata(metadata)
    : resolveBackendTargetFromSessionMetadata(metadata);
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
    const currentProviderConnectionId = currentIntent?.selection?.providerConnectionId ?? null;
    if (hasExplicitProviderConnectionId && requestedProviderConnectionId !== currentProviderConnectionId) {
      throw new SessionMessageProviderSwitchUnsupportedError();
    }
    const providerConnectionId = hasExplicitProviderConnectionId
      ? requestedProviderConnectionId
      : currentProviderConnectionId;
    if (requestedModelId === null || (providerConnectionId === null && requestedModelId.trim() === 'default')) {
      return '';
    }
    const selection = resolveSessionModelSelectionInputRefV1({
      agentTargetKey,
      providerConnectionId,
      modelId: requestedModelId,
    });
    return selection?.modelId ?? '';
  }

  if (params.legacyModelOverride !== undefined) {
    const modelId = params.legacyModelOverride?.trim() ?? '';
    return modelId === 'default' ? '' : modelId;
  }

  if (!agentTargetKey) {
    if (hasPersistedModelIntent(metadata)) {
      throw new SessionModelSelectionResolutionError('model_selection_agent_target_unknown');
    }
    return '';
  }
  const intent = resolveModelSelectionIntentFromSessionMetadata(metadata, agentTargetKey);
  return intent?.selection?.modelId ?? '';
}
