import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { importCodexSessionBundle } from '../../../backends/codex/handoff/importCodexSessionBundle';
import { readSessionHandoffProviderBundleFile } from '../sessionHandoffProviderBundleFile';
import { readWorkspaceReplicationManifestFromFile } from '../workspaceReplicationAdapter/workspaceReplicationManifestFile';
import { createSessionHandoffSourceExportStore } from './sessionHandoffSourceExportStore';

describe('sessionHandoffSourceExportStore', () => {
  it('saves and loads a schema-versioned source export record', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-store-'));
    try {
      const store = createSessionHandoffSourceExportStore({ activeServerDir });
      await store.save({
        handoffId: 'handoff-123',
        exportedAtMs: 1234,
        workspaceSourceRootPath: '/repo',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        providerBundle: {
          transferId: 'session-handoff:handoff-123:provider-bundle-file',
          filePath: join(activeServerDir, 'dummy-provider.json'),
          sizeBytes: 2,
          manifestHash: `sha256:${'a'.repeat(64)}`,
        },
        workspaceManifest: {
          transferId: 'session-handoff:handoff-123:workspace-manifest',
          filePath: join(activeServerDir, 'dummy-manifest.txt'),
          sizeBytes: 3,
          manifestHash: `sha256:${'b'.repeat(64)}`,
          entriesCount: 1,
          fileDigestsCount: 1,
        },
      });

      const loaded = await store.load('handoff-123');
      expect(loaded).toEqual(
        expect.objectContaining({
          handoffId: 'handoff-123',
          exportedAtMs: 1234,
          workspaceSourceRootPath: '/repo',
          sourceMachineId: 'machine_source',
          targetMachineId: 'machine_target',
        }),
      );
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('writes provider bundle and workspace manifest files under the handoff directory', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-store-files-'));
    try {
      const store = createSessionHandoffSourceExportStore({ activeServerDir });
      const handoffId = 'handoff-files-1';

      const provider = await store.writeProviderBundleFile({
        handoffId,
        providerBundle: {
          providerId: 'codex',
          remoteSessionId: 'remote-session-1',
          files: [],
        },
      });
      const providerStats = await stat(provider.filePath);
      expect(providerStats.isFile()).toBe(true);
      expect(provider.sizeBytes).toBe(providerStats.size);
      expect(provider.manifestHash.startsWith('sha256:')).toBe(true);
      const parsedProvider = await readSessionHandoffProviderBundleFile(provider.filePath);
      expect(parsedProvider).toMatchObject({ providerId: 'codex' });

      const manifest = await store.writeWorkspaceReplicationManifestFile({
        handoffId,
        manifest: {
          entries: [
            {
              kind: 'file',
              relativePath: 'README.md',
              digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
              sizeBytes: 1,
              executable: false,
            },
          ],
        },
      });
      expect(manifest.filePath).toContain(join('session-handoff', handoffId));
      const parsed = await readWorkspaceReplicationManifestFromFile({
        transferId: manifest.transferId,
        filePath: manifest.filePath,
        sizeBytes: manifest.sizeBytes,
      });
      expect(parsed.entries).toHaveLength(1);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('writes provider file contents as a binary streamed artifact instead of base64 JSON', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-store-binary-'));
    const sourceCodexHome = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-source-codex-'));
    const targetCodexHome = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-target-codex-'));
    try {
      const relativePath = 'sessions/2026/03/08/rollout-thread-large.jsonl';
      const sourcePath = join(sourceCodexHome, relativePath);
      await mkdir(join(sourceCodexHome, 'sessions/2026/03/08'), { recursive: true });
      const content = Buffer.alloc(5 * 1024 * 1024, 'handoff-binary-safe\n');
      await writeFile(sourcePath, content);

      const store = createSessionHandoffSourceExportStore({ activeServerDir });
      const persisted = await store.writeProviderBundleFile({
        handoffId: 'handoff-binary-1',
        providerBundle: {
          providerId: 'codex',
          remoteSessionId: 'thread-large',
          files: [{
            relativePath,
            contentFile: {
              t: 'happier.handoff.file.v1',
              filePath: sourcePath,
              offsetBytes: 0,
              sizeBytes: content.length,
            },
          }],
        },
      });

      expect(persisted.sizeBytes).toBeGreaterThan(content.length);
      expect(persisted.sizeBytes).toBeLessThan(content.length + 64 * 1024);
      const prefix = (await readFile(persisted.filePath)).subarray(0, 48).toString('utf8');
      expect(prefix).toMatch(/^HAPPIER_SESSION_HANDOFF_BUNDLE_V2\n/u);
      const artifact = await readFile(persisted.filePath);
      const magicBytes = Buffer.byteLength('HAPPIER_SESSION_HANDOFF_BUNDLE_V2\n', 'utf8');
      const manifestBytes = Number(artifact.readBigUInt64BE(magicBytes));
      const manifest = JSON.parse(
        artifact.subarray(magicBytes + 8, magicBytes + 8 + manifestBytes).toString('utf8'),
      ) as { t?: unknown; bundle?: unknown };
      expect(manifest.t).toBe('session_handoff_bundle_artifact_v1');
      expect(manifest.bundle).toMatchObject({ providerId: 'codex' });

      const importedBundle = await readSessionHandoffProviderBundleFile(persisted.filePath);
      await importCodexSessionBundle({
        bundle: importedBundle.providerId === 'codex' ? importedBundle : (() => { throw new Error('expected codex'); })(),
        targetPath: '/repo',
        env: { CODEX_HOME: targetCodexHome },
      });
      await expect(readFile(join(targetCodexHome, relativePath))).resolves.toEqual(content);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(sourceCodexHome, { recursive: true, force: true });
      await rm(targetCodexHome, { recursive: true, force: true });
    }
  });

  it('fails closed on invalid handoff ids that can escape the activeServerDir', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-store-safe-'));
    try {
      const store = createSessionHandoffSourceExportStore({ activeServerDir });
      await expect(store.load('../evil')).rejects.toThrow(/Invalid handoffId/);
      await expect(store.save({
        handoffId: '../evil',
        exportedAtMs: 1,
      })).rejects.toThrow(/Invalid handoffId/);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails closed when persisted file paths escape the activeServerDir', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-store-escape-'));
    try {
      const store = createSessionHandoffSourceExportStore({ activeServerDir });
      const handoffId = 'handoff-escape-1';
      const handoffDir = join(activeServerDir, 'session-handoff', handoffId);
      await mkdir(handoffDir, { recursive: true });

      await writeFile(join(handoffDir, 'source-export.json'), JSON.stringify({
        t: 'session_handoff_source_export_v1',
        schemaVersion: 1,
        handoffId,
        exportedAtMs: 1,
        providerBundle: {
          transferId: 'session-handoff:handoff-escape-1:provider-bundle-file',
          filePath: '../../outside-provider.json',
          sizeBytes: 1,
          manifestHash: `sha256:${'a'.repeat(64)}`,
        },
        workspaceManifest: {
          transferId: 'session-handoff:handoff-escape-1:workspace-manifest',
          filePath: '/etc/passwd',
          sizeBytes: 1,
          manifestHash: `sha256:${'b'.repeat(64)}`,
          entriesCount: 0,
          fileDigestsCount: 0,
        },
      }, null, 2) + '\n', 'utf8');

      await expect(store.load(handoffId)).rejects.toThrow('Invalid session handoff source export record');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
