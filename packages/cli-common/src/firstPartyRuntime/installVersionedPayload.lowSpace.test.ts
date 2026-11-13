import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { installVersionedPayload } from './installVersionedPayload.js';

// Filesystem capacity and cross-device rename are OS boundaries. Keep the real
// installer, retention policy, native-use census, staging and activation path.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, cp: vi.fn(actual.cp), rename: vi.fn(actual.rename) };
});

afterEach(() => { vi.mocked(cp).mockReset(); vi.mocked(rename).mockReset(); vi.unstubAllEnvs(); });

it.skipIf(process.platform === 'win32')('reclaims superseded versions before low-space staging while retaining current and running payloads', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-install-low-space-'));
  const versions = join(home, 'cli', 'versions');
  const source = join(home, 'incoming');
  try {
    const tools = join(home, 'tools');
    await mkdir(tools);
    // Native process observation reports version 1 still running; lsof has no
    // open files. Only these native queries are simulated, not retention logic.
    await writeFile(join(tools, 'ps'), '#!/bin/sh\nprintf "%s\\n" "$(id -u) external-runtime $running_payload/entry.mjs"\n', { mode: 0o755 });
    await writeFile(join(tools, 'lsof'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${tools}:${process.env.PATH}`);
    vi.stubEnv('running_payload', join(versions, '1.0.0'));
    for (const version of ['1.0.0', '2.0.0', '3.0.0', '4.0.0']) {
      await mkdir(join(versions, version), { recursive: true });
      await writeFile(join(versions, version, 'happier'), Buffer.alloc(1024, version.charCodeAt(0)));
    }
    await writeFile(join(home, 'cli', 'current.version'), '4.0.0\n');
    await writeFile(join(home, 'cli', 'previous.version'), '3.0.0\n');
    await mkdir(source);
    await writeFile(join(source, 'happier'), Buffer.alloc(1024, 5));
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (from === source) throw Object.assign(new Error('cross-device payload'), { code: 'EXDEV' });
      return await actual.rename(from, to);
    });
    vi.mocked(cp).mockImplementation(async (from, to, options) => {
      if (from === source) {
        const retained = (await readdir(versions)).filter(name => !name.startsWith('.'));
        const freeBytes = 4608 - retained.length * 1024;
        if (freeBytes < 1024) throw Object.assign(new Error('no space for payload'), { code: 'ENOSPC' });
      }
      return await actual.cp(from, to, options);
    });
    await expect(installVersionedPayload({ componentId: 'happier-cli', versionId: '5.0.0', payloadRoot: source,
      processEnv: { ...process.env, HAPPIER_FIRST_PARTY_INSTALL_HOME: home } })).resolves.toMatchObject({ currentVersionId: '5.0.0', previousVersionId: '4.0.0' });
    expect((await readdir(versions)).sort()).toEqual(['1.0.0', '4.0.0', '5.0.0']);
    expect(await readFile(join(home, 'cli', 'current.version'), 'utf8')).toBe('5.0.0\n');
    expect(await readFile(join(versions, '1.0.0', 'happier'))).toEqual(Buffer.alloc(1024, 49));
  } finally { await rm(home, { recursive: true, force: true }); }
});
