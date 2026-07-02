import { describe, expect, it, vi } from 'vitest';

import {
  createOpenCodeServerCatalogControlAdapter,
  type OpenCodeSessionCatalogControlAdapterParams,
} from './control.js';

function createParams(
  overrides: Partial<OpenCodeSessionCatalogControlAdapterParams>,
): OpenCodeSessionCatalogControlAdapterParams {
  return {
    metadata: {},
    cwd: '/repo',
    ...overrides,
  };
}

describe('openCodeServerCatalogControlAdapter', () => {
  it('routes inactive OpenCode skill listing through the stored server runtime handle', async () => {
    const client = {
      appSkills: vi.fn(async () => [
        {
          name: 'reviewer',
          description: 'Review code',
          location: '/repo/.agents/skills/reviewer/SKILL.md',
          content: 'private prompt text',
        },
      ]),
      dispose: vi.fn(async () => {}),
    };
    const createClient = vi.fn(async () => client);
    const adapter = createOpenCodeServerCatalogControlAdapter({ createClient });

    await expect(adapter.listSkills?.(createParams({
      cwd: '/repo',
      metadata: {
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'server',
            serverBaseUrl: 'http://127.0.0.1:4096/',
            serverBaseUrlExplicit: true,
            providerSessionId: 'oc_1',
          },
        },
      },
    }))).resolves.toEqual({
      supported: true,
      skills: [
        {
          name: 'reviewer',
          displayName: 'reviewer',
          description: 'Review code',
          path: '/repo/.agents/skills/reviewer/SKILL.md',
          origin: 'opencode_native',
          enabled: true,
        },
      ],
    });

    expect(createClient).toHaveBeenCalledWith({
      directory: '/repo',
      baseUrlOverride: 'http://127.0.0.1:4096/',
    });
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not start a shared managed OpenCode server for passive skill listing when no server URL is stored', async () => {
    const createClient = vi.fn(async () => ({
      appSkills: vi.fn(async () => []),
      dispose: vi.fn(async () => {}),
    }));
    const adapter = createOpenCodeServerCatalogControlAdapter({ createClient });

    await expect(adapter.listSkills?.(createParams({
      cwd: '/repo',
      metadata: {
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'server',
            providerSessionId: 'oc_1',
          },
        },
      },
    }))).resolves.toEqual({
      unsupported: true,
      skills: [],
      diagnostic: 'session_catalog_control_unavailable',
    });

    expect(createClient).not.toHaveBeenCalled();
  });

  it('reports vendor plugins unsupported for OpenCode server sessions', async () => {
    const adapter = createOpenCodeServerCatalogControlAdapter();

    await expect(adapter.listVendorPlugins?.(createParams({ cwd: '/repo' }))).resolves.toEqual({
      unsupported: true,
      vendorPlugins: [],
      diagnostic: 'session_catalog_control_unsupported',
    });
  });
});
