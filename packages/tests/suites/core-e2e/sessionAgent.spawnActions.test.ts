import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import {
  accountSettingsParse,
  buildAcpConfigOptionOverridesV1,
  type AccountSettings,
  type ConnectedServiceBindingsV1,
  type SessionMcpSelectionV1,
  type V2SessionByIdResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import type { Metadata } from '../../../../apps/cli/src/api/types';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../../../../apps/cli/src/api/encryption';
import { SpawnDaemonSessionRequestSchema, type SpawnDaemonSessionRequest } from '../../../../apps/cli/src/rpc/handlers/spawnSessionOptionsContract';
import { createApiSessionSocketStub } from '../../../../apps/cli/src/testkit/backends/apiSessionSocketHarness';
import { createSessionRecordFixture } from '../../../../apps/cli/src/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '../../../../apps/cli/src/testkit/http/axiosAdapter';
import { resolveServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';

const {
  resolveDaemonSpawnSessionByNonce,
  spawnDaemonSession,
  spawnMachineSession,
  io,
} = vi.hoisted(() => ({
  resolveDaemonSpawnSessionByNonce: vi.fn(),
  spawnDaemonSession: vi.fn(),
  spawnMachineSession: vi.fn<(request: SpawnDaemonSessionRequest) => { type: 'success'; sessionId: string }>(),
  io: vi.fn(),
}));

vi.mock('socket.io-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('socket.io-client')>(),
  io,
}));

vi.mock('../../../../apps/cli/src/daemon/controlClient', () => ({
  resolveDaemonSpawnSessionByNonce,
  spawnDaemonSession,
}));

const run = createRunDirs({ runLabel: 'core' });

function parseMcpJsonText(result: unknown): Record<string, unknown> {
  const text = (result as { content?: readonly { text?: unknown }[] })?.content?.[0]?.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Missing MCP JSON text response');
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function createCredentials() {
  return {
    token: 'token-session-agent-spawn-actions',
    encryption: {
      type: 'legacy' as const,
      secret: new Uint8Array(32).fill(7),
    },
  };
}

async function createSessionAgentMcpScenario(params?: Readonly<{
  accountSettings?: AccountSettings;
  parentMetadata?: Partial<Metadata> & Record<string, unknown>;
}>) {
  const testDir = run.testDir(`session-agent-spawn-actions-${randomUUID()}`);
  const workspaceDir = resolve(join(testDir, 'workspace'));
  await mkdir(workspaceDir, { recursive: true });

  const parentSessionId = `sess_parent_${randomUUID()}`;
  const parentMetadata: Metadata & Record<string, unknown> = {
    path: workspaceDir,
    host: 'test-host',
    homeDir: resolve(join(testDir, 'home')),
    happyHomeDir: resolve(join(testDir, 'happy-home')),
    happyLibDir: resolve(join(testDir, 'happy-home', 'lib')),
    happyToolsDir: resolve(join(testDir, 'happy-home', 'tools')),
    machineId: 'machine-local',
    flavor: 'claude',
    permissionMode: 'default',
    permissionModeUpdatedAt: 101,
    modelOverrideV1: { v: 1, updatedAt: 102, modelId: 'claude-sonnet-parent' },
    sessionConfigOptionOverridesV1: buildAcpConfigOptionOverridesV1({
      updatedAt: 103,
      overrides: {
        inherited_option: { updatedAt: 103, value: true },
      },
    }),
    ...(params?.parentMetadata ?? {}),
  };
  const childSessionId = `sess_child_${randomUUID()}`;
  const childSession = createSessionRecordFixture({
    id: childSessionId,
    encryptionMode: 'plain',
    metadata: JSON.stringify({ path: workspaceDir, host: 'test-host', machineId: 'machine-local', flavor: 'claude' }),
  });

  const relay = Fastify();
  relay.addHook('onRequest', async (request) => {
    expect(request.headers.authorization).toBe(`Bearer ${createCredentials().token}`);
  });
  relay.get('/v1/machines/machine-local', async () => {
    return { machine: { id: 'machine-local', dataEncryptionKey: null } };
  });
  relay.get(`/v2/sessions/${childSessionId}`, async () => ({ session: childSession } satisfies V2SessionByIdResponse));
  relay.patch<{ Body: { metadata: { ciphertext: string; expectedVersion: number } } }>(`/v2/sessions/${childSessionId}`, async (request) => {
    const update = request.body.metadata;
    if (update.expectedVersion !== childSession.metadataVersion) {
      return { success: false, error: 'version-mismatch', metadata: { version: childSession.metadataVersion, value: childSession.metadata } };
    }
    childSession.metadata = update.ciphertext;
    childSession.metadataVersion += 1;
    return { success: true, metadata: { version: childSession.metadataVersion } };
  });
  await relay.ready();
  // Keep published-key selection and RPC crypto real beneath the HTTP boundary.
  const restoreHttp = installAxiosFastifyAdapter({ app: relay, origin: new URL(resolveServerHttpBaseUrl()).origin });

  spawnMachineSession.mockReturnValue({ type: 'success', sessionId: childSessionId });
  io.mockImplementation((_url: unknown, options?: { auth?: { clientType?: unknown } }) => {
    if (options?.auth?.clientType === 'session-scoped') {
      // Exercise the real metadata writer through its supported HTTP transport.
      return createApiSessionSocketStub({ onConnect: (socket) => socket.trigger('connect_error', new Error('Session socket unavailable')) });
    }
    return createApiSessionSocketStub({
      emit: (event, args) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        // Socket.IO is the network boundary; keep real RPC encryption and dispatch beneath it.
        const [payload, acknowledge] = args as [
          { method: string; params: string },
          (response: { ok: true; result: string }) => void,
        ];
        expect(payload.method).toBe(`machine-local:${RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE}`);
        const key = createCredentials().encryption.secret;
        const request = SpawnDaemonSessionRequestSchema.parse(decrypt(key, 'legacy', decodeBase64(payload.params, 'base64')));
        const result = spawnMachineSession(request);
        acknowledge({ ok: true, result: encodeBase64(encrypt(key, 'legacy', result)) });
      },
    });
  });
  resolveDaemonSpawnSessionByNonce.mockResolvedValue({ status: 'unsupported' });

  const { RpcHandlerManager } = await import('../../../../apps/cli/src/api/rpc/RpcHandlerManager');
  const { startHappyServer } = await import('../../../../apps/cli/src/mcp/startHappyServer');
  const accountSettings = params?.accountSettings ?? accountSettingsParse({});
  const rpcHandlerManager = new RpcHandlerManager({
    scopePrefix: parentSessionId,
    encryptionKey: new Uint8Array([1, 2, 3, 4]),
    encryptionVariant: 'legacy',
  });

  const server = await startHappyServer(
    {
      sessionId: parentSessionId,
      rpcHandlerManager,
      sendClaudeSessionMessage: () => {},
      updateMetadata: () => {},
      getMetadataSnapshot: () => parentMetadata,
    },
    {
      credentials: createCredentials(),
      getAccountSettings: () => accountSettings,
    },
  );
  const sdkClientIndexPath = resolve(repoRootDir(), 'apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const sdkClientHttpPath = resolve(repoRootDir(), 'apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js');
  const { Client } = await import(pathToFileURL(sdkClientIndexPath).href) as {
    Client: new (params: { name: string; version: string }, opts?: { capabilities?: Record<string, unknown> }) => {
      connect(transport: unknown): Promise<void>;
      close?(): Promise<void>;
      listTools(): Promise<{ tools?: readonly { name?: unknown }[] }>;
      callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
    };
  };
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(sdkClientHttpPath).href) as {
    StreamableHTTPClientTransport: new (url: URL) => unknown;
  };
  const client = new Client({ name: 'session-agent-spawn-actions', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));

  return {
    childSessionId,
    client,
    parentSessionId,
    server,
    workspaceDir,
    getChildMetadata: () => JSON.parse(childSession.metadata) as Record<string, unknown>,
    async close() {
      await client.close?.();
      server.stop();
      restoreHttp();
      await relay.close();
    },
  };
}

describe('core e2e: session-agent spawn actions', () => {
  beforeEach(() => {
    resolveDaemonSpawnSessionByNonce.mockReset();
    spawnDaemonSession.mockReset();
    spawnMachineSession.mockReset();
    io.mockReset();
  });

  it('exposes session.spawn_new to session agents, honors Off settings, and forwards rich inherited spawn options', async () => {
    const connectedServices = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'profile',
          profileId: 'claude-profile-1',
        },
      },
    } satisfies ConnectedServiceBindingsV1;
    const mcpSelection = {
      v: 1,
      managedServersEnabled: false,
      forceIncludeServerIds: ['repo-tools'],
      forceExcludeServerIds: ['secret-env-server'],
    } satisfies SessionMcpSelectionV1;
    const inheritedConfig = buildAcpConfigOptionOverridesV1({
      updatedAt: 1700000000100,
      overrides: {
        reasoning_effort: { updatedAt: 1700000000100, value: 'high' },
        ultracode: { updatedAt: 1700000000100, value: false },
      },
    });
    const scenario = await createSessionAgentMcpScenario({
      parentMetadata: {
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 1700000000001,
        modelOverrideV1: { v: 1, updatedAt: 1700000000002, modelId: 'claude-opus-parent' },
        sessionConfigOptionOverridesV1: inheritedConfig,
        profileId: 'parent-profile',
        connectedServices,
        connectedServicesUpdatedAt: 1700000000003,
        mcpSelectionV1: mcpSelection,
      },
    });

    try {
      const tools = await scenario.client.listTools();
      const toolNames = new Set((tools.tools ?? []).map((tool) => String((tool as { name?: unknown }).name)));
      expect(toolNames.has('action_spec_get')).toBe(true);
      expect(toolNames.has('action_execute')).toBe(true);

      const specPayload = parseMcpJsonText(await scenario.client.callTool({
        name: 'action_spec_get',
        arguments: { id: 'session.spawn_new' },
      }));
      expect((specPayload.actionSpec as { id?: unknown })?.id).toBe('session.spawn_new');

      const minimalPayload = parseMcpJsonText(await scenario.client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'session.spawn_new',
          input: {
            title: 'Inherited child',
            initialMessage: 'Use inherited parent context.',
          },
        },
      }));
      expect(minimalPayload).toEqual(expect.objectContaining({
        type: 'success',
        created: true,
        sessionId: scenario.childSessionId,
      }));
      expect(spawnMachineSession).toHaveBeenLastCalledWith(expect.objectContaining({
        directory: scenario.workspaceDir,
        machineId: 'machine-local',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 1700000000001,
        modelId: 'claude-opus-parent',
        sessionConfigOptionOverrides: inheritedConfig,
        profileId: 'parent-profile',
        connectedServices,
        connectedServicesUpdatedAt: 1700000000003,
        mcpSelection,
        pendingFirstInput: {
          text: 'Use inherited parent context.',
          localId: expect.stringMatching(/^spawn-first:/),
        },
      }));

      const richConfig = buildAcpConfigOptionOverridesV1({
        updatedAt: 1700000000200,
        overrides: {
          reasoning_effort: { updatedAt: 1700000000200, value: 'xhigh' },
          ultracode: { updatedAt: 1700000000200, value: true },
        },
      });
      const richPayload = parseMcpJsonText(await scenario.client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'session.spawn_new',
          input: {
            directory: scenario.workspaceDir,
            agentId: 'claude',
            modelId: 'claude-opus-4-8',
            permissionMode: 'read-only',
            sessionConfigOptionOverrides: richConfig,
            connectedServices,
            mcpSelection,
            title: 'Rich child',
            initialPrompt: 'Use explicit rich options.',
          },
        },
      }));
      expect(richPayload).toEqual(expect.objectContaining({
        type: 'success',
        sessionId: scenario.childSessionId,
      }));
      expect(spawnMachineSession).toHaveBeenLastCalledWith(expect.objectContaining({
        directory: scenario.workspaceDir,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read-only',
        modelId: 'claude-opus-4-8',
        sessionConfigOptionOverrides: richConfig,
        connectedServices,
        mcpSelection,
        pendingFirstInput: {
          text: 'Use explicit rich options.',
          localId: expect.stringMatching(/^spawn-first:/),
        },
      }));
      expect(scenario.getChildMetadata()).toEqual(expect.objectContaining({
        summary: expect.objectContaining({ text: 'Rich child' }),
      }));

      const spawnCallsBeforeEscalation = spawnMachineSession.mock.calls.length;
      const escalationPayload = parseMcpJsonText(await scenario.client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'session.spawn_new',
          input: {
            directory: scenario.workspaceDir,
            agentId: 'claude',
            permissionMode: 'bypassPermissions',
            initialMessage: 'Escalate.',
          },
        },
      }));
      expect(escalationPayload).toEqual(expect.objectContaining({
        errorCode: 'permission_escalation_denied',
        error: 'permission_escalation_denied',
        details: expect.objectContaining({
          requestedOrdinal: 3,
          callerOrdinal: 2,
        }),
      }));
      expect(spawnMachineSession).toHaveBeenCalledTimes(spawnCallsBeforeEscalation);
      expect(spawnDaemonSession).not.toHaveBeenCalled();
    } finally {
      await scenario.close();
    }

    const disabledScenario = await createSessionAgentMcpScenario({
      accountSettings: accountSettingsParse({
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.spawn_new': {
              disabledSurfaces: ['session_agent'],
            },
          },
        },
      }),
    });
    try {
      const disabledPayload = parseMcpJsonText(await disabledScenario.client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'session.spawn_new',
          input: { initialMessage: 'Must remain disabled.' },
        },
      }));
      expect(disabledPayload).toEqual(expect.objectContaining({
        errorCode: 'action_disabled',
        details: expect.objectContaining({
          actionId: 'session.spawn_new',
          surface: 'session_agent',
          reason: 'disabled_by_settings',
        }),
      }));
    } finally {
      await disabledScenario.close();
    }
  }, 240_000);
});
