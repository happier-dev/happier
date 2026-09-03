import { readSessionMetadataRuntimeDescriptor } from '@happier-dev/agents';
import { SessionConnectedServiceAuthApplyGenerationResponseV1Schema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { ConnectedServiceRuntimeAuthSelectionMaterializer } from '@/daemon/connectedServices/sessionAuthSwitch/runtimeAuthSelectionMaterializerTypes';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';

import { readCodexAuthStoreProviderAccountId } from './readCodexAuthStoreProviderAccountId';
import { writeCodexAuthStoreFile } from './writeCodexAuthStoreFile';

const CODEX_CONNECTED_SERVICE_AUTH_APPLY_TIMEOUT_MS = 60_000;

export const materializeCodexConnectedServiceRuntimeAuthSelection: ConnectedServiceRuntimeAuthSelectionMaterializer = async (params) => {
  if (params.input.serviceId !== 'openai-codex') return params.baseSelection;

  const cwd = typeof params.input.tracked.spawnOptions?.directory === 'string'
    ? params.input.tracked.spawnOptions.directory.trim()
    : '';
  if (!cwd) return params.baseSelection;

  const transport = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.input.sessionId,
  });
  if (!transport.ok) return params.baseSelection;

  const metadata = params.input.tracked.happySessionMetadataFromLocalWebhook ?? null;
  const runtimeDescriptor = readSessionMetadataRuntimeDescriptor(metadata, 'codex');
  const codexHome = typeof runtimeDescriptor?.homePath === 'string' && runtimeDescriptor.homePath.trim().length > 0
    ? runtimeDescriptor.homePath.trim()
    : null;
  return {
    ...params.baseSelection,
    applyReason: params.input.applyReason ?? 'manual',
    // K5:fsm_switch this materializer only wires the provider-owned direct-live apply callback
    // into the session-auth FSM/runtime-auth owners; restart/hot-apply policy still lives there.
    applyConnectedServiceAuthGeneration: async (request: unknown) => {
      const rawResponse = await callSessionRpc({
        token: params.credentials.token,
        sessionId: transport.sessionId,
        ctx: transport.ctx,
        mode: transport.mode,
        timeoutMs: CODEX_CONNECTED_SERVICE_AUTH_APPLY_TIMEOUT_MS,
        method: `${transport.sessionId}:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION}`,
        request,
      });
      const parsedResponse = SessionConnectedServiceAuthApplyGenerationResponseV1Schema.safeParse(rawResponse);
      if (!parsedResponse.success) {
        throw new Error('invalid_connected_service_auth_apply_generation_response');
      }
      return parsedResponse.data;
    },
    ...(codexHome
      ? {
          readAuthStoreProviderAccountId: async () => await readCodexAuthStoreProviderAccountId(codexHome),
          // Durable adoption for hot-apply: the session app-server reloads
          // `<codexHome>/auth.json` when its transports are invalidated, so the
          // switched credential must be persisted there or the runtime would
          // resume on the previous account (post-switch verification then
          // rejects the hot apply without replacing the live app-server).
          persistAuthStore: async () => {
            await writeCodexAuthStoreFile({
              codexHome,
              record: params.baseSelection.record as Parameters<typeof writeCodexAuthStoreFile>[0]['record'],
            });
          },
        }
      : {}),
  };
};
