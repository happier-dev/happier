import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

const serverCtor = vi.hoisted(() => vi.fn());
vi.mock('socket.io', () => ({
  Server: function ServerMock(this: any, ...args: any[]) {
    return serverCtor(...args);
  },
}));

vi.mock('@/utils/process/shutdown', () => ({ onShutdown: vi.fn() }));
vi.mock('@/app/events/eventRouter', () => ({
  buildMachineActivityEphemeral: vi.fn(),
  eventRouter: { setIo: vi.fn(), addConnection: vi.fn(), emitEphemeral: vi.fn() },
}));
vi.mock('./socket/rpcHandler', () => ({ rpcHandler: vi.fn() }));
vi.mock('./socket/usageHandler', () => ({ usageHandler: vi.fn() }));
vi.mock('./socket/sessionUpdateHandler', () => ({ sessionUpdateHandler: vi.fn() }));
vi.mock('./socket/pingHandler', () => ({ pingHandler: vi.fn() }));
vi.mock('./socket/machineUpdateHandler', () => ({ machineUpdateHandler: vi.fn() }));
vi.mock('./socket/machineTransferHandler', () => ({ machineTransferHandler: vi.fn() }));
vi.mock('./socket/transferRelayV2Handler', () => ({ transferRelayV2Handler: vi.fn() }));
vi.mock('./socket/peer/mediation/tunnel/registerRelay', () => ({ registerPeerTcpTunnelRelaySocketHandler: vi.fn() }));
vi.mock('./socket/artifactUpdateHandler', () => ({ artifactUpdateHandler: vi.fn() }));
vi.mock('./socket/accessKeyHandler', () => ({ accessKeyHandler: vi.fn() }));
vi.mock('./socket/serverRpcForwarder', () => ({ createServerRpcForwarder: vi.fn(() => vi.fn()) }));

describe('startSocket transfer relay v2 registration', () => {
  let harness: LightSqliteHarness;
  let accountId: string;
  let token: string;

  beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-transfer-relay-registration-', initAuth: true });
  }, 120_000);

  afterAll(async () => { await harness?.close(); });

  beforeEach(async () => {
    harness.resetEnv();
    vi.stubEnv('HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED', '1');
    vi.stubEnv('HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__ENABLED', '0');
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    accountId = account.id;
    token = await auth.createToken(accountId, undefined, { kind: 'account', authority: 'present_user' });
  });

  afterEach(async () => {
    await db.account.deleteMany();
    vi.unstubAllEnvs();
  });

  function makeServer() {
    let middleware: ((socket: any, next: (error?: unknown) => void) => Promise<void>) | undefined;
    const server = {
      on: vi.fn(),
      use: vi.fn((handler: any) => { middleware = handler; }),
      close: vi.fn(),
      to: vi.fn(() => ({ emit: vi.fn() })),
      serverSideEmit: vi.fn(),
      sockets: { adapter: { on: vi.fn(), rooms: new Map() }, sockets: new Map() },
    };
    serverCtor.mockReturnValue(server);
    return { server, getMiddleware: () => middleware };
  }

  function socketFor(authToken: string) {
    return {
      id: 'socket-1',
      data: {},
      connected: true,
      on: vi.fn(),
      once: vi.fn(),
      use: vi.fn(),
      join: vi.fn(),
      emit: vi.fn(),
      disconnect: vi.fn(),
      handshake: {
        address: '127.0.0.1',
        auth: { token: authToken, clientType: 'user-scoped', clientPurpose: 'transfer' },
        headers: { 'user-agent': 'happier-test-agent' },
      },
      conn: { transport: { name: 'websocket' }, remotePort: 1234 },
    };
  }

  it('uses the real verifier for a test-issued token and registers the relay connection hook', async () => {
    const { server, getMiddleware } = makeServer();
    const { startSocket } = await import('./socket');
    startSocket({ server: { on: vi.fn() } } as any);

    const middleware = getMiddleware();
    expect(middleware).toBeTypeOf('function');
    const next = vi.fn();
    await middleware!(socketFor(token), next);
    expect(next).toHaveBeenCalledWith();
    expect(server.on.mock.calls.some(([event]) => event === 'connection')).toBe(true);
  });

  it('refuses an invalid handshake token at the auth boundary', async () => {
    makeServer();
    const { startSocket } = await import('./socket');
    startSocket({ server: { on: vi.fn() } } as any);
    // Read the middleware from the server mock without introducing an auth mock.
    const io = serverCtor.mock.results.at(-1)?.value as { use: ReturnType<typeof vi.fn> };
    const handler = io.use.mock.calls.length > 0 ? io.use.mock.calls[0][0] as (socket: any, next: (error?: unknown) => void) => Promise<void> : undefined;
    expect(handler).toBeTypeOf('function');
    const next = vi.fn();
    await handler!(socketFor('invalid-transfer-relay-v2-token'), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ error: 'invalid-token' }) }));
  });
});
