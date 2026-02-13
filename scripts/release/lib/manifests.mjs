export const MANIFEST_SCHEMA_VERSION = 'v1';

const PRODUCT_NAMES = new Set(['happier', 'hstack', 'happier-server']);

export function parseArtifactFilename(name) {
  const raw = String(name ?? '').trim();
  const match = /^(happier|hstack|happier-server)-v(.+)-([a-z]+)-(x64|arm64)\.tar\.gz$/.exec(raw);
  if (!match) return null;
  const [, product, version, os, arch] = match;
  return { product, version, os, arch, filename: raw };
}

export function assertValidProduct(product) {
  const value = String(product ?? '').trim();
  if (!PRODUCT_NAMES.has(value)) {
    throw new Error(`[release] invalid product "${value}" (expected happier|hstack|happier-server)`);
  }
  return value;
}

export function buildManifestRecord(params) {
  const product = assertValidProduct(params.product);
  const channel = String(params.channel ?? '').trim();
  if (channel !== 'stable' && channel !== 'preview') {
    throw new Error(`[release] invalid channel "${channel}"`);
  }
  const version = String(params.version ?? '').trim();
  const os = String(params.os ?? '').trim();
  const arch = String(params.arch ?? '').trim();
  const url = String(params.url ?? '').trim();
  const sha256 = String(params.sha256 ?? '').trim();
  if (!version || !os || !arch || !url || !sha256) {
    throw new Error('[release] manifest record requires version/os/arch/url/sha256');
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    product,
    channel,
    version,
    os,
    arch,
    url,
    sha256,
    signature: params.signature ?? null,
    publishedAt: params.publishedAt ?? new Date().toISOString(),
    minSupportedVersion: params.minSupportedVersion ?? null,
    rolloutPercent: Number(params.rolloutPercent ?? 100),
    critical: Boolean(params.critical ?? false),
    notesUrl: params.notesUrl ?? null,
    build: {
      commitSha: params.commitSha ?? null,
      workflowRunId: params.workflowRunId ?? null,
    },
  };
}
