import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { Credentials } from '@/persistence';
import { buildConfiguredAcpBackendSessionMetadata } from '@/agent/acp/catalog/configured/sessionMetadata';

const {
  resolveAgentIdFromSessionMetadataMock,
  readAgentCatalogSnapshotMock,
  resolveAvailableAccountSettingsMock,
  resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock,
} = vi.hoisted(() => ({
  resolveAgentIdFromSessionMetadataMock: vi.fn(),
  readAgentCatalogSnapshotMock: vi.fn(),
  resolveAvailableAccountSettingsMock: vi.fn(),
  resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock: vi.fn(),
}));

vi.mock('@happier-dev/agents', () => ({
  AGENT_IDS: ['claude', 'codex', 'opencode', 'customAcp'],
  DEFAULT_AGENT_ID: 'claude',
  resolveAgentIdFromSessionMetadata: resolveAgentIdFromSessionMetadataMock,
}));

vi.mock('@/settings/accountSettings/resolveAvailableAccountSettings', () => ({
  resolveAvailableAccountSettings: resolveAvailableAccountSettingsMock,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: '/tmp/happy-home',
  },
}));

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot: readAgentCatalogSnapshotMock,
}));

vi.mock('@/agent/acp/catalog/configured/resolveBackend', () => ({
  resolveConfiguredAcpBackendFromAccountSettingsOrPlugins: resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock,
}));

import { resolveSessionForkBackendTarget } from './backendTarget';

describe('resolveSessionForkBackendTarget', () => {
  const credentials = {
    token: 'token',
    encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
  } satisfies Credentials;

  beforeEach(() => {
    vi.clearAllMocks();
    readAgentCatalogSnapshotMock.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {
        claude: { id: 'claude', cliSubcommand: 'claude' },
      },
    });
    resolveAvailableAccountSettingsMock.mockResolvedValue(null);
    resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock.mockResolvedValue(null);
    resolveAgentIdFromSessionMetadataMock.mockReturnValue('claude');
  });

  it('resolves configured ACP fork targets from embedded metadata and preserves vendor session ids', async () => {
    const result = await resolveSessionForkBackendTarget({
      credentials,
      parentMetadata: {
        ...buildConfiguredAcpBackendSessionMetadata({ backendId: 'review-bot', title: 'Review Bot' }),
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'customAcp',
          provider: {
            providerSessionId: 'vendor-123',
          },
        },
      },
    });

    expect(resolveAvailableAccountSettingsMock).toHaveBeenCalledWith({ credentials });
    expect(resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock).toHaveBeenCalledWith({
      settings: {},
      backendId: 'review-bot',
      happyHomeDir: '/tmp/happy-home',
    });
    expect(result).toMatchObject({
      ok: true,
      catalogAgentId: null,
      agentHintAgentId: 'acp:review-bot',
      backendTargetV2: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      replayFlavor: 'acp:review-bot',
      metadataOverlay: expect.objectContaining({
        acpConfiguredBackendV1: expect.objectContaining({
          backendId: 'review-bot',
          title: 'Review Bot',
        }),
      }),
      configuredAcp: {
        backendId: 'review-bot',
        title: 'Review Bot',
        providerSessionId: 'vendor-123',
        resolvedBackend: null,
        accountSettings: null,
      },
    });
  });

  it('recovers configured ACP fork targets from flavor-only metadata when account settings resolve the backend', async () => {
    const accountSettings = { source: 'snapshot' };
    const resolvedBackend = { backendId: 'review-bot', title: 'Review Bot' };

    resolveAvailableAccountSettingsMock.mockResolvedValueOnce(accountSettings);
    resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock.mockResolvedValueOnce(resolvedBackend);

    const result = await resolveSessionForkBackendTarget({
      credentials,
      parentMetadata: {
        flavor: 'acp:review-bot',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'acp:review-bot',
          provider: {
            providerSessionId: 'vendor-456',
          },
        },
      },
    });

    expect(resolveAvailableAccountSettingsMock).toHaveBeenCalledWith({ credentials });
    expect(resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock).toHaveBeenCalledWith({
      settings: accountSettings,
      backendId: 'review-bot',
      happyHomeDir: '/tmp/happy-home',
    });
    expect(result).toMatchObject({
      ok: true,
      catalogAgentId: null,
      agentHintAgentId: 'acp:review-bot',
      backendTargetV2: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      replayFlavor: 'acp:review-bot',
      metadataOverlay: expect.objectContaining({
        acpConfiguredBackendV1: expect.objectContaining({
          backendId: 'review-bot',
          title: 'Review Bot',
        }),
      }),
      configuredAcp: {
        backendId: 'review-bot',
        title: 'Review Bot',
        providerSessionId: 'vendor-456',
        resolvedBackend,
        accountSettings,
      },
    });
  });

  it('recovers configured ACP fork targets from plugin contributions when account settings are empty', async () => {
    const resolvedBackend = { backendId: 'plugin-review-bot', title: 'Plugin Review Bot' };

    resolveAvailableAccountSettingsMock.mockResolvedValueOnce(null);
    resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock.mockResolvedValueOnce(resolvedBackend);

    const result = await resolveSessionForkBackendTarget({
      credentials,
      parentMetadata: {
        flavor: 'acp:plugin-review-bot',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'acp:plugin-review-bot',
          provider: {
            providerSessionId: 'vendor-plugin-123',
          },
        },
      },
    });

    expect(resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock).toHaveBeenCalledWith({
      settings: {},
      backendId: 'plugin-review-bot',
      happyHomeDir: '/tmp/happy-home',
    });
    expect(result).toMatchObject({
      ok: true,
      catalogAgentId: null,
      agentHintAgentId: 'acp:plugin-review-bot',
      backendTargetV2: {
        kind: 'backend',
        backendId: 'plugin-review-bot',
        configuredBackendId: 'plugin-review-bot',
        sourceKind: 'configured',
      },
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'plugin-review-bot' },
      replayFlavor: 'acp:plugin-review-bot',
      metadataOverlay: expect.objectContaining({
        acpConfiguredBackendV1: expect.objectContaining({
          backendId: 'plugin-review-bot',
          title: 'Plugin Review Bot',
        }),
      }),
      configuredAcp: {
        backendId: 'plugin-review-bot',
        title: 'Plugin Review Bot',
        providerSessionId: 'vendor-plugin-123',
        resolvedBackend,
        accountSettings: null,
      },
    });
  });

  it('resolves built-in fork targets from session metadata when no configured ACP backend is present', async () => {
    resolveAgentIdFromSessionMetadataMock.mockReturnValueOnce('claude');

    const result = await resolveSessionForkBackendTarget({
      credentials,
      parentMetadata: {},
    });

    expect(resolveAvailableAccountSettingsMock).not.toHaveBeenCalled();
    expect(resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      catalogAgentId: 'claude',
      agentHintAgentId: 'claude',
      backendTargetV2: {
        kind: 'backend',
        backendId: 'claude',
        sourceKind: 'built_in',
      },
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      replayFlavor: 'claude',
      metadataOverlay: {},
      configuredAcp: null,
    });
  });

  it('resolves an installed external Agent from session metadata through the active catalog', async () => {
    resolveAgentIdFromSessionMetadataMock.mockReturnValueOnce('acme.agent');
    readAgentCatalogSnapshotMock.mockReturnValueOnce({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {
        'acme.agent': { id: 'acme.agent', cliSubcommand: 'acme-agent' },
      },
    });

    await expect(resolveSessionForkBackendTarget({
      credentials,
      parentMetadata: {},
    })).resolves.toMatchObject({
      ok: true,
      catalogAgentId: 'acme.agent',
      agentHintAgentId: 'acme.agent',
      backendTargetV2: {
        kind: 'backend',
        backendId: 'acme.agent',
        sourceKind: 'built_in',
      },
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.agent' },
      replayFlavor: 'acme.agent',
    });
  });

  it('rejects a parent whose canonical and rollback links require reconciliation before backend resolution', async () => {
    const result = await resolveSessionForkBackendTarget({
      credentials,
      parentMetadata: {
        flavor: 'opencode',
        externalSessionV1: {
          v: 1,
          agentId: 'opencode',
          machineId: 'machine_source',
          remoteSessionId: 'opencode_conflict',
          source: { kind: 'opencodeServer', directory: '/repo/current' },
          linkedAtMs: 1,
        },
        directSessionV1: {
          v: 1,
          providerId: 'opencode',
          machineId: 'machine_source',
          remoteSessionId: 'opencode_conflict',
          source: { kind: 'opencodeServer', directory: '/repo/stale' },
          linkedAtMs: 1,
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      errorMessage: 'linked_session_reconciliation_required',
    });
    expect(resolveAvailableAccountSettingsMock).not.toHaveBeenCalled();
    expect(resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock).not.toHaveBeenCalled();
    expect(resolveAgentIdFromSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('fails closed when session metadata does not expose a known agent flavor', async () => {
    resolveAgentIdFromSessionMetadataMock.mockReturnValueOnce(null);

    const result = await resolveSessionForkBackendTarget({
      credentials,
      parentMetadata: {},
    });

    expect(result).toEqual({
      ok: false,
      errorMessage: 'Session metadata missing agent flavor',
    });
  });
});
