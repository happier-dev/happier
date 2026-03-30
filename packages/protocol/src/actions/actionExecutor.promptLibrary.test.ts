import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  return createActionExecutor({
    executionRunStart: async () => ({}),
    executionRunList: async () => ({}),
    executionRunGet: async () => ({}),
    executionRunSend: async () => ({}),
    executionRunStop: async () => ({}),
    executionRunAction: async () => ({}),
    executionRunWait: async () => ({}),
    sessionOpen: async () => ({}),
    sessionFork: async () => ({}),
    sessionRollback: async () => ({}),
    sessionSpawnNew: async () => ({}),
    sessionSpawnPicker: async () => ({}),
    pathsListRecent: async () => ({ items: [] }),
    machinesList: async () => ({ items: [] }),
    serversList: async () => ({ items: [] }),
    reviewEnginesList: async () => ({ items: [] }),
    agentsBackendsList: async () => ({ items: [] }),
    agentsModelsList: async () => ({ items: [] }),
    sessionSendMessage: async () => ({}),
    sessionPermissionRespond: async () => ({}),
    sessionUserActionAnswer: async () => ({}),
    sessionModeSet: async () => ({}),
    sessionModesList: async () => ({ items: [] }),
    sessionTargetPrimarySet: async () => ({}),
    sessionTargetTrackedSet: async () => ({}),
    sessionList: async () => ({}),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({}),
    resetGlobalVoiceAgent: async () => {},
    ...overrides,
  });
}

describe('createActionExecutor (prompt library actions)', () => {
  it('routes prompt_doc.update to deps.promptDocUpdate', async () => {
    const promptDocUpdate = vi.fn(async () => ({ ok: true, artifactId: 'doc-1' }));
    const executor = createExecutor({ promptDocUpdate } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('prompt_doc.update' as any, {
      artifactId: 'doc-1',
      title: 'Review prompt',
      markdown: '# Review',
      tags: ['review'],
    });

    expect(res).toEqual({ ok: true, result: { ok: true, artifactId: 'doc-1' } });
    expect(promptDocUpdate).toHaveBeenCalledWith({
      artifactId: 'doc-1',
      title: 'Review prompt',
      markdown: '# Review',
      tags: ['review'],
    });
  });

  it('routes prompt_bundle.update to deps.promptBundleUpdate', async () => {
    const promptBundleUpdate = vi.fn(async () => ({ ok: true, artifactId: 'bundle-1' }));
    const executor = createExecutor({ promptBundleUpdate } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('prompt_bundle.update' as any, {
      artifactId: 'bundle-1',
      title: 'Reviewer',
      skillMarkdown: '# Reviewer',
      folderId: 'folder-1',
    });

    expect(res).toEqual({ ok: true, result: { ok: true, artifactId: 'bundle-1' } });
    expect(promptBundleUpdate).toHaveBeenCalledWith({
      artifactId: 'bundle-1',
      title: 'Reviewer',
      skillMarkdown: '# Reviewer',
      folderId: 'folder-1',
    });
  });

  it('routes prompt_asset.export to deps.promptAssetExport', async () => {
    const promptAssetExport = vi.fn(async () => ({ ok: true, artifactId: 'doc-1' }));
    const executor = createExecutor({ promptAssetExport } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('prompt_asset.export' as any, {
      artifactId: 'doc-1',
      machineId: 'machine-1',
      assetTypeId: 'claude.command',
      scope: 'user',
      targetPath: 'review.md',
      installMode: 'symlink',
    });

    expect(res).toEqual({ ok: true, result: { ok: true, artifactId: 'doc-1' } });
    expect(promptAssetExport).toHaveBeenCalledWith({
      artifactId: 'doc-1',
      machineId: 'machine-1',
      assetTypeId: 'claude.command',
      scope: 'user',
      targetPath: 'review.md',
      installMode: 'symlink',
    });
  });

  it('forwards server routing to prompt_asset.export deps', async () => {
    const promptAssetExport = vi.fn(async () => ({ ok: true, artifactId: 'doc-1' }));
    const executor = createExecutor({ promptAssetExport } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('prompt_asset.export' as any, {
      artifactId: 'doc-1',
      machineId: 'machine-1',
      assetTypeId: 'claude.command',
      scope: 'user',
      targetPath: 'review.md',
    }, {
      serverId: 'server-1',
    });

    expect(res).toEqual({ ok: true, result: { ok: true, artifactId: 'doc-1' } });
    expect(promptAssetExport).toHaveBeenCalledWith({
      artifactId: 'doc-1',
      machineId: 'machine-1',
      assetTypeId: 'claude.command',
      scope: 'user',
      targetPath: 'review.md',
      serverId: 'server-1',
    });
  });

  it('propagates prompt_asset.export failures from deps', async () => {
    const promptAssetExport = vi.fn(async () => ({ ok: false, errorCode: 'conflict', error: 'conflict' }));
    const executor = createExecutor({ promptAssetExport } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('prompt_asset.export' as any, {
      artifactId: 'doc-1',
      machineId: 'machine-1',
      assetTypeId: 'claude.command',
      scope: 'user',
      targetPath: 'review.md',
    });

    expect(res).toEqual({ ok: false, errorCode: 'conflict', error: 'conflict' });
  });

  it('routes prompt_registry.install to deps.promptRegistryInstall', async () => {
    const promptRegistryInstall = vi.fn(async () => ({ ok: true, artifactId: 'bundle-1', exported: true }));
    const executor = createExecutor({ promptRegistryInstall } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('prompt_registry.install' as any, {
      machineId: 'machine-1',
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:item-1',
      configuredSources: [],
      installTarget: {
        assetTypeId: 'agents.skill',
        scope: 'project',
        directory: '/tmp/project',
        targetName: 'frontend-design',
        installMode: 'symlink',
      },
    });

    expect(res).toEqual({ ok: true, result: { ok: true, artifactId: 'bundle-1', exported: true } });
    expect(promptRegistryInstall).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:item-1',
      configuredSources: [],
      installTarget: {
        assetTypeId: 'agents.skill',
        scope: 'project',
        directory: '/tmp/project',
        targetName: 'frontend-design',
        installMode: 'symlink',
      },
    });
  });

  it('forwards server routing to prompt_registry.install deps', async () => {
    const promptRegistryInstall = vi.fn(async () => ({ ok: true, artifactId: 'bundle-1', exported: true }));
    const executor = createExecutor({ promptRegistryInstall } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('prompt_registry.install' as any, {
      machineId: 'machine-1',
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:item-1',
      configuredSources: [],
    }, {
      serverId: 'server-1',
    });

    expect(res).toEqual({ ok: true, result: { ok: true, artifactId: 'bundle-1', exported: true } });
    expect(promptRegistryInstall).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:item-1',
      configuredSources: [],
      serverId: 'server-1',
    });
  });

  it('propagates prompt_registry.install failures from deps', async () => {
    const promptRegistryInstall = vi.fn(async () => ({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' }));
    const executor = createExecutor({ promptRegistryInstall } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('prompt_registry.install' as any, {
      machineId: 'machine-1',
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:item-1',
      configuredSources: [],
    });

    expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
  });
});
