#!/usr/bin/env node

// @ts-check

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { normalizeChannel, parseArgs } from './lib/binary-release.mjs';
import { buildManifestRecord, parseArtifactFilename } from './lib/manifests.mjs';

function parseChecksums(raw) {
  const map = new Map();
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([a-fA-F0-9]{64})\s{2}(.+)$/.exec(trimmed);
    if (!match) continue;
    map.set(match[2], match[1].toLowerCase());
  }
  return map;
}

function ensureUrlBase(baseUrl) {
  const value = String(baseUrl ?? '').trim();
  if (!value) {
    throw new Error('[release] --assets-base-url is required');
  }
  return value.replace(/\/+$/, '');
}

function toBool(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'y';
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function main() {
  const { kv } = parseArgs(process.argv.slice(2));
  const product = String(kv.get('--product') ?? '').trim();
  if (!product) {
    throw new Error('[release] --product is required (happier|hstack|happier-server)');
  }
  const channel = normalizeChannel(kv.get('--channel'));
  const artifactsDir = resolve(String(kv.get('--artifacts-dir') ?? '').trim() || join(process.cwd(), 'dist', 'release-assets'));
  const outDir = resolve(String(kv.get('--out-dir') ?? '').trim() || join(process.cwd(), 'dist', 'manifests'));
  const assetsBaseUrl = ensureUrlBase(kv.get('--assets-base-url'));
  const rolloutPercent = Number(kv.get('--rollout-percent') ?? 100);
  const critical = toBool(kv.get('--critical'));
  const notesUrl = String(kv.get('--notes-url') ?? '').trim() || null;
  const minSupportedVersion = String(kv.get('--min-supported-version') ?? '').trim() || null;
  const commitSha = String(kv.get('--commit-sha') ?? process.env.GITHUB_SHA ?? '').trim() || null;
  const workflowRunId = String(kv.get('--workflow-run-id') ?? process.env.GITHUB_RUN_ID ?? '').trim() || null;

  const entries = await readdir(artifactsDir);
  const parsedArtifacts = entries
    .filter((name) => name.endsWith('.tar.gz'))
    .map((name) => parseArtifactFilename(name))
    .filter(Boolean)
    .filter((artifact) => artifact.product === product);
  if (parsedArtifacts.length === 0) {
    throw new Error(`[release] no artifacts found for product "${product}" in ${artifactsDir}`);
  }

  const version = String(kv.get('--version') ?? '').trim() || parsedArtifacts[0].version;
  const checksumsPath = join(artifactsDir, `checksums-${product}-v${version}.txt`);
  const checksumsRaw = await readFile(checksumsPath, 'utf-8');
  const checksums = parseChecksums(checksumsRaw);
  const checksumsSigName = `checksums-${product}-v${version}.txt.minisig`;
  const checksumsSigPresent = entries.includes(checksumsSigName);
  if (!checksumsSigPresent) {
    throw new Error(`[release] minisign signature asset missing: ${checksumsSigName}`);
  }

  const records = [];
  for (const artifact of parsedArtifacts) {
    if (artifact.version !== version) continue;
    const sha256 = checksums.get(artifact.filename);
    if (!sha256) {
      throw new Error(`[release] checksum missing for ${artifact.filename}`);
    }
    const record = buildManifestRecord({
      product,
      channel,
      version,
      os: artifact.os,
      arch: artifact.arch,
      url: `${assetsBaseUrl}/${artifact.filename}`,
      sha256,
      signature: `${assetsBaseUrl}/${checksumsSigName}`,
      rolloutPercent,
      critical,
      notesUrl,
      minSupportedVersion,
      commitSha,
      workflowRunId,
    });
    records.push(record);

    const platformManifestPath = join(outDir, 'v1', product, channel, `${artifact.os}-${artifact.arch}.json`);
    await writeJson(platformManifestPath, record);
  }

  const latestManifest = {
    schemaVersion: 'v1',
    product,
    channel,
    version,
    publishedAt: new Date().toISOString(),
    records,
  };
  const latestPath = join(outDir, 'v1', product, channel, 'latest.json');
  await writeJson(latestPath, latestManifest);

  console.log(JSON.stringify({
    ok: true,
    product,
    channel,
    version,
    artifactsDir,
    outDir,
    records: records.length,
    latestPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
