import { describe, expect, it, vi } from 'vitest';

import { createPluginInstallationReviewFixture } from '@/plugins/testkit/pluginInstallationReviewFixture';

import type { PluginChangeRequestResult } from './changeContract';
import { requestPluginDevelopmentChange } from './developmentClient';

describe('requestPluginDevelopmentChange', () => {
  it('allows the daemon to derive code-defined plugin identity from the sole source evaluation', async () => {
    const requestChange = vi.fn(async () => ({
      kind: 'committed' as const,
      pluginId: 'acme.derived',
      desiredGeneration: 'generation-derived',
      appliedGeneration: 'generation-derived',
      pendingSurfaces: [],
    }));

    await expect(requestPluginDevelopmentChange(
      { kind: 'development', projectRoot: '/tmp/plugin.ts' },
      { ensureDaemon: async () => undefined, requestChange },
    )).resolves.toEqual({ ok: true, generation: { desired: 'generation-derived', applied: 'generation-derived', pendingSurfaces: [] } });

    expect(requestChange).toHaveBeenCalledWith({
      kind: 'development',
      sourceRootPath: '/tmp/plugin.ts',
    });
  });

  it('keeps a noninteractive source-root review pending with the daemon-issued review DTO', async () => {
    const pendingReview = {
      kind: 'sourceRootReviewRequired' as const,
      pendingChangeId: 'pending-source-root',
      review: { source: { kind: 'path' as const, locator: '/tmp/plugin.ts' } },
    };
    const confirm = vi.fn();
    const decideChange = vi.fn();

    await expect(requestPluginDevelopmentChange(
      { kind: 'development', projectRoot: '/tmp/plugin.ts' },
      {
        ensureDaemon: async () => undefined,
        confirm,
        requestChange: async (): Promise<PluginChangeRequestResult> => pendingReview,
        decideChange,
      },
      { approval: 'none' },
    )).resolves.toEqual({
      ok: false,
      diagnostics: [{
        code: 'plugin_dev_review_pending',
        message: 'The daemon is still awaiting a plugin trust decision.',
      }],
      pendingReview,
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(decideChange).not.toHaveBeenCalled();
  });

  it('starts the daemon and presents one trust decision before applying the first source', async () => {
    const ensureDaemon = vi.fn(async () => undefined);
    const confirm = vi.fn(async (_message: string) => true);
    const requestChange = vi.fn(async (): Promise<PluginChangeRequestResult> => ({
      kind: 'reviewRequired' as const,
      pendingChangeId: 'pending-1',
      review: createPluginInstallationReviewFixture({
        updateChannel: { kind: 'path', locator: '/tmp/example', development: true },
        contributions: [{ family: 'actions', count: 1 }],
      }),
    }));
    const decideChange = vi.fn(async () => ({
      kind: 'committed' as const,
      pluginId: 'acme.example',
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: [],
    }));

    await expect(requestPluginDevelopmentChange(
      {
        kind: 'development',
        pluginId: 'acme.example',
        projectRoot: '/tmp/example',
        changedPaths: ['src/index.ts'],
        sdkRegistryOrigin: 'https://registry.example.test',
      },
      { ensureDaemon, confirm, requestChange, decideChange, createInteractionId: () => 'interaction-1', nowMs: () => 1 },
    )).resolves.toEqual({ ok: true, generation: { desired: 'generation-1', applied: 'generation-1', pendingSurfaces: [] } });

    expect(ensureDaemon).toHaveBeenCalledBefore(requestChange);
    expect(requestChange).toHaveBeenCalledWith({
      kind: 'development',
      pluginId: 'acme.example',
      sourceRootPath: '/tmp/example',
      changedPaths: ['src/index.ts'],
      sdkRegistryOrigin: 'https://registry.example.test',
    });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Example'));
    expect(decideChange).toHaveBeenCalledWith(expect.objectContaining({
      pendingChangeId: 'pending-1',
      decision: 'installAndTrust',
      actorEvidence: expect.objectContaining({ interactionId: 'interaction-1' }),
    }));
  });

  it('requires package install and trust approval after source-root approval', async () => {
    const confirm = vi.fn(async (_message: string) => true);
    const requestChange = vi.fn(async (): Promise<PluginChangeRequestResult> => ({
      kind: 'sourceRootReviewRequired',
      pendingChangeId: 'pending-source-root',
      review: { source: { kind: 'path', locator: '/tmp/plugin.ts' } },
    }));
    const decideChange = vi.fn()
      .mockResolvedValueOnce({
        kind: 'reviewRequired' as const,
        pendingChangeId: 'pending-source-root',
        review: createPluginInstallationReviewFixture({
          pluginId: 'acme.derived',
          updateChannel: { kind: 'path', locator: '/tmp/plugin.ts', development: true },
        }),
      })
      .mockResolvedValueOnce({
        kind: 'committed' as const,
        pluginId: 'acme.derived',
        desiredGeneration: 'generation-derived',
        appliedGeneration: 'generation-derived',
        pendingSurfaces: [],
      });
    let interaction = 0;

    await expect(requestPluginDevelopmentChange(
      { kind: 'development', projectRoot: '/tmp/plugin.ts' },
      {
        ensureDaemon: async () => undefined,
        confirm,
        requestChange,
        decideChange,
        createInteractionId: () => `interaction-${interaction += 1}`,
        nowMs: () => interaction,
      },
    )).resolves.toEqual({ ok: true, generation: { desired: 'generation-derived', applied: 'generation-derived', pendingSurfaces: [] } });

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[0]?.[0]).toContain('source root');
    expect(confirm.mock.calls[1]?.[0]).toContain('Install & Trust');
    expect(decideChange.mock.calls.map(([decision]) => decision.decision)).toEqual([
      'trustSourceRoot',
      'installAndTrust',
    ]);
  });

  it('treats optional access after source-root trust as selection-only', async () => {
    const confirm = vi.fn(async (_message: string) => true);
    const requestChange = vi.fn(async (): Promise<PluginChangeRequestResult> => ({
      kind: 'sourceRootReviewRequired',
      pendingChangeId: 'pending-source-root',
      review: { source: { kind: 'path', locator: '/tmp/plugin.ts' } },
    }));
    const decideChange = vi.fn()
      .mockResolvedValueOnce({
        kind: 'reviewRequired' as const,
        pendingChangeId: 'pending-source-root',
        review: createPluginInstallationReviewFixture({
          pluginId: 'acme.derived',
          updateChannel: { kind: 'path', locator: '/tmp/plugin.ts', development: true },
          optionalHostAccess: [{
            id: 'project-sessions',
            capability: 'sessions',
            reason: 'Read selected project sessions',
            authorizationClass: 'hostResourceSelection',
            normalizedScope: { access: ['read'], projectIds: ['project-a'] },
          }],
        }),
      })
      .mockResolvedValueOnce({
        kind: 'committed' as const,
        pluginId: 'acme.derived',
        desiredGeneration: 'generation-derived',
        appliedGeneration: 'generation-derived',
        pendingSurfaces: [],
      });
    let interaction = 0;

    await expect(requestPluginDevelopmentChange(
      { kind: 'development', projectRoot: '/tmp/plugin.ts' },
      {
        ensureDaemon: async () => undefined,
        confirm,
        requestChange,
        decideChange,
        createInteractionId: () => `interaction-${interaction += 1}`,
        nowMs: () => interaction,
      },
    )).resolves.toEqual({ ok: true, generation: { desired: 'generation-derived', applied: 'generation-derived', pendingSurfaces: [] } });

    expect(confirm).toHaveBeenCalledTimes(3);
    expect(confirm.mock.calls[0]?.[0]).toContain('source root');
    expect(confirm.mock.calls[1]?.[0]).toContain('Install & Trust');
    expect(confirm.mock.calls[2]?.[0]).toContain('optional sessions access');
    expect(decideChange.mock.calls.map(([decision]) => decision)).toEqual([
      expect.objectContaining({ decision: 'trustSourceRoot' }),
      expect.objectContaining({
        decision: 'installAndTrust',
        optionalSelections: [{ accessId: 'project-sessions', selected: true }],
      }),
    ]);
  });

  it('does not prompt when the daemon applies an already-trusted development edit', async () => {
    const confirm = vi.fn();
    await expect(requestPluginDevelopmentChange(
      { kind: 'development', pluginId: 'acme.example', projectRoot: '/tmp/example' },
      {
        ensureDaemon: async () => undefined,
        confirm,
        requestChange: async () => ({
          kind: 'committed',
          pluginId: 'acme.example',
          desiredGeneration: 'generation-2',
          appliedGeneration: 'generation-2',
          pendingSurfaces: [],
        }),
        decideChange: vi.fn(),
      },
    )).resolves.toEqual({ ok: true, generation: { desired: 'generation-2', applied: 'generation-2', pendingSurfaces: [] } });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('preserves response-loss uncertainty and directs the caller to installed state without replaying the mutation', async () => {
    const requestChange = vi.fn(async () => ({
      kind: 'unavailable' as const,
      code: 'daemon_unavailable' as const,
    }));
    const request = {
      kind: 'development' as const,
      pluginId: 'acme.example',
      projectRoot: '/tmp/example',
    };
    const dependencies = {
      ensureDaemon: async () => undefined,
      requestChange,
    };

    await expect(requestPluginDevelopmentChange(request, dependencies)).resolves.toEqual({
      ok: false,
      diagnostics: [{
        code: 'plugin_dev_outcome_unknown',
        message: 'The daemon may have applied the development change for acme.example; inspect installed state before retrying.',
      }],
    });

    expect(requestChange).toHaveBeenCalledTimes(1);
    expect(requestChange).toHaveBeenCalledWith({
      kind: 'development',
      pluginId: 'acme.example',
      sourceRootPath: '/tmp/example',
    });
  });

  it('forwards command cancellation to the daemon request owner', async () => {
    const controller = new AbortController();
    const requestChange = vi.fn(async () => ({
      kind: 'committed' as const,
      pluginId: 'acme.example',
      desiredGeneration: 'generation-3',
      appliedGeneration: 'generation-3',
      pendingSurfaces: [],
    }));

    await expect(requestPluginDevelopmentChange(
      { kind: 'development', pluginId: 'acme.example', projectRoot: '/tmp/example' },
      {
        ensureDaemon: async () => undefined,
        requestChange,
      },
      { signal: controller.signal },
    )).resolves.toEqual({ ok: true, generation: { desired: 'generation-3', applied: 'generation-3', pendingSurfaces: [] } });

    expect(requestChange).toHaveBeenCalledWith({
      kind: 'development',
      pluginId: 'acme.example',
      sourceRootPath: '/tmp/example',
    }, { signal: controller.signal });
  });

  it('reports startup cancellation without implying that source trust was missing', async () => {
    const controller = new AbortController();
    let finishDaemonStartup!: () => void;
    const ensureDaemon = vi.fn(async () => await new Promise<void>((resolve) => {
      finishDaemonStartup = resolve;
    }));
    const requestChange = vi.fn();

    const pending = requestPluginDevelopmentChange(
      { kind: 'development', pluginId: 'acme.example', projectRoot: '/tmp/example' },
      { ensureDaemon, requestChange },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(ensureDaemon).toHaveBeenCalledTimes(1));
    controller.abort();

    try {
      await expect(pending).resolves.toEqual({
        ok: false,
        diagnostics: [{
          code: 'plugin_dev_cancelled',
          message: 'Plugin development was cancelled before the candidate was applied.',
        }],
      });
      expect(requestChange).not.toHaveBeenCalled();
    } finally {
      finishDaemonStartup();
      await pending;
    }
  });

  it('preserves the daemon candidate diagnostic when development activation fails', async () => {
    await expect(requestPluginDevelopmentChange(
      { kind: 'development', pluginId: 'acme.example', projectRoot: '/tmp/example' },
      {
        ensureDaemon: async () => undefined,
        requestChange: async () => ({
          kind: 'failed',
          code: 'plugin_install_failed',
          message: 'Plugin acme.example activation failed: missing export activate',
        }),
      },
    )).resolves.toEqual({
      ok: false,
      diagnostics: [{
        code: 'plugin_install_failed',
        message: 'Plugin acme.example activation failed: missing export activate',
      }],
    });
  });
});
