import { resolveReleaseAssetBundle } from '@happier-dev/release-runtime/assets';

export function resolveServerReleaseAssets({ release, os, arch }) {
  const resolved = resolveReleaseAssetBundle({
    assets: release?.assets,
    product: 'happier-server',
    os,
    arch,
    preferZipOnWindows: true,
  });
  return {
    version: resolved.version,
    tarball: resolved.archive,
    checksums: resolved.checksums,
    checksumsSig: resolved.checksumsSig,
  };
}

export function resolveUiWebReleaseAssets({ release }) {
  const resolved = resolveReleaseAssetBundle({
    assets: release?.assets,
    product: 'happier-ui-web',
    os: 'web',
    arch: 'any',
    preferZipOnWindows: false,
  });
  return {
    version: resolved.version,
    tarball: resolved.archive,
    checksums: resolved.checksums,
    checksumsSig: resolved.checksumsSig,
  };
}
