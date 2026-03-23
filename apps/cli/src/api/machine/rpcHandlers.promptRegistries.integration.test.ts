import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  createTransferRecipientKeyPair,
  decryptEncryptedTransferChunkEnvelope,
} from '@/machines/transfer/transferChunkEncryption';

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

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Happier Bot',
      GIT_AUTHOR_EMAIL: 'bot@example.com',
      GIT_COMMITTER_NAME: 'Happier Bot',
      GIT_COMMITTER_EMAIL: 'bot@example.com',
    },
  }).trim();
}

describe('rpcHandlers (prompt registries)', () => {
  it('lists configured git sources, scans them, and fetches skill bundles from a local git repo', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'happier-prompt-registry-repo-'));
    const workspace = mkdtempSync(join(tmpdir(), 'happier-prompt-registry-workspace-'));
    const happierHomeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-registry-happier-home-'));
    try {
      mkdirSync(join(repo, 'reviewer'), { recursive: true });
      writeFileSync(join(repo, 'reviewer', 'SKILL.md'), '# Reviewer\n', 'utf8');
      writeFileSync(join(repo, 'reviewer', 'notes.txt'), 'remember me\n', 'utf8');
      git(repo, ['init', '-b', 'main']);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-m', 'init']);

      const mgr = createRpcHandlerManager();
      registerMachineRpcHandlers({
        rpcHandlerManager: mgr as any,
        handlers: {
          spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
          stopSession: async () => true,
          requestShutdown: () => {},
        },
        deps: {
          promptAssetsHappierHomeDir: () => happierHomeDir,
        },
      });

      const listAdapters = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_ADAPTERS);
      const listSources = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_SOURCES);
      const scanSource = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_REGISTRY_SCAN_SOURCE);
      const downloadInit = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT);
      const downloadChunk = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_CHUNK);
      const downloadFinalize = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_FINALIZE);
      const installItem = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_REGISTRY_INSTALL);
      if (!listAdapters || !listSources || !scanSource || !downloadInit || !downloadChunk || !downloadFinalize || !installItem) {
        throw new Error('expected prompt registry handlers');
      }
      expect(mgr.handlers.has('daemon.promptRegistry.fetchItem')).toBe(false);

      const adapters = await listAdapters({});
      expect(adapters.ok).toBe(true);
      expect(adapters.adapters.map((adapter: any) => adapter.id)).toContain('git');
      expect(adapters.adapters.map((adapter: any) => adapter.id)).toContain('skills_sh');
      expect(adapters.adapters.map((adapter: any) => adapter.id)).toContain('claude_marketplace');

      const configuredSources = [{
        id: 'local-skills',
        adapterId: 'git',
        title: 'Local skills',
        enabled: true,
        config: {
          repositoryUrl: repo,
        },
      }];

      const sources = await listSources({
        configuredSources,
      });
      expect(sources.ok).toBe(true);
      expect(sources.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'git:local-skills',
          adapterId: 'git',
          title: 'Local skills',
          origin: 'user',
        }),
      ]));

      const scan = await scanSource({
        sourceId: 'git:local-skills',
        configuredSources,
      });
      expect(scan.ok).toBe(true);
      expect(scan.items).toEqual([
        expect.objectContaining({
          sourceId: 'git:local-skills',
          title: 'reviewer',
          bundleSchemaId: 'skills.skill_md_v1',
        }),
      ]);

      const startedDownload = await downloadInit({
        sourceId: 'git:local-skills',
        itemId: scan.items[0]?.itemId,
        configuredSources,
        recipientPublicKeyBase64: createTransferRecipientKeyPair().recipientPublicKeyBase64,
      });
      expect(startedDownload).toMatchObject({
        success: true,
        name: 'reviewer.prompt-registry-item.json',
      });
      const recipientKeyPair = createTransferRecipientKeyPair();
      const restartedDownload = await downloadInit({
        sourceId: 'git:local-skills',
        itemId: scan.items[0]?.itemId,
        configuredSources,
        recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
      });
      expect(restartedDownload).toMatchObject({
        success: true,
        name: 'reviewer.prompt-registry-item.json',
      });

      const downloadedChunk = await downloadChunk({
        downloadId: (restartedDownload as { downloadId: string }).downloadId,
        index: 0,
      });
      expect(downloadedChunk).toMatchObject({
        success: true,
        isLast: true,
      });

      const downloadedPayload = JSON.parse(
        decryptEncryptedTransferChunkEnvelope({
          transferId: (restartedDownload as { downloadId: string }).downloadId,
          sequence: 0,
          payloadBase64: (downloadedChunk as { payloadBase64: string }).payloadBase64,
          encryptedDataKeyEnvelopeBase64: (downloadedChunk as { encryptedDataKeyEnvelopeBase64: string }).encryptedDataKeyEnvelopeBase64,
          recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
        }).toString('utf8'),
      );
      expect(downloadedPayload).toMatchObject({
        sourceId: 'git:local-skills',
        itemId: scan.items[0]?.itemId,
        title: 'reviewer',
        bundleSchemaId: 'skills.skill_md_v1',
      });
      expect(downloadedPayload.bundleBody.entries.map((entry: { path: string }) => entry.path)).toEqual(['SKILL.md', 'notes.txt']);

      await expect(downloadFinalize({
        downloadId: (restartedDownload as { downloadId: string }).downloadId,
      })).resolves.toEqual({ success: true });

      const installed = await installItem({
        sourceId: 'git:local-skills',
        itemId: scan.items[0]?.itemId,
        configuredSources,
        installTarget: {
          assetTypeId: 'agents.skill',
          scope: 'project',
          directory: repo,
          targetName: 'reviewer-installed',
        },
      });
      expect(installed).toMatchObject({
        ok: true,
        externalRef: { skillName: 'reviewer-installed' },
      });
      expect(readFileSync(join(repo, '.agents', 'skills', 'reviewer-installed', 'SKILL.md'), 'utf8')).toBe('# Reviewer\n');
      expect(readFileSync(join(repo, '.agents', 'skills', 'reviewer-installed', 'notes.txt'), 'utf8')).toBe('remember me\n');

      const installedSymlink = await installItem({
        sourceId: 'git:local-skills',
        itemId: scan.items[0]?.itemId,
        configuredSources,
        installTarget: {
          assetTypeId: 'agents.skill',
          scope: 'project',
          directory: repo,
          targetName: 'reviewer-linked',
          installMode: 'symlink',
        },
      });
      expect(installedSymlink).toMatchObject({
        ok: true,
        externalRef: { skillName: 'reviewer-linked' },
      });
      const symlinkSkillDir = join(repo, '.agents', 'skills', 'reviewer-linked');
      expect(lstatSync(symlinkSkillDir).isSymbolicLink()).toBe(true);
      expect(realpathSync(symlinkSkillDir).startsWith(realpathSync(happierHomeDir))).toBe(true);
      expect(readFileSync(join(symlinkSkillDir, 'SKILL.md'), 'utf8')).toBe('# Reviewer\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
      rmSync(happierHomeDir, { recursive: true, force: true });
    }
  });

  it('returns an invalid_request error when a configured git source subdirectory escapes the cloned repository', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'happier-prompt-registry-escape-'));
    try {
      mkdirSync(join(repo, 'reviewer'), { recursive: true });
      writeFileSync(join(repo, 'reviewer', 'SKILL.md'), '# Reviewer\n', 'utf8');
      git(repo, ['init', '-b', 'main']);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-m', 'init']);

      const mgr = createRpcHandlerManager();
      registerMachineRpcHandlers({
        rpcHandlerManager: mgr as any,
        handlers: {
          spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
          stopSession: async () => true,
          requestShutdown: () => {},
        },
      });

      const scanSource = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_REGISTRY_SCAN_SOURCE);
      if (!scanSource) throw new Error('expected prompt registry scan handler');

      const configuredSources = [{
        id: 'escaped-subdir',
        adapterId: 'git',
        title: 'Escaped subdir',
        enabled: true,
        config: {
          repositoryUrl: repo,
          subdirectory: '../outside',
        },
      }];

      await expect(scanSource({
        sourceId: 'git:escaped-subdir',
        configuredSources,
      })).resolves.toEqual({
        ok: false,
        errorCode: 'invalid_request',
        error: 'registry subdirectory must stay within the cloned repository',
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
