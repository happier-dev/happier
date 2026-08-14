import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import cliDistBuildManifest from '../../cliDistBuildManifest.cjs';

const tempDirs: string[] = [];

async function createRuntimeRoot(input: Readonly<{
  executableName: string;
  executableBytes?: string;
}>): Promise<Readonly<{
  runtimeRoot: string;
  entrypoint: string;
  executablePath: string;
  relativePath: string;
}>> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'cli-runtime-asset-manifest-'));
  tempDirs.push(runtimeRoot);
  const entrypoint = join(runtimeRoot, 'package-dist', 'index.mjs');
  const relativePath = `tools/unpacked/${input.executableName}`;
  const executablePath = join(runtimeRoot, ...relativePath.split('/'));
  await mkdir(join(runtimeRoot, 'package-dist'), { recursive: true });
  await mkdir(join(runtimeRoot, 'tools', 'unpacked'), { recursive: true });
  await writeFile(entrypoint, 'export default true;\n');
  await writeFile(
    executablePath,
    input.executableBytes ?? 'managed-runtime-bytes',
    { mode: 0o755 },
  );
  cliDistBuildManifest.writeCliDistBuildManifest(entrypoint);
  return { runtimeRoot, entrypoint, executablePath, relativePath };
}

describe('CLI runtime asset build manifest', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }));
  });

  it('records and verifies the exact Windows executable leaf in the existing manifest', async () => {
    const runtime = await createRuntimeRoot({
      executableName: 'happier-cliproxyapi-managed.exe',
    });

    const written = cliDistBuildManifest.writeCliRuntimeAssetBuildManifest({
      runtimeRoot: runtime.runtimeRoot,
      entrypoint: runtime.entrypoint,
      relativePath: runtime.relativePath,
    });

    expect(written.runtimeAsset).toEqual({
      relativePath: runtime.relativePath,
      byteLength: Buffer.byteLength('managed-runtime-bytes'),
      sha256: createHash('sha256')
        .update('managed-runtime-bytes')
        .digest('hex'),
    });
    expect(JSON.parse(await readFile(written.manifestPath, 'utf8')))
      .toMatchObject({ runtimeAsset: written.runtimeAsset });
    expect(cliDistBuildManifest.readCliRuntimeAssetIntegrity({
      runtimeRoot: runtime.runtimeRoot,
      relativePath: runtime.relativePath,
    })).toMatchObject({
      ok: true,
      reason: 'runtime_asset_manifest',
      assetPath: runtime.executablePath,
    });
  });

  it('rejects same-length substituted bytes and a missing runtime asset record', async () => {
    const runtime = await createRuntimeRoot({
      executableName: 'happier-cliproxyapi-managed',
      executableBytes: 'managed-runtime-A',
    });
    cliDistBuildManifest.writeCliRuntimeAssetBuildManifest({
      runtimeRoot: runtime.runtimeRoot,
      entrypoint: runtime.entrypoint,
      relativePath: runtime.relativePath,
    });
    await writeFile(runtime.executablePath, 'managed-runtime-B', {
      mode: 0o755,
    });

    expect(cliDistBuildManifest.readCliRuntimeAssetIntegrity({
      runtimeRoot: runtime.runtimeRoot,
      relativePath: runtime.relativePath,
    })).toMatchObject({
      ok: false,
      reason: 'runtime_asset_sha256_mismatch',
    });
    cliDistBuildManifest.refreshCliRuntimeAssetBuildManifest({
      runtimeRoot: runtime.runtimeRoot,
      entrypoint: runtime.entrypoint,
    });
    expect(cliDistBuildManifest.readCliRuntimeAssetIntegrity({
      runtimeRoot: runtime.runtimeRoot,
      relativePath: runtime.relativePath,
    })).toMatchObject({
      ok: true,
      observedSha256: createHash('sha256')
        .update('managed-runtime-B')
        .digest('hex'),
    });

    const missing = await createRuntimeRoot({
      executableName: 'happier-cliproxyapi-managed',
    });
    expect(cliDistBuildManifest.readCliRuntimeAssetIntegrity({
      runtimeRoot: missing.runtimeRoot,
      relativePath: missing.relativePath,
    })).toMatchObject({
      ok: false,
      reason: 'missing_runtime_asset_manifest',
    });
  });

  it('rejects non-canonical paths and the superseded plural manifest shape', async () => {
    const runtime = await createRuntimeRoot({
      executableName: 'happier-cliproxyapi-managed',
    });

    expect(() => cliDistBuildManifest.writeCliRuntimeAssetBuildManifest({
      runtimeRoot: runtime.runtimeRoot,
      entrypoint: runtime.entrypoint,
      relativePath: ` ${runtime.relativePath}`,
    })).toThrow('exactly one canonical runtime asset path');

    const unrelatedPath = 'tools/unpacked/unrelated-runtime';
    await writeFile(
      join(runtime.runtimeRoot, ...unrelatedPath.split('/')),
      'unrelated-runtime-bytes',
      { mode: 0o755 },
    );
    const written = cliDistBuildManifest.writeCliRuntimeAssetBuildManifest({
      runtimeRoot: runtime.runtimeRoot,
      entrypoint: runtime.entrypoint,
      relativePath: runtime.relativePath,
    });
    const manifest = JSON.parse(await readFile(written.manifestPath, 'utf8'));
    manifest.runtimeAssets = [manifest.runtimeAsset, {
      relativePath: unrelatedPath,
      byteLength: Buffer.byteLength('unrelated-runtime-bytes'),
      sha256: createHash('sha256')
        .update('unrelated-runtime-bytes')
        .digest('hex'),
    }];
    await writeFile(written.manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(cliDistBuildManifest.readCliRuntimeAssetIntegrity({
      runtimeRoot: runtime.runtimeRoot,
      relativePath: runtime.relativePath,
    })).toMatchObject({
      ok: false,
      reason: 'invalid_runtime_asset_manifest_entry',
    });
  });
});
