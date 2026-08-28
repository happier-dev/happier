// @ts-check

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const SERVER_RUNTIME_TARGETS = Object.freeze([
  Object.freeze({ os: 'darwin', arch: 'arm64' }),
  Object.freeze({ os: 'darwin', arch: 'x64' }),
  Object.freeze({ os: 'linux', arch: 'arm64' }),
  Object.freeze({ os: 'linux', arch: 'x64' }),
  Object.freeze({ os: 'windows', arch: 'x64' }),
]);

export const SERVER_RUNTIME_CANDIDATE_MAX_FILE_BYTES = 512 * 1024 * 1024;
export const SERVER_RUNTIME_CANDIDATE_MAX_AGGREGATE_BYTES = 2 * 1024 * 1024 * 1024;

function assertVersion(version) {
  const value = String(version ?? '').trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(value)) {
    throw new Error(`Invalid server runtime candidate version: ${value || '<empty>'}`);
  }
  return value;
}

function expectedNames(version) {
  return SERVER_RUNTIME_TARGETS
    .map(({ os, arch }) => `happier-server-v${version}-${os}-${arch}.tar.gz`)
    .sort();
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/**
 * Treats an Actions artifact directory as hostile, opaque data. It never opens or extracts an archive.
 * @param {{ candidateDir: string; version: string; maxFileBytes?: number; maxAggregateBytes?: number }} params
 */
export async function inspectServerRuntimeCandidate(params) {
  const candidateDir = resolve(params.candidateDir);
  const version = assertVersion(params.version);
  const maxFileBytes = params.maxFileBytes ?? SERVER_RUNTIME_CANDIDATE_MAX_FILE_BYTES;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new Error('candidate max file size must be a positive safe integer');
  }
  const maxAggregateBytes = params.maxAggregateBytes ?? SERVER_RUNTIME_CANDIDATE_MAX_AGGREGATE_BYTES;
  if (!Number.isSafeInteger(maxAggregateBytes) || maxAggregateBytes <= 0) {
    throw new Error('candidate aggregate max size must be a positive safe integer');
  }

  const expected = expectedNames(version);
  const entries = await readdir(candidateDir, { withFileTypes: true });
  const actual = entries.map((entry) => entry.name).sort();
  const unexpected = actual.filter((name) => !expected.includes(name));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected candidate file(s): ${unexpected.join(', ')}`);
  }
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`Candidate file set mismatch: expected ${expected.join(', ')}`);
  }

  const candidateFiles = [];
  let aggregateBytes = 0;
  for (const name of expected) {
    const filePath = join(candidateDir, name);
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Candidate entry must be a regular file, not a symbolic link: ${name}`);
    }
    if (metadata.size <= 0 || metadata.size > maxFileBytes) {
      throw new Error(`Candidate file size is outside the allowed range: ${name} (${metadata.size} bytes)`);
    }
    aggregateBytes += metadata.size;
    if (aggregateBytes > maxAggregateBytes) {
      throw new Error(
        `Candidate aggregate size exceeds the allowed range (actual=${aggregateBytes}, max=${maxAggregateBytes}, file=${name})`,
      );
    }
    candidateFiles.push({ name, path: filePath, size: metadata.size });
  }
  const artifacts = [];
  for (const candidateFile of candidateFiles) {
    artifacts.push({ ...candidateFile, sha256: await sha256(candidateFile.path) });
  }
  return { candidateDir, version, artifacts };
}

/**
 * Copies only validated opaque archives into a clean trusted directory, then regenerates and signs checksums.
 * @param {{
 *   candidateDir: string;
 *   outDir: string;
 *   version: string;
 *   authorizedSha: string;
 *   maxFileBytes?: number;
 *   maxAggregateBytes?: number;
 *   sign: (checksumsPath: string) => Promise<unknown>;
 * }} params
 */
export async function finalizeServerRuntimeCandidate(params) {
  const authorizedSha = String(params.authorizedSha ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(authorizedSha)) {
    throw new Error('An externally authorized SHA (full 40-character commit id) is required');
  }
  if (typeof params.sign !== 'function') {
    throw new Error('A trusted signing function is required');
  }
  const inspected = await inspectServerRuntimeCandidate(params);
  const outDir = resolve(params.outDir);
  if (outDir === inspected.candidateDir) {
    throw new Error('Trusted output directory must differ from candidate directory');
  }
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  for (const artifact of inspected.artifacts) {
    await copyFile(artifact.path, join(outDir, basename(artifact.name)));
  }
  const checksums = `${inspected.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join('\n')}\n`;
  const checksumsPath = join(outDir, `checksums-happier-server-v${inspected.version}.txt`);
  await writeFile(checksumsPath, checksums, { encoding: 'utf8', mode: 0o600 });
  await params.sign(checksumsPath);
  const signaturePath = `${checksumsPath}.minisig`;
  const signatureMetadata = await lstat(signaturePath);
  if (!signatureMetadata.isFile() || signatureMetadata.isSymbolicLink() || signatureMetadata.size <= 0) {
    throw new Error('Trusted signing did not produce a regular non-empty signature file');
  }
  return {
    authorizedSha,
    version: inspected.version,
    artifacts: inspected.artifacts,
    checksums,
    checksumsPath,
    signaturePath,
    outDir,
  };
}
