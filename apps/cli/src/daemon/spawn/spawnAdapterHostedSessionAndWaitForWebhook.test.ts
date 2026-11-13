import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createOrAttachHost: vi.fn(async () => ({
    kind: 'herdr' as const,
    sessionName: 'work terminals',
    socketPath: '/tmp/herdr.sock',
    terminalId: 'term_42',
    paneId: 'w1:p2',
    attachMetadata: {
      attachStrategy: 'terminal_host' as const,
      topology: 'shared' as const,
      locality: 'same_machine' as const,
      maxClients: null,
      requiresLocalAttachmentInfo: true,
      liveProbe: 'required' as const,
    },
  })),
  writeTerminalHostAttachmentInfo: vi.fn(async () => {}),
  waitForTerminalHostedSessionWebhook: vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-1' })),
}));

vi.mock('@/integrations/terminal/host/defaultAdapters', () => ({
  createDefaultTerminalHostAdapterInventory: vi.fn(async () => ({
    adapters: {
      herdr: {
        kind: 'herdr',
        createOrAttachHost: mocks.createOrAttachHost,
        injectUserPrompt: vi.fn(),
        interruptTurn: vi.fn(),
        evaluateLiveness: vi.fn(async () => ({ paneAlive: true, panePid: 4242, observedAt: 1 })),
        dispose: vi.fn(async () => {}),
      },
    },
  })),
}));
vi.mock('@/utils/spawnHappyCLI', () => ({
  buildHappyCliSubprocessLaunchSpec: vi.fn((args: readonly string[]) => ({
    filePath: '/test/happier',
    args: [...args],
  })),
}));
vi.mock('../backendTargetRouting', () => ({
  resolveDaemonCliSubcommandFromBackendTarget: vi.fn(() => 'opencode'),
}));
vi.mock('@/terminal/runtime/terminalMetadata', () => ({
  buildTerminalMetadataFromHostHandle: vi.fn(() => ({ mode: 'herdr' })),
}));
vi.mock('@/terminal/attachment/terminalAttachmentInfo', () => ({
  createTerminalAttachmentId: vi.fn(() => 'attachment-1'),
  writeTerminalHostAttachmentInfo: mocks.writeTerminalHostAttachmentInfo,
}));
vi.mock('./buildSpawnChildProcessEnv', () => ({
  buildSpawnChildProcessEnv: vi.fn(({ extraEnv }: Readonly<{ extraEnv: Record<string, string> }>) => extraEnv),
}));
vi.mock('@/utils/processEnv/buildScopedProcessEnv', () => ({
  stripUnsetEnvironmentVariables: vi.fn((env: Record<string, string>) => env),
}));
vi.mock('./waitForTerminalHostedSessionWebhook', () => ({
  waitForTerminalHostedSessionWebhook: mocks.waitForTerminalHostedSessionWebhook,
}));

import { spawnAdapterHostedSessionAndWaitForWebhook } from './spawnAdapterHostedSessionAndWaitForWebhook';

describe('spawnAdapterHostedSessionAndWaitForWebhook', () => {
  beforeEach(() => {
    mocks.createOrAttachHost.mockClear();
  });

  it('carries the daemon-selected Herdr session name into the hosted runner', async () => {
    await expect(spawnAdapterHostedSessionAndWaitForWebhook({
      terminalRequest: { requested: 'herdr', herdr: { sessionName: 'work terminals' } },
      directory: '/tmp/project',
      trackedSpawnOptions: { directory: '/tmp/project' },
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: 'opencode' },
      sessionControlArgs: [],
      directoryCreated: false,
      extraEnvForChildWithMessage: {},
      processEnv: {},
      happyHomeDir: '/tmp/happier-home',
      trackedSessionsByKey: new Map(),
      spawnAwaiterByKey: new Map(),
      spawnResultResolverByKey: new Map(),
      spawnWebhookTimeoutByKey: new Map(),
      onChildExited: vi.fn(),
      spawnLifecycleCallbacks: {
        registerConnectedServiceSpawnTarget: vi.fn(),
        registerSpawnResourceCleanupForSession: vi.fn(),
        consumeSessionAttachCleanupForSession: vi.fn(),
        cleanupPendingSessionAttach: vi.fn(async () => {}),
        persistAcceptedSpawnMarker: vi.fn(async () => {}),
        removeAcceptedSpawnMarkerIfOwned: vi.fn(async () => true),
      },
      cleanupSpawnResources: vi.fn(async () => {}),
      onUntrackedHostedChild: () => {},
      logDebug: vi.fn(),
      warn: vi.fn(),
    })).resolves.toMatchObject({ type: 'success', sessionId: 'session-1' });

    expect(mocks.createOrAttachHost).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'work terminals',
      spawnArgv: expect.arrayContaining([
        '/test/happier',
        'opencode',
        '--happy-terminal-mode', 'herdr',
        '--happy-terminal-requested', 'herdr',
        '--happy-herdr-session-name', 'work terminals',
      ]),
    }));
  });
});
