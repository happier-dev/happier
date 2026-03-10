import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { exportOpenCodeSessionBundle } from './exportOpenCodeSessionBundle';
import { importOpenCodeSessionBundle } from './importOpenCodeSessionBundle';

async function createFakeExecutable(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-opencode-cli-'));
  const commandPath = join(root, name);
  await writeFile(commandPath, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(commandPath, 0o755);
  return commandPath;
}

describe('opencode session handoff bundle', () => {
  it('exports the session via the resolved opencode CLI command and captures affinity metadata', async () => {
    const execFile = vi.fn<(command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>>(async () => ({
      stdout: '{"id":"op_sess_1"}',
      stderr: '',
    }));
    const commandPath = await createFakeExecutable('opencode');

    const result = await exportOpenCodeSessionBundle({
      metadata: {
        path: '/repo',
        opencodeSessionId: 'op_sess_1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096',
        opencodeServerBaseUrlExplicit: true,
      },
      remoteSessionId: 'op_sess_1',
      execFile,
      processEnv: { HAPPIER_OPENCODE_PATH: commandPath },
    });

    expect(execFile).toHaveBeenCalledWith(commandPath, ['export', 'op_sess_1']);
    expect(result).toEqual({
      providerId: 'opencode',
      remoteSessionId: 'op_sess_1',
      exportJsonBase64: Buffer.from('{"id":"op_sess_1"}', 'utf8').toString('base64'),
      affinity: {
        backendMode: 'server',
        serverBaseUrl: 'http://127.0.0.1:4096/',
        serverBaseUrlExplicit: true,
      },
    });
  });

  it('imports the session via the resolved opencode CLI command and returns resume metadata', async () => {
    const execFile = vi.fn<(command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>>(async () => ({
      stdout: '',
      stderr: '',
    }));
    const commandPath = await createFakeExecutable('opencode');
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-handoff-import-'));
    const targetPath = join(root, 'workspace');

    const result = await importOpenCodeSessionBundle({
      bundle: {
        providerId: 'opencode',
        remoteSessionId: 'op_sess_1',
        exportJsonBase64: Buffer.from('{"id":"op_sess_1"}', 'utf8').toString('base64'),
        affinity: {
          backendMode: 'server',
          serverBaseUrl: 'http://127.0.0.1:4096',
          serverBaseUrlExplicit: true,
        },
      },
      targetPath,
      execFile,
      processEnv: { HAPPIER_OPENCODE_PATH: commandPath },
    });

    expect(execFile).toHaveBeenCalledWith(commandPath, ['import', expect.stringContaining('handoff-opencode-')]);
    const importPath = String(execFile.mock.calls[0]?.[1]?.[1] ?? '');
    await expect(readFile(importPath, 'utf8')).resolves.toBe('{"id":"op_sess_1"}');

    expect(result.remoteSessionId).toBe('op_sess_1');
    expect(result.directSource).toEqual({
      kind: 'opencodeServer',
      baseUrl: 'http://127.0.0.1:4096',
      directory: targetPath,
    });
    expect(result.resume).toEqual({
      directory: targetPath,
      agent: 'opencode',
      resume: 'op_sess_1',
      environmentVariables: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
        HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
      },
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
    });
  });

  it('supports persisted resume plans when the handoff keeps persisted transcript storage', async () => {
    const execFile = vi.fn<(command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>>(async () => ({
      stdout: '',
      stderr: '',
    }));
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-handoff-import-persisted-'));
    const targetPath = join(root, 'workspace');

    const result = await importOpenCodeSessionBundle({
      bundle: {
        providerId: 'opencode',
        remoteSessionId: 'op_sess_2',
        exportJsonBase64: Buffer.from('{"id":"op_sess_2"}', 'utf8').toString('base64'),
        affinity: {
          backendMode: 'server',
          serverBaseUrl: 'http://127.0.0.1:4096',
          serverBaseUrlExplicit: true,
        },
      },
      targetPath,
      execFile,
      sessionStorageMode: 'persisted',
    });

    expect(result.resume).toMatchObject({
      directory: targetPath,
      agent: 'opencode',
      resume: 'op_sess_2',
      transcriptStorage: 'persisted',
      approvedNewDirectoryCreation: true,
    });
  });
});
