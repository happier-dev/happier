type RawAsset = {
  name?: unknown;
  browser_download_url?: unknown;
  url?: unknown;
};

function normalizeAsset(asset: RawAsset) {
  const name = String(asset?.name ?? '').trim();
  const url = String(asset?.browser_download_url ?? asset?.url ?? '').trim();
  return name && url ? { name, url } : null;
}

const VERSION_RE = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?';

export function resolveReleaseAssetBundle({
  assets,
  product,
  os,
  arch,
  preferZipOnWindows = true,
}: {
  assets: unknown;
  product: string;
  os: string;
  arch: string;
  preferZipOnWindows?: boolean;
}) {
  const list = Array.isArray(assets) ? assets : [];
  const byName = new Map<string, { name: string; url: string }>();
  for (const asset of list) {
    const normalized = normalizeAsset(asset as RawAsset);
    if (!normalized) continue;
    byName.set(normalized.name, normalized);
  }

  const checksumsRe = new RegExp(`^checksums-${product}-v(${VERSION_RE})\\.txt$`);
  const checksumsName = [...byName.keys()].find((name) => checksumsRe.test(name)) ?? '';
  if (!checksumsName) {
    throw new Error(`[release-assets] missing checksums-${product}-v<version>.txt asset`);
  }
  const versionMatch = checksumsRe.exec(checksumsName);
  const version = versionMatch?.[1] ?? '';
  if (!version) {
    throw new Error(`[release-assets] unable to derive version from checksums filename: ${checksumsName}`);
  }

  const checksumsSigName = `${checksumsName}.minisig`;
  const base = `${product}-v${version}-${os}-${arch}`;
  const zipName = `${base}.zip`;
  const tgzName = `${base}.tar.gz`;
  const archiveName =
    os.toLowerCase() === 'windows' && preferZipOnWindows && byName.has(zipName)
      ? zipName
      : tgzName;

  const checksums = byName.get(checksumsName) ?? null;
  const checksumsSig = byName.get(checksumsSigName) ?? null;
  const archive = byName.get(archiveName) ?? null;

  if (!checksums) throw new Error(`[release-assets] missing release asset: ${checksumsName}`);
  if (!checksumsSig) throw new Error(`[release-assets] missing release asset: ${checksumsSigName}`);
  if (!archive) throw new Error(`[release-assets] missing release asset: ${archiveName}`);

  return { version, archive, checksums, checksumsSig };
}
