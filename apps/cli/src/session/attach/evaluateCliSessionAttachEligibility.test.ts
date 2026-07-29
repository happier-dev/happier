import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAcpConfiguredBackendV1,
  sealSessionOwnerMetadataV1,
  SessionOwnerMetadataV1Schema,
} from '@happier-dev/protocol';

import type { BackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistryTypes';
import type { AnyTerminalRuntimeOps, ProviderAttachOps } from '@/agent/catalog/types';
import type { Credentials } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { evaluateCliSessionAttachEligibility } from './evaluateCliSessionAttachEligibility';

const {
  resolveBackendExecutionSurfaces,
  createMockBackendExecutionSurfaces,
} = vi.hoisted(() => {
  const createMockBackendExecutionSurfaces = (backendId: string | null | undefined): BackendExecutionSurfaces => {
    if (backendId === 'opencode') {
      const attach: ProviderAttachOps = {
        evaluateAvailability: async ({ currentMachineId, sessionMachineId, hasLocalAttachmentInfo, metadata }) => ({
          eligible: true,
          scope:
            (currentMachineId && sessionMachineId && currentMachineId === sessionMachineId) || hasLocalAttachmentInfo
              ? 'local'
              : 'remote',
          metadata,
        }),
        probeReachability: async () => ({ reachable: true }),
        attach: async () => 0,
      };
      return {
        terminalRuntime: null,
        externalSession: null,
        attach,
        handoff: null,
        fork: null,
        checkpoint: null,
      };
    }

    if (backendId === 'claude' || backendId === 'codex' || backendId === 'ohMyPi') {
      const terminalRuntime: AnyTerminalRuntimeOps = backendId === 'ohMyPi'
        ? {}
        : {
            launch: async () => 'launched',
          };
      return {
        terminalRuntime,
        externalSession: null,
        attach: null,
        handoff: null,
        fork: null,
        checkpoint: null,
      };
    }

    return {
      terminalRuntime: null,
      externalSession: null,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    };
  };
  const resolveBackendExecutionSurfaces = vi.fn(createMockBackendExecutionSurfaces);
  return {
    resolveBackendExecutionSurfaces,
    createMockBackendExecutionSurfaces,
  };
});

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendExecutionSurfaces,
}));

const credentialSecret = new Uint8Array(32).fill(1);
const credentials: Credentials = {
  token: 'token-1',
  encryption: { type: 'legacy', secret: credentialSecret },
};

const previousManagedServerStatePath = process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;

afterEach(() => {
  resolveBackendExecutionSurfaces.mockReset().mockImplementation(createMockBackendExecutionSurfaces);
  if (previousManagedServerStatePath === undefined) {
    delete process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;
    return;
  }
  process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = previousManagedServerStatePath;
});

type EvaluateAttachEligibilityParams = Parameters<typeof evaluateCliSessionAttachEligibility>[0];

function evaluateWithMockBackendSurfaces(
  params: Omit<EvaluateAttachEligibilityParams, 'resolveExecutionSurfaces'> & Partial<Pick<EvaluateAttachEligibilityParams, 'resolveExecutionSurfaces'>>,
) {
  return evaluateCliSessionAttachEligibility({
    ...params,
    resolveExecutionSurfaces: params.resolveExecutionSurfaces ?? (async (backendId) => resolveBackendExecutionSurfaces(backendId)),
  });
}

function assertAttachEligibilityResolverIsRequiredForTypeSafety() {
  // @ts-expect-error Attach eligibility must always receive bridge-owned execution surface resolution.
  void evaluateCliSessionAttachEligibility({
    credentials,
    rawSession: createSessionRecordFixture({
      id: 'sid_missing_surface_resolver_type_guard_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ flavor: 'opencode', machineId: 'machine-1' }),
    }),
    currentMachineId: 'machine-1',
    localAttachmentInfo: null,
    insideTmux: false,
  });
}

describe('evaluateCliSessionAttachEligibility', () => {
  it('excludes owner-only External Session operation progress from provider attach leaves', async () => {
    const evaluateAvailability = vi.fn<ProviderAttachOps['evaluateAvailability']>(
      async ({ metadata }) => ({
        eligible: true,
        scope: 'local',
        metadata,
      }),
    );
    const attach: ProviderAttachOps = {
      evaluateAvailability,
      probeReachability: async () => ({ reachable: true }),
      attach: async () => 0,
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_provider_attach_private_operation_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-1',
        flavor: 'opencode',
        path: '/private/workspace',
        externalSessionOperationV1: {
          v: 1,
          progress: { operationId: 'private-operation', revision: 5 },
        },
        externalSessionOperationPresentationV1: {
          v: 1,
          operationId: 'private-operation',
          revision: 5,
          kind: 'materialize',
          status: 'running',
          phase: 'publishing',
        },
      }),
    });

    const result = await evaluateWithMockBackendSurfaces({
      credentials,
      rawSession,
      currentMachineId: 'machine-1',
      localAttachmentInfo: null,
      insideTmux: false,
      resolveExecutionSurfaces: async () => ({
        terminalRuntime: null,
        externalSession: null,
        attach,
        handoff: null,
        fork: null,
        checkpoint: null,
      }),
    });

    expect(evaluateAvailability).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        path: '/private/workspace',
        externalSessionOperationPresentationV1: expect.objectContaining({
          operationId: 'private-operation',
          revision: 5,
        }),
      }),
    }));
    expect(evaluateAvailability.mock.calls[0]?.[0].metadata)
      .not.toHaveProperty('externalSessionOperationV1');
    expect(result.metadata).not.toHaveProperty('externalSessionOperationV1');
  });

  it('uses layout-v1 owner metadata for Agent, machine, path, and terminal attach facts', async () => {
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        machineId: 'machine-layout1',
        host: 'layout1-host',
        path: '/private/layout1-workspace',
        flavor: 'claude',
      },
      runtime: {
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:layout1-owner' },
        },
      },
    });
    const rawSession = createSessionRecordFixture({
      id: 'sid_layout1_owner_tmux_1',
      active: true,
      encryptionMode: 'plain',
      metadataLayoutVersion: 1,
      metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: sealSessionOwnerMetadataV1({
        material: { type: 'legacy', secret: credentialSecret },
        ownerMetadata,
        randomBytes: (length) => new Uint8Array(length).fill(7),
      }),
    });

    await expect(evaluateWithMockBackendSurfaces({
      credentials,
      rawSession,
      currentMachineId: 'machine-layout1',
      currentMachineHost: 'layout1-host',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'terminal_host',
      attachScope: 'local',
      agentId: 'claude',
      metadata: {
        machineId: 'machine-layout1',
        host: 'layout1-host',
        path: '/private/layout1-workspace',
        flavor: 'claude',
      },
      plan: expect.objectContaining({
        type: 'tmux',
        target: 'happy:layout1-owner',
      }),
    });
  });

  it('fails closed when layout-v1 owner metadata is unavailable', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_layout1_missing_owner_1',
      active: true,
      encryptionMode: 'plain',
      metadataLayoutVersion: 1,
      metadata: JSON.stringify({
        v: 1,
        agentPresentation: { agentId: 'claude' },
      }),
      ownerMetadata: null,
    });

    await expect(evaluateWithMockBackendSurfaces({
      credentials,
      rawSession,
      currentMachineId: 'machine-layout1',
      currentMachineHost: 'layout1-host',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: false,
      agentId: null,
      reasonCode: 'metadata_unavailable',
      metadata: null,
    });
  });

  it('rejects terminal-host sessions from a different physical host even when synced tmux metadata exists', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_remote_tmux_physical_host_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-remote',
        flavor: 'claude',
        host: 'office-imac',
        path: '/tmp/workspace',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:session-remote' },
        },
      }),
    });

    await expect(evaluateWithMockBackendSurfaces({
      credentials,
      rawSession,
      currentMachineId: 'machine-local',
      currentMachineHost: 'leeroy-mbp',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: false,
      reasonCode: 'not_current_machine',
    });
  });

  it('accepts a local terminal marker even when the session machine identity changed', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_local_marker_after_machine_rotation_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-before-reauth',
        flavor: 'claude',
        host: 'leeroy-mbp',
        path: '/tmp/workspace',
      }),
    });

    await expect(evaluateWithMockBackendSurfaces({
      credentials,
      rawSession,
      currentMachineId: 'machine-after-reauth',
      currentMachineHost: 'leeroy-mbp',
      localAttachmentInfo: {
        version: 1,
        sessionId: 'sid_local_marker_after_machine_rotation_1',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:session-local-marker' },
        },
        updatedAt: Date.now(),
      },
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'terminal_host',
      agentId: 'claude',
      attachScope: 'local',
      plan: expect.objectContaining({ type: 'tmux', target: 'happy:session-local-marker' }),
    });
  });

  it('accepts same-host synced tmux metadata when the machine identity differs without a local marker', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_same_host_synced_tmux_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-from-ui',
        flavor: 'claude',
        host: 'leeroy-mbp',
        path: '/tmp/workspace',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:session-same-host' },
        },
      }),
    });

    await expect(evaluateWithMockBackendSurfaces({
      credentials,
      rawSession,
      currentMachineId: 'machine-from-cli',
      currentMachineHost: 'leeroy-mbp.local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'terminal_host',
      agentId: 'claude',
      attachScope: 'local',
      plan: expect.objectContaining({ type: 'tmux', target: 'happy:session-same-host' }),
    });
  });

  it('accepts same-host synced tmux metadata even when terminal runtime ops are unavailable without a local marker', async () => {
    resolveBackendExecutionSurfaces.mockResolvedValue({
      terminalRuntime: null,
      externalSession: null,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    });

    const rawSession = createSessionRecordFixture({
      id: 'sid_same_host_synced_tmux_without_backend_runtime_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-from-ui',
        flavor: 'claude',
        host: 'leeroy-mbp',
        path: '/tmp/workspace',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:session-same-host' },
        },
      }),
    });

    await expect(evaluateWithMockBackendSurfaces({
      credentials,
      rawSession,
      currentMachineId: 'machine-from-cli',
      currentMachineHost: 'leeroy-mbp.local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'terminal_host',
      agentId: 'claude',
      attachScope: 'local',
      plan: expect.objectContaining({ type: 'tmux', target: 'happy:session-same-host' }),
    });
  });

  it('does not fall back to claude when same-host metadata terminal attach cannot infer an agent id', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_same_host_synced_tmux_unknown_agent_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-from-ui',
        host: 'leeroy-mbp',
        path: '/tmp/ohmypi-workspace',
        acpConfiguredBackendV1: buildAcpConfiguredBackendV1({
          updatedAt: 1,
          backendId: 'ohMyPi',
          title: 'Oh My Pi',
        }),
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:session-same-host-unknown-agent' },
        },
      }),
    });

    await expect(evaluateWithMockBackendSurfaces({
      credentials,
      rawSession,
      currentMachineId: 'machine-from-cli',
      currentMachineHost: 'leeroy-mbp.local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'terminal_host',
      agentId: null,
      attachScope: 'local',
      plan: expect.objectContaining({ type: 'tmux', target: 'happy:session-same-host-unknown-agent' }),
    });
  });

  it('accepts synced tmux metadata when the machine identity matches even if the host is unavailable', async () => {
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

    await expect(evaluateWithMockBackendSurfaces({
      credentials,
      rawSession,
      currentMachineId: 'machine-remote',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'terminal_host',
      agentId: 'claude',
      attachScope: 'local',
      plan: expect.objectContaining({ type: 'tmux', target: 'happy:session-1' }),
    });
  });

  it('accepts tmux-backed terminal attach from same-machine synced metadata without local attachment state', async () => {
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

    await expect(evaluateWithMockBackendSurfaces({
      credentials,
      rawSession,
      currentMachineId: 'machine-local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'terminal_host',
      agentId: 'claude',
      attachScope: 'local',
      plan: expect.objectContaining({ type: 'tmux', target: 'happy:session-1' }),
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

    await expect(evaluateWithMockBackendSurfaces({
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
    const resolveBackendExecutionSurfacesSpy = resolveBackendExecutionSurfaces.mockResolvedValue(
      createMockBackendExecutionSurfaces('opencode'),
    );
    const resolveExecutionSurfaces = vi.fn(async () => createMockBackendExecutionSurfaces('opencode'));

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

    await expect(evaluateWithMockBackendSurfaces({
      credentials,
      rawSession,
      currentMachineId: 'machine-local',
      localAttachmentInfo: null,
      insideTmux: false,
      resolveExecutionSurfaces,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'provider_attach',
      agentId: 'opencode',
      attachScope: 'local',
    });

    expect(resolveExecutionSurfaces).toHaveBeenCalledWith('opencode');
    expect(resolveBackendExecutionSurfacesSpy).not.toHaveBeenCalled();
  });

  it('resolves configured ACP attach through the concrete configured backend execution surface', async () => {
    const evaluateAvailability = vi.fn(async ({ metadata }) => ({
      eligible: true as const,
      scope: 'remote' as const,
      metadata,
    }));
    const attach: ProviderAttachOps = {
      evaluateAvailability,
      probeReachability: async () => ({ reachable: true }),
      attach: async () => 0,
    };
    resolveBackendExecutionSurfaces.mockImplementation((backendId) => backendId === 'plugin-review-bot'
      ? {
          terminalRuntime: null,
          externalSession: null,
          attach,
          handoff: null,
          fork: null,
          checkpoint: null,
        }
      : createMockBackendExecutionSurfaces(backendId));

    const rawSession = createSessionRecordFixture({
      id: 'sid_configured_plugin_attach_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-remote',
        flavor: 'acp:plugin-review-bot',
        acpConfiguredBackendV1: buildAcpConfiguredBackendV1({
          updatedAt: 1,
          backendId: 'plugin-review-bot',
          title: 'Plugin Review Bot',
        }),
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'opencode',
          provider: {},
        },
      }),
    });

    await expect(evaluateWithMockBackendSurfaces({
      credentials,
      rawSession,
      currentMachineId: 'machine-local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'provider_attach',
      agentId: 'opencode',
      backendId: 'plugin-review-bot',
      attachScope: 'remote',
    });

    expect(resolveBackendExecutionSurfaces).toHaveBeenCalledWith('plugin-review-bot');
    expect(evaluateAvailability).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sid_configured_plugin_attach_1',
    }));
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

    await expect(evaluateWithMockBackendSurfaces({
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

    await expect(evaluateWithMockBackendSurfaces({
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

    await expect(evaluateWithMockBackendSurfaces({
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

    await expect(evaluateWithMockBackendSurfaces({
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

    await expect(evaluateWithMockBackendSurfaces({
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
