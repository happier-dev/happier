#!/usr/bin/env node

import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  assertPackedCliEntrypoint,
  assertPackedAuthorCandidateArchivesSafe,
  assertPackedPluginUiSdkDependency,
  assertPackedPackageIdentity,
  readPackedPackageManifest,
  sha512Sri,
} from './packed-author-artifact-boundary.mjs';
const SDK_PACKAGE_NAME = '@happier-dev/plugin-sdk';
const PLUGIN_UI_PACKAGE_NAME = '@happier-dev/plugin-ui';
const CHANNELS_PROTOCOL_PACKAGE_NAME = '@happier-dev/channels-protocol';
const CLI_PACKAGE_NAME = '@happier-dev/cli';

function fail(message) {
  throw new Error(message);
}

function assertPackedChannelsProtocolPublicExports(packageManifest) {
  const expectedExports = {
    '.': {
      types: './dist/index.d.ts',
      default: './dist/index.js',
    },
    './v1': {
      types: './dist/v1/index.d.ts',
      default: './dist/v1/index.js',
    },
    './testing/v1': {
      types: './dist/testing/v1/index.d.ts',
      default: './dist/testing/v1/index.js',
    },
  };
  const exports = packageManifest?.exports;
  if (
    !exports
    || typeof exports !== 'object'
    || Array.isArray(exports)
    || packageManifest?.main !== './dist/index.js'
    || packageManifest?.types !== './dist/index.d.ts'
    || JSON.stringify(Object.keys(exports).sort())
      !== JSON.stringify(Object.keys(expectedExports).sort())
    || Object.entries(expectedExports).some(([key, expected]) => {
      const entry = exports[key];
      return !entry
        || typeof entry !== 'object'
        || Array.isArray(entry)
        || entry.types !== expected.types
        || entry.default !== expected.default
        || JSON.stringify(Object.keys(entry).sort())
          !== JSON.stringify(['default', 'types']);
    })
  ) {
    fail('Packed Channels protocol public exports are not the exact root, /v1, and /testing/v1 surface');
  }
}

export async function createPackedAuthorCandidate(params) {
  if (Object.hasOwn(params, 'standaloneCliArtifactPath')) {
    fail('Packed npm-pair attestation does not accept native artifacts');
  }
  const channelsProtocolTarballPath = params.channelsProtocolTarballPath;
  if (
    channelsProtocolTarballPath !== undefined
    && (typeof channelsProtocolTarballPath !== 'string'
      || channelsProtocolTarballPath.trim().length === 0)
  ) {
    fail('Packed Channels protocol tarball path must be a non-empty string when supplied');
  }
  const extractionRoot = await mkdtemp(join(tmpdir(), 'happier-packed-candidate-'));
  try {
    const [sdkBytes, pluginUiBytes, cliBytes, channelsProtocolBytes] = await Promise.all([
      readFile(params.sdkTarballPath),
      readFile(params.pluginUiTarballPath),
      readFile(params.cliTarballPath),
      ...(channelsProtocolTarballPath === undefined
        ? []
        : [readFile(channelsProtocolTarballPath)]),
    ]);
    const sdkAttestedCopyPath = join(extractionRoot, 'sdk-attested.tgz');
    const pluginUiAttestedCopyPath = join(extractionRoot, 'plugin-ui-attested.tgz');
    const channelsProtocolAttestedCopyPath = join(
      extractionRoot,
      'channels-protocol-attested.tgz',
    );
    const cliAttestedCopyPath = join(extractionRoot, 'cli-attested.tgz');
    await Promise.all([
      writeFile(sdkAttestedCopyPath, sdkBytes, { flag: 'wx' }),
      writeFile(pluginUiAttestedCopyPath, pluginUiBytes, { flag: 'wx' }),
      ...(channelsProtocolTarballPath === undefined
        ? []
        : [writeFile(
            channelsProtocolAttestedCopyPath,
            channelsProtocolBytes,
            { flag: 'wx' },
          )]),
      writeFile(cliAttestedCopyPath, cliBytes, { flag: 'wx' }),
    ]);
    await assertPackedAuthorCandidateArchivesSafe({
      sdkTarballPath: sdkAttestedCopyPath,
      pluginUiTarballPath: pluginUiAttestedCopyPath,
      ...(channelsProtocolTarballPath === undefined
        ? {}
        : { channelsProtocolTarballPath: channelsProtocolAttestedCopyPath }),
      cliTarballPath: cliAttestedCopyPath,
    });
    const [sdkManifest, pluginUiManifest, cliManifest, channelsProtocolManifest] = await Promise.all([
      readPackedPackageManifest(sdkAttestedCopyPath, join(extractionRoot, 'sdk')),
      readPackedPackageManifest(pluginUiAttestedCopyPath, join(extractionRoot, 'plugin-ui')),
      readPackedPackageManifest(cliAttestedCopyPath, join(extractionRoot, 'cli')),
      ...(channelsProtocolTarballPath === undefined
        ? []
        : [readPackedPackageManifest(
            channelsProtocolAttestedCopyPath,
            join(extractionRoot, 'channels-protocol'),
          )]),
    ]);
    const sdkArtifact = { packageName: SDK_PACKAGE_NAME, version: sdkManifest.version };
    const pluginUiArtifact = {
      packageName: PLUGIN_UI_PACKAGE_NAME,
      version: pluginUiManifest.version,
    };
    const cliArtifact = {
      packageName: CLI_PACKAGE_NAME,
      version: cliManifest.version,
      entrypoint: 'package/bin/happier.mjs',
    };
    assertPackedPackageIdentity(sdkManifest, sdkArtifact, 'Packed SDK');
    assertPackedPackageIdentity(pluginUiManifest, pluginUiArtifact, 'Packed Plugin UI');
    const pluginSdkVersion = assertPackedPluginUiSdkDependency(pluginUiManifest, sdkArtifact);
    const channelsProtocolArtifact = channelsProtocolManifest === undefined
      ? null
      : {
          packageName: CHANNELS_PROTOCOL_PACKAGE_NAME,
          version: channelsProtocolManifest.version,
        };
    if (channelsProtocolArtifact) {
      assertPackedPackageIdentity(
        channelsProtocolManifest,
        channelsProtocolArtifact,
        'Packed Channels protocol',
      );
      assertPackedChannelsProtocolPublicExports(channelsProtocolManifest);
    }
    assertPackedPackageIdentity(cliManifest, cliArtifact, 'Packed CLI');
    assertPackedCliEntrypoint(cliManifest, cliArtifact);
    return {
      runId: params.runId,
      sdk: {
        ...sdkArtifact,
        integrity: sha512Sri(sdkBytes),
        tarballPath: resolve(params.sdkTarballPath),
      },
      pluginUi: {
        ...pluginUiArtifact,
        pluginSdkVersion,
        integrity: sha512Sri(pluginUiBytes),
        tarballPath: resolve(params.pluginUiTarballPath),
      },
      ...(channelsProtocolArtifact
        ? {
            channelsProtocol: {
              ...channelsProtocolArtifact,
              integrity: sha512Sri(channelsProtocolBytes),
              tarballPath: resolve(channelsProtocolTarballPath),
            },
          }
        : {}),
      cli: {
        ...cliArtifact,
        integrity: sha512Sri(cliBytes),
        tarballPath: resolve(params.cliTarballPath),
      },
    };
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}
