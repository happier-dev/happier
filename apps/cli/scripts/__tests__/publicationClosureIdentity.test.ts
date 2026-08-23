import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempDirSync, removeTempDirSync } from '../../src/testkit/fs/tempDir';
import { assertCliPublicationClosureIdentity } from '../packTarball.mjs';

const require = createRequire(import.meta.url);
const { writeCliDistBuildManifest } = require(
  '../../../../packages/cli-common/cliDistBuildManifest.cjs',
) as {
  writeCliDistBuildManifest: (
    entrypoint: string,
    options: Readonly<{ inputFingerprint: string }>,
  ) => { manifest: { fingerprint: string; inputFingerprint: string } };
};

const INPUT_FINGERPRINT_A = 'a'.repeat(64);
const INPUT_FINGERPRINT_B = 'b'.repeat(64);

/**
 * Builds a closure the same way the CLI build does: real output bytes, and the manifest
 * written by the one build-manifest producer over those bytes. A hand-written manifest
 * would not survive the reader's own fingerprint check, so the test cannot pass on a
 * fabricated closure.
 */
function writeClosure(
  packageRoot: string,
  directoryName: 'dist' | 'package-dist',
  options: Readonly<{ entrypointBody: string; inputFingerprint: string }>,
): string {
  const closureDir = resolve(packageRoot, directoryName);
  mkdirSync(closureDir, { recursive: true });
  const entrypoint = resolve(closureDir, 'index.mjs');
  writeFileSync(entrypoint, options.entrypointBody, 'utf8');
  return writeCliDistBuildManifest(entrypoint, {
    inputFingerprint: options.inputFingerprint,
  }).manifest.fingerprint;
}

describe('CLI publication closure identity', () => {
  it('accepts a package closure promoted from the dist build it ships beside', () => {
    const packageRoot = createTempDirSync('cli-publication-closure-');
    try {
      const built = { entrypointBody: 'export const build = 2;\n', inputFingerprint: INPUT_FINGERPRINT_A };
      const fingerprint = writeClosure(packageRoot, 'dist', built);
      writeClosure(packageRoot, 'package-dist', built);
      expect(assertCliPublicationClosureIdentity({ packageRoot })).toEqual({
        fingerprint,
        inputFingerprint: INPUT_FINGERPRINT_A,
      });
    } finally {
      removeTempDirSync(packageRoot);
    }
  });

  it('refuses a tarball whose package closure was built from a different source state', () => {
    const packageRoot = createTempDirSync('cli-publication-closure-');
    try {
      // Exactly what a skipped `syncPackageDist` leaves behind: a current `dist/` that
      // `assertCliPackInputCurrentness` accepts, beside a `package-dist/` from an older build.
      writeClosure(packageRoot, 'dist', {
        entrypointBody: 'export const build = 2;\n',
        inputFingerprint: INPUT_FINGERPRINT_A,
      });
      writeClosure(packageRoot, 'package-dist', {
        entrypointBody: 'export const build = 1;\n',
        inputFingerprint: INPUT_FINGERPRINT_B,
      });
      expect(() => assertCliPublicationClosureIdentity({ packageRoot })).toThrow(
        /publication closure is split: dist and package-dist disagree on fingerprint/,
      );
    } finally {
      removeTempDirSync(packageRoot);
    }
  });

  it('refuses a package closure whose outputs match but whose inputs do not', () => {
    const packageRoot = createTempDirSync('cli-publication-closure-');
    try {
      // The case an output-only comparison would wave through: identical emitted bytes
      // from two different source states.
      writeClosure(packageRoot, 'dist', {
        entrypointBody: 'export const build = 2;\n',
        inputFingerprint: INPUT_FINGERPRINT_A,
      });
      writeClosure(packageRoot, 'package-dist', {
        entrypointBody: 'export const build = 2;\n',
        inputFingerprint: INPUT_FINGERPRINT_B,
      });
      expect(() => assertCliPublicationClosureIdentity({ packageRoot })).toThrow(
        /disagree on inputFingerprint/,
      );
    } finally {
      removeTempDirSync(packageRoot);
    }
  });

  it('refuses a tarball with no package closure at all', () => {
    const packageRoot = createTempDirSync('cli-publication-closure-');
    try {
      writeClosure(packageRoot, 'dist', {
        entrypointBody: 'export const build = 2;\n',
        inputFingerprint: INPUT_FINGERPRINT_A,
      });
      expect(() => assertCliPublicationClosureIdentity({ packageRoot })).toThrow(
        /package-dist publication closure is unavailable/,
      );
    } finally {
      removeTempDirSync(packageRoot);
    }
  });
});
