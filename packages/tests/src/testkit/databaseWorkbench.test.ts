import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { installDatabaseWorkbenchPluginFixture } from './databaseWorkbench';

it('registers Workbench source owned by the test run so checkout edits cannot retire its Actions', async () => {
  const testDir = await realpath(await mkdtemp(join(tmpdir(), 'dbw-plugin-fixture-')));
  const register = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 503 }));
  vi.stubGlobal('fetch', register);
  try {
    const fixture = { testDir, daemonPort: 1234 };
    await expect(installDatabaseWorkbenchPluginFixture(fixture)).rejects.toThrow('status=503');
    const body = JSON.parse(String(register.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ kind: 'registerExplicit', rootPath: expect.any(String) });
    expect(dirname(body.rootPath)).toBe(testDir);
    const entry = join(body.rootPath, 'src', 'index.ts');
    expect(await realpath(entry)).toBe(entry);
  } finally {
    vi.unstubAllGlobals();
    await rm(testDir, { recursive: true, force: true });
  }
});
