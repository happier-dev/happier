import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as backendCatalog from '@/backends/catalog';
import type { BackendExecutionSurfaces } from '@/backends/catalog';
import type { AnyTerminalRuntimeOps, ProviderAttachOps } from '@/backends/types';
import type { LocalHostedDirectTranscriptBinding } from '@/agent/terminalRuntime/directTranscriptBinding';
import type { Credentials } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { evaluateCliSessionAttachEligibility } from './evaluateCliSessionAttachEligibility';

const {
  resolveBackendExecutionSurfaces,
  getProviderAttachOps,
  getTerminalRuntimeOps,
  createMockBackendExecutionSurfaces,
} = vi.hoisted(() => {
  const createMockTerminalRuntimeBinding = (
    providerId: 'claude' | 'codex' | 'ohMyPi',
  ): LocalHostedDirectTranscriptBinding => providerId === 'claude'
    ? {
        providerId,
        source: {
          kind: 'claudeConfig',
          configDir: '/tmp/runtime-binding',
          projectId: null,
        },
        remoteSessionId: 'runtime-binding',
      }
    : providerId === 'codex'
      ? {
          providerId,
          source: {
            kind: 'codexHome',
            home: 'user',
            homePath: '/tmp/runtime-binding',
          },
          remoteSessionId: 'runtime-binding',
        }
      : {
          providerId,
          source: {
            kind: 'ohMyPiAgentDir',
            agentDir: '/tmp/runtime-binding',
          },
          remoteSessionId: 'runtime-binding',
        };

  const createMockBackendExecutionSurfaces = (backendId: string | null | undefined): BackendExecutionSurfaces => {
    if (backendId === 'opencode') {
      const attach: ProviderAttachOps = {
        evaluateEligibility: async ({ currentMachineId, sessionMachineId, hasLocalAttachmentInfo, metadata }) => ({
          eligible: true,
          scope:
            (currentMachineId && sessionMachineId && currentMachineId === sessionMachineId) || hasLocalAttachmentInfo
              ? 'local'
              : 'remote',
          metadata,
        }),
        probeReachability: async () => ({ reachable: true }),
        runAttach: async () => 0,
      };
      return {
        terminalRuntime: null,
        directSessions: null,
        attach,
        sessionHandoff: null,
      };
    }

    if (backendId === 'claude' || backendId === 'codex' || backendId === 'ohMyPi') {
      const terminalRuntime: AnyTerminalRuntimeOps = backendId === 'ohMyPi'
        ? {
            bindTranscript: async () => createMockTerminalRuntimeBinding('ohMyPi'),
          }
        : {
            launch: async () => 'launched',
            bindTranscript: async () => createMockTerminalRuntimeBinding(backendId),
          };
      return {
        terminalRuntime,
        directSessions: null,
        attach: null,
        sessionHandoff: null,
      };
    }

    return {
      terminalRuntime: null,
      directSessions: null,
      attach: null,
      sessionHandoff: null,
    };
  };
  const resolveBackendExecutionSurfaces = vi.fn(createMockBackendExecutionSurfaces);
  return {
    resolveBackendExecutionSurfaces,
    getProviderAttachOps: vi.fn(),
    getTerminalRuntimeOps: vi.fn(),
    createMockBackendExecutionSurfaces,
  };
});

vi.mock('@/backends/catalog', () => ({
  resolveBackendExecutionSurfaces,
  getProviderAttachOps,
  getTerminalRuntimeOps,
}));

const credentials: Credentials = {
  token: 'token-1',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
};

const previousManagedServerStatePath = process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;

afterEach(() => {
  resolveBackendExecutionSurfaces.mockReset().mockImplementation(createMockBackendExecutionSurfaces);
  getProviderAttachOps.mockReset();
  getTerminalRuntimeOps.mockReset();
  if (previousManagedServerStatePath === undefined) {
    delete process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;
    return;
  }
  process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = previousManagedServerStatePath;
});

describe('evaluateCliSessionAttachEligibility', () => {
  it('rejects sessions from a different machine even when synced tmux metadata exists', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_remote_tmux_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-remote',
        flavor: 'claude',
        path: '/tmp/workspace',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:session-1' },
        },
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-remote',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: false,
      reasonCode: 'missing_local_attach_state',
    });
  });

  it('requires local attachment state for tmux-backed terminal attach', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_local_tmux_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-local',
        flavor: 'claude',
        path: '/tmp/workspace',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:session-1' },
        },
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: false,
      reasonCode: 'missing_local_attach_state',
    });
  });

  it('accepts provider-attach sessions on the current machine without local terminal attachment state', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_local_opencode_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-local',
        flavor: 'opencode',
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
        opencodeServerBaseUrlExplicit: true,
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'provider_attach',
      agentId: 'opencode',
      attachScope: 'local',
    });
  });

  it('resolves attach eligibility through the generic backend execution surface instead of direct catalog getters', async () => {
    const resolveBackendExecutionSurfacesSpy = vi.spyOn(backendCatalog, 'resolveBackendExecutionSurfaces').mockResolvedValue(
      createMockBackendExecutionSurfaces('opencode'),
    );
    const getProviderAttachOpsSpy = vi.spyOn(backendCatalog, 'getProviderAttachOps');
    const getTerminalRuntimeOpsSpy = vi.spyOn(backendCatalog, 'getTerminalRuntimeOps');

    const rawSession = createSessionRecordFixture({
      id: 'sid_generic_attach_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-local',
        flavor: 'opencode',
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
        opencodeServerBaseUrlExplicit: true,
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'provider_attach',
      agentId: 'opencode',
      attachScope: 'local',
    });

    expect(resolveBackendExecutionSurfacesSpy).toHaveBeenCalledWith('opencode');
    expect(getProviderAttachOpsSpy).not.toHaveBeenCalled();
    expect(getTerminalRuntimeOpsSpy).not.toHaveBeenCalled();
    resolveBackendExecutionSurfacesSpy.mockRestore();
  });

  it('accepts terminal-hosted sessions when the backend catalog exposes terminal runtime ops', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_local_ohmy_pi_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-local',
        flavor: 'ohMyPi',
        path: '/tmp/ohmypi-workspace',
        ohMyPiSessionId: 'ohmypi-session-1',
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-local',
      localAttachmentInfo: {
        version: 1,
        sessionId: 'sid_local_ohmy_pi_1',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:ohmypi-1' },
        },
        updatedAt: Date.now(),
      },
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'terminal_host',
      agentId: 'ohMyPi',
      attachScope: 'local',
    });
  });

  it('accepts same-machine OpenCode sessions when the managed server state provides the local server URL', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'happier-opencode-attach-'));
    process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = join(stateDir, 'managed-server.json');
    await writeFile(process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH, JSON.stringify({
      baseUrl: 'http://127.0.0.1:4096/',
      pid: 12345,
      startedAtMs: Date.now(),
      status: 'ready',
    }));

    const rawSession = createSessionRecordFixture({
      id: 'sid_local_opencode_managed_state_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-local',
        flavor: 'opencode',
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-1',
        opencodeBackendMode: 'server',
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'provider_attach',
      agentId: 'opencode',
      attachScope: 'local',
    });
  });

  it('treats a local attachment marker as authoritative local ownership for OpenCode provider attach', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'happier-opencode-attach-local-marker-'));
    process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = join(stateDir, 'managed-server.json');
    await writeFile(process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH, JSON.stringify({
      baseUrl: 'http://127.0.0.1:4096/',
      pid: 12345,
      startedAtMs: Date.now(),
      status: 'ready',
    }));

    const rawSession = createSessionRecordFixture({
      id: 'sid_local_opencode_local_marker_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-before-reauth',
        flavor: 'opencode',
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-1',
        opencodeBackendMode: 'server',
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-after-reauth',
      localAttachmentInfo: {
        version: 1,
        sessionId: 'sid_local_opencode_local_marker_1',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:opencode-1' },
        },
        updatedAt: Date.now(),
      },
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'provider_attach',
      agentId: 'opencode',
      attachScope: 'local',
    });
  });

  it('accepts provider-attach sessions as remote when machine ownership is missing', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_local_opencode_missing_machine_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        flavor: 'opencode',
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
        opencodeServerBaseUrlExplicit: true,
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'provider_attach',
      agentId: 'opencode',
      attachScope: 'remote',
    });
  });

  it('accepts provider-attach sessions as remote when they belong to another machine', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_remote_opencode_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-remote',
        flavor: 'opencode',
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'https://remote.example.test/',
        opencodeServerBaseUrlExplicit: true,
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'provider_attach',
      agentId: 'opencode',
      attachScope: 'remote',
    });
  });
});
