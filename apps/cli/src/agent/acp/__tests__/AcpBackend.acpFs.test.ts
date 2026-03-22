import { describe, expect, it, afterEach } from 'vitest';

import { writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { buildInitializeRequest, createAcpClientFsMethods } from '../AcpBackend';
import type { AcpPermissionHandler } from '../AcpBackend';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const envScope = createEnvKeyScope(['HAPPIER_ACP_FS']);

describe('AcpBackend ACP FS capability experiment', () => {
  afterEach(() => {
    envScope.restore();
  });

  it('exposes buildInitializeRequest to allow ACP capabilities to be unit-tested', () => {
    expect(typeof buildInitializeRequest).toBe('function');
  });

  it('advertises fs.readTextFile/fs.writeTextFile when HAPPIER_ACP_FS is enabled', () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    const req = buildInitializeRequest({ clientName: 'test', clientVersion: '0.0.0' });
    expect(req.clientCapabilities?.fs?.readTextFile).toBe(true);
    expect(req.clientCapabilities?.fs?.writeTextFile).toBe(true);
  });

  it('advertises ACP fs capabilities by default', () => {
    envScope.patch({ HAPPIER_ACP_FS: undefined });

    const req = buildInitializeRequest({ clientName: 'test', clientVersion: '0.0.0' });
    expect(req.clientCapabilities?.fs?.readTextFile).toBe(true);
    expect(req.clientCapabilities?.fs?.writeTextFile).toBe(true);
  });

  it('writeTextFile is permission-gated when ACP fs is enabled', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-', async (workspace) => {
      const targetPath = join(workspace, 'a.txt');
      const clientFs = createAcpClientFsMethods({
        cwd: workspace,
        permissionHandler: {
          async handleToolCall() {
            return { decision: 'denied' };
          },
        } satisfies AcpPermissionHandler,
      });

      await expect(
        clientFs.writeTextFile!({ sessionId: 's', path: targetPath, content: 'hi' })
      ).rejects.toThrow(/denied/i);

      expect(existsSync(targetPath)).toBe(false);
    });
  });

  it('readTextFile reads file content when ACP fs is enabled', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-', async (workspace) => {
      const targetPath = join(workspace, 'b.txt');
      writeFileSync(targetPath, 'line1\nline2\nline3\n', 'utf8');
      const clientFs = createAcpClientFsMethods({ cwd: workspace });

      const res = await clientFs.readTextFile!({ sessionId: 's', path: targetPath, line: 2, limit: 1 });
      expect(res.content).toBe('line2');
      expect(readFileSync(targetPath, 'utf8')).toContain('line3');
    });
  });

  it('does not treat missing files under a symlinked cwd as path traversal (reports ENOENT instead)', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-root-', async (root) => {
      const workspaceReal = join(root, 'workspace-real');
      const workspaceLink = join(root, 'workspace-link');
      mkdirSync(workspaceReal, { recursive: true });
      symlinkSync(workspaceReal, workspaceLink);

      const clientFs = createAcpClientFsMethods({ cwd: workspaceLink });
      const missing = join(workspaceLink, 'missing.txt');

      await expect(clientFs.readTextFile!({ sessionId: 's', path: missing })).rejects.toThrow(/ENOENT/i);
    });
  });

  it('readTextFile rejects paths that escape cwd', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-root-', async (root) => {
      const workspace = join(root, 'workspace');
      const outside = join(root, 'outside');
      const outsideFile = join(outside, 'outside.txt');
      // Prepare test files.
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(outsideFile, 'nope', 'utf8');

      const clientFs = createAcpClientFsMethods({ cwd: workspace });
      await expect(clientFs.readTextFile!({ sessionId: 's', path: outsideFile })).rejects.toThrow(/permission denied|traversal/i);
      await expect(clientFs.readTextFile!({ sessionId: 's', path: '../outside/outside.txt' })).rejects.toThrow(/permission denied|traversal/i);
    });
  });

  it('writeTextFile rejects paths that escape cwd even when approved', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-root-', async (root) => {
      const workspace = join(root, 'workspace');
      const outside = join(root, 'outside');
      const outsideFile = join(outside, 'outside.txt');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside, { recursive: true });

      const clientFs = createAcpClientFsMethods({
        cwd: workspace,
        permissionHandler: {
          async handleToolCall() {
            return { decision: 'approved' };
          },
        } satisfies AcpPermissionHandler,
      });

      await expect(clientFs.writeTextFile!({ sessionId: 's', path: outsideFile, content: 'nope' })).rejects.toThrow(/permission denied|traversal/i);
      await expect(clientFs.writeTextFile!({ sessionId: 's', path: '../outside/outside.txt', content: 'nope' })).rejects.toThrow(/permission denied|traversal/i);

      expect(existsSync(outsideFile)).toBe(false);
    });
  });

  it('writeTextFile rejects writes through symlinks that point outside cwd', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-root-', async (root) => {
      const workspace = join(root, 'workspace');
      const outside = join(root, 'outside');
      const outsideFile = join(outside, 'outside.txt');
      const linkPath = join(workspace, 'link.txt');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(outsideFile, 'original', 'utf8');
      symlinkSync(outsideFile, linkPath);

      const clientFs = createAcpClientFsMethods({
        cwd: workspace,
        permissionHandler: {
          async handleToolCall() {
            return { decision: 'approved' };
          },
        } satisfies AcpPermissionHandler,
      });

      await expect(clientFs.writeTextFile!({ sessionId: 's', path: linkPath, content: 'nope' })).rejects.toThrow(/permission denied|traversal/i);
      expect(readFileSync(outsideFile, 'utf8')).toBe('original');
    });
  });

  it('writeTextFile rejects writes when a missing child is nested under a symlinked ancestor outside cwd', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-root-', async (root) => {
      const workspace = join(root, 'workspace');
      const outside = join(root, 'outside');
      const linkDir = join(workspace, 'linkdir');
      const escapedFile = join(outside, 'nested', 'via-symlink.txt');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, linkDir);

      const clientFs = createAcpClientFsMethods({
        cwd: workspace,
        permissionHandler: {
          async handleToolCall() {
            return { decision: 'approved' };
          },
        } satisfies AcpPermissionHandler,
      });

      await expect(
        clientFs.writeTextFile!({
          sessionId: 's',
          path: join(linkDir, 'nested', 'via-symlink.txt'),
          content: 'nope',
        })
      ).rejects.toThrow(/permission denied|traversal/i);
      expect(existsSync(escapedFile)).toBe(false);
    });
  });
});
