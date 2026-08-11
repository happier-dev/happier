import {
  type SessionEncryptionContext,
  type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { logger } from '@/ui/logger';

import type { Session } from '../session';
import type { ClaudeWorkflowAgentTranscriptRegistration } from './claudeWorkflowJournalFollower';
import {
  wireClaudeWorkflowActivitySource,
  type WiredClaudeWorkflowActivitySource,
} from './wireClaudeWorkflowActivitySource';

/**
 * Launcher-level composition that binds the provider-clean Claude workflow ACTIVITY source to a LIVE
 * session's durable writer + stored-content encryption (CWF3 wiring).
 *
 * The session client already owns the active session socket, storage mode, and encryption context.
 * Workflow activity records are live session mutations, so they must use that canonical session
 * transport instead of a parallel credential + raw HTTP path.
 *
 * Returns `null` only for older/session stubs that do not expose the required generic session
 * capabilities; production `ApiSessionClient` implements both.
 */
export async function createClaudeWorkflowActivitySourceForSession(params: Readonly<{
  session: Session;
  logPrefix: string;
  getCurrentClaudeSessionId: () => string | null;
  /**
   * Hand a workflow agent's sidecar transcript to the launcher's sidechain importer — the same one
   * that imports `Task` sub-agent transcripts. Omitted by launchers that run no importer.
   */
  registerWorkflowAgentTranscript?: (
    registration: ClaudeWorkflowAgentTranscriptRegistration,
  ) => void | Promise<void>;
}>): Promise<WiredClaudeWorkflowActivitySource | null> {
  const sessionId = params.session.sessionId ?? params.session.client.sessionId;
  if (!sessionId) {
    logger.debug(`${params.logPrefix}: no session id yet; Claude workflow activity source not wired`);
    return null;
  }

  const upsertSystemRecord = params.session.client.upsertSessionSystemRecord?.bind(params.session.client);
  const fetchSystemRecord = params.session.client.fetchSessionSystemRecord?.bind(params.session.client);
  const getStoredContentEncryptionContext = params.session.client.getStoredContentEncryptionContext?.bind(params.session.client);
  if (!upsertSystemRecord || !getStoredContentEncryptionContext) {
    logger.debug(`${params.logPrefix}: session client cannot write workflow system records; Claude workflow activity source not wired`);
    return null;
  }

  let cached: Readonly<{ mode: SessionStoredContentEncryptionMode; ctx?: SessionEncryptionContext }> | null = null;
  const resolveEncryption = async (): Promise<Readonly<{ mode: SessionStoredContentEncryptionMode; ctx?: SessionEncryptionContext }>> => {
    if (cached) return cached;
    const resolved = getStoredContentEncryptionContext();
    cached = resolved;
    return resolved;
  };

  const runtimeActivityAdapter = params.session.getProviderTaskRuntimeActivityAdapter?.() ?? null;
  const providerActivityLedger = params.session.getProviderTaskActivityLedger?.() ?? null;
  const source = wireClaudeWorkflowActivitySource({
    backendId: 'claude',
    agentId: 'claude',
    binding: {
      sessionId,
      metadataWriter: params.session.client,
      upsertSystemRecord,
      ...(fetchSystemRecord ? { fetchSystemRecord } : {}),
      resolveEncryption,
      getCurrentClaudeSessionId: params.getCurrentClaudeSessionId,
    },
    ...(runtimeActivityAdapter
      ? {
        onProviderTaskActivity: (activity) => (
          runtimeActivityAdapter.observeActivity({
            activity,
            evidence: 'live',
          })
        ),
      }
      : {}),
    ...(providerActivityLedger
      ? { isOwnedClaudeSessionId: (sessionId) => providerActivityLedger.isOwnedSessionId(sessionId) }
      : {}),
    ...(params.registerWorkflowAgentTranscript
      ? { registerWorkflowAgentTranscript: params.registerWorkflowAgentTranscript }
      : {}),
    logPrefix: params.logPrefix,
  });
  return source;
}
