import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentNativeHomeReadService } from './nativeHomeFileService';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

describe('createAgentNativeHomeReadService', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.mocked(readFile).mockReset();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('reads declared files together and omits missing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-agent-native-home-'));
    roots.push(root);
    await Promise.all([
      writeFile(join(root, '.claude.json'), 'profile'),
      writeFile(join(root, '.credentials.json'), 'credential'),
    ]);
    const service = createAgentNativeHomeReadService({
      root,
      declaredFileIds: ['.claude.json', '.credentials.json', 'missing.json'],
    });
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let finishFirstRead!: () => void;
    const firstRead = new Promise<void>(resolve => { finishFirstRead = resolve; });
    const started = new Set<string>();
    vi.mocked(readFile).mockImplementation(async (path, options) => {
      started.add(path.toString());
      if (path.toString().endsWith('.claude.json')) await firstRead;
      return await fs.readFile(path, options);
    });
    const result = service!.readFiles(['.claude.json', '.credentials.json', 'missing.json']);
    try {
      await vi.waitFor(() => {
        expect([...started].map(path => basename(path)).sort()).toEqual(['.claude.json', '.credentials.json']);
      }, { timeout: 500 });
    } finally {
      finishFirstRead();
      await result;
    }
    await expect(result).resolves.toEqual({
      '.claude.json': new TextEncoder().encode('profile'),
      '.credentials.json': new TextEncoder().encode('credential'),
    });
  });

  it('reads only exact files declared by the Agent native-home descriptor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-agent-native-home-'));
    roots.push(root);
    await writeFile(join(root, 'auth.json'), '{"account":"work"}');
    const service = createAgentNativeHomeReadService({
      root,
      declaredFileIds: ['auth.json'],
    });

    await expect(service?.readFiles(['auth.json'])).resolves.toEqual({
      'auth.json': expect.any(Uint8Array),
    });
    await expect(service?.readFiles(['settings.json']))
      .rejects.toThrow('connected_service_native_home_credential_file_undeclared');
  });
});
