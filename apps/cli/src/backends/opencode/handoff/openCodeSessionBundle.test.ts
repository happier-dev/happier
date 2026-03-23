import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

async function createNodeShebangExecutable(name: string): Promise<{ commandPath: string; runtimePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'happier-opencode-cli-node-'));
  const commandPath = join(root, name);
  const runtimeDir = join(root, 'runtime');
  const runtimePath = join(runtimeDir, 'node');
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(commandPath, '#!/usr/bin/env node\nprocess.stdout.write("ok\\n")\n', 'utf8');
  await chmod(commandPath, 0o755);
  await writeFile(runtimePath, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(runtimePath, 0o755);
  return { commandPath, runtimePath };
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
    let importPath = '';
    const execFile = vi.fn<(command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>>(async (_command, args) => {
      importPath = String(args[1] ?? '');
      await expect(readFile(importPath, 'utf8')).resolves.toBe('{"id":"op_sess_1"}');
      return {
        stdout: '',
        stderr: '',
      };
    });
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
    await expect(access(importPath)).rejects.toThrow();

    expect(result.remoteSessionId).toBe('op_sess_1');
    expect(result.directSource).toEqual({
      kind: 'opencodeServer',
      baseUrl: 'http://127.0.0.1:4096',
      directory: targetPath,
    });
    expect(result.agentRuntimeDescriptorV1).toEqual({
      v: 1,
      providerId: 'opencode',
      provider: {
        backendMode: 'server',
        vendorSessionId: 'op_sess_1',
        serverBaseUrl: 'http://127.0.0.1:4096',
        serverBaseUrlExplicit: true,
        providerExtra: {
          owner: 'opencode',
          schemaId: 'opencode.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeHandle: {
            backendMode: 'server',
            vendorSessionId: 'op_sess_1',
            serverBaseUrl: 'http://127.0.0.1:4096',
            serverBaseUrlExplicit: true,
          },
        },
      },
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

  it('forces server mode when importing a direct OpenCode session even if the exported affinity backendMode was acp', async () => {
    let importPath = '';
    const execFile = vi.fn<(command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>>(async (_command, args) => {
      importPath = String(args[1] ?? '');
      await expect(readFile(importPath, 'utf8')).resolves.toBe('{"id":"op_sess_acp"}');
      return {
        stdout: '',
        stderr: '',
      };
    });
    const commandPath = await createFakeExecutable('opencode');
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-handoff-import-acp-'));
    const targetPath = join(root, 'workspace');

    const result = await importOpenCodeSessionBundle({
      bundle: {
        providerId: 'opencode',
        remoteSessionId: 'op_sess_acp',
        exportJsonBase64: Buffer.from('{"id":"op_sess_acp"}', 'utf8').toString('base64'),
        affinity: {
          backendMode: 'acp',
          serverBaseUrl: 'http://127.0.0.1:4096',
          serverBaseUrlExplicit: true,
        },
      },
      targetPath,
      execFile,
      processEnv: { HAPPIER_OPENCODE_PATH: commandPath },
    });

    expect(execFile).toHaveBeenCalledWith(commandPath, ['import', expect.stringContaining('handoff-opencode-')]);
    await expect(access(importPath)).rejects.toThrow();

    expect(result.directSource).toEqual({
      kind: 'opencodeServer',
      baseUrl: 'http://127.0.0.1:4096',
      directory: targetPath,
    });

    // Direct sessions currently only support the server transport; "acp" affinity is treated as a requested mode
    // and normalized to server in the imported runtime envelope.
    expect(result.agentRuntimeDescriptorV1?.provider?.backendMode).toBe('server');
    expect(result.resume.environmentVariables?.HAPPIER_OPENCODE_BACKEND_MODE).toBe('server');
  });

  it('does not invent a server runtime descriptor when imported affinity is unknown', async () => {
    const execFile = vi.fn<(command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>>(async () => ({
      stdout: '',
      stderr: '',
    }));
    const commandPath = await createFakeExecutable('opencode');
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-handoff-import-unknown-'));
    const targetPath = join(root, 'workspace');

    const result = await importOpenCodeSessionBundle({
      bundle: {
        providerId: 'opencode',
        remoteSessionId: 'op_unknown',
        exportJsonBase64: Buffer.from('{"id":"op_unknown"}', 'utf8').toString('base64'),
        affinity: {
          backendMode: null,
          serverBaseUrl: 'http://127.0.0.1:4096',
          serverBaseUrlExplicit: true,
        },
      },
      targetPath,
      execFile,
      processEnv: { HAPPIER_OPENCODE_PATH: commandPath },
    });

    expect(result).not.toHaveProperty('agentRuntimeDescriptorV1');
  });

  it('cleans up decoded temp artifacts when opencode import fails', async () => {
    let importPath = '';
    const execFile = vi.fn<(command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>>(async (_command, args) => {
      importPath = String(args[1] ?? '');
      await expect(readFile(importPath, 'utf8')).resolves.toBe('{"id":"op_sess_fail"}');
      throw new Error('import failed');
    });
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-handoff-import-failure-'));

    await expect(importOpenCodeSessionBundle({
      bundle: {
        providerId: 'opencode',
        remoteSessionId: 'op_sess_fail',
        exportJsonBase64: Buffer.from('{"id":"op_sess_fail"}', 'utf8').toString('base64'),
        affinity: {
          backendMode: 'server',
          serverBaseUrl: 'http://127.0.0.1:4096',
          serverBaseUrlExplicit: true,
        },
      },
      targetPath: join(root, 'workspace'),
      execFile,
    })).rejects.toThrow('import failed');

    await expect(access(importPath)).rejects.toThrow();
  });

  it('rejects oversized export payloads before decode or import execution', async () => {
    const execFile = vi.fn<(command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>>(async () => ({
      stdout: '',
      stderr: '',
    }));
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-handoff-import-too-large-'));
    const oversizedExportJsonBase64 = Buffer.from('a'.repeat((8 * 1024 * 1024) + 1), 'utf8').toString('base64');

    await expect(importOpenCodeSessionBundle({
      bundle: {
        providerId: 'opencode',
        remoteSessionId: 'op_sess_too_large',
        exportJsonBase64: oversizedExportJsonBase64,
        affinity: {
          backendMode: 'server',
          serverBaseUrl: 'http://127.0.0.1:4096',
          serverBaseUrlExplicit: true,
        },
      },
      targetPath: join(root, 'workspace'),
      execFile,
    })).rejects.toThrow(/too large|size limit/i);

    expect(execFile).not.toHaveBeenCalled();
  });

  it('rejects malformed export payloads before import execution', async () => {
    const execFile = vi.fn<(command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>>(async () => ({
      stdout: '',
      stderr: '',
    }));
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-handoff-import-invalid-base64-'));

    await expect(importOpenCodeSessionBundle({
      bundle: {
        providerId: 'opencode',
        remoteSessionId: 'op_sess_invalid',
        exportJsonBase64: '@@not-base64@@',
        affinity: {
          backendMode: 'server',
          serverBaseUrl: 'http://127.0.0.1:4096',
          serverBaseUrlExplicit: true,
        },
      },
      targetPath: join(root, 'workspace'),
      execFile,
    })).rejects.toThrow(/invalid|malformed|base64|json/i);

    expect(execFile).not.toHaveBeenCalled();
  });

  it('rejects remote session ids that escape the temp import directory', async () => {
    const escapedSessionId = `../opencode-import-escape-${process.pid}-${Date.now()}`;
    const escapedImportPath = join(tmpdir(), `${escapedSessionId.slice(3)}.json`);
    await rm(escapedImportPath, { force: true });
    const execFile = vi.fn<(command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>>(async () => ({
      stdout: '',
      stderr: '',
    }));
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-handoff-import-invalid-id-'));

    await expect(importOpenCodeSessionBundle({
      bundle: {
        providerId: 'opencode',
        remoteSessionId: escapedSessionId,
        exportJsonBase64: Buffer.from('{"id":"escape"}', 'utf8').toString('base64'),
        affinity: {
          backendMode: 'server',
          serverBaseUrl: 'http://127.0.0.1:4096',
          serverBaseUrlExplicit: true,
        },
      },
      targetPath: join(root, 'workspace'),
      execFile,
    })).rejects.toThrow(/remoteSessionId|session id|path/i);

    expect(execFile).not.toHaveBeenCalled();
    await expect(access(escapedImportPath)).rejects.toThrow();
  });

  it('wraps node-shebang opencode CLIs with the configured JS runtime during export', async () => {
    const execFile = vi.fn<(command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>>(async () => ({
      stdout: '{"id":"op_sess_1"}',
      stderr: '',
    }));
    const { commandPath, runtimePath } = await createNodeShebangExecutable('opencode');

    await exportOpenCodeSessionBundle({
      metadata: {},
      remoteSessionId: 'op_sess_1',
      execFile,
      processEnv: { HAPPIER_OPENCODE_PATH: commandPath, HAPPIER_JS_RUNTIME_PATH: runtimePath },
    });

    expect(execFile).toHaveBeenCalledWith(runtimePath, [commandPath, 'export', 'op_sess_1']);
  });

  it('wraps node-shebang opencode CLIs with the configured JS runtime during import', async () => {
    let importPath = '';
    const execFile = vi.fn<(command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>>(async (_command, args) => {
      importPath = String(args[2] ?? '');
      await expect(readFile(importPath, 'utf8')).resolves.toBe('{"id":"op_sess_3"}');
      return {
        stdout: '',
        stderr: '',
      };
    });
    const { commandPath, runtimePath } = await createNodeShebangExecutable('opencode');
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-handoff-import-runtime-'));
    const targetPath = join(root, 'workspace');

    await importOpenCodeSessionBundle({
      bundle: {
        providerId: 'opencode',
        remoteSessionId: 'op_sess_3',
        exportJsonBase64: Buffer.from('{"id":"op_sess_3"}', 'utf8').toString('base64'),
        affinity: {
          backendMode: 'server',
          serverBaseUrl: 'http://127.0.0.1:4096',
          serverBaseUrlExplicit: true,
        },
      },
      targetPath,
      execFile,
      processEnv: {
        HAPPIER_OPENCODE_PATH: commandPath,
        HAPPIER_JS_RUNTIME_PATH: runtimePath,
      },
    });

    expect(execFile).toHaveBeenCalledWith(runtimePath, [commandPath, 'import', expect.stringContaining('handoff-opencode-')]);
    await expect(access(importPath)).rejects.toThrow();
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
