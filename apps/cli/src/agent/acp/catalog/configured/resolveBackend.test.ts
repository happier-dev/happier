import { describe, expect, it } from 'vitest';

import {
  resolveConfiguredAcpBackendFromAccountSettings,
  resolveConfiguredAcpBackendFromPluginBackendDefinition,
  listPluginConfiguredAcpBackendsFromRegistry,
} from './resolveBackend';
import type { ResolvedAgentContribution, ResolvedSystemToolContribution } from '@/plugins/projection/registry/types';

describe('resolveConfiguredAcpBackendFromAccountSettings', () => {
  it('returns null when the backend is missing', () => {
    const out = resolveConfiguredAcpBackendFromAccountSettings({}, 'missing');
    expect(out).toBeNull();
  });

  it('returns backend launch configuration when present', () => {
    const out = resolveConfiguredAcpBackendFromAccountSettings({
      acpCatalogSettingsV1: {
        v: 2,
        backends: [
          {
            id: 'backend-1',
            name: 'backend-1',
            title: 'Backend 1',
            command: 'kiro-cli',
            args: ['acp', '--agent', 'spec'],
            env: {
              REGION: { t: 'literal', v: 'eu' },
              EXTRA: { t: 'literal', v: '1' },
            },
            auth: {
              support: 'login_terminal',
              machineLoginKey: 'kiro-cli',
              loginCommand: { command: 'kiro-cli', args: ['login'] },
              statusCommand: ['whoami', '--format', 'json'],
              parser: 'kiroWhoamiJson',
            },
            transportProfile: 'kiro',
            capabilities: {
              supportsLoadSession: true,
              supportsModes: 'yes',
              supportsModels: 'yes',
              supportsConfigOptions: 'unknown',
              promptImageSupport: 'yes',
            },
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      },
    }, 'backend-1');

    expect(out).toMatchObject({
      backendId: 'backend-1',
      title: 'Backend 1',
      command: 'kiro-cli',
      args: ['acp', '--agent', 'spec'],
      transportProfile: 'kiro',
    });
    expect(out?.env).toEqual({
      REGION: { t: 'literal', v: 'eu' },
      EXTRA: { t: 'literal', v: '1' },
    });
    expect(out?.auth?.parser).toBe('kiroWhoamiJson');
    expect(out?.capabilities.supportsLoadSession).toBe(true);
  });
});

describe('resolveConfiguredAcpBackendFromPluginBackendDefinition', () => {
  it('preserves canonical system-tool launch provenance and definitions', () => {
    const out = resolveConfiguredAcpBackendFromPluginBackendDefinition({
      id: 'acme.agent',
      runtime: {
        kind: 'acp',
        transport: {
          kind: 'stdio',
          executable: { kind: 'systemTool', id: 'acme-cli' },
          args: ['--acp'],
          env: { ACP_REGION: 'eu' },
        },
        ux: { title: 'Acme Agent' },
      },
    }, 'acme.agent', 'acme.plugin', [{
      id: 'acme-cli',
      title: 'Acme CLI',
      executableNames: ['acme'],
    }]);

    expect(out).toMatchObject({
      backendId: 'acme.agent',
      source: {
        kind: 'plugin_contributed',
        pluginId: 'acme.plugin',
        systemTools: [{ id: 'acme-cli' }],
      },
      command: 'acme-cli',
      args: ['--acp'],
      launch: {
        kind: 'system-tool',
        toolId: 'acme-cli',
        args: ['--acp'],
        env: { ACP_REGION: 'eu' },
      },
    });
  });

  it('discovers current Manifest V2 ACP Agents from the projected Agent catalog', () => {
    const agent = {
      id: 'acme-agent', provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.plugin',
      definition: { kindVersion: 1, id: 'acme-agent', ownedBackendIds: [] },
      richDefinition: {
        provenance: 'external',
        definition: {
          id: 'acme-agent', title: 'Plugin Review Bot', primary: 'sessions',
          capabilities: {
            surfaces: [],
            sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
          },
          runtime: {
            kind: 'acp',
            transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'acme-cli' }, args: ['--acp'] },
          },
        },
      },
    } satisfies ResolvedAgentContribution;
    const systemTool = {
      provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.plugin',
      definition: { id: 'acme-cli', title: 'Acme CLI', executableNames: ['acme'] },
    } satisfies ResolvedSystemToolContribution;

    expect(listPluginConfiguredAcpBackendsFromRegistry({ agents: [agent], systemTools: [systemTool] }))
      .toEqual([expect.objectContaining({
        backendId: 'acme-agent', title: 'Plugin Review Bot',
        command: 'acme-cli',
        source: expect.objectContaining({
          kind: 'plugin_contributed', pluginId: 'acme.plugin', systemTools: [{ id: 'acme-cli', title: 'Acme CLI', executableNames: ['acme'] }],
        }),
      })]);
  });
});
