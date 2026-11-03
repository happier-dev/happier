import type { ActionExecutorContext, BackendTargetRefV2, ExternalActionTargetV1 } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import type { ResolveSessionTransportContextResult } from '@/session/services/resolveSessionTransportContext';
import { readSessionLegacyMetadata } from './cliActionDeps/sessionStateReaders';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { resolveSessionStoredContentEncryptionMode, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';

type SessionMetadataReaderInput = Parameters<typeof readSessionLegacyMetadata>[0];

/** Account and plugin hosts have no bound Session; their labels are not selectors. */
export function readCliActionBoundSessionId(value: string): string | null {
  const sessionId = value.trim();
  return sessionId && sessionId !== 'cli-global' && sessionId !== 'plugin-global' ? sessionId : null;
}

/** The bound process's live snapshot, then its cached/fetched stored metadata. */
export function createCliBoundSessionMetadataReader(params: SessionMetadataReaderInput & Readonly<{
  token: string;
  sessionId: string;
  credentials?: StoredCredentials;
  getCurrentSessionMetadata?: () => Readonly<Record<string, unknown>> | null;
  resolveTransportForSession: (sessionId: string, signal?: AbortSignal) => Promise<Extract<ResolveSessionTransportContextResult, { ok: true }> | Readonly<{ ok: false }>>;
}>): (signal?: AbortSignal) => Promise<Record<string, unknown> | null> {
  const sessionId = readCliActionBoundSessionId(params.sessionId);
  if (!sessionId) return async () => null;
  // A layout-1 shared record is not the process's owner metadata snapshot.
  // Opening it requires the authenticated Account mode from transport resolution.
  let currentSessionMetadata = readSessionLegacyMetadata(params);
  return async (signal) => {
    if (params.getCurrentSessionMetadata) return params.getCurrentSessionMetadata();
    if (currentSessionMetadata) return currentSessionMetadata;
    try {
      if (params.credentials) {
        const transport = await params.resolveTransportForSession(sessionId, signal);
        if (!transport.ok || transport.sessionId !== sessionId || transport.rawSession.id !== sessionId) return null;
        currentSessionMetadata = tryDecryptSessionOwnerMetadataView({ credentials: params.credentials,
          accountEncryptionMode: transport.accountEncryptionCurrentness.mode, rawSession: transport.rawSession });
        return currentSessionMetadata;
      }
      const rawSession = await fetchSessionById({ reason: 'requester-binding', token: params.token, sessionId, ...(signal ? { signal } : {}) });
      // A Session bearer cannot open Account-private owner metadata.
      if (!rawSession || rawSession.id !== sessionId) return null;
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
  boundSessionId?: string;
  readBoundSession?: () => Promise<CallerSessionFacts>;
  resolveTransportForSession: (sessionId: string, signal?: AbortSignal) => Promise<Extract<ResolveSessionTransportContextResult, { ok: true }> | Readonly<{ ok: false }>>;
}>): Promise<(CallerSessionFacts & Readonly<{ sessionId: string }>) | null> {
  const callerSessionId = params.context.actionCaller?.kind === 'session'
    ? params.context.actionCaller.sessionId : params.context.defaultSessionId;
  const sessionId = typeof callerSessionId === 'string' ? callerSessionId.trim() : '';
  if (!sessionId || (params.context.actionCaller?.kind === 'session'
    && params.context.defaultSessionId !== sessionId)) return null;
  if (sessionId === params.boundSessionId) return params.readBoundSession
    ? { sessionId, ...await params.readBoundSession() } : null;
  // A selector is not authenticated Session identity.
  if (params.context.actionCaller?.kind !== 'session') return null;
  const transport = await params.resolveTransportForSession(sessionId, params.context.signal);
  if (!transport.ok || transport.sessionId !== sessionId || transport.rawSession.id !== sessionId || !params.credentials) return null;
  const metadata = tryDecryptSessionOwnerMetadataView({ credentials: params.credentials,
    accountEncryptionMode: transport.accountEncryptionCurrentness.mode, rawSession: transport.rawSession });
  if (!metadata) return null;
  const readString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
  const { resolveBackendTargetFromSessionMetadata } = await import('@/session/backendTargets/resolveBackendTargetFromSessionMetadata');
  return { sessionId, metadata, workDepth: transport.rawSession.workDepth,
    backendTarget: resolveBackendTargetFromSessionMetadata(metadata),
    machineId: readString(transport.rawSession.machineId) ?? readString(metadata?.machineId),
    directory: readString(metadata?.path) ?? readString(transport.rawSession.path) };
}

/** The caller's workspace is resolved before signing, never from the relay host. */
export async function resolveCliActionCallerWorkflowTarget(params: Parameters<typeof resolveCliActionCallerSession>[0] & Readonly<{
  target?: ExternalActionTargetV1;
}>): Promise<Extract<ExternalActionTargetV1, { kind: 'machine' }> | null> {
  if (params.target && params.target.kind !== 'machine') return null;
  const session = await resolveCliActionCallerSession(params);
  if (!session?.machineId || !session.directory
    || params.target && params.target.machineId !== session.machineId) return null;
  return params.target?.project ? params.target : { kind: 'machine', machineId: session.machineId,
    project: { machineId: session.machineId, directory: session.directory } };
}
