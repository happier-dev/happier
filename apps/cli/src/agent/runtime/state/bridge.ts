import type {
  SessionStateCapabilitiesV1,
  SessionStateFieldId,
} from '@happier-dev/protocol';
import {
  createSessionStateSyncEngine,
  type MetadataUpdatePort,
  type RuntimeFacetCtx,
  type SessionStateApplyReason,
  type SessionStateFacet,
  type SessionStateFieldWriteValue,
  type SessionStateSyncEngine,
} from '@happier-dev/agents';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { StoredCredentials } from '@/persistence';
import { createCliSessionStateMetadataUpdatePort } from './metadataUpdatePort';
import { mergeHostSessionStateCapabilities } from './sessionStateMetadataCapabilities';
import { enqueueDurableRegisteredSessionStateFieldWrite } from './registeredFieldDurability';

export type CliRuntimeSessionStateBridge = Readonly<{
  engine: SessionStateSyncEngine;
  writeHappierField<F extends SessionStateFieldId>(params: Readonly<{
    fieldId: F;
    value: SessionStateFieldWriteValue<F>;
    reason: SessionStateApplyReason;
    metadataReason: string;
    ctx?: RuntimeFacetCtx;
    maxAttempts?: number;
    mirrorToProvider?: boolean;
  }>): ReturnType<SessionStateSyncEngine['writeHappierField']>;
}>;

export function createCliRuntimeSessionStateBridge(params: Readonly<{
  credentials: StoredCredentials;
  session: Pick<ApiSessionClient, 'sessionId'> & Partial<Pick<ApiSessionClient, 'enqueueRegisteredSessionStateFieldMutation'>>;
  facet?: SessionStateFacet | null;
  capabilities?: SessionStateCapabilitiesV1 | null;
  metadataPort?: MetadataUpdatePort;
}>): CliRuntimeSessionStateBridge {
  const capabilities = mergeHostSessionStateCapabilities(params.capabilities ?? params.facet?.capabilities);
  const engine = createSessionStateSyncEngine({
    capabilities,
    facet: params.facet ?? null,
    metadataPort: params.metadataPort ?? createCliSessionStateMetadataUpdatePort({
      credentials: params.credentials,
    }),
  });

  return {
    engine,
    writeHappierField: async (writeParams) => {
      const durableResult = await enqueueDurableRegisteredSessionStateFieldWrite({
        sessionId: params.session.sessionId,
        fieldId: writeParams.fieldId,
        value: writeParams.value,
        source: 'runtime',
        enqueue: typeof params.session.enqueueRegisteredSessionStateFieldMutation === 'function'
          ? (mutation) => params.session.enqueueRegisteredSessionStateFieldMutation?.(mutation)
          : undefined,
      });
      if (durableResult) return durableResult;
      return engine.writeHappierField({
        ...writeParams,
        sessionId: params.session.sessionId,
        ctx: writeParams.ctx ?? { sessionId: params.session.sessionId },
      });
    },
  };
}
