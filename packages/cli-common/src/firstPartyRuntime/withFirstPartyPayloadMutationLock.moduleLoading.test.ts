import { afterEach, describe, expect, it } from 'vitest';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe('withFirstPartyPayloadMutationLock module loading', () => {
  it('does not require the lock implementation until a payload mutation actually runs', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-lock-module-'));
    tempDirs.push(tempDir);
    const isolatedModulePath = join(tempDir, 'withFirstPartyPayloadMutationLock.mjs');
    await copyFile(
      join(__dirname, '../../dist/firstPartyRuntime/withFirstPartyPayloadMutationLock.js'),
      isolatedModulePath,
    );
    await copyFile(
      join(__dirname, '../../dist/firstPartyRuntime/withFirstPartyPayloadMutationLock.js.map'),
      join(tempDir, 'withFirstPartyPayloadMutationLock.js.map'),
    );

    await expect(import(pathToFileURL(isolatedModulePath).href)).resolves.toMatchObject({
      withFirstPartyPayloadMutationLock: expect.any(Function),
    });
  });
});
