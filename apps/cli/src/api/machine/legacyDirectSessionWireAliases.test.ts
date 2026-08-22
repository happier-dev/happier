import { describe, expect, it, vi } from 'vitest';

import { buildLinkedExternalSessionMetadataV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { EXTERNAL_SESSION_REQUIRED_GENERIC_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';

import { mapCanonicalExternalSessionResponseToLegacyDirectSession } from './legacyDirectSessionResponseCompatibility';
import { registerLegacyDirectSessionLinkEnsureWireAlias } from './legacyDirectSessionWireAliases';

type RegisteredHandlers = Map<string, (input: unknown) => Promise<unknown>>;

function createRpcHandlerManagerStub(registered: RegisteredHandlers) {
  return {
    registerHandler: (method: string, handler: (input: unknown) => Promise<unknown>) => {
      registered.set(method, handler);
    },
    hasHandler: (method: string) => registered.has(method),
  } as never;
}

function registerGenericExternalSessionHandlers(
  registered: RegisteredHandlers,
  execute: (actionId: string, input: unknown) => Promise<unknown>,
): void {
  registerActionSpecRpcHandlers({
    rpcHandlerManager: createRpcHandlerManagerStub(registered),
    actionExecutor: {
      execute: async (actionId, input) => ({
        ok: true,
        result: await execute(actionId, input),
      }),
    },
    scopes: EXTERNAL_SESSION_REQUIRED_GENERIC_RPC_SCOPES,
    mapResponseForMethod: ({ method, response }) => method.startsWith('daemon.directSessions.')
      ? mapCanonicalExternalSessionResponseToLegacyDirectSession(response)
      : response,
  });
}

// Released request shape emitted by ui-web-v0.2.0@dc5203145 and
// ui-web-v0.2.2-preview.1775585938.1@4913c1e5 through
// apps/ui/sources/sync/ops/machineDirectSessions.ts#machineDirectSessionLinkEnsure,
// and by remote-dev@04b48d57 through its identically named client.
const RELEASED_LINK_ENSURE_REQUEST = {
  machineId: 'machine_1',
  providerId: 'claude',
  remoteSessionId: 'remote_123',
  titleHint: 'Linked Claude Session',
  source: { kind: 'claudeConfig', configDir: '/tmp/claude', projectId: 'proj-a' },
} as const;

describe('legacy direct-session link.ensure wire alias', () => {
  it('fails closed with the released error envelope instead of dispatching a link the caller cannot open', async () => {
    const registered: RegisteredHandlers = new Map();
    const execute = vi.fn(async () => ({ ok: true, sessionId: 'sess_1', created: true }));
    registerGenericExternalSessionHandlers(registered, execute);
    registerLegacyDirectSessionLinkEnsureWireAlias({
      rpcHandlerManager: createRpcHandlerManagerStub(registered),
    });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE_LEGACY);
    expect(handler).toBeDefined();

    await expect(handler!(RELEASED_LINK_ENSURE_REQUEST)).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'upgrade_required',
    });
    // No ActionSpec dispatch means no Session row and no metadata write.
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps the released malformed-request envelope for requests the shipped schema rejects', async () => {
    const registered: RegisteredHandlers = new Map();
    registerLegacyDirectSessionLinkEnsureWireAlias({
      rpcHandlerManager: createRpcHandlerManagerStub(registered),
    });

    await expect(
      registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE_LEGACY)!({ machineId: 'machine_1' }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'invalid_request',
    });
  });

  it('excepts the legacy link.ensure method from generic ActionSpec registration', () => {
    const registered: RegisteredHandlers = new Map();
    registerGenericExternalSessionHandlers(registered, async () => ({ ok: true }));

    expect(registered.has(RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE)).toBe(true);
    expect(registered.has(RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE_LEGACY)).toBe(false);
  });

  it('documents why the released caller cannot use a canonical link', () => {
    const metadata = buildLinkedExternalSessionMetadataV1({}, {
      v: 1,
      agentId: 'claude',
      machineId: 'machine_1',
      remoteSessionId: 'remote_123',
      source: { kind: 'claudeConfig', configDir: '/tmp/claude', projectId: 'proj-a' },
      linkedAtMs: 1,
    });

    expect(metadata.externalSessionV1).toBeDefined();
    // ui-web-v0.2.0@dc5203145 sync/domains/session/sessionStorageKind.ts treats a
    // Session as external only when metadata.directSessionV1.v === 1, and
    // directSessions/readDirectSessionLink.ts requires the same envelope.
    expect(Object.hasOwn(metadata, 'directSessionV1')).toBe(false);
  });
});
