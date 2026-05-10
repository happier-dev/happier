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
import type { Credentials } from '@/persistence';
import { createCliSessionStateMetadataUpdatePort } from './metadataUpdatePort';

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
  credentials: Credentials;
  session: Pick<ApiSessionClient, 'sessionId'>;
  facet?: SessionStateFacet | null;
  capabilities?: SessionStateCapabilitiesV1 | null;
  metadataPort?: MetadataUpdatePort;
}>): CliRuntimeSessionStateBridge {
  const capabilities = params.capabilities ?? params.facet?.capabilities ?? {};
  const engine = createSessionStateSyncEngine({
    capabilities,
    facet: params.facet ?? null,
    metadataPort: params.metadataPort ?? createCliSessionStateMetadataUpdatePort({
      credentials: params.credentials,
    }),
  });

  return {
    engine,
    writeHappierField: (writeParams) => engine.writeHappierField({
      ...writeParams,
      sessionId: params.session.sessionId,
      ctx: writeParams.ctx ?? { sessionId: params.session.sessionId },
    }),
  };
}
