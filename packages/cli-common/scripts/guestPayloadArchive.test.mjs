import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { createScpReadyPayloadArchive } from '../src/systemTasks/kinds/createScpReadyPayloadArchive.ts';
import { CLI_BINARY_TARGETS } from '../src/componentArtifacts/targets.ts';
import { resolveIrohNodeAddonArtifactName, resolveSessionHolderArtifactName } from '../../iroh-native/src/nodeNative.ts';

const execFileAsync = promisify(execFile);

it.skipIf(process.platform === 'win32')('delivers native addon and executable Session holders for every CLI payload target', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-holder-delivery-'));
  try {
    for (const target of CLI_BINARY_TARGETS) {
      const platform = target.os === 'windows' ? 'win32' : target.os;
      const holder = resolveSessionHolderArtifactName(platform, target.arch);
      expect(holder).not.toBeNull();
      const payload = join(scratch, `${target.os}-${target.arch}`);
      const nativeRelative = 'node_modules/@happier-dev/iroh-native/native';
      const files = [resolveIrohNodeAddonArtifactName(platform, target.arch), holder,
        'targets/happier-session-holder.linux-x64-musl', 'targets/happier-session-holder.linux-arm64-musl'];
      for (const file of files) {
        const path = join(payload, nativeRelative, file);
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, `delivered ${target.os}-${target.arch}: ${file}`, { mode: 0o555 });
      }
      const archive = await createScpReadyPayloadArchive(payload);
      try {
        const extracted = join(scratch, 'extracted', `${target.os}-${target.arch}`);
        await mkdir(extracted, { recursive: true });
        await execFileAsync('tar', ['-xf', join(archive.archiveStageRoot, archive.archiveFileName), '-C', extracted]);
        for (const file of files) {
          const delivered = join(extracted, archive.extractedPayloadDirName, nativeRelative, file);
          expect(await readFile(delivered, 'utf8')).toBe(`delivered ${target.os}-${target.arch}: ${file}`);
          expect((await lstat(delivered)).mode & 0o111).toBe(0o111);
        }
      } finally { await archive.cleanup(); }
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
