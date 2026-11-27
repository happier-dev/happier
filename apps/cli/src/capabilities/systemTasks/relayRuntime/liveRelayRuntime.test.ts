import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The live adapter's contract is delegation to the canonical cli-common relay
// host engine; the engine facade is the genuine system boundary this adapter
// owns, so the tests observe the delegation seam instead of re-testing the
// engine's platform internals (those are covered by cli-common's own suite).
type RelayEngineStub = Readonly<{
  readStatus: ReturnType<typeof vi.fn>;
  installOrUpdate: ReturnType<typeof vi.fn>;
  control: ReturnType<typeof vi.fn>;
}>;

type AdapterHarness = Readonly<{
  engine: RelayEngineStub;
  engineFactoryDeps: unknown[];
  ensureLocalRelayServerInstallCommand: ReturnType<typeof vi.fn>;
  checkRelayRuntimeHealth: ReturnType<typeof vi.fn>;
  createLocalPersonalHomeHost: ReturnType<typeof vi.fn>;
  personalHomeSystemTaskOperations: Readonly<{ inspect: ReturnType<typeof vi.fn> }>;
  personalHomeRelocationDestinationOwner: Readonly<{ stage: ReturnType<typeof vi.fn> }>;
}>;

let harness: AdapterHarness;
let tempHomeDir: string;
let adapter: typeof import('./liveRelayRuntime');
const previousEnv = new Map<string, string | undefined>();

function patchEnv(key: string, value: string | undefined): void {
  if (!previousEnv.has(key)) {
    previousEnv.set(key, process.env[key]);
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function statusSnapshot() {
  return {
    installed: true,
    version: 'happier-server-v9',
    service: { active: true, enabled: true },
    baseUrl: 'http://127.0.0.1:4123',
    healthy: true,
    purpose: { kind: 'personal-home' as const, canonicalServerUrl: 'http://127.0.0.1:4123' },
  };
}

function healthResult() {
  return {
    reachable: true,
    portOpen: true,
    pingOk: true,
    url: 'http://127.0.0.1:4123/health',
    statusCode: 200,
    version: null,
  };
}

function createHarness(): AdapterHarness {
  const personalHomeSystemTaskOperations = { inspect: vi.fn(async () => ({})) };
  const personalHomeRelocationDestinationOwner = { stage: vi.fn(async () => ({})) };
  return {
    engine: {
      readStatus: vi.fn(async () => statusSnapshot()),
      installOrUpdate: vi.fn(async () => ({ relayUrl: 'http://127.0.0.1:4123', mode: 'system' as const })),
      control: vi.fn(async () => undefined),
    },
    engineFactoryDeps: [],
    ensureLocalRelayServerInstallCommand: vi.fn(async (_params: Record<string, unknown>) => '/resolved/happier-server'),
    checkRelayRuntimeHealth: vi.fn(async (_params: Record<string, unknown>) => healthResult()),
    createLocalPersonalHomeHost: vi.fn((_target: Record<string, unknown>) => ({
      releaseRing: 'stable' as const,
      createOperations: vi.fn(async () => ({})),
      createSystemTaskOperations: vi.fn(async () => personalHomeSystemTaskOperations),
      createRelocationDestinationOwner: vi.fn(async () => personalHomeRelocationDestinationOwner),
    })),
    personalHomeSystemTaskOperations,
    personalHomeRelocationDestinationOwner,
  };
}

// The adapter graph is mocked and imported exactly once for the whole file:
// re-importing it per test re-transformed the large graph on every case and
// dominated the suite's runtime. Because each mock factory is evaluated only
// once, every seam forwards at call time to the current per-test harness
// instead of capturing a harness member while the factory runs.
vi.doMock('@happier-dev/cli-common/systemTasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/systemTasks')>();
  return {
    ...actual,
    createRelayHostEngine: ((deps: unknown) => {
      harness.engineFactoryDeps.push(deps);
      return harness.engine;
    }) as unknown as typeof actual.createRelayHostEngine,
    ensureLocalRelayServerInstallCommand: ((...args: unknown[]) =>
      harness.ensureLocalRelayServerInstallCommand(...args)) as unknown as typeof actual.ensureLocalRelayServerInstallCommand,
  };
});
vi.doMock('@happier-dev/cli-common/relayHost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/relayHost')>();
  return {
    ...actual,
    createLocalPersonalHomeHost: ((...args: unknown[]) =>
      harness.createLocalPersonalHomeHost(...args)) as unknown as typeof actual.createLocalPersonalHomeHost,
    probeLocalRelayRuntimeHealth: ((...args: unknown[]) =>
      harness.checkRelayRuntimeHealth(...args)) as unknown as typeof actual.probeLocalRelayRuntimeHealth,
  };
});
// Guard against accidental GitHub network access from any pre-existing
// implementation path; the canonical engine resolves binaries through the
// shared first-party component dependency instead.
vi.doMock('@happier-dev/release-runtime/github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/release-runtime/github')>();
  return {
    ...actual,
    fetchGitHubReleaseByTag: async () => {
      throw new Error('GitHub release fetch is disabled in relay runtime adapter tests');
    },
  };
});

// One cold import of the adapter graph serves the whole file and may exceed
// Vitest's default hook timeout under load; every test then reuses the module.
beforeAll(async () => {
  adapter = await import('./liveRelayRuntime');
}, 60_000);

beforeEach(async () => {
  harness = createHarness();
  tempHomeDir = await mkdtemp(path.join(tmpdir(), 'happier-live-relay-adapter-'));
  patchEnv('HOME', tempHomeDir);
  patchEnv('USERPROFILE', tempHomeDir);
});

afterEach(async () => {
  for (const [key, value] of previousEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  previousEnv.clear();
  vi.clearAllMocks();
  await rm(tempHomeDir, { recursive: true, force: true });
});

const fullLocalParams = {
  target: { kind: 'local' as const },
  channel: 'preview' as const,
  mode: 'user' as const,
  env: { PORT: '4123' },
  purpose: { kind: 'personal-home' as const, canonicalServerUrl: 'http://127.0.0.1:4123' },
  selfHostRelayBinaryOverride: '/tmp/happier-server-override',
};

describe('liveRelayRuntime adapter delegation', () => {
  it('builds Personal Home task operations from the shared local composition owner with a local-only engine', async () => {
    const operations = await adapter.createLivePersonalHomeSystemTaskOperations();

    expect(operations).toBe(harness.personalHomeSystemTaskOperations);
    expect(harness.createLocalPersonalHomeHost).toHaveBeenCalledTimes(1);
    const target = harness.createLocalPersonalHomeHost.mock.calls[0]?.[0] as {
      engine: unknown;
      channel: string;
      mode: string;
      homeDir?: string;
    };
    expect(target).toMatchObject({ channel: 'stable', mode: 'user' });
    // The CLI host owns only the engine, and that engine stays local-only.
    expect(target.engine).toBe(harness.engine);
    expect(target.homeDir).toBeUndefined();
    const engineDeps = harness.engineFactoryDeps[0] as Readonly<{
      installRemoteComponent(): Promise<unknown>;
      resolveRemoteReleaseTarget(): Promise<unknown>;
      runRemoteText(): Promise<unknown>;
      copyLocalDirectoryToRemote(): Promise<unknown>;
    }>;
    await expect(engineDeps.installRemoteComponent()).rejects.toThrow(/not available/u);
    await expect(engineDeps.resolveRemoteReleaseTarget()).rejects.toThrow(/not available/u);
    await expect(engineDeps.runRemoteText()).rejects.toThrow(/not available/u);
    await expect(engineDeps.copyLocalDirectoryToRemote()).rejects.toThrow(/not available/u);
  });

  it('builds the relocation destination owner from the same composition for the selected channel and mode', async () => {
    const owner = await adapter.createLivePersonalHomeRelocationDestinationOwner({
      channel: 'preview',
      mode: 'system',
    });

    expect(owner).toBe(harness.personalHomeRelocationDestinationOwner);
    expect(harness.createLocalPersonalHomeHost).toHaveBeenCalledTimes(1);
    expect(harness.createLocalPersonalHomeHost.mock.calls[0]?.[0]).toMatchObject({
      channel: 'preview',
      mode: 'system',
    });
  });

  it('delegates readLiveRelayRuntimeStatus to the canonical engine with every parsed param field', async () => {
    const status = await adapter.readLiveRelayRuntimeStatus(fullLocalParams);

    expect(harness.engine.readStatus).toHaveBeenCalledTimes(1);
    expect(harness.engine.readStatus).toHaveBeenCalledWith(fullLocalParams);
    expect(status).toEqual(statusSnapshot());
  });

  it('rejects ssh targets because live relay runtime tasks are local-only', async () => {
    await expect(adapter.readLiveRelayRuntimeStatus({
      target: { kind: 'ssh', ssh: { target: 'relay.example.test', auth: 'agent' } },
    })).rejects.toThrow(/local/u);

    expect(harness.engine.readStatus).not.toHaveBeenCalled();
  });

  it('delegates start, restart, stop, and safe uninstall to engine control with the same full params', async () => {
    await adapter.startLiveRelayRuntime(fullLocalParams);
    await adapter.restartLiveRelayRuntime(fullLocalParams);
    await adapter.stopLiveRelayRuntime(fullLocalParams);
    await adapter.uninstallLiveRelayRuntime(fullLocalParams);

    expect(harness.engine.control).toHaveBeenCalledTimes(4);
    expect(harness.engine.control).toHaveBeenNthCalledWith(1, { ...fullLocalParams, action: 'start' });
    expect(harness.engine.control).toHaveBeenNthCalledWith(2, { ...fullLocalParams, action: 'restart' });
    expect(harness.engine.control).toHaveBeenNthCalledWith(3, { ...fullLocalParams, action: 'stop' });
    expect(harness.engine.control).toHaveBeenNthCalledWith(4, { ...fullLocalParams, action: 'uninstall' });
  });

  it('delegates installOrUpdate with the explicit server binary override intact', async () => {
    const result = await adapter.installOrUpdateLiveRelayRuntime(fullLocalParams);

    expect(harness.engine.installOrUpdate).toHaveBeenCalledTimes(1);
    expect(harness.engine.installOrUpdate).toHaveBeenCalledWith(fullLocalParams);
    expect(harness.ensureLocalRelayServerInstallCommand).not.toHaveBeenCalled();
    expect(result).toEqual({ relayUrl: 'http://127.0.0.1:4123', mode: 'system' });
  });

  it('resolves the server binary through the shared first-party component dependency when no override is provided', async () => {
    await adapter.installOrUpdateLiveRelayRuntime({
      target: { kind: 'local' },
      channel: 'dev',
      mode: 'user',
      env: { PORT: '4123' },
    });

    expect(harness.ensureLocalRelayServerInstallCommand).toHaveBeenCalledWith(expect.objectContaining({
      installedVersion: 'happier-server-v9',
      envVarNames: ['HAPPIER_SELF_HOST_SERVER_BINARY'],
      releaseRing: 'publicdev',
    }));
    expect(harness.engine.installOrUpdate).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: 'local' },
      channel: 'dev',
      mode: 'user',
      env: { PORT: '4123' },
      selfHostRelayBinaryOverride: '/resolved/happier-server',
    }));
  });

  it('probes health at the engine-resolved base URL instead of reconstructed defaults', async () => {
    const health = await adapter.readLiveRelayRuntimeHealth({
      target: { kind: 'local' },
      channel: 'preview',
      mode: 'user',
    });

    expect(harness.engine.readStatus).toHaveBeenCalledTimes(1);
    expect(harness.checkRelayRuntimeHealth).toHaveBeenCalledTimes(1);
    expect(harness.checkRelayRuntimeHealth).toHaveBeenCalledWith({ baseUrl: 'http://127.0.0.1:4123' });
    expect(health).toEqual(healthResult());
  });
});
