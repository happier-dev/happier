import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createAcpBackendMock,
  requireProviderCliLaunchSpecMock,
} = vi.hoisted(() => ({
  createAcpBackendMock: vi.fn(),
  requireProviderCliLaunchSpecMock: vi.fn(),
}));

vi.mock('@/agent/acp/createAcpBackend', () => ({
  createAcpBackend: createAcpBackendMock,
}));

vi.mock('@/packagedRuntime/managedTools/requireProviderCliLaunchSpec', () => ({
  requireProviderCliLaunchSpec: requireProviderCliLaunchSpecMock,
}));

import { createConfiguredAcpBackend } from './createConfiguredAcpBackend';

describe('createConfiguredAcpBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves agent-cli launches against the merged runtime env', () => {
    requireProviderCliLaunchSpecMock.mockReturnValue({
      source: 'system',
      resolvedPath: '/resolved/kiro',
      command: '/usr/bin/env',
      args: ['node'],
    });
    createAcpBackendMock.mockReturnValue({ kind: 'backend' });

    createConfiguredAcpBackend({
      cwd: '/repo',
      definition: {
        backendId: 'custom-backend',
        source: {
          kind: 'account_configured',
        },
        identity: {
          backendId: 'custom-backend',
        },
        engine: {
          kind: 'acp',
        },
        ux: {
          title: 'Custom Backend',
        },
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'agent-cli',
            agentId: 'kiro',
            args: ['--acp'],
          },
        },
        launchEnv: {
          ACP_HOME: '/custom/home',
        },
        capabilities: {
          supportsResume: true,
          supportsModes: true,
          supportsModels: true,
          supportsConfigOptions: 'unknown',
          promptImageSupport: 'unknown',
          supportsToolUse: true,
          supportsPermissionRequests: true,
        },
        mcp: {
          policy: 'pass_through',
        },
        callbacks: {},
      },
      backend: {
        backendId: 'custom-backend',
        name: 'custom-backend',
        title: 'Custom Backend',
        command: 'ignored',
        args: [],
        env: {},
        transportProfile: 'generic',
        capabilities: {
          supportsLoadSession: true,
          supportsModes: 'yes',
          supportsModels: 'yes',
          supportsConfigOptions: 'unknown',
          promptImageSupport: 'unknown',
        },
      },
      launchEnv: {
        ACP_HOME: '/custom/home',
      },
      env: {
        PATH: '/custom/bin',
      },
      mcpServers: {},
      permissionHandler: {} as never,
    });

    expect(requireProviderCliLaunchSpecMock).toHaveBeenCalledWith('kiro', {
      processEnv: expect.objectContaining({
        ACP_HOME: '/custom/home',
        PATH: '/custom/bin',
      }),
    });
  });

  it('fails closed instead of leaking a promise when configured ACP startup callbacks are async', () => {
    createAcpBackendMock.mockReturnValue({ kind: 'backend' });

    expect(() => createConfiguredAcpBackend({
      cwd: '/repo',
      definition: {
        backendId: 'custom-backend',
        source: {
          kind: 'account_configured',
        },
        identity: {
          backendId: 'custom-backend',
        },
        engine: {
          kind: 'acp',
        },
        ux: {
          title: 'Custom Backend',
        },
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'custom-agent',
            args: ['--acp'],
          },
        },
        launchEnv: {},
        capabilities: {
          supportsResume: true,
          supportsModes: true,
          supportsModels: true,
          supportsConfigOptions: 'unknown',
          promptImageSupport: 'unknown',
          supportsToolUse: true,
          supportsPermissionRequests: true,
        },
        mcp: {
          policy: 'pass_through',
        },
        callbacks: {
          argvBuilder: async () => ['--acp'],
        },
      },
      launchEnv: {},
      mcpServers: {},
      permissionHandler: {} as never,
    })).toThrow(/async Tier-2 startup callbacks/);
    expect(createAcpBackendMock).not.toHaveBeenCalled();
  });
});
