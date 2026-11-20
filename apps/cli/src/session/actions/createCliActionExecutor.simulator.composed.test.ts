import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FeaturesResponseSchema,
  type ActionExecutorContext,
} from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionMachineBootstrapV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type {
  SimulatorPreviewActionResultV1,
  SimulatorPreviewActionV1,
  SimulatorPreviewSnapshotV1,
} from '@happier-dev/protocol/devices/simulator/runtimeV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import {
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
} from '@happier-dev/protocol/rpc/errors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createExternalMcpServer } from '@/mcp/createExternalMcpServer';
import { registerDaemonSimulatorPreviewHandlers } from '@/rpc/handlers/daemonSimulatorPreview';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';

const { io } = vi.hoisted(() => ({ io: vi.fn() }));
// Socket.IO is the Home relay boundary. Machine RPC framing, the registered
// daemon handlers and their serializers below are the production owners.
vi.mock('socket.io-client', () => ({ io }));

const owner = {
  token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`,
  encryption: null,
};
const features = FeaturesResponseSchema.parse({
  features: {
    devices: { enabled: true, simulatorPreview: { enabled: true } },
    machines: { enabled: true, liveStream: { enabled: true } },
  },
  capabilities: {},
});

/** Home HTTP is a network boundary: Account mode and Machine bootstrap rows only. */
async function startHome(): Promise<
  Readonly<{ url: string; server: Server; paths: string[] }>
> {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    request.resume();
    paths.push(request.url ?? '');
    response.setHeader('content-type', 'application/json');
    const machine = /^\/v1\/machines\/([^/?]+)$/u.exec(request.url ?? '')?.[1];
    if (request.url === '/v1/account/encryption')
      response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
    else if (request.url === '/v1/account/encryption/currentness')
      response.end(
        JSON.stringify({
          mode: 'plain',
          version: 1,
          updatedAt: 1,
          signingKeyFingerprint: null,
          contentKeyFingerprint: null,
        }),
      );
    else if (request.url === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1)
      response.end(JSON.stringify(ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] })));
    else if (request.url === '/v2/account/settings')
      response.end(
        JSON.stringify({ version: 1, content: { t: 'plain', v: {} } }),
      );
    else if (machine)
      response.end(
        JSON.stringify({
          machine: {
            ...ExternalActionMachineBootstrapV1Schema.parse({
              id: machine,
              kind: 'persistent',
              active: true,
              dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
              revokedAt: null,
              replacedByMachineId: null,
            }),
            storageMode: 'plain',
          },
        }),
      );
    else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing Home address');
  return { url: `http://127.0.0.1:${address.port}`, server, paths };
}

/**
 * The addressed daemon: the real registered simulator Machine RPC handlers over
 * a native-adapter boundary. Home admits Machines in `admitted`; any other
 * Machine receives Home's Machine-admission refusal and never reaches a daemon.
 */
function relayToDaemons(admitted: ReadonlySet<string>) {
  const snapshots: string[] = [];
  const events: SimulatorPreviewActionV1[] = [];
  const calls: string[] = [];
  const daemons = new Map<string, RpcHandlerManager>();
  for (const machineId of admitted) {
    const rpc = new RpcHandlerManager({
      scopePrefix: machineId,
      encryptionMode: 'plain',
      logger() {},
    });
    registerDaemonSimulatorPreviewHandlers(rpc, {
      simulatorPreview: {
        getSnapshot: async (): Promise<SimulatorPreviewSnapshotV1> => {
          snapshots.push(machineId);
          return {
            v: 1,
            machineId,
            generatedAt: 1,
            refreshState: 'idle',
            resources: [],
            diagnostics: [],
          };
        },
        dispatchAction: async (
          event,
        ): Promise<SimulatorPreviewActionResultV1> => {
          events.push(event);
          return {
            v: 1,
            eventType: event.type,
            status: 'accepted',
            diagnostics: [],
          };
        },
      },
    });
    daemons.set(machineId, rpc);
  }
  io.mockImplementation(() =>
    createApiSessionSocketStub({
      emit(event, args, socket) {
        if (event === SOCKET_RPC_EVENTS.REGISTER)
          socket.trigger(SOCKET_RPC_EVENTS.REGISTERED, args[0]);
      },
      async emitWithAck(event, payload) {
        expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
        if (
          !payload ||
          typeof payload !== 'object' ||
          !('method' in payload) ||
          typeof payload.method !== 'string' ||
          !('params' in payload)
        )
          throw new Error('Missing RPC request');
        calls.push(payload.method);
        const machineId = payload.method.slice(0, payload.method.indexOf(':'));
        const daemon = daemons.get(machineId);
        if (!daemon)
          return {
            ok: false,
            error: RPC_ERROR_MESSAGES.FORBIDDEN,
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
            failureCause: {
              phase: 'rpc.admission.machine',
              errorClass: 'Error',
              errorCode: 'access_denied',
              httpStatus: 403,
            },
          };
        return {
          ok: true,
          result: await daemon.handleRequest({
            method: payload.method,
            params: payload.params,
          }),
        };
      },
    }),
  );
  return { snapshots, events, calls };
}

/**
 * The harness's runtime bridge is the seam under test: Action admission and
 * approval run above it unchanged, the MCP case below drives the whole executor.
 */
function runtimeBridge(homeUrl: string, surface: 'agent' | 'mcp' | 'cli') {
  const { deps } = createCliActionExecutorHarness({
    credentials: owner,
    token: owner.token,
    mode: 'plain',
    ctx: null,
    sessionId: 'session-a',
    serverId: 'home-a',
    serverHttpBaseUrl: homeUrl,
    resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }),
  });
  const context: ActionExecutorContext = {
    surface,
    authority: surface === 'cli' ? 'present_user' : 'account_automation',
    serverId: 'home-a',
    actionRequestId: 'simulator-invocation',
    defaultSessionId: 'session-a',
    defaultSessionMachineId: 'machine-a',
  };
  const execute = deps.runtimeActionExecute;
  if (!execute) throw new Error('Missing runtime Action bridge');
  return { execute, context };
}

/** The external MCP server's public tool, exactly as the incident called it. */
async function callExternalMcp(homeUrl: string, machineId: string, actionId: string, input: unknown): Promise<unknown> {
  const { mcp } = runWithServerHttpBaseUrl(homeUrl, () =>
    createExternalMcpServer({
      credentials: { ...owner, credentialProvenance: 'stored_session' },
      machineId,
      serverFeaturesSnapshot: { status: 'ready', features },
    }),
  );
  const client = new Client({ name: 'simulator-ingress', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const result = CallToolResultSchema.parse(
      await client.callTool({ name: 'action_execute', arguments: { actionId, input } }),
    );
    const text = result.content.find((item) => item.type === 'text');
    return text?.type === 'text' ? JSON.parse(text.text) : null;
  } finally {
    await client.close();
    await mcp.close();
  }
}

describe('simulator Actions outside the app reach the addressed Machine daemon', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  it('serves external MCP action_execute devices.simulator.list from the MCP Machine daemon', async () => {
    const home = await startHome();
    servers.push(home.server);
    const daemon = relayToDaemons(new Set(['machine-a']));
    // The incident's exact tool arguments (L12-FC-NATIVE simulator1120 replay).
    expect(getActionSpec('devices.simulator.list').surfaces.mcp).toBe(true);
    expect(await callExternalMcp(home.url, 'machine-a', 'devices.simulator.list', { type: 'simulator.devices.list' }))
      .toMatchObject({ v: 1, machineId: 'machine-a', resources: [] });
    expect(daemon.snapshots).toEqual(['machine-a']);
  });

  it('returns Home Machine-admission refusal to external MCP for a Machine it is not admitted to, without a local answer', async () => {
    const home = await startHome();
    servers.push(home.server);
    const daemon = relayToDaemons(new Set(['machine-a']));
    expect(await callExternalMcp(home.url, 'foreign-machine', 'devices.simulator.list', { type: 'simulator.devices.list' }))
      .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(daemon.calls).toEqual([`foreign-machine:${RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_SNAPSHOT}`]);
    expect(daemon.snapshots).toEqual([]);
  });

  it.each(['agent', 'mcp', 'cli'] as const)(
    'lists and controls a named Machine through the %s runtime Action bridge',
    async (surface) => {
      const home = await startHome();
      servers.push(home.server);
      const daemon = relayToDaemons(new Set(['machine-a', 'machine-b']));
      const { execute, context } = runtimeBridge(home.url, surface);
      const target = { ...context, externalActionTarget: { kind: 'machine' as const, machineId: 'machine-b' } };
      expect(await execute({ actionId: 'devices.simulator.list', input: { type: 'simulator.devices.list' }, context: target }))
        .toMatchObject({ machineId: 'machine-b' });
      const lease = { type: 'simulator.lease.acquire', simulatorId: 'sim-1', streamId: 'stream-1', sourceId: 'source-1', viewerId: 'viewer-1' };
      expect(await execute({ actionId: 'devices.simulator.lease.acquire', input: lease, context: target }))
        .toMatchObject({ eventType: 'simulator.lease.acquire', status: 'accepted' });
      // An unaddressed call uses the host's Session Machine.
      expect(await execute({ actionId: 'devices.simulator.list', input: { type: 'simulator.devices.list' }, context }))
        .toMatchObject({ machineId: 'machine-a' });
      expect(daemon.snapshots).toEqual(['machine-b', 'machine-a']);
      expect(daemon.events).toEqual([expect.objectContaining({ type: 'simulator.lease.acquire', simulatorId: 'sim-1' })]);
    },
  );
});
