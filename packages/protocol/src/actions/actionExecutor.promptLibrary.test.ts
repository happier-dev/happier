import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { createPromptDocInLibrary, listPromptLibrary, setPromptDocFavorite, type PromptLibraryStoredArtifact } from '../prompts/library/promptLibraryActionOperations.js';
import { getActionSpec } from './actionSpecs.js';

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  return createActionExecutor({
    executionRunStart: async () => ({}),
    executionRunList: async () => ({}),
    executionRunGet: async () => ({}),
    detachedExecutionRunSend: async () => ({}),
    executionRunStop: async () => ({}),
    executionRunAction: async () => ({}),
    executionRunWait: async () => ({}),
    sessionOpen: async () => ({}),
    sessionFork: async () => ({}),
    sessionRollback: async () => ({}),
    sessionSpawnNew: async () => ({}),
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
    // Routing tests exercise the domain ports, not the shared approval owner.
    isActionApprovalRequired: () => false,
    ...overrides,
  });
}

describe('createActionExecutor (prompt library actions)', () => {
  it('creates, inventories, and favourites through real library operations on agent, MCP, CLI and UI surfaces', async () => {
    let stored: PromptLibraryStoredArtifact | null = null;
    const store = { read: async () => stored,
      create: async ({ header, body }: { header: Readonly<Record<string, unknown>>; body: string }) => {
        stored = { id: 'saved', header, body, revision: { headerVersion: 1, bodyVersion: 1 } }; return 'saved';
      },
      update: async ({ header, body }: { header: Readonly<Record<string, unknown>>; body: string }) => { stored = { ...stored!, header, body }; },
      list: async () => ({ items: stored ? [{ id: stored.id, header: stored.header, updatedAtMs: 1 }] : [], coverage: 'complete' as const }),
    };
    const executor = createExecutor({
      promptDocCreate: async ({ signal, ...request }) => createPromptDocInLibrary({ store, request, signal }),
      promptDocFavoriteSet: async ({ signal, ...request }) => setPromptDocFavorite({ store, request, signal }),
      promptsLibraryList: async ({ signal, ...request }) => listPromptLibrary({ store, request, signal }),
    });
    for (const surface of ['agent', 'mcp', 'cli', 'ui'] as const) {
      expect(getActionSpec('prompt_doc.create').surfaces[surface]).toBe(true);
      expect(await executor.execute('prompt_doc.create', { title: 'Saved', markdown: 'Text', favorite: false }, { surface })).toMatchObject({ ok: true, result: { artifactId: 'saved' } });
      expect(await executor.execute('prompt_doc.favorite.set', { artifactId: 'saved', favorite: true }, { surface })).toMatchObject({ ok: true });
      expect(await executor.execute('prompts.library.list', {}, { surface })).toMatchObject({ ok: true, result: { coverage: 'complete', items: [{ artifactId: 'saved', favorite: true }] } });
    }
  });
  it('routes daemon prompt adapter actions through canonical deps with caller cancellation', async () => {
    const signal = new AbortController().signal;
    const daemonPromptAssetsDiscover = vi.fn(async () => ({ ok: true, items: [] }));
    const daemonPromptAssetsDelete = vi.fn(async () => ({ ok: true }));
    const daemonPromptRegistryScanSource = vi.fn(async () => ({ ok: true, items: [] }));
    const daemonPromptRegistryInstall = vi.fn(async () => ({ ok: true, installed: true }));
    const executor = createExecutor({
      daemonPromptAssetsDiscover,
      daemonPromptAssetsDelete,
      daemonPromptRegistryScanSource,
      daemonPromptRegistryInstall,
    });

    await expect(executor.execute('daemon.promptAssets.discover', {
      assetTypeId: 'agents.skill',
      scope: 'user',
    }, { surface: 'rpc', signal })).resolves.toEqual({ ok: true, result: { ok: true, items: [] } });
    await expect(executor.execute('daemon.promptAssets.delete', {
      assetTypeId: 'agents.skill',
      scope: 'user',
      externalRef: { path: 'skills/review' },
    }, { surface: 'rpc', signal })).resolves.toEqual({ ok: true, result: { ok: true } });
    await expect(executor.execute('daemon.promptRegistry.scanSource', {
      sourceId: 'skills_sh:featured',
    }, { surface: 'rpc', signal })).resolves.toEqual({ ok: true, result: { ok: true, items: [] } });
    await expect(executor.execute('daemon.promptRegistry.install', {
      sourceId: 'skills_sh:featured',
      itemId: 'review',
      installTarget: {
        assetTypeId: 'agents.skill',
        scope: 'user',
        targetName: 'review',
      },
    }, { surface: 'rpc', signal })).resolves.toEqual({ ok: true, result: { ok: true, installed: true } });

    expect(daemonPromptAssetsDiscover).toHaveBeenCalledWith({
      request: { assetTypeId: 'agents.skill', scope: 'user' },
      signal,
    });
    expect(daemonPromptAssetsDelete).toHaveBeenCalledWith({
      request: {
        assetTypeId: 'agents.skill',
        scope: 'user',
        externalRef: { path: 'skills/review' },
      },
      signal,
    });
    expect(daemonPromptRegistryScanSource).toHaveBeenCalledWith({
      request: { sourceId: 'skills_sh:featured', configuredSources: [] },
      signal,
    });
    expect(daemonPromptRegistryInstall).toHaveBeenCalledWith({
      request: {
        sourceId: 'skills_sh:featured',
        itemId: 'review',
        configuredSources: [],
        installTarget: {
          assetTypeId: 'agents.skill',
          scope: 'user',
          targetName: 'review',
        },
      },
      signal,
    });
  });

  it('routes prompt_doc.update to deps.promptDocUpdate', async () => {
    const promptDocUpdate = vi.fn(async () => ({ ok: true, artifactId: 'doc-1' }));
    const executor = createExecutor({ promptDocUpdate } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('prompt_doc.update' as any, {
      artifactId: 'doc-1',
      title: 'Review prompt',
      markdown: '# Review',
      tags: ['review'],
    }, { surface: 'ui' });

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
    }, { surface: 'ui' });

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
    }, { surface: 'ui' });

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
      surface: 'ui',
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
    }, { surface: 'ui' });

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
    }, { surface: 'ui' });

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
      surface: 'ui',
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
    }, { surface: 'ui' });

    expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
  });
});
