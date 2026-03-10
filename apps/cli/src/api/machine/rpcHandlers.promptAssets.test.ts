import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PromptAssetDiscoverResponseV1Schema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineRpcHandlers } from './rpcHandlers';

type Handler = (data: unknown) => Promise<any>;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

describe('rpcHandlers (prompt assets)', () => {
  it('registers daemon.promptAssets.* handlers', () => {
    const mgr = createRpcHandlerManager();

    registerMachineRpcHandlers({
      rpcHandlerManager: mgr as any,
      handlers: {
        spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    expect(mgr.handlers.has(RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES)).toBe(true);
    expect(mgr.handlers.has(RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER)).toBe(true);
    expect(mgr.handlers.has(RPC_METHODS.DAEMON_PROMPT_ASSETS_READ)).toBe(true);
    expect(mgr.handlers.has(RPC_METHODS.DAEMON_PROMPT_ASSETS_WRITE)).toBe(true);
    expect(mgr.handlers.has(RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE)).toBe(true);
  });

  it('discovers and reads project Agent skills (.agents)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-home-'));
    try {
      mkdirSync(join(workspace, '.agents', 'skills', 'reviewer'), { recursive: true });
      writeFileSync(join(workspace, '.agents', 'skills', 'reviewer', 'SKILL.md'), '# Reviewer\n', 'utf8');
      writeFileSync(join(workspace, '.agents', 'skills', 'reviewer', 'notes.txt'), 'remember me\n', 'utf8');

      const mgr = createRpcHandlerManager();
      registerMachineRpcHandlers({
        rpcHandlerManager: mgr as any,
        handlers: {
          spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
          stopSession: async () => true,
          requestShutdown: () => {},
        },
        deps: {
          promptAssetsHomedir: () => homeDir,
        },
      });

      const listTypes = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES);
      const discover = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER);
      const read = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_READ);
      if (!listTypes || !discover || !read) throw new Error('expected prompt asset handlers');

      const types = await listTypes({});
      expect(types.ok).toBe(true);
      expect(types.types.map((item: any) => item.id)).toContain('agents.skill');
      expect(types.types.map((item: any) => item.id)).toContain('claude.skill');
      expect(types.types.map((item: any) => item.id)).toContain('claude.command');
      expect(types.types.map((item: any) => item.id)).toContain('gemini.skill');
      expect(types.types.map((item: any) => item.id)).toContain('copilot.skill');
      expect(types.types.map((item: any) => item.id)).toContain('opencode.command');
      expect(types.types.map((item: any) => item.id)).toContain('opencode.skill');

      const discovered = await discover({
        assetTypeId: 'agents.skill',
        scope: 'project',
        directory: workspace,
      });
      expect(() => PromptAssetDiscoverResponseV1Schema.parse(discovered)).not.toThrow();
      expect(discovered.ok).toBe(true);
      expect(discovered.items).toHaveLength(1);
      expect(discovered.items[0]).toMatchObject({
        assetTypeId: 'agents.skill',
        scope: 'project',
        externalRef: { skillName: 'reviewer' },
      });
      expect(discovered.items[0]).not.toHaveProperty('bundleBody');

      const record = await read({
        assetTypeId: 'agents.skill',
        scope: 'project',
        directory: workspace,
        externalRef: { skillName: 'reviewer' },
      });
      expect(record.ok).toBe(true);
      expect(record.item.title).toBe('reviewer');
      expect(record.item.bundleSchemaId).toBe('skills.skill_md_v1');
      expect(record.item.bundleBody.entries.map((entry: any) => entry.path)).toEqual(['SKILL.md', 'notes.txt']);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('discovers and reads project Claude skills', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-home-'));
    try {
      mkdirSync(join(workspace, '.claude', 'skills', 'reviewer'), { recursive: true });
      writeFileSync(join(workspace, '.claude', 'skills', 'reviewer', 'SKILL.md'), '# Claude Reviewer\n', 'utf8');
      writeFileSync(join(workspace, '.claude', 'skills', 'reviewer', 'notes.txt'), 'claude notes\n', 'utf8');

      const mgr = createRpcHandlerManager();
      registerMachineRpcHandlers({
        rpcHandlerManager: mgr as any,
        handlers: {
          spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
          stopSession: async () => true,
          requestShutdown: () => {},
        },
        deps: {
          promptAssetsHomedir: () => homeDir,
        },
      });

      const discover = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER);
      const read = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_READ);
      if (!discover || !read) throw new Error('expected prompt asset handlers');

      const discovered = await discover({
        assetTypeId: 'claude.skill',
        scope: 'project',
        directory: workspace,
      });
      expect(discovered.ok).toBe(true);
      expect(discovered.items).toHaveLength(1);
      expect(discovered.items[0]).toMatchObject({
        assetTypeId: 'claude.skill',
        scope: 'project',
        externalRef: { skillName: 'reviewer' },
      });

      const record = await read({
        assetTypeId: 'claude.skill',
        scope: 'project',
        directory: workspace,
        externalRef: { skillName: 'reviewer' },
      });
      expect(record.ok).toBe(true);
      expect(record.item.title).toBe('reviewer');
      expect(record.item.bundleSchemaId).toBe('skills.skill_md_v1');
      expect(record.item.bundleBody.entries.map((entry: any) => entry.path)).toEqual(['SKILL.md', 'notes.txt']);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('discovers and reads project Claude commands', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-home-'));
    try {
      mkdirSync(join(workspace, '.claude', 'commands', 'review'), { recursive: true });
      writeFileSync(join(workspace, '.claude', 'commands', 'review', 'code.md'), '# Review code\n\nUse $ARGUMENTS\n', 'utf8');

      const mgr = createRpcHandlerManager();
      registerMachineRpcHandlers({
        rpcHandlerManager: mgr as any,
        handlers: {
          spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
          stopSession: async () => true,
          requestShutdown: () => {},
        },
        deps: {
          promptAssetsHomedir: () => homeDir,
        },
      });

      const discover = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER);
      const read = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_READ);
      if (!discover || !read) throw new Error('expected prompt asset handlers');

      const discovered = await discover({
        assetTypeId: 'claude.command',
        scope: 'project',
        directory: workspace,
      });
      expect(() => PromptAssetDiscoverResponseV1Schema.parse(discovered)).not.toThrow();
      expect(discovered.ok).toBe(true);
      expect(discovered.items).toHaveLength(1);
      expect(discovered.items[0]).toMatchObject({
        assetTypeId: 'claude.command',
        scope: 'project',
        externalRef: { relativePath: 'review/code.md' },
        title: 'review/code',
      });
      expect(discovered.items[0]).not.toHaveProperty('markdown');

      const record = await read({
        assetTypeId: 'claude.command',
        scope: 'project',
        directory: workspace,
        externalRef: { relativePath: 'review/code.md' },
      });
      expect(record.ok).toBe(true);
      expect(record.item.libraryKind).toBe('doc');
      expect(record.item.title).toBe('review/code');
      expect(record.item.markdown).toContain('$ARGUMENTS');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('rejects project prompt-asset reads when the workspace directory is relative', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-home-'));
    try {
      const mgr = createRpcHandlerManager();
      registerMachineRpcHandlers({
        rpcHandlerManager: mgr as any,
        handlers: {
          spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
          stopSession: async () => true,
          requestShutdown: () => {},
        },
        deps: {
          promptAssetsHomedir: () => homeDir,
        },
      });

      const read = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_READ);
      if (!read) throw new Error('expected prompt asset read handler');

      const result = await read({
        assetTypeId: 'claude.command',
        scope: 'project',
        directory: 'relative-workspace',
        externalRef: { relativePath: 'review/code.md' },
      });

      expect(result).toEqual({
        ok: false,
        errorCode: 'invalid_request',
        error: 'directory must be an absolute path for project-scoped prompt assets',
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('skips symlinked markdown files during discovery and rejects direct reads through them', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-home-'));
    const outsideFile = join(workspace, 'outside.md');
    try {
      mkdirSync(join(workspace, '.claude', 'commands', 'review'), { recursive: true });
      writeFileSync(outsideFile, '# Outside\n', 'utf8');
      symlinkSync(outsideFile, join(workspace, '.claude', 'commands', 'review', 'code.md'));

      const mgr = createRpcHandlerManager();
      registerMachineRpcHandlers({
        rpcHandlerManager: mgr as any,
        handlers: {
          spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
          stopSession: async () => true,
          requestShutdown: () => {},
        },
        deps: {
          promptAssetsHomedir: () => homeDir,
        },
      });

      const discover = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER);
      const read = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_READ);
      if (!discover || !read) throw new Error('expected prompt asset handlers');

      const discovered = await discover({
        assetTypeId: 'claude.command',
        scope: 'project',
        directory: workspace,
      });
      expect(discovered).toEqual({ ok: true, items: [] });

      const result = await read({
        assetTypeId: 'claude.command',
        scope: 'project',
        directory: workspace,
        externalRef: { relativePath: 'review/code.md' },
      });

      expect(result).toEqual({
        ok: false,
        errorCode: 'access_denied',
        error: 'prompt asset path resolves through a symlink',
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('rejects Windows-style absolute markdown target paths for doc writes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-home-'));
    try {
      const mgr = createRpcHandlerManager();
      registerMachineRpcHandlers({
        rpcHandlerManager: mgr as any,
        handlers: {
          spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
          stopSession: async () => true,
          requestShutdown: () => {},
        },
        deps: {
          promptAssetsHomedir: () => homeDir,
        },
      });

      const write = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_WRITE);
      if (!write) throw new Error('expected prompt asset write handler');

      const result = await write({
        assetTypeId: 'claude.command',
        scope: 'project',
        directory: workspace,
        externalRef: null,
        targetPath: 'C:\\\\escape.md',
        title: 'Escape',
        markdown: '# Escape',
        previewOnly: false,
      });

      expect(result).toEqual({
        ok: false,
        errorCode: 'invalid_request',
        error: 'targetPath must be a relative markdown path',
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('discovers and reads project OpenCode commands', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-home-'));
    try {
      mkdirSync(join(workspace, '.opencode', 'commands', 'review'), { recursive: true });
      writeFileSync(join(workspace, '.opencode', 'commands', 'review', 'code.md'), '# OpenCode review\n\nUse {input}\n', 'utf8');

      const mgr = createRpcHandlerManager();
      registerMachineRpcHandlers({
        rpcHandlerManager: mgr as any,
        handlers: {
          spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
          stopSession: async () => true,
          requestShutdown: () => {},
        },
        deps: {
          promptAssetsHomedir: () => homeDir,
        },
      });

      const discover = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER);
      const read = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_READ);
      if (!discover || !read) throw new Error('expected prompt asset handlers');

      const discovered = await discover({
        assetTypeId: 'opencode.command',
        scope: 'project',
        directory: workspace,
      });
      expect(() => PromptAssetDiscoverResponseV1Schema.parse(discovered)).not.toThrow();
      expect(discovered.ok).toBe(true);
      expect(discovered.items).toHaveLength(1);
      expect(discovered.items[0]).toMatchObject({
        assetTypeId: 'opencode.command',
        scope: 'project',
        externalRef: { relativePath: 'review/code.md' },
        title: 'review/code',
      });
      expect(discovered.items[0]).not.toHaveProperty('markdown');

      const record = await read({
        assetTypeId: 'opencode.command',
        scope: 'project',
        directory: workspace,
        externalRef: { relativePath: 'review/code.md' },
      });
      expect(record.ok).toBe(true);
      expect(record.item.libraryKind).toBe('doc');
      expect(record.item.title).toBe('review/code');
      expect(record.item.markdown).toContain('{input}');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('writes, previews, rejects digest conflicts, and deletes user Agent skills (.agents) using the current digest', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-home-'));
    try {
      const mgr = createRpcHandlerManager();
      registerMachineRpcHandlers({
        rpcHandlerManager: mgr as any,
        handlers: {
          spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
          stopSession: async () => true,
          requestShutdown: () => {},
        },
        deps: {
          promptAssetsHomedir: () => homeDir,
        },
      });

      const write = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_WRITE);
      const read = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_READ);
      const remove = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE);
      if (!write || !read || !remove) throw new Error('expected prompt asset handlers');

      const bundleBody = {
        v: 1,
        entries: [
          { path: 'SKILL.md', contentBase64: Buffer.from('# User skill\n', 'utf8').toString('base64'), contentKind: 'utf8' },
          { path: 'notes.txt', contentBase64: Buffer.from('remember me\n', 'utf8').toString('base64'), contentKind: 'utf8' },
        ],
        createdAtMs: 1,
        updatedAtMs: 2,
      };

      const preview = await write({
        assetTypeId: 'agents.skill',
        scope: 'user',
        directory: workspace,
        targetName: 'writer',
        title: 'Writer',
        bundleSchemaId: 'skills.skill_md_v1',
        bundleBody,
        previewOnly: true,
        expectedDigest: null,
      });
      expect(preview.ok).toBe(true);
      expect(preview.preview).toMatchObject({ operation: 'write' });

      const firstWrite = await write({
        assetTypeId: 'agents.skill',
        scope: 'user',
        directory: workspace,
        targetName: 'writer',
        title: 'Writer',
        bundleSchemaId: 'skills.skill_md_v1',
        bundleBody,
        previewOnly: false,
        expectedDigest: null,
      });
      expect(firstWrite.ok).toBe(true);

      const skillDir = join(homeDir, '.agents', 'skills', 'writer');
      expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toBe('# User skill\n');

      writeFileSync(join(skillDir, 'SKILL.md'), '# Changed on disk\n', 'utf8');

      const conflict = await write({
        assetTypeId: 'agents.skill',
        scope: 'user',
        directory: workspace,
        targetName: 'writer',
        title: 'Writer',
        bundleSchemaId: 'skills.skill_md_v1',
        bundleBody,
        previewOnly: false,
        expectedDigest: firstWrite.digest,
      });
      expect(conflict).toMatchObject({ ok: false, errorCode: 'conflict' });
      expect(conflict.currentDigest).toBeTruthy();

      const current = await read({
        assetTypeId: 'agents.skill',
        scope: 'user',
        directory: workspace,
        externalRef: { skillName: 'writer' },
      });
      expect(current.ok).toBe(true);

      const deleted = await remove({
        assetTypeId: 'agents.skill',
        scope: 'user',
        directory: workspace,
        externalRef: { skillName: 'writer' },
        previewOnly: false,
        expectedDigest: current.item.digest,
      });
      expect(deleted.ok).toBe(true);
      expect(() => readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toThrow();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('writes, previews, rejects digest conflicts, and deletes project Claude commands', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-home-'));
    try {
      const mgr = createRpcHandlerManager();
      registerMachineRpcHandlers({
        rpcHandlerManager: mgr as any,
        handlers: {
          spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
          stopSession: async () => true,
          requestShutdown: () => {},
        },
        deps: {
          promptAssetsHomedir: () => homeDir,
        },
      });

      const write = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_WRITE);
      const read = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_READ);
      const remove = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE);
      if (!write || !read || !remove) throw new Error('expected prompt asset handlers');

      const preview = await write({
        assetTypeId: 'claude.command',
        scope: 'project',
        directory: workspace,
        externalRef: null,
        targetPath: 'review/code.md',
        title: 'review/code',
        markdown: '# Review code\n\nUse $ARGUMENTS\n',
        previewOnly: true,
        expectedDigest: null,
      });
      expect(preview.ok).toBe(true);
      expect(preview.preview).toMatchObject({ operation: 'write' });

      const firstWrite = await write({
        assetTypeId: 'claude.command',
        scope: 'project',
        directory: workspace,
        externalRef: null,
        targetPath: 'review/code.md',
        title: 'review/code',
        markdown: '# Review code\n\nUse $ARGUMENTS\n',
        previewOnly: false,
        expectedDigest: null,
      });
      expect(firstWrite.ok).toBe(true);

      const commandPath = join(workspace, '.claude', 'commands', 'review', 'code.md');
      expect(readFileSync(commandPath, 'utf8')).toBe('# Review code\n\nUse $ARGUMENTS\n');

      writeFileSync(commandPath, '# Changed on disk\n', 'utf8');

      const conflict = await write({
        assetTypeId: 'claude.command',
        scope: 'project',
        directory: workspace,
        externalRef: { relativePath: 'review/code.md' },
        targetPath: 'review/code.md',
        title: 'review/code',
        markdown: '# Review code\n\nUse $ARGUMENTS\n',
        previewOnly: false,
        expectedDigest: firstWrite.digest,
      });
      expect(conflict).toMatchObject({ ok: false, errorCode: 'conflict' });
      expect(conflict.currentDigest).toBeTruthy();

      const current = await read({
        assetTypeId: 'claude.command',
        scope: 'project',
        directory: workspace,
        externalRef: { relativePath: 'review/code.md' },
      });
      expect(current.ok).toBe(true);

      const deleted = await remove({
        assetTypeId: 'claude.command',
        scope: 'project',
        directory: workspace,
        externalRef: { relativePath: 'review/code.md' },
        previewOnly: false,
        expectedDigest: current.item.digest,
      });
      expect(deleted.ok).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
