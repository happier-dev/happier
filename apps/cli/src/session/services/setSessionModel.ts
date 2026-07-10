import type { Credentials } from '@/persistence';
import {
  buildBackendTargetKeyV2,
  createProviderErrorV1,
  ProviderConnectionIdSchema,
  resolveSessionModelSelectionInputRefV1,
  SessionModelSelectionResolutionError,
  type ProviderConnectionId,
  type ProviderErrorV1,
} from '@happier-dev/protocol';
import { resolveModelSelectionIntentFromSessionMetadata } from '@happier-dev/agents';
import { applyModelIntentSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';

import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { updateSessionMetadataForTarget } from './updateSessionMetadataForTarget';

type SetSessionModelResult = Awaited<ReturnType<typeof updateSessionMetadataForTarget>>
  | Readonly<{
      ok: false;
      code: 'provider_switch_unsupported';
      providerError: ProviderErrorV1;
    }>;

class SessionModelProviderSwitchUnsupportedError extends Error {
  constructor() {
    super('Changing provider connections requires restarting the session');
    this.name = 'SessionModelProviderSwitchUnsupportedError';
  }
}

export async function setSessionModel(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  modelId: string;
  providerConnectionId?: ProviderConnectionId | string | null;
  updatedAt?: number;
}>): Promise<SetSessionModelResult> {
  const updatedAt = params.updatedAt ?? Date.now();
  const modelId = params.modelId.trim();
  const hasExplicitProviderConnectionId = Object.prototype.hasOwnProperty.call(
    params,
    'providerConnectionId',
  );
  const explicitProviderConnectionId = params.providerConnectionId == null
    ? null
    : ProviderConnectionIdSchema.parse(params.providerConnectionId);
  try {
    return await updateSessionMetadataForTarget({
      credentials: params.credentials,
      idOrPrefix: params.idOrPrefix,
      updater: (metadata) => {
        const backendTarget = resolveBackendTargetFromSessionMetadata(metadata);
        if (!backendTarget) {
          throw new SessionModelSelectionResolutionError('model_selection_agent_target_unknown');
        }
        const agentTargetKey = buildBackendTargetKeyV2(backendTarget);
        const currentIntent = resolveModelSelectionIntentFromSessionMetadata(metadata, agentTargetKey);
        const currentProviderConnectionId = currentIntent?.selection?.providerConnectionId ?? null;
        const providerConnectionId = hasExplicitProviderConnectionId
          ? explicitProviderConnectionId
          : currentProviderConnectionId;
        if (providerConnectionId !== currentProviderConnectionId) {
          throw new SessionModelProviderSwitchUnsupportedError();
        }
        const selection = resolveSessionModelSelectionInputRefV1({
          agentTargetKey,
          providerConnectionId,
          modelId,
        });
        return applyModelIntentSessionMetadata(metadata, {
          v: 1,
          updatedAt,
          selection,
        });
      },
    });
  } catch (error) {
    if (error instanceof SessionModelProviderSwitchUnsupportedError) {
      return {
        ok: false,
        code: 'provider_switch_unsupported',
        providerError: createProviderErrorV1('provider_switch_unsupported'),
      };
    }
    throw error;
  }
}
