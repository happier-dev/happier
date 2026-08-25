import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as tar from 'tar';
import { describe, expect, it } from 'vitest';

import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';
import {
  resolveManagedProviderRuntimeExecutable,
  type PackagedRuntimeBinaryExecutableRef,
} from './resolveManagedProviderRuntimeLaunch';

const require = createRequire(import.meta.url);

type RuntimeAssetEntry = Readonly<{
  platformDir: string;
  archiveName: string;
  binaryName: string;
  licenseNames: readonly string[];
  runtimeAssetRelativePath: string;
}>;

type ToolEntry = Readonly<{
  platformDir: string;
  archiveName: string;
  binaryName: string;
  extraBinaries?: readonly string[];
  licenseName?: string;
}>;

const unpackTools = require('../../../scripts/unpack-tools.cjs') as {
  getToolArchiveManifest: () => readonly ToolEntry[];
  getCliRuntimeAssetArchiveManifest: () => readonly RuntimeAssetEntry[];
  unpackTools: (options: { platformDir: string; toolsDir: string }) => Promise<unknown>;
};

/**
 * The npm CLI shape is the only distribution where the CLIProxyAPI wrapper is
 * materialized by postinstall rather than staged into a native payload. This
 * exercises that whole seam end to end: staged archive -> postinstall
 * extraction -> canonical runtime-asset manifest -> managed Provider launch
 * resolution. The launch reference is derived from the postinstall owner's
 * declared asset path so the two ends cannot drift apart; the plugin side of
 * that path is pinned by the CLIProxyAPI managed runtime's own launch test.
 */
function declaredExecutableRef(entry: RuntimeAssetEntry): PackagedRuntimeBinaryExecutableRef {
  const segments = entry.runtimeAssetRelativePath.split('/');
  const fileName = segments.at(-1);
  if (!fileName) throw new Error('runtime asset path has no file name');
  return {
    kind: 'packaged-runtime-binary',
    directorySegments: segments.slice(0, -1),
    executableBaseName: fileName.replace(/\.exe$/u, ''),
  };
}

async function createInstalledCliTree(platformDir: string): Promise<Readonly<{
  runtimeRoot: string;
  toolsDir: string;
  wrapperPath: string;
  executable: PackagedRuntimeBinaryExecutableRef;
}>> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'happier-npm-cli-install-'));
  const toolsDir = join(runtimeRoot, 'tools');
  const archivesDir = join(toolsDir, 'archives');
  const stagingDir = join(runtimeRoot, '.staging');
  const packageDist = join(runtimeRoot, 'package-dist');
  await mkdir(archivesDir, { recursive: true });
  await mkdir(stagingDir, { recursive: true });
  await mkdir(packageDist, { recursive: true });
  await writeFile(join(packageDist, 'index.mjs'), 'export default 1;\n');
  cliDistBuildManifest.writeCliDistBuildManifest(join(packageDist, 'index.mjs'));

  const toolChecksumLines: string[] = [];
  const runtimeAssetChecksumLines: string[] = [];
  const recordArchive = async (
    archiveName: string,
    entries: readonly string[],
    inventory: 'tools' | 'runtimeAssets',
  ): Promise<void> => {
    const archivePath = join(archivesDir, archiveName);
    await tar.create({ cwd: stagingDir, file: archivePath, gzip: true, portable: true }, [...entries]);
    const digest = createHash('sha256').update(await readFile(archivePath)).digest('hex');
    (inventory === 'tools' ? toolChecksumLines : runtimeAssetChecksumLines)
      .push(`${digest}  ${archiveName}`);
  };

  for (const entry of unpackTools.getToolArchiveManifest().filter((tool) => tool.platformDir === platformDir)) {
    const members = [entry.binaryName, ...(entry.extraBinaries ?? [])];
    for (const member of members) await writeFile(join(stagingDir, member), `stub:${member}`);
    if (entry.licenseName) await writeFile(join(archivesDir, entry.licenseName), 'license');
    await recordArchive(entry.archiveName, members, 'tools');
  }

  const runtimeAsset = unpackTools.getCliRuntimeAssetArchiveManifest()
    .find((entry) => entry.platformDir === platformDir);
  if (!runtimeAsset) throw new Error(`no runtime asset declared for ${platformDir}`);
  const wrapperMembers = [runtimeAsset.binaryName, ...runtimeAsset.licenseNames];
  await writeFile(join(stagingDir, runtimeAsset.binaryName), 'managed-wrapper');
  await chmod(join(stagingDir, runtimeAsset.binaryName), 0o755);
  for (const licenseName of runtimeAsset.licenseNames) {
    await writeFile(join(stagingDir, licenseName), `notice:${licenseName}`);
  }
  await recordArchive(runtimeAsset.archiveName, wrapperMembers, 'runtimeAssets');

  await writeFile(join(archivesDir, 'checksums.sha256'), `${toolChecksumLines.join('\n')}\n`);
  await writeFile(
    join(archivesDir, 'checksums.runtime-assets.sha256'),
    `${runtimeAssetChecksumLines.join('\n')}\n`,
  );
  await unpackTools.unpackTools({ platformDir, toolsDir });
  return {
    runtimeRoot,
    toolsDir,
    wrapperPath: join(toolsDir, 'unpacked', runtimeAsset.binaryName),
    executable: declaredExecutableRef(runtimeAsset),
  };
}

describe('npm-installed managed CLIProxyAPI runtime', () => {
  const platformDir = process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'arm64-darwin' : 'x64-darwin')
    : (process.arch === 'arm64' ? 'arm64-linux' : 'x64-linux');

  it.runIf(process.platform !== 'win32')(
    'resolves the plugin-declared packaged runtime binary an npm install materialized',
    async () => {
      const { runtimeRoot, wrapperPath, executable } = await createInstalledCliTree(platformDir);

      const resolved = await resolveManagedProviderRuntimeExecutable(
        executable,
        {
          platform: process.platform,
          resolveAssetPath: (...segments: string[]) => join(runtimeRoot, ...segments),
        },
      );

      // The resolver returns the verified real path; macOS temp roots are symlinked.
      expect(resolved).toBe(await realpath(wrapperPath));
    },
    120_000,
  );

  it.runIf(process.platform !== 'win32')(
    'fails closed when the materialized wrapper no longer matches its recorded integrity',
    async () => {
      const { runtimeRoot, wrapperPath, executable } = await createInstalledCliTree(platformDir);
      await writeFile(wrapperPath, 'tampered-wrapper');
      await chmod(wrapperPath, 0o755);

      const resolved = await resolveManagedProviderRuntimeExecutable(
        executable,
        {
          platform: process.platform,
          resolveAssetPath: (...segments: string[]) => join(runtimeRoot, ...segments),
        },
      );

      expect(resolved).toBeNull();
    },
    120_000,
  );
});
