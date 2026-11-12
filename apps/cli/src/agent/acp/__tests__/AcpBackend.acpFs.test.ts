import { describe, expect, it, afterEach, beforeAll } from 'vitest';

import { writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { buildInitializeRequest, createAcpClientFsMethods } from '../AcpBackend';
import type { AcpPermissionHandler } from '../AcpBackend';
import { loadAcpSdk } from '../connection/acpSdk';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const envScope = createEnvKeyScope(['HAPPIER_ACP_FS']);

describe('AcpBackend ACP FS capability experiment', () => {
  beforeAll(async () => {
    // Handlers only run inside an open connection, where the SDK is already loaded.
    await loadAcpSdk();
  });

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

  it('advertises the SDK plan lifecycle capability only when its canonical publisher is active', () => {
    const withoutPublisher = buildInitializeRequest({
      clientName: 'test',
      clientVersion: '0.0.0',
      planUpdates: false,
    });
    const withPublisher = buildInitializeRequest({
      clientName: 'test',
      clientVersion: '0.0.0',
      planUpdates: true,
    });
    expect(withoutPublisher.clientCapabilities?.plan).toBeUndefined();
    expect(withPublisher.clientCapabilities?.plan).toEqual({});
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
      ).rejects.toMatchObject({
        message: expect.stringContaining(`Permission denied: writing ${targetPath} was not approved`),
        data: { path: targetPath },
      });

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

  it('reports a missing file as ACP resource-not-found', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-root-', async (root) => {
      const workspaceReal = join(root, 'workspace-real');
      const workspaceLink = join(root, 'workspace-link');
      mkdirSync(workspaceReal, { recursive: true });
      symlinkSync(workspaceReal, workspaceLink);

      const clientFs = createAcpClientFsMethods({ cwd: workspaceLink });
      const missing = join(workspaceLink, 'missing.txt');

      await expect(clientFs.readTextFile!({ sessionId: 's', path: missing })).rejects.toMatchObject({
        code: -32002,
        message: expect.stringContaining(missing),
      });
    });
  });

  it('names the failing path and cause instead of a bare internal error', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-', async (workspace) => {
      const clientFs = createAcpClientFsMethods({ cwd: workspace });

      await expect(clientFs.readTextFile!({ sessionId: 's', path: workspace })).rejects.toMatchObject({
        code: -32603,
        message: expect.stringMatching(/EISDIR/),
      });
    });
  });

  it('readTextFile reads files outside cwd, like the agent itself can', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-root-', async (root) => {
      const workspace = join(root, 'workspace');
      const outside = join(root, 'outside');
      const outsideFile = join(outside, 'outside.txt');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(outsideFile, 'shared', 'utf8');

      const clientFs = createAcpClientFsMethods({ cwd: workspace });
      await expect(clientFs.readTextFile!({ sessionId: 's', path: outsideFile })).resolves.toEqual({ content: 'shared' });
      await expect(clientFs.readTextFile!({ sessionId: 's', path: '../outside/outside.txt' })).resolves.toEqual({ content: 'shared' });
    });
  });

  it('writeTextFile writes outside cwd once the session permission policy approves it', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-root-', async (root) => {
      const workspace = join(root, 'workspace');
      const outsideFile = join(root, 'analysis', 'report.md');
      mkdirSync(workspace, { recursive: true });
      const approvedPaths: unknown[] = [];

      const clientFs = createAcpClientFsMethods({
        cwd: workspace,
        permissionHandler: {
          async handleToolCall(_toolCallId, _toolName, input) {
            approvedPaths.push((input as { path?: unknown }).path);
            return { decision: 'approved' };
          },
        } satisfies AcpPermissionHandler,
      });

      await clientFs.writeTextFile!({ sessionId: 's', path: '../analysis/report.md', content: 'done' });

      expect(approvedPaths).toEqual([outsideFile]);
      expect(readFileSync(outsideFile, 'utf8')).toBe('done');
    });
  });
});
