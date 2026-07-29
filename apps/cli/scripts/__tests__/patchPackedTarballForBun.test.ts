import fs, { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as tar from 'tar';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { patchPackedTarballForBun } from '../postpack/patchPackedTarballForBun.mjs';

describe('patchPackedTarballForBun', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not require a tarball during an explicitly marked npm pack dry run', async () => {
    await expect(patchPackedTarballForBun({
      env: {
        npm_config_dry_run: 'true',
      },
    })).resolves.toEqual({
      skipped: true,
      reason: 'npm-pack-dry-run',
    });
  });

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

  it('removes heavy voice inference runtime dependencies only when the tarball ships the complete deferred archive matrix', async () => {
    const tmp = createTempDirSync('happier-cli-postpack-voice-runtime-test-');
    const packageDir = join(tmp, 'package');
    const tarballPath = join(tmp, 'artifact.tgz');
    const archivesDir = join(packageDir, 'tools', 'archives');

    mkdirSync(archivesDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      `${JSON.stringify({
        name: '@happier-dev/cli',
        version: '0.1.0',
        dependencies: {
          '@huggingface/transformers': '^3.8.1',
          'ffmpeg-static': '5.2.0',
          'sherpa-onnx-node': '^1.12.38',
          tweetnacl: '^1.0.3',
        },
        optionalDependencies: {
          'sherpa-onnx-darwin-arm64': '1.12.38',
          'unrelated-optional-package': '1.0.0',
        },
        happier: {
          voiceInference: {
            deferredRuntimePackages: [
              '@huggingface/transformers',
              'ffmpeg-static',
              'sherpa-onnx-node',
              'sherpa-onnx-darwin-arm64',
            ],
            deferredRuntimeArchiveTargets: [
              'linux-x64',
              'linux-arm64',
              'darwin-x64',
              'darwin-arm64',
              'windows-x64',
            ],
          },
        },
      }, null, 2)}\n`,
      'utf8',
    );

    for (const target of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64']) {
      writeFileSync(join(archivesDir, `voice-inference-runtime-${target}.tar.gz`), `${target}\n`, 'utf8');
    }

    await tar.c({ gzip: true, file: tarballPath, cwd: tmp, portable: true }, ['package']);

    await patchPackedTarballForBun({ tarballPath, env: {} });

    const extracted = createTempDirSync('happier-cli-postpack-voice-runtime-extract-');
    await tar.x({ file: tarballPath, cwd: extracted, strict: true });

    const patchedPkg = JSON.parse(
      readFileSync(join(extracted, 'package', 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

    expect(patchedPkg.dependencies).toEqual({
      tweetnacl: '^1.0.3',
    });
    expect(patchedPkg.optionalDependencies).toEqual({
      'unrelated-optional-package': '1.0.0',
    });
  });

  it('retains heavy voice inference runtime dependencies when the deferred archive matrix is incomplete', async () => {
    const tmp = createTempDirSync('happier-cli-postpack-voice-runtime-incomplete-test-');
    const packageDir = join(tmp, 'package');
    const tarballPath = join(tmp, 'artifact.tgz');
    const archivesDir = join(packageDir, 'tools', 'archives');

    mkdirSync(archivesDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      `${JSON.stringify({
        name: '@happier-dev/cli',
        version: '0.1.0',
        dependencies: {
          '@huggingface/transformers': '^3.8.1',
          'ffmpeg-static': '5.2.0',
          'sherpa-onnx-node': '^1.12.38',
          tweetnacl: '^1.0.3',
        },
        optionalDependencies: {
          'sherpa-onnx-darwin-arm64': '1.12.38',
        },
        happier: {
          voiceInference: {
            deferredRuntimePackages: [
              '@huggingface/transformers',
              'ffmpeg-static',
              'sherpa-onnx-node',
              'sherpa-onnx-darwin-arm64',
            ],
            deferredRuntimeArchiveTargets: [
              'linux-x64',
              'linux-arm64',
              'darwin-x64',
              'darwin-arm64',
              'windows-x64',
            ],
          },
        },
      }, null, 2)}\n`,
      'utf8',
    );

    for (const target of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']) {
      writeFileSync(join(archivesDir, `voice-inference-runtime-${target}.tar.gz`), `${target}\n`, 'utf8');
    }

    await tar.c({ gzip: true, file: tarballPath, cwd: tmp, portable: true }, ['package']);

    await patchPackedTarballForBun({ tarballPath, env: {} });

    const extracted = createTempDirSync('happier-cli-postpack-voice-runtime-incomplete-extract-');
    await tar.x({ file: tarballPath, cwd: extracted, strict: true });

    const patchedPkg = JSON.parse(
      readFileSync(join(extracted, 'package', 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

    expect(patchedPkg.dependencies).toEqual({
      '@huggingface/transformers': '^3.8.1',
      'ffmpeg-static': '5.2.0',
      'sherpa-onnx-node': '^1.12.38',
      tweetnacl: '^1.0.3',
    });
    expect(patchedPkg.optionalDependencies).toEqual({
      'sherpa-onnx-darwin-arm64': '1.12.38',
    });
  });

  it('restores the published cli bin contract when missing from packed package.json', async () => {
    const tmp = createTempDirSync('happier-cli-postpack-bin-contract-');
    const packageDir = join(tmp, 'package');
    const tarballPath = join(tmp, 'artifact.tgz');

    const pkgJsonPath = join(packageDir, 'package.json');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      pkgJsonPath,
      `${JSON.stringify({
        name: '@happier-dev/cli',
        version: '0.2.6',
        dependencies: {
          tweetnacl: '^1.0.3',
        },
      }, null, 2)}\n`,
      'utf8',
    );

    await tar.c({ gzip: true, file: tarballPath, cwd: tmp, portable: true }, ['package']);
    await patchPackedTarballForBun({ tarballPath, env: {} });

    const extracted = createTempDirSync('happier-cli-postpack-bin-contract-extract-');
    await tar.x({ file: tarballPath, cwd: extracted, strict: true });

    const patchedPkgRaw = readFileSync(join(extracted, 'package', 'package.json'), 'utf8');
    const patchedPkg = JSON.parse(patchedPkgRaw) as {
      bin?: Record<string, string>;
    };

    expect(patchedPkg.bin).toEqual({
      happier: './bin/happier.mjs',
      'happier-dev': './bin/happier-dev.mjs',
      'happier-mcp': './bin/happier-mcp.mjs',
    });
  });

  it('avoids a cross-device final rename by creating the complete replacement beside the destination', async () => {
    const tmp = createTempDirSync('happier-cli-postpack-cross-device-');
    const packageDir = join(tmp, 'package');
    const tarballPath = join(tmp, 'artifact.tgz');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      `${JSON.stringify({
        name: '@happier-dev/cli',
        version: '0.2.10',
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
          tweetnacl: '^1.0.3',
        },
      }, null, 2)}\n`,
      'utf8',
    );
    await tar.c({ gzip: true, file: tarballPath, cwd: tmp, portable: true }, ['package']);

    const actualRenameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((sourcePath, destinationPath) => {
      if (String(destinationPath) === tarballPath && dirname(String(sourcePath)) !== dirname(tarballPath)) {
        const error = new Error('EXDEV: injected cross-device postpack promotion failure') as NodeJS.ErrnoException;
        error.code = 'EXDEV';
        throw error;
      }
      actualRenameSync(sourcePath, destinationPath);
    });

    await expect(patchPackedTarballForBun({ tarballPath, env: {} })).resolves.toEqual({ tarballPath });

    const extracted = createTempDirSync('happier-cli-postpack-cross-device-extract-');
    await tar.x({ file: tarballPath, cwd: extracted, strict: true });
    const patchedPkg = JSON.parse(
      readFileSync(join(extracted, 'package', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(patchedPkg.dependencies).toEqual({ tweetnacl: '^1.0.3' });
    expect(readdirSync(tmp).sort()).toEqual(['artifact.tgz', 'package']);
  });

  it.each(['EPERM', 'EEXIST'] as const)(
    'replaces an existing destination after Windows-shaped %s overwrite failure',
    async (renameErrorCode) => {
      const tmp = createTempDirSync('happier-cli-postpack-windows-replace-');
      const packageDir = join(tmp, 'package');
      const tarballPath = join(tmp, 'artifact.tgz');
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(packageDir, 'package.json'),
        `${JSON.stringify({ name: '@happier-dev/cli', version: '0.2.10' }, null, 2)}\n`,
        'utf8',
      );
      await tar.c({ gzip: true, file: tarballPath, cwd: tmp, portable: true }, ['package']);

      const actualRenameSync = fs.renameSync.bind(fs);
      vi.spyOn(fs, 'renameSync').mockImplementation((sourcePath, destinationPath) => {
        if (String(destinationPath) === tarballPath && fs.existsSync(tarballPath)) {
          const error = new Error(
            `${renameErrorCode}: injected Windows existing-destination replacement failure`,
          ) as NodeJS.ErrnoException;
          error.code = renameErrorCode;
          throw error;
        }
        actualRenameSync(sourcePath, destinationPath);
      });

      await expect(patchPackedTarballForBun({ tarballPath, env: {} })).resolves.toEqual({ tarballPath });
      expect(readdirSync(tmp).sort()).toEqual(['artifact.tgz', 'package']);
    },
  );

  it('restores the existing destination and cleans staging when promotion fails after Windows fallback', async () => {
    const tmp = createTempDirSync('happier-cli-postpack-windows-rollback-');
    const packageDir = join(tmp, 'package');
    const tarballPath = join(tmp, 'artifact.tgz');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      `${JSON.stringify({ name: '@happier-dev/cli', version: '0.2.10' }, null, 2)}\n`,
      'utf8',
    );
    await tar.c({ gzip: true, file: tarballPath, cwd: tmp, portable: true }, ['package']);
    const originalTarball = readFileSync(tarballPath);

    const actualRenameSync = fs.renameSync.bind(fs);
    let injectedPromotionFailure = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((sourcePath, destinationPath) => {
      if (String(destinationPath) === tarballPath && fs.existsSync(tarballPath)) {
        const error = new Error('EPERM: injected Windows existing-destination replacement failure') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      if (
        String(destinationPath) === tarballPath
        && String(sourcePath).includes('.postpack-staging-')
        && !injectedPromotionFailure
      ) {
        injectedPromotionFailure = true;
        const error = new Error('EIO: injected destination-local promotion failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      actualRenameSync(sourcePath, destinationPath);
    });

    await expect(patchPackedTarballForBun({ tarballPath, env: {} })).rejects.toMatchObject({ code: 'EIO' });

    expect(readFileSync(tarballPath)).toEqual(originalTarball);
    expect(readdirSync(tmp).sort()).toEqual(['artifact.tgz', 'package']);
  });
});
