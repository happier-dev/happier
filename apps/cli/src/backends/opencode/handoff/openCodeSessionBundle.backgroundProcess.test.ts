import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));

import { exportOpenCodeSessionBundle } from './exportOpenCodeSessionBundle';
import { importOpenCodeSessionBundle } from './importOpenCodeSessionBundle';
import { OPEN_CODE_EXPORT_MAX_BUFFER_BYTES } from './opencodeHandoffLimits';

const roots = new Set<string>();

afterEach(async () => {
  execFileMock.mockReset();
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function createOpenCodeExecutable(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-opencode-background-'));
  roots.add(root);
  const command = join(root, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  await writeFile(command, 'mock native executable', 'utf8');
  await chmod(command, 0o755);
  return command;
}

describe('OpenCode handoff background processes', () => {
  it('hides the export process while preserving its large-output buffer', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, '{"id":"session-export"}', '');
    });
    const command = await createOpenCodeExecutable();

    const bundle = await exportOpenCodeSessionBundle({
      metadata: {},
      remoteSessionId: 'session-export',
      processEnv: { HAPPIER_OPENCODE_PATH: command },
    });

    expect(bundle.remoteSessionId).toBe('session-export');
    expect(execFileMock).toHaveBeenCalledWith(command, ['export', 'session-export'], {
      encoding: 'utf8',
      maxBuffer: OPEN_CODE_EXPORT_MAX_BUFFER_BYTES,
      windowsHide: true,
    }, expect.any(Function));
  });

  it('hides the import process without changing its session restoration', async () => {
    const command = await createOpenCodeExecutable();
    // The existing injection seam represents the OS execFile boundary, with internal resolution real.
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));

    const imported = await importOpenCodeSessionBundle({
      bundle: {
        providerId: 'opencode',
        remoteSessionId: 'session-import',
        exportJsonBase64: Buffer.from('{"id":"session-import"}').toString('base64'),
        affinity: { backendMode: 'server', serverBaseUrl: null, serverBaseUrlExplicit: false },
      },
      targetPath: '/workspace',
      processEnv: { HAPPIER_OPENCODE_PATH: command },
      execFile,
    });

    expect(imported.resume.resume).toBe('session-import');
    expect(execFile).toHaveBeenCalledWith(command, ['import', expect.any(String)], { windowsHide: true });
  });
});
