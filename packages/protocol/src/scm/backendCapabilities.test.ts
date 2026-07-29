import { describe, expect, it } from 'vitest';

describe('scmBackendCapabilities', () => {
  it('defines exactly the grouped local SCM backend capability surface', async () => {
    const module = await import('./backendCapabilities.js').catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;

    expect(module.SCM_BACKEND_CAPABILITY_GROUPS).toEqual([
      'detection',
      'read',
      'changeSet',
      'commit',
      'remote',
      'branch',
      'worktree',
      'lifecycle',
      'hosting',
      'checkpoints',
      'workspaceIntegration',
      'tooling',
      'freshness',
    ]);
    expect(module.SCM_BACKEND_CAPABILITY_GROUPS).not.toContain('repositoryDetection');
    expect(module.SCM_BACKEND_CAPABILITY_GROUPS).not.toContain('repositoryLifecycle');
    expect(module.SCM_BACKEND_CAPABILITY_GROUPS).not.toContain('hostingInterop');
    expect(module.SCM_BACKEND_CAPABILITY_GROUPS).not.toContain('sourceController');
  });

  it('parses support levels, unavailable reasons, and freshness metadata', async () => {
    const module = await import('./backendCapabilities.js').catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;

    const parsed = module.ScmBackendCapabilitiesSchema.parse({
      detection: {
        repository: { support: 'supported' },
        executable: { support: 'unsupported', reason: 'tool_missing' },
      },
      read: {
        status: { support: 'supported' },
        defaultBranch: { support: 'experimental' },
      },
      changeSet: {
        model: 'index',
        diffAreas: ['included', 'pending', 'both'],
      },
      commit: {
        create: { support: 'supported' },
        lineSelection: { support: 'unsupported', reason: 'not_implemented' },
      },
      remote: {
        push: { support: 'supported' },
      },
      branch: {},
      worktree: {},
      lifecycle: {},
      hosting: {
        providerDetection: { support: 'unsupported', reason: 'hosting_provider_missing' },
      },
      checkpoints: {},
      workspaceIntegration: {},
      tooling: {
        managedCliResolution: { support: 'experimental' },
        binarySafe: { support: 'supported' },
      },
      freshness: {
        observed: { support: 'supported' },
        refreshPolicy: 'stale-while-revalidate',
        state: {
          source: 'live-local',
          observedAt: 10,
          expiresAt: 20,
        },
      },
    });

    expect(parsed.detection.executable).toEqual({
      support: 'unsupported',
      reason: 'tool_missing',
    });
    expect(parsed.freshness.state).toEqual({
      source: 'live-local',
      observedAt: 10,
      expiresAt: 20,
    });
  });
});
