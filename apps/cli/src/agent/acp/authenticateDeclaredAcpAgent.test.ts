import { describe, expect, it, vi } from 'vitest';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';

import { authenticateDeclaredAcpAgent } from './authenticateDeclaredAcpAgent';

describe('authenticateDeclaredAcpAgent', () => {
  it('rejects auxiliary-only Agent declarations before ACP runtime normalization', async () => {
    const definition = PluginAgentContributionV2Schema.parse({
      id: 'external-agent',
      title: 'External Agent',
      capabilities: { surfaces: ['externalSessions'] },
      surfaces: {
        externalSession: {
          sources: [{
            sourceKind: 'fixture',
            schema: { fields: [{ name: 'kind', kind: 'literal', value: 'fixture' }] },
            key: { segments: [{ kind: 'literal', value: 'fixture' }] },
            instances: [{ kind: 'default', constants: {} }],
          }],
        },
      },
    });
    const registry = {
      agents: [{
        id: 'external-agent',
        pluginId: 'happier.agent.external',
        richDefinition: {
          provenance: 'external',
          definition,
        },
      }],
    };

    await expect(authenticateDeclaredAcpAgent({
      registry: registry as never,
      agentId: 'external-agent',
      cwd: '/workspace',
      env: {},
      onStderr: () => {},
    })).rejects.toThrow("Agent 'external-agent' does not declare host-managed ACP authentication");
  });

  it('uses the declared ACP method and exact plugin-owned managed transport', async () => {
    const authenticateAcpAgent = vi.fn(async () => {});
    const ensureRuntimeInstallablesForLaunch = vi.fn(async () => ({ ok: true as const, installedKeys: [] }));
    const resolveLaunchCommand = vi.fn(async () => ({
      ok: true as const,
      command: '/managed/agy_acp_server',
      args: ['--uid='],
      source: 'managed' as const,
    }));
    const descriptor = {
      key: 'dep.antigravity.agy-acp-server',
    };
    const installablesRegistry = {
      descriptors: [{ owner: { pluginId: 'happier.agent.antigravity' }, descriptor }],
      descriptorsByKey: { 'dep.antigravity.agy-acp-server': { owner: { pluginId: 'happier.agent.antigravity' }, descriptor } },
    };
    const definition = PluginAgentContributionV2Schema.parse({
      id: 'antigravity',
      title: 'Antigravity',
      runtime: {
        kind: 'acp',
        transport: {
          kind: 'stdio',
          executable: { kind: 'managedDependency', id: 'agy-acp-server' },
        },
        definition: {
          auth: { methodId: 'oauth-personal' },
          mcp: { policy: 'pass_through' },
        },
      },
      primary: 'sessions',
      capabilities: {
        sessions: {
          open: ['create', 'resume'],
          delivery: ['newTurn'],
          cancel: true,
        },
      },
    });
    const registry = {
      agents: [{
        id: 'antigravity',
        pluginId: 'happier.agent.antigravity',
        richDefinition: {
          provenance: 'first_party',
          definition,
        },
      }],
      managedDependencies: [{
        pluginId: 'happier.agent.antigravity',
        definition: {
          id: 'agy-acp-server',
          title: 'Antigravity ACP server',
          description: 'Pinned Antigravity ACP server',
          sources: [{
            kind: 'pinnedArchive',
            installId: 'dep.antigravity.agy-acp-server',
            version: '1.1.1',
            assetsByPlatform: {
              'linux-x64': {
                archiveUrl: 'https://example.com/agy-acp-server.zip',
                sha256: 'a'.repeat(64),
                executableSubpath: 'agy_acp_server',
              },
            },
          }],
          platforms: ['linux'],
          architectures: ['x64'],
          executable: 'agy_acp_server',
        },
      }],
    };

    await authenticateDeclaredAcpAgent({
      registry: registry as never,
      agentId: 'antigravity',
      cwd: '/workspace',
      env: { BASE: '1' },
      onStderr: () => {},
    }, {
      resolveInstallablesRegistry: () => installablesRegistry as never,
      readActiveMachineId: async () => 'machine-1',
      readAccountSettings: () => ({ featureToggles: {} }) as never,
      ensureRuntimeInstallablesForLaunch,
      getRuntimeInstallableAdapter: async () => ({ resolveLaunchCommand }) as never,
      authenticateAcpAgent,
    });

    expect(ensureRuntimeInstallablesForLaunch).toHaveBeenCalledWith(expect.objectContaining({
      installableKeys: ['dep.antigravity.agy-acp-server'],
      machineId: 'machine-1',
      env: { BASE: '1' },
    }));
    expect(authenticateAcpAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'antigravity',
      command: '/managed/agy_acp_server',
      args: ['--uid='],
      methodId: 'oauth-personal',
      cwd: '/workspace',
    }));
  });
});
