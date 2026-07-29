#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertPackedCliEntrypoint,
  assertPackedAuthorCandidateArchivesSafe,
  assertPackedPackageIdentity,
  readPackedPackageManifest,
  sha512Sri,
} from './packed-author-artifact-boundary.mjs';
import {
  inspectTarArchiveEntries,
} from '@happier-dev/release-runtime/archiveExtraction';
import {
  parseArtifactFilename,
} from '../../../../scripts/pipeline/release/lib/manifests.mjs';

const SDK_PACKAGE_NAME = '@happier-dev/plugin-sdk';
const CLI_PACKAGE_NAME = '@happier-dev/cli';

function fail(message) {
  throw new Error(message);
}

function readFlag(argv, flag) {
  const index = argv.indexOf(flag);
  const value = index < 0 ? null : argv[index + 1];
  if (!value || value.startsWith('--')) fail(`Missing ${flag} <value>`);
  return value;
}

function readOptionalFlag(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail(`Missing ${flag} <value>`);
  return value;
}

export function parseCandidateCreatorArgs(argv) {
  const runId = readFlag(argv, '--run-id');
  if (!/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*$/u.test(runId) || runId.length > 64) {
    fail('Candidate run id must be a bounded lower-case identifier');
  }
  return {
    runId,
    sdkTarballPath: resolve(readFlag(argv, '--sdk-tarball')),
    cliTarballPath: resolve(readFlag(argv, '--cli-tarball')),
    standaloneCliArtifactPath:
      readOptionalFlag(argv, '--standalone-cli-artifact') === null
        ? null
        : resolve(readOptionalFlag(argv, '--standalone-cli-artifact')),
  };
}

export async function createPackedAuthorCandidate(params) {
  const extractionRoot = await mkdtemp(join(tmpdir(), 'happier-packed-candidate-'));
  try {
    const [sdkBytes, cliBytes, standaloneBytes] = await Promise.all([
      readFile(params.sdkTarballPath),
      readFile(params.cliTarballPath),
      params.standaloneCliArtifactPath
        ? readFile(params.standaloneCliArtifactPath)
        : Promise.resolve(null),
    ]);
    const sdkAttestedCopyPath = join(extractionRoot, 'sdk-attested.tgz');
    const cliAttestedCopyPath = join(extractionRoot, 'cli-attested.tgz');
    const standaloneAttestedCopyPath = standaloneBytes
      ? join(extractionRoot, 'standalone-attested.tar')
      : null;
    await Promise.all([
      writeFile(sdkAttestedCopyPath, sdkBytes, { flag: 'wx' }),
      writeFile(cliAttestedCopyPath, cliBytes, { flag: 'wx' }),
      ...(standaloneAttestedCopyPath && standaloneBytes
        ? [writeFile(standaloneAttestedCopyPath, standaloneBytes, { flag: 'wx' })]
        : []),
    ]);
    await Promise.all([
      assertPackedAuthorCandidateArchivesSafe({
        sdkTarballPath: sdkAttestedCopyPath,
        cliTarballPath: cliAttestedCopyPath,
      }),
      ...(standaloneAttestedCopyPath
        ? [inspectTarArchiveEntries({ archivePath: standaloneAttestedCopyPath })]
        : []),
    ]);
    const [sdkManifest, cliManifest] = await Promise.all([
      readPackedPackageManifest(sdkAttestedCopyPath, join(extractionRoot, 'sdk')),
      readPackedPackageManifest(cliAttestedCopyPath, join(extractionRoot, 'cli')),
    ]);
    const sdkArtifact = { packageName: SDK_PACKAGE_NAME, version: sdkManifest.version };
    const cliArtifact = {
      packageName: CLI_PACKAGE_NAME,
      version: cliManifest.version,
      entrypoint: 'package/bin/happier.mjs',
    };
    assertPackedPackageIdentity(sdkManifest, sdkArtifact, 'Packed SDK');
    assertPackedPackageIdentity(cliManifest, cliArtifact, 'Packed CLI');
    assertPackedCliEntrypoint(cliManifest, cliArtifact);
    const standaloneIdentity = params.standaloneCliArtifactPath
      ? parseArtifactFilename(basename(params.standaloneCliArtifactPath))
      : null;
    if (
      params.standaloneCliArtifactPath
      && (
        !standaloneIdentity
        || standaloneIdentity.product !== 'happier'
        || standaloneIdentity.version !== cliArtifact.version
      )
    ) {
      fail('Standalone CLI artifact must be the same-version canonical happier native archive');
    }
    return {
      schemaVersion: 1,
      runId: params.runId,
      sdk: {
        ...sdkArtifact,
        integrity: sha512Sri(sdkBytes),
        tarballPath: resolve(params.sdkTarballPath),
      },
      cli: {
        ...cliArtifact,
        integrity: sha512Sri(cliBytes),
        tarballPath: resolve(params.cliTarballPath),
      },
      ...(standaloneIdentity && standaloneBytes
        ? {
            standaloneCli: {
              product: standaloneIdentity.product,
              version: standaloneIdentity.version,
              os: standaloneIdentity.os,
              arch: standaloneIdentity.arch,
              sha256: createHash('sha256').update(standaloneBytes).digest('hex'),
              archivePath: resolve(params.standaloneCliArtifactPath),
            },
          }
        : {}),
    };
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const candidate = await createPackedAuthorCandidate(parseCandidateCreatorArgs(argv));
    process.stdout.write(`${JSON.stringify(candidate, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${basename(process.argv[1] ?? 'create-packed-author-candidate')}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
