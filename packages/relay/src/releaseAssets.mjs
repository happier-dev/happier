export function resolveServerReleaseAssets({ release, os, arch }) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const byName = new Map();
  for (const asset of assets) {
    const name = String(asset?.name ?? '');
    const url = String(asset?.browser_download_url ?? '');
    if (!name || !url) continue;
    byName.set(name, { name, url });
  }

  const checksumsName = [...byName.keys()].find((name) => /^checksums-happier-server-v\d+\.\d+\.\d+\.txt$/.test(name));
  if (!checksumsName) {
    throw new Error('[server] missing checksums-happier-server-v<version>.txt asset');
  }
  const versionMatch = /^checksums-happier-server-v(\d+\.\d+\.\d+)\.txt$/.exec(checksumsName);
  const version = versionMatch?.[1] ?? null;
  if (!version) {
    throw new Error('[server] unable to derive server version from checksums filename');
  }

  const checksumsSigName = `${checksumsName}.minisig`;
  const tarballName = `happier-server-v${version}-${os}-${arch}.tar.gz`;

  const checksums = byName.get(checksumsName) ?? null;
  const checksumsSig = byName.get(checksumsSigName) ?? null;
  const tarball = byName.get(tarballName) ?? null;

  if (!checksums) throw new Error(`[server] missing release asset: ${checksumsName}`);
  if (!checksumsSig) throw new Error(`[server] missing release asset: ${checksumsSigName}`);
  if (!tarball) throw new Error(`[server] missing release asset: ${tarballName}`);

  return { version, tarball, checksums, checksumsSig };
}
