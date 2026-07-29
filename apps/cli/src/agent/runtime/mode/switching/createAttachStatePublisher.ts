import { getAgentLocalControlCapability, type AgentId } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import type { AgentState } from '@/api/types';
import { createSessionScopedSocket } from '@/api/session/sockets';
import { updateSessionAgentStateWithAck } from '@/api/session/stateUpdates';
import { configuration } from '@/configuration';
import { waitForSocketConnect } from '@/session/transport/socket/waitForSocketConnect';
import {
  readSessionMetadataTupleWriterSnapshot,
  updateSessionMetadataEnvelopeTupleWithRetry,
  type SessionMetadataTupleWriterSnapshot,
} from '@/session/metadata/updateSessionMetadataWithRetry';
import {
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';

import { createAgentRuntimeSwitchState } from './createSwitchState';

type RawSessionLike = Readonly<{
  metadata: string;
  metadataVersion: number;
  metadataLayoutVersion?: unknown;
  ownerMetadata?: unknown;
  agentState?: string | null;
  agentStateVersion?: number;
  dataEncryptionKey?: unknown;
  encryptionMode?: unknown;
}>;

type AgentAttachPublisher = Readonly<{
  publishAttached: (attached: boolean) => Promise<void>;
}>;

type SocketLike = Readonly<{
  connect: () => void;
  disconnect: () => void;
  emitWithAck: (event: string, ...args: any[]) => Promise<any>;
  on: (event: string, handler: (...args: any[]) => void) => void;
}>;

export function createAgentAttachStatePublisher(params: Readonly<{
  agentId: AgentId;
  sessionId: string;
  credentials: Credentials;
  rawSession: RawSessionLike;
  createSessionScopedSocketFn?: typeof createSessionScopedSocket;
  waitForSocketConnectFn?: typeof waitForSocketConnect;
  updateSessionAgentStateWithAckFn?:
    typeof updateSessionAgentStateWithAck;
  updateSessionMetadataEnvelopeTupleWithRetryFn?:
    typeof updateSessionMetadataEnvelopeTupleWithRetry;
  connectTimeoutMs?: number;
}>): AgentAttachPublisher | null {
  const capability = getAgentLocalControlCapability(params.agentId);
  if (!capability || capability.attachStrategy !== 'provider_attach') return null;

  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, params.rawSession);
  let currentTupleSnapshot: SessionMetadataTupleWriterSnapshot =
    readSessionMetadataTupleWriterSnapshot({
      credentials: params.credentials,
      rawSession: params.rawSession,
    });

  const updateAttachedState = (
    agentState: AgentState,
    attached: boolean,
  ): AgentState => ({
    ...agentState,
    controlledByUser: false,
    localControl: createAgentRuntimeSwitchState({
      attached,
      topology: capability.topology,
      canAttach: true,
      canDetach: attached,
      remoteWritable: capability.remoteWritable,
    }),
  });

  const mutateLegacyAgentState = async (
    request: Parameters<
      NonNullable<
        Parameters<
          typeof updateSessionMetadataEnvelopeTupleWithRetry
        >[0]['mutateLegacy']
      >
    >[0],
  ) => {
    if (request.kind !== 'agentState') {
      throw Object.assign(
        new Error('Attach state publisher cannot mutate legacy metadata'),
        {
          code: 'metadata_privacy_upgrade_required' as const,
          retryable: false as const,
        },
      );
    }
    let currentAgentState = request.current.value.agentState;
    let currentAgentStateVersion = request.current.agentStateVersion;
    let usePreparedMutation = true;
    const socket = (
      params.createSessionScopedSocketFn
      ?? createSessionScopedSocket
    )({
      token: params.credentials.token,
      sessionId: params.sessionId,
    }) as unknown as SocketLike;
    socket.connect();
    try {
      await (params.waitForSocketConnectFn ?? waitForSocketConnect)(
        socket as Parameters<typeof waitForSocketConnect>[0],
        params.connectTimeoutMs
          ?? configuration.sessionControlHttpTimeoutMs,
      );
      const result = await (
        params.updateSessionAgentStateWithAckFn
        ?? updateSessionAgentStateWithAck
      )({
        socket: socket as Parameters<
          typeof updateSessionAgentStateWithAck
        >[0]['socket'],
        sessionId: params.sessionId,
        sessionEncryptionMode: mode,
        encryptionKey: ctx.encryptionKey,
        encryptionVariant: ctx.encryptionVariant,
        getAgentState: () => currentAgentState,
        setAgentState: (agentState) => {
          currentAgentState = agentState;
        },
        getAgentStateVersion: () => currentAgentStateVersion,
        setAgentStateVersion: (version) => {
          currentAgentStateVersion = version;
        },
        syncSessionSnapshotFromServer: async () => {},
        handler: (agentState) => {
          const next = usePreparedMutation
            ? request.updatedAgentState
            : request.mutation.update(agentState);
          usePreparedMutation = false;
          if (
            next
            && typeof (next as Promise<AgentState>).then
              === 'function'
          ) {
            throw new Error(
              'Attach state mutation must be synchronous',
            );
          }
          return next as AgentState;
        },
      });
      return {
        ...request.current,
        agentStateVersion: result.version,
        agentStateCiphertext: result.ciphertext,
        value: {
          ...request.current.value,
          agentState: result.agentState,
        },
      };
    } finally {
      socket.disconnect();
    }
  };

  return {
    publishAttached: async (attached) => {
      currentTupleSnapshot = await (
        params.updateSessionMetadataEnvelopeTupleWithRetryFn
        ?? updateSessionMetadataEnvelopeTupleWithRetry
      )({
        token: params.credentials.token,
        sessionId: params.sessionId,
        credentials: params.credentials,
        mode,
        ctx,
        initialSnapshot: currentTupleSnapshot,
        mutation: {
          kind: 'agentState',
          update: (agentState) =>
            updateAttachedState(agentState, attached),
        },
        mutateLegacy: mutateLegacyAgentState,
      });
    },
  };
}
