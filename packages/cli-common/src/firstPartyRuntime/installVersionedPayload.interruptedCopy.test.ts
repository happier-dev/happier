import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { installVersionedPayload } from './installVersionedPayload.js';
import { resolveFirstPartyInstallLayout } from './installLayout.js';
import { readInstalledVersionMarkers } from './versionMarkers.js';

it('promotes the exact payload on retry beside a prior interrupted copy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-interrupted-payload-copy-'));
  const options = { componentId: 'happier-cli', processEnv: { ...process.env, HAPPIER_FIRST_PARTY_INSTALL_HOME: home } } as const;
  const layout = resolveFirstPartyInstallLayout(options);
  const binary = process.platform === 'win32' ? 'happier.exe' : 'happier';
  const oldVersion = 'local-1744b6dc3f2fc7f41974932bc27be8853d835319bf138c51c102bb91df71d358';
  const requestedVersion = 'local-ab42e589606d7f7ce484387db8396792e3d2b5ac1469c8327c4e33741caa9dbf';
  const interrupted = join(layout.versionsDir, `.${requestedVersion}.tmp-481-4fdab01c-c36b-4484-8cbf-a493ca2acd7c`);
  async function writePayload(directory: string, content: string) {
    await mkdir(directory);
    await writeFile(join(directory, binary), content);
  }
  try {
    const old = join(home, 'old-payload');
    await writePayload(old, 'previous payload');
    await installVersionedPayload({ ...options, payloadRoot: old, versionId: oldVersion });
    expect(await readFile(join(layout.currentPath, binary), 'utf8')).toBe('previous payload');

    await writePayload(interrupted, 'interrupted copy');
    const incoming = join(home, 'incoming-payload');
    await writePayload(incoming, 'verified incoming payload');
    await installVersionedPayload({ ...options, payloadRoot: incoming, versionId: requestedVersion });

    expect(await readInstalledVersionMarkers(layout)).toEqual({
      currentVersionId: requestedVersion,
      previousVersionId: oldVersion,
    });
    expect(await readFile(join(layout.currentPath, binary), 'utf8')).toBe('verified incoming payload');
    expect(await readFile(join(interrupted, binary), 'utf8')).toBe('interrupted copy');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
