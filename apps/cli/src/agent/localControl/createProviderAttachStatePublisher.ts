import { getAgentLocalControlCapability, type AgentId } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import type { AgentState } from '@/api/types';
import { createSessionScopedSocket } from '@/api/session/sockets';
import { updateSessionAgentStateWithAck } from '@/api/session/stateUpdates';
import { configuration } from '@/configuration';
import { waitForSocketConnect } from '@/session/transport/socket/waitForSocketConnect';
import {
  decryptStoredSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';

import { createAgentLocalControlState } from './createAgentLocalControlState';

type RawSessionLike = Readonly<{
  agentState?: string | null;
  agentStateVersion?: number;
  dataEncryptionKey?: unknown;
  encryptionMode?: unknown;
}>;

type ProviderAttachPublisher = Readonly<{
  publishAttached: (attached: boolean) => Promise<void>;
}>;

type SocketLike = Readonly<{
  connect: () => void;
  disconnect: () => void;
  emitWithAck: (event: string, ...args: any[]) => Promise<any>;
  on: (event: string, handler: (...args: any[]) => void) => void;
}>;

export function createProviderAttachStatePublisher(params: Readonly<{
  agentId: AgentId;
  sessionId: string;
  credentials: Credentials;
  rawSession: RawSessionLike;
  createSessionScopedSocketFn?: typeof createSessionScopedSocket;
  waitForSocketConnectFn?: typeof waitForSocketConnect;
  updateSessionAgentStateWithAckFn?: typeof updateSessionAgentStateWithAck;
  connectTimeoutMs?: number;
}>): ProviderAttachPublisher | null {
  const capability = getAgentLocalControlCapability(params.agentId);
  if (!capability || capability.attachStrategy !== 'provider_attach') return null;

  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, params.rawSession);
  let currentAgentState = !params.rawSession.agentState
    ? null
    : (decryptStoredSessionPayload({
      mode,
      ctx,
      value: params.rawSession.agentState,
    }) as AgentState | null);
  let currentAgentStateVersion =
    typeof params.rawSession.agentStateVersion === 'number' && Number.isInteger(params.rawSession.agentStateVersion)
      ? params.rawSession.agentStateVersion
      : 0;

  return {
    publishAttached: async (attached) => {
      const socket = (params.createSessionScopedSocketFn ?? createSessionScopedSocket)({
        token: params.credentials.token,
        sessionId: params.sessionId,
      }) as unknown as SocketLike;

      socket.connect();

      try {
        await (params.waitForSocketConnectFn ?? waitForSocketConnect)(
          socket as Parameters<typeof waitForSocketConnect>[0],
          params.connectTimeoutMs ?? configuration.sessionControlHttpTimeoutMs,
        );

        await (params.updateSessionAgentStateWithAckFn ?? updateSessionAgentStateWithAck)({
          socket: socket as Parameters<typeof updateSessionAgentStateWithAck>[0]['socket'],
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
          handler: (agentState) => ({
            ...agentState,
            controlledByUser: false,
            localControl: createAgentLocalControlState({
              attached,
              topology: capability.topology,
              canAttach: true,
              canDetach: attached,
              remoteWritable: capability.topology === 'shared',
            }),
          }),
        });
      } finally {
        socket.disconnect();
      }
    },
  };
}
