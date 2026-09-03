#!/usr/bin/env node

// @ts-check

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  normalizeRollingBaseVersion,
  validateExactRollingPublishVersion,
} from './lib/rolling-version-allocation.mjs';
import { normalizePublicReleaseChannel } from './lib/public-release-rings.mjs';
import { resolveImmutableCandidateIdentity } from './lib/immutable-release-candidate.mjs';

/** @type {readonly Readonly<{
 *   key: 'cli' | 'stack' | 'server' | 'ui-web';
 *   option: 'candidate-cli-version' | 'candidate-stack-version' | 'candidate-server-version' | 'candidate-ui-web-version';
 *   productId: 'cli' | 'stack' | 'server' | 'ui-web';
 * }>[]} */
const CANDIDATES = Object.freeze([
  Object.freeze({ key: 'cli', option: 'candidate-cli-version', productId: 'cli' }),
  Object.freeze({ key: 'stack', option: 'candidate-stack-version', productId: 'stack' }),
  Object.freeze({ key: 'server', option: 'candidate-server-version', productId: 'server' }),
  Object.freeze({ key: 'ui-web', option: 'candidate-ui-web-version', productId: 'ui-web' }),
]);

/**
 * @param {{
 *   channel: string;
 *   versions: Partial<Record<'cli' | 'stack' | 'server' | 'ui-web', string>>;
 * }} input
 */
export function validateCandidateVersions(input) {
  const requestedChannel = String(input.channel ?? '');
  if (!['dev', 'preview', 'production', 'stable'].includes(requestedChannel)) {
    throw new Error(`[release] unsupported candidate verification channel: ${requestedChannel || '<empty>'}`);
  }
  const channel = normalizePublicReleaseChannel(requestedChannel);
  if (!channel) {
    throw new Error(`[release] unsupported candidate verification channel: ${requestedChannel}`);
  }
  /** @type {Record<'cli' | 'stack' | 'server' | 'ui-web', string>} */
  const versions = { cli: '', stack: '', server: '', 'ui-web': '' };
  for (const candidate of CANDIDATES) {
    const version = String(input.versions[candidate.key] ?? '');
    if (!version) continue;
    if (version.trim() !== version) throw new Error(`[release] Invalid version: ${version}`);
    versions[candidate.key] = validateExactRollingPublishVersion({
      productId: candidate.productId,
      channel,
      baseVersion: normalizeRollingBaseVersion(version),
      version,
    });
  }
  return { channel, versions };
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === 'object'
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {string} url @param {string} token */
async function githubJson(url, token) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'happier-release-candidate-verification',
    },
  });
  if (!response.ok) {
    throw new Error(`[release] candidate identity lookup failed (${response.status})`);
  }
  return response.json();
}

/**
 * @param {string} baseUrl
 * @param {string} repository
 * @param {string} tag
 * @param {string} token
 */
async function resolveTagCommit(baseUrl, repository, tag, token) {
  const payload = asRecord(await githubJson(
    `${baseUrl}/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
    token,
  ));
  let object = asRecord(payload.object);
  for (let depth = 0; depth < 5 && object.type === 'tag'; depth += 1) {
    const tagSha = String(object.sha ?? '');
    if (!/^[a-f0-9]{40}$/i.test(tagSha)) {
      throw new Error(`[release] ${tag} annotated tag object SHA is invalid`);
    }
    const tagPayload = asRecord(await githubJson(
      `${baseUrl}/repos/${repository}/git/tags/${tagSha}`,
      token,
    ));
    object = asRecord(tagPayload.object);
  }
  const commitSha = String(object.sha ?? '').toLowerCase();
  if (object.type !== 'commit' || !/^[a-f0-9]{40}$/.test(commitSha)) {
    throw new Error(`[release] ${tag} does not resolve to a commit`);
  }
  return commitSha;
}

/**
 * @param {string[]} [argv]
 * @param {Record<string, string | undefined>} [environment]
 */
export async function main(argv = process.argv.slice(2), environment = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repository: { type: 'string' },
      channel: { type: 'string' },
      'candidate-source-sha': { type: 'string' },
      'candidate-cli-version': { type: 'string', default: '' },
      'candidate-stack-version': { type: 'string', default: '' },
      'candidate-server-version': { type: 'string', default: '' },
      'candidate-ui-web-version': { type: 'string', default: '' },
      'candidate-product': { type: 'string', default: '' },
      'candidate-version': { type: 'string', default: '' },
      'api-base-url': { type: 'string', default: 'https://api.github.com' },
    },
    allowPositionals: false,
  });
  const candidateProduct = String(values['candidate-product'] ?? '');
  const candidateVersion = String(values['candidate-version'] ?? '');
  if (Boolean(candidateProduct) !== Boolean(candidateVersion)) {
    throw new Error('[release] --candidate-product and --candidate-version must be supplied together');
  }
  const productKey = candidateProduct === 'hstack' ? 'stack' : candidateProduct;
  if (productKey && !CANDIDATES.some((candidate) => candidate.key === productKey)) {
    throw new Error(`[release] unsupported candidate product: ${candidateProduct}`);
  }
  const explicitVersions = {
    cli: String(values['candidate-cli-version'] ?? ''),
    stack: String(values['candidate-stack-version'] ?? ''),
    server: String(values['candidate-server-version'] ?? ''),
    'ui-web': String(values['candidate-ui-web-version'] ?? ''),
  };
  if (productKey) {
    if (Object.values(explicitVersions).some(Boolean)) {
      throw new Error('[release] generic and product-specific candidate options cannot be combined');
    }
    explicitVersions[/** @type {'cli' | 'stack' | 'server' | 'ui-web'} */ (productKey)] = candidateVersion;
  }
  const validated = validateCandidateVersions({
    channel: String(values.channel ?? ''),
    versions: explicitVersions,
  });
  const repository = String(values.repository ?? '').trim();
  const candidateSourceSha = String(values['candidate-source-sha'] ?? '').trim().toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error('[release] repository must be owner/repo');
  }
  if (!/^[a-f0-9]{40}$/.test(candidateSourceSha)) {
    throw new Error('[release] candidate source SHA must be a full commit ID');
  }
  const token = String(environment.GITHUB_TOKEN ?? '').trim();
  if (!token) throw new Error('[release] GITHUB_TOKEN is required');
  const baseUrl = String(values['api-base-url'] ?? '').replace(/\/+$/u, '');
  const resolved = [];
  for (const candidate of CANDIDATES) {
    const version = validated.versions[candidate.key];
    if (!version) continue;
    const tag = resolveImmutableCandidateIdentity({ product: candidate.productId, version }).sourceTag;
    const sha = await resolveTagCommit(baseUrl, repository, tag, token);
    if (sha !== candidateSourceSha) {
      throw new Error(`[release] immutable tag ${tag} does not identify the candidate source SHA`);
    }
    resolved.push({ product: candidate.key, version, tag, sha });
  }
  const result = { ok: true, candidateSourceSha, channel: validated.channel, resolved };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
