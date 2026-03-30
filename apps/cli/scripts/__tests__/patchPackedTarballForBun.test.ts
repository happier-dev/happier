import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import * as tar from 'tar';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { patchPackedTarballForBun } from '../postpack/patchPackedTarballForBun.mjs';

describe('patchPackedTarballForBun', () => {
  it('removes internal @happier-dev/* dependencies without removing bundled payload files', async () => {
    const tmp = createTempDirSync('happier-cli-postpack-test-');
    const packageDir = join(tmp, 'package');
    const tarballPath = join(tmp, 'artifact.tgz');

    const pkgJsonPath = join(packageDir, 'package.json');
    const bundledMarkerPath = join(packageDir, 'node_modules', '@happier-dev', 'protocol', 'package.json');

    mkdirSync(join(packageDir, 'node_modules', '@happier-dev', 'protocol'), { recursive: true });
    writeFileSync(
      pkgJsonPath,
      `${JSON.stringify({
        name: '@happier-dev/cli',
        version: '0.1.0',
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
          '@happier-dev/release-runtime': '0.0.0',
          tweetnacl: '^1.0.3',
        },
      }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      bundledMarkerPath,
      `${JSON.stringify({ name: '@happier-dev/protocol', version: '0.0.0' }, null, 2)}\n`,
      'utf8',
    );

    // Re-pack the tarball with the actual payload.
    await tar.c({ gzip: true, file: tarballPath, cwd: tmp, portable: true }, ['package']);

    await patchPackedTarballForBun({ tarballPath, env: {} });

    const extracted = createTempDirSync('happier-cli-postpack-extract-');
    await tar.x({ file: tarballPath, cwd: extracted, strict: true });

    const patchedPkgRaw = readFileSync(join(extracted, 'package', 'package.json'), 'utf8');
    const patchedPkg = JSON.parse(patchedPkgRaw) as { dependencies?: Record<string, string> };

    expect(Object.keys(patchedPkg.dependencies ?? {}).filter((key) => key.startsWith('@happier-dev/'))).toEqual([]);
    expect(patchedPkg.dependencies?.tweetnacl).toBeTruthy();

    expect(() => readFileSync(join(extracted, 'package', 'node_modules', '@happier-dev', 'protocol', 'package.json'), 'utf8'))
      .not.toThrow();
  });
});
