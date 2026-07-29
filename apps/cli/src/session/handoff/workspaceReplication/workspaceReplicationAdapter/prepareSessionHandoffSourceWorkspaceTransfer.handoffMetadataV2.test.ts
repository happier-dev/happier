import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SessionHandoffWorkspaceTransfer } from '@happier-dev/protocol';

import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ScmBackendRegistry } from '@/scm/registry';
import { resolveDefaultScmBackendRegistry } from '@/scm/scmBackendCatalog';
import { prepareSessionHandoffSourceWorkspaceTransfer } from './adapter';

const execFile = promisify(execFileCallback);
let runtimeRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
let scmRegistry: ScmBackendRegistry;

beforeAll(async () => {
  runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
    pluginIds: ['happier.scm.backend.git'],
  });
  scmRegistry = await resolveDefaultScmBackendRegistry({
    pluginRuntimeRegistry: runtimeRegistry,
  });
});

afterAll(async () => {
  await runtimeRegistry?.dispose();
});

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFile('git', [...args], { cwd });
}

async function configureGitRepo(cwd: string): Promise<void> {
  await runGit(cwd, ['config', 'user.email', 'test@example.com']);
  await runGit(cwd, ['config', 'user.name', 'Happier Test']);
}

describe('prepareSessionHandoffSourceWorkspaceTransfer (handoffMetadataV2)', () => {
  it('includes sourceRootPath + manifest transfer publication when workspace transfer is enabled (server_routed_stream)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-source-transfer-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-handoff-source-root-'));
    try {
      await mkdir(join(sourceRootPath, 'nested'), { recursive: true });
      await writeFile(join(sourceRootPath, 'README.md'), 'hello\n');
      await writeFile(join(sourceRootPath, 'nested', 'note.txt'), 'note\n');

      const workspaceTransfer: SessionHandoffWorkspaceTransfer = {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      };

      const result = await prepareSessionHandoffSourceWorkspaceTransfer({
        handoffId: 'handoff_1',
        activeServerDir,
        negotiatedTransportStrategy: 'server_routed_stream',
        workspaceTransfer,
        scmRegistry,
        sourceRootPath,
      });

      expect(result.handoffMetadataV2?.workspaceReplicationSourceRootPath).toBe(sourceRootPath);
      expect(result.handoffMetadataV2?.workspaceReplicationManifestTransferPublication?.transferId).toEqual(expect.any(String));
      expect(result.handoffMetadataV2?.workspaceReplicationManifestTransferPublication?.endpointCandidates).toBeUndefined();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('keeps workspace integration metadata internal so prepareStartedState owns the protocol wire key', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-source-transfer-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-handoff-source-root-'));
    try {
      await runGit(sourceRootPath, ['init']);
      await configureGitRepo(sourceRootPath);
      await runGit(sourceRootPath, ['branch', '-M', 'main']);
      await writeFile(join(sourceRootPath, 'README.md'), 'hello\n');
      await runGit(sourceRootPath, ['add', 'README.md']);
      await runGit(sourceRootPath, ['commit', '-m', 'initial']);

      const workspaceTransfer: SessionHandoffWorkspaceTransfer = {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      };

      const result = await prepareSessionHandoffSourceWorkspaceTransfer({
        handoffId: 'handoff_1',
        activeServerDir,
        negotiatedTransportStrategy: 'server_routed_stream',
        workspaceTransfer,
        scmRegistry,
        sourceRootPath,
      });

      expect(result.workspaceReplicationMetadata?.workspaceIntegrationMetadata).toEqual(expect.any(Object));
      expect(result.handoffMetadataV2).not.toHaveProperty('workspaceReplicationSourceControllerMetadata');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(sourceRootPath, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('includes referenced ignored session media paths from transcript metadata in workspace replication', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-source-transfer-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-handoff-source-root-'));
    try {
      await mkdir(join(sourceRootPath, '.happier', 'uploads', 'generated', 'session-1', 'message-1'), { recursive: true });
      await mkdir(join(sourceRootPath, '.happier', 'uploads', 'generated', 'session-1', 'message-2'), { recursive: true });
      await writeFile(join(sourceRootPath, '.gitignore'), '.happier/uploads/**\n');
      await writeFile(join(sourceRootPath, 'README.md'), 'hello\n');
      await writeFile(
        join(sourceRootPath, '.happier', 'uploads', 'generated', 'session-1', 'message-1', 'image[1].png'),
        'referenced\n',
      );
      await writeFile(
        join(sourceRootPath, '.happier', 'uploads', 'generated', 'session-1', 'message-2', 'unrelated.png'),
        'unrelated\n',
      );
      await runGit(sourceRootPath, ['init']);
      await configureGitRepo(sourceRootPath);
      await runGit(sourceRootPath, ['add', 'README.md', '.gitignore']);
      await runGit(sourceRootPath, ['commit', '-m', 'initial']);

      const workspaceTransfer: SessionHandoffWorkspaceTransfer = {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      };

      const result = await prepareSessionHandoffSourceWorkspaceTransfer({
        handoffId: 'handoff_1',
        activeServerDir,
        negotiatedTransportStrategy: 'server_routed_stream',
        workspaceTransfer,
        scmRegistry,
        sourceRootPath,
        sessionTranscriptRecords: [
          {
            meta: {
              happierMedia: {
                kind: 'session_media.v1',
                payload: {
                  media: [
                    {
                      id: 'media-1',
                      role: 'output',
                      category: 'generated',
                      mediaKind: 'image',
                      mimeType: 'image/png',
                      name: 'image.png',
                      path: '.happier/uploads/generated/session-1/message-1/image[1].png',
                      sizeBytes: 11,
                      origin: { source: 'provider-generated' },
                    },
                  ],
                },
              },
            },
          },
        ],
      } as Parameters<typeof prepareSessionHandoffSourceWorkspaceTransfer>[0] & {
        sessionTranscriptRecords: readonly unknown[];
      });

      const manifestPaths = result.workspaceReplicationMetadata?.manifest.entries.map((entry) => entry.relativePath) ?? [];
      expect(manifestPaths).toContain('.happier/uploads/generated/session-1/message-1/image[1].png');
      expect(manifestPaths).not.toContain('.happier/uploads/generated/session-1/message-2/unrelated.png');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(sourceRootPath, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('includes endpoint candidates in the manifest transfer publication when negotiated transport is direct_peer', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-source-transfer-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-handoff-source-root-'));
    try {
      await mkdir(join(sourceRootPath, 'nested'), { recursive: true });
      await writeFile(join(sourceRootPath, 'README.md'), 'hello\n');
      await writeFile(join(sourceRootPath, 'nested', 'note.txt'), 'note\n');

      const workspaceTransfer: SessionHandoffWorkspaceTransfer = {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      };

      const result = await prepareSessionHandoffSourceWorkspaceTransfer({
        handoffId: 'handoff_1',
        activeServerDir,
        negotiatedTransportStrategy: 'direct_peer',
        workspaceTransfer,
        scmRegistry,
        sourceRootPath,
        agentBundleTransferPublication: {
          transferId: 'provider_bundle_1',
          sizeBytes: 123,
          manifestHash: 'sha256:provider_bundle_1',
          endpointCandidates: [
            {
              kind: 'http',
              url: 'http://127.0.0.1:46001/machine-transfers/direct/provider_bundle_1?token=aaa#ignored',
              authorizationToken: 'token_1',
              expiresAt: Date.now() + 60_000,
            },
          ],
        },
      });

      const manifestTransferId = result.handoffMetadataV2?.workspaceReplicationManifestTransferPublication?.transferId;
      expect(manifestTransferId).toEqual(expect.any(String));
      const expectedEncodedKey = Buffer.from(String(manifestTransferId), 'utf8').toString('base64url');

      expect(result.handoffMetadataV2?.workspaceReplicationManifestTransferPublication).toEqual({
        transferId: expect.any(String),
        endpointCandidates: [
          {
            kind: 'http',
            url: `http://127.0.0.1:46001/machine-transfers/direct/${expectedEncodedKey}`,
            authorizationToken: 'token_1',
            expiresAt: expect.any(Number),
          },
        ],
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when the workspace transfer source root is missing', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-source-transfer-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-handoff-source-root-missing-'));
    try {
      await rm(sourceRootPath, { recursive: true, force: true });

      const workspaceTransfer: SessionHandoffWorkspaceTransfer = {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      };

      await expect(prepareSessionHandoffSourceWorkspaceTransfer({
        handoffId: 'handoff_1',
        activeServerDir,
        negotiatedTransportStrategy: 'server_routed_stream',
        workspaceTransfer,
        scmRegistry,
        sourceRootPath,
      })).rejects.toMatchObject({
        code: 'source_path_unreadable',
        sourcePath: sourceRootPath,
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('returns no handoffMetadataV2 when workspace transfer is disabled', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-source-transfer-'));
    try {
      const result = await prepareSessionHandoffSourceWorkspaceTransfer({
        handoffId: 'handoff_1',
        activeServerDir,
        negotiatedTransportStrategy: 'server_routed_stream',
        workspaceTransfer: {
          enabled: false,
          strategy: 'transfer_snapshot',
          conflictPolicy: 'create_sibling_copy',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
        scmRegistry,
        sourceRootPath: '/source',
      });

      expect(result.handoffMetadataV2).toBeUndefined();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
