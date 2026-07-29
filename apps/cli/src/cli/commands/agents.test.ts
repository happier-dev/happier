import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const { createCliCapabilitiesServiceMock, resolveMergedContributionRegistryMock } = vi.hoisted(() => ({
  createCliCapabilitiesServiceMock: vi.fn(),
  resolveMergedContributionRegistryMock: vi.fn(),
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/projection/registry/createResolvedContributionRegistry')>();
  return {
    ...actual,
    resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
  };
});

vi.mock('@/rpc/handlers/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/rpc/handlers/capabilities')>();
  return {
    ...actual,
    createCliCapabilitiesService: createCliCapabilitiesServiceMock,
  };
});

import { handleAgentsCommand } from './agents';

describe('happier agents --json', () => {
  let home = '';
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);

  beforeEach(async () => {
    createCliCapabilitiesServiceMock.mockReset();
    resolveMergedContributionRegistryMock.mockReset();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    home = await createTempDir('happier-agents-json-');
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    resolveMergedContributionRegistryMock.mockResolvedValue({
      agents: [
        {
          id: 'acme.providers.list',
          provenance: 'first_party',
          source: { kind: 'bundled' },
          definition: {
            kindVersion: 1,
            id: 'acme.providers.list',
            ownedBackendIds: [],
          },
          runtimeSpec: {
            kindVersion: 1,
            id: 'acme.providers.list',
            title: 'Acme Providers List',
            binaryName: 'acme-providers-list',
            sourcePreferenceDefault: 'system-first',
            managedInstall: {
              kind: 'managed_package',
              packageName: '@acme/providers-list',
              binaryName: 'acme-providers-list',
            },
            manualInstallKind: 'command',
            manualInstallRecipes: null,
            acceptsJavaScriptFileOverride: false,
          },
        },
      ],
      runtimeAdaptersByBackendId: new Map(),
      catalogEntriesById: {},
      agentDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: {},
    });

    createCliCapabilitiesServiceMock.mockResolvedValue({
      invoke: vi.fn(async ({ id, method }: { id: string; method: string }) => {
        if (id !== 'cli.acme.providers.list') {
          return { ok: false, error: { code: 'unsupported-capability', message: id } };
        }
        if (method === 'probeModels') {
          return {
            ok: true,
            result: {
              provider: 'acme.providers.list',
              source: 'dynamic',
              supportsFreeform: true,
              availableModels: [{ id: 'model-a', name: 'Model A' }],
            },
          };
        }
        if (method === 'probeModes') {
          return {
            ok: true,
            result: {
              provider: 'acme.providers.list',
              source: 'static',
              availableModes: [],
            },
          };
        }
        if (method === 'probeConfigOptions') {
          return {
            ok: true,
            result: {
              provider: 'acme.providers.list',
              source: 'static',
              configOptions: [],
            },
          };
        }
        return { ok: false, error: { code: 'unsupported-method', message: method } };
      }),
    });
  });

  afterEach(async () => {
    envScope.restore();
    reloadConfiguration();
    if (home) await removeTempDir(home);
  });

  it('prints an agents_list JSON envelope', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleAgentsCommand(['list', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('agents_list');
      expect(Array.isArray(parsed.data?.agents)).toBe(true);
      expect(parsed.data.agents.length).toBeGreaterThan(0);
      const first = parsed.data.agents[0];
      expect(first).toEqual(expect.objectContaining({
        id: 'acme.providers.list',
        title: 'Acme Providers List',
        installed: expect.any(Boolean),
      }));
      expect(first.source === null || typeof first.source === 'string').toBe(true);
      expect(first.command === null || typeof first.command === 'string').toBe(true);
    } finally {
      output.restore();
    }
  });

  it('prints an agents_status JSON envelope', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleAgentsCommand(['status', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('agents_status');
      expect(parsed.data.agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'acme.providers.list',
            title: 'Acme Providers List',
          }),
        ]),
      );
    } finally {
      output.restore();
    }
  });

  it('projects the merged provider registry into the help page', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleAgentsCommand(['help']);
      const text = output.logs.join('\n');
      expect(text).toContain('Available agents:');
      expect(text).toContain('Acme Providers List');
      expect(text).toContain('acme.providers.list');
      expect(text).toContain('happier agents install acme.providers.list');
    } finally {
      output.restore();
    }
  });

  it('prints an agents_probe JSON envelope using the canonical capability probes', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleAgentsCommand(['probe', 'acme.providers.list', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('agents_probe');
      expect(parsed.data).toEqual({
        agentId: 'acme.providers.list',
        title: 'Acme Providers List',
        probes: {
          models: {
            provider: 'acme.providers.list',
            source: 'dynamic',
            supportsFreeform: true,
            availableModels: [{ id: 'model-a', name: 'Model A' }],
          },
          modes: {
            provider: 'acme.providers.list',
            source: 'static',
            availableModes: [],
          },
          configOptions: {
            provider: 'acme.providers.list',
            source: 'static',
            configOptions: [],
          },
        },
      });
    } finally {
      output.restore();
    }
  });

  it('prints a typed agents_install JSON error for unknown agent ids', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleAgentsCommand(['install', 'missing.provider', '--dry-run', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('agents_install');
      expect(parsed.error).toEqual({
        code: 'unknown_agent',
        message: 'Unknown agent id: missing.provider',
        agentId: 'missing.provider',
      });
    } finally {
      output.restore();
    }
  });

  it('prints the same typed agent id on agents_probe JSON errors', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleAgentsCommand(['probe', 'missing.provider', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('agents_probe');
      expect(parsed.error).toEqual({
        code: 'unknown_agent',
        message: 'Unknown agent id: missing.provider',
        agentId: 'missing.provider',
      });
    } finally {
      output.restore();
    }
  });
});
