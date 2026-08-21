import type {
  SessionSystemRecord,
  SessionSystemRecordNamespace,
  SessionSystemRecordUpsertRequest,
  SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';
import { SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY } from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';

import {
  ACTIVITY_SYSTEM_RECORD_NAMESPACE,
  buildWorkflowRunSystemRecordLocalId,
  openWorkflowRunSystemRecordPayload,
} from './activitySystemRecords';
import { commitWorkflowActivitySystemRecord } from './commitWorkflowActivitySystemRecords';
import type { SessionActivityHeadlineBundle } from './publishWorkflowActivitySnapshot';

/**
 * The provider-neutral session transport required by a workflow activity source.
 * Providers normalize their own events; this owner applies the one durable/encrypted
 * record and paired-headline write contract.
 */
export type SessionWorkflowActivityBinding = Readonly<{
  sessionId: string;
  metadataWriter: Readonly<{
    updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  }>;
  upsertSystemRecord: (request: SessionSystemRecordUpsertRequest) => Promise<void>;
  fetchSystemRecord?: (params: Readonly<{
    namespace: SessionSystemRecordNamespace;
    localId: string;
  }>) => Promise<SessionSystemRecord | null>;
  resolveEncryption: () => Promise<Readonly<{
    mode: SessionStoredContentEncryptionMode;
    ctx?: SessionEncryptionContext;
  }>>;
}>;

export type SessionWorkflowActivityTransport = Readonly<{
  resolveEncryption: SessionWorkflowActivityBinding['resolveEncryption'];
  commitRecord: (snapshot: SessionWorkflowRunSnapshotV1) => Promise<void>;
  readCommittedRunSnapshot?: (runId: string) => Promise<SessionWorkflowRunSnapshotV1 | null>;
  writeHeadlines: (bundle: SessionActivityHeadlineBundle) => Promise<void>;
}>;

export function createSessionWorkflowActivityTransport(
  binding: SessionWorkflowActivityBinding,
): SessionWorkflowActivityTransport {
  let encryptionResolution: ReturnType<SessionWorkflowActivityBinding['resolveEncryption']> | null = null;
  const resolveEncryption = (): ReturnType<SessionWorkflowActivityBinding['resolveEncryption']> => {
    if (!encryptionResolution) {
      encryptionResolution = Promise.resolve(binding.resolveEncryption()).catch((error) => {
        encryptionResolution = null;
        throw error;
      });
    }
    return encryptionResolution;
  };

  const commitRecord = async (snapshot: SessionWorkflowRunSnapshotV1): Promise<void> => {
    const { mode, ctx } = await resolveEncryption();
    await commitWorkflowActivitySystemRecord({
      sessionId: binding.sessionId,
      mode,
      ...(ctx ? { ctx } : {}),
      snapshot,
      upsertSystemRecord: binding.upsertSystemRecord,
    });
  };

  const readCommittedRunSnapshot = binding.fetchSystemRecord
    ? async (runId: string): Promise<SessionWorkflowRunSnapshotV1 | null> => {
      const record = await binding.fetchSystemRecord?.({
        namespace: ACTIVITY_SYSTEM_RECORD_NAMESPACE,
        localId: buildWorkflowRunSystemRecordLocalId({ runId }),
      });
      if (!record || record.namespace !== ACTIVITY_SYSTEM_RECORD_NAMESPACE) return null;
      const { ctx } = await resolveEncryption();
      return openWorkflowRunSystemRecordPayload({
        namespace: record.namespace,
        content: record.content,
        ...(ctx ? { ctx } : {}),
      });
    }
    : undefined;

  return {
    resolveEncryption,
    commitRecord,
    ...(readCommittedRunSnapshot ? { readCommittedRunSnapshot } : {}),
    writeHeadlines: async (bundle) => {
      await binding.metadataWriter.updateMetadata((metadata) => ({
        ...metadata,
        sessionWorkflowActivityHeadlineV1: bundle.workflow,
        [SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY]: bundle.agentActivity,
      }));
    },
  };
}
