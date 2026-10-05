import type { ActionExecutorContext, BackendTargetRefV2 } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import type { ResolveSessionTransportContextResult } from '@/session/services/resolveSessionTransportContext';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { readSessionLegacyMetadata } from './cliActionDeps/sessionStateReaders';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { resolveSessionStoredContentEncryptionMode, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';

type SessionMetadataReaderInput = Parameters<typeof readSessionLegacyMetadata>[0];

/** The bound process's live snapshot, then its cached/fetched stored metadata. */
export function createCliBoundSessionMetadataReader(params: SessionMetadataReaderInput & Readonly<{
  token: string;
  sessionId: string;
  credentials?: StoredCredentials;
  getCurrentSessionMetadata?: () => Readonly<Record<string, unknown>> | null;
  resolveTransportForSession: (sessionId: string) => Promise<Extract<ResolveSessionTransportContextResult, { ok: true }> | Readonly<{ ok: false }>>;
}>): () => Promise<Record<string, unknown> | null> {
  // A layout-1 shared record is not the process's owner metadata snapshot.
  // Opening it requires the authenticated Account mode from transport resolution.
  let currentSessionMetadata = readSessionLegacyMetadata(params);
  return async () => {
    if (params.getCurrentSessionMetadata) return params.getCurrentSessionMetadata();
    if (currentSessionMetadata) return currentSessionMetadata;
    try {
      if (params.credentials) {
        const transport = await params.resolveTransportForSession(params.sessionId);
        if (!transport.ok || transport.sessionId !== params.sessionId || transport.rawSession.id !== params.sessionId) return null;
        currentSessionMetadata = tryDecryptSessionOwnerMetadataView({ credentials: params.credentials,
          accountEncryptionMode: transport.accountEncryptionCurrentness.mode, rawSession: transport.rawSession });
        return currentSessionMetadata;
      }
      const rawSession = await fetchSessionById({ token: params.token, sessionId: params.sessionId });
      // A Session bearer cannot open Account-private owner metadata.
      if (!rawSession || rawSession.id !== params.sessionId) return null;
      const mode = resolveSessionStoredContentEncryptionMode(rawSession);
      if (mode === 'e2ee' && params.mode !== 'e2ee') return null;
      currentSessionMetadata = mode === 'plain'
        ? readSessionLegacyMetadata({ mode, ctx: null, rawSession })
        : params.mode === 'e2ee' ? readSessionLegacyMetadata({ mode, ctx: params.ctx, rawSession }) : null;
      return currentSessionMetadata;
    } catch {
      currentSessionMetadata = null;
      return null;
    }
  };
}

type CallerSessionFacts = Readonly<{
  metadata: Readonly<Record<string, unknown>> | null;
  workDepth: unknown;
  backendTarget: BackendTargetRefV2 | null | undefined;
  machineId: string | null;
  directory: string | null;
}>;

/** One caller-identity owner shared by Agent admission and Workflow ingress. */
export async function resolveCliActionCallerSession(params: Readonly<{
  context: ActionExecutorContext;
  credentials?: StoredCredentials;
  boundSessionId: string;
  readBoundSession: () => Promise<CallerSessionFacts>;
  resolveTransportForSession: (sessionId: string) => Promise<Extract<ResolveSessionTransportContextResult, { ok: true }> | Readonly<{ ok: false }>>;
}>): Promise<(CallerSessionFacts & Readonly<{ sessionId: string }>) | null> {
  const callerSessionId = params.context.actionCaller?.kind === 'session'
    ? params.context.actionCaller.sessionId : params.context.defaultSessionId;
  const sessionId = typeof callerSessionId === 'string' ? callerSessionId.trim() : '';
  if (!sessionId || (params.context.actionCaller?.kind === 'session'
    && params.context.defaultSessionId !== sessionId)) return null;
  if (sessionId === params.boundSessionId) return { sessionId, ...await params.readBoundSession() };
  // A selector is not authenticated Session identity.
  if (params.context.actionCaller?.kind !== 'session') return null;
  const transport = await params.resolveTransportForSession(sessionId);
  if (!transport.ok || transport.sessionId !== sessionId || transport.rawSession.id !== sessionId || !params.credentials) return null;
  const metadata = tryDecryptSessionOwnerMetadataView({ credentials: params.credentials,
    accountEncryptionMode: transport.accountEncryptionCurrentness.mode, rawSession: transport.rawSession });
  if (!metadata) return null;
  const readString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
  return { sessionId, metadata, workDepth: transport.rawSession.workDepth,
    backendTarget: resolveBackendTargetFromSessionMetadata(metadata),
    machineId: readString(transport.rawSession.machineId) ?? readString(metadata?.machineId),
    directory: readString(metadata?.path) ?? readString(transport.rawSession.path) };
}
