#!/usr/bin/env node

// @ts-check

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  parseWorkflowRunPath,
  validateCandidateRun,
} from './verify-github-candidate-run.mjs';
import {
  normalizeRollingBaseVersion,
  validateExactRollingPublishVersion,
} from './lib/rolling-version-allocation.mjs';
import { normalizePublicReleaseChannel } from './lib/public-release-rings.mjs';

/** @type {readonly ('cli' | 'stack' | 'server' | 'ui-web')[]} */
const CANDIDATE_VERSION_PRODUCTS = ['cli', 'stack', 'server', 'ui-web'];

const IMMUTABLE_TAG_PREFIX = Object.freeze({
  cli: 'cli-v',
  stack: 'stack-v',
  server: 'server-v',
  'ui-web': 'ui-web-v',
});

const ROLLING_TAG_PREFIX = Object.freeze({
  cli: 'cli-',
  stack: 'stack-',
  server: 'server-',
  'ui-web': 'ui-web-',
});

const MANIFEST_PRODUCT = Object.freeze({
  cli: 'happier',
  stack: 'hstack',
  server: 'happier-server',
});

/** @param {string} value */
function parseCsv(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** @param {string} value @param {string} label */
function parseRunId(value, label) {
  if (!/^[0-9]+$/.test(value)) throw new Error(`[release] ${label} run ID must contain decimal digits`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`[release] ${label} run ID is outside the safe integer range`);
  }
  return parsed;
}

/** @param {unknown} value */
function parseManifestSpecs(value) {
  return parseCsv(String(value ?? '')).map((entry) => {
    const [product, channel, tag, ...extra] = entry.split(':');
    if (!product || !channel || !tag || extra.length > 0) {
      throw new Error('[release] candidate manifest specs must use product:channel:tag');
    }
    return { product, channel, tag };
  });
}

/** @param {{ product: string; channel: string; tag: string }} manifest */
function isCliManifestSpec(manifest) {
  return manifest.product === 'happier' && manifest.tag === `cli-${manifest.channel}`;
}

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
  for (const productId of CANDIDATE_VERSION_PRODUCTS) {
    const version = String(input.versions[productId] ?? '');
    if (!version) continue;
    if (version.trim() !== version) {
      throw new Error(`[release] Invalid version: ${version}`);
    }
    const baseVersion = normalizeRollingBaseVersion(version);
    versions[productId] = validateExactRollingPublishVersion({
      productId,
      channel,
      baseVersion,
      version,
    });
  }
  return { channel, versions };
}

/**
 * Resolve every mutable ref, immutable/rolling tag, and manifest that must
 * identify one candidate. GitHub workflows pass facts into this owner; they
 * do not independently recreate release-channel or product mappings.
 *
 * @param {{
 *   channel: string;
 *   versions: Partial<Record<'cli' | 'stack' | 'server' | 'ui-web', string>>;
 *   verifyDeploy: { ui: boolean; server: boolean; website: boolean; docs: boolean };
 *   verifyRelease: Record<'cli' | 'stack' | 'server' | 'ui-web', boolean>;
 * }} input
 */
export function resolveCandidateVerificationTargets(input) {
  const requestedChannel = String(input.channel ?? '');
  const { channel: normalizedChannel, versions } = validateCandidateVersions({
    channel: requestedChannel,
    versions: input.versions,
  });
  const stable = normalizedChannel === 'stable';
  const releaseSuffix = stable
    ? 'stable'
    : normalizedChannel === 'publicdev'
      ? 'dev'
      : 'preview';
  const deploymentChannel = stable ? 'production' : releaseSuffix;
  const sourceBranch = stable ? 'main' : releaseSuffix;
  const refs = [`heads/${sourceBranch}`];
  for (const target of /** @type {const} */ (['ui', 'server', 'website', 'docs'])) {
    if (input.verifyDeploy[target]) {
      refs.push(`heads/deploy/${deploymentChannel}/${target}`);
    }
  }

  const tags = [];
  const manifests = [];
  for (const product of CANDIDATE_VERSION_PRODUCTS) {
    if (!input.verifyRelease[product]) continue;
    const tag = versions[product]
      ? `${IMMUTABLE_TAG_PREFIX[product]}${versions[product]}`
      : `${ROLLING_TAG_PREFIX[product]}${releaseSuffix}`;
    tags.push(tag);
    if (product !== 'ui-web') {
      manifests.push({
        product: MANIFEST_PRODUCT[product],
        channel: releaseSuffix,
        tag,
      });
    }
  }
  return { refs, tags, manifests };
}

/** @param {unknown} value @param {string} label */
function parseBoolean(value, label) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`[release] ${label} must be true or false`);
}

/**
 * @param {{
 *   repository: string;
 *   candidateSourceSha: string;
 *   candidateBuildRunId: string;
 *   cliCandidateBuildRunId?: string;
 *   publicationRunId: string;
 *   currentRunId: string;
 *   refs: string[];
 *   tags: string[];
 *   manifests: Array<{ product: string; channel: string; tag: string }>;
 * }} input
 */
export function validateCandidateIdentityInputs(input) {
  const repository = String(input.repository ?? '').trim();
  const candidateSourceSha = String(input.candidateSourceSha ?? '').trim().toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error('[release] repository must be owner/repo');
  if (!/^[a-f0-9]{40}$/.test(candidateSourceSha)) {
    throw new Error('[release] candidate source SHA must be a full lowercase commit ID');
  }
  const refs = input.refs.map((entry) => String(entry).trim());
  const tags = input.tags.map((entry) => String(entry).trim());
  const manifests = input.manifests.map((entry) => ({
    product: String(entry.product ?? '').trim(),
    channel: String(entry.channel ?? '').trim(),
    tag: String(entry.tag ?? '').trim(),
  }));
  for (const [kind, values] of [['ref', refs], ['tag', tags]]) {
    if (values.some((value) => !value || /[\s,]/.test(value))) {
      throw new Error(`[release] candidate ${kind} names must be nonempty and comma-safe`);
    }
    if (new Set(values).size !== values.length) {
      throw new Error(`[release] candidate ${kind} names must be unique`);
    }
  }
  for (const manifest of manifests) {
    if (!manifest.product || !manifest.channel || !manifest.tag) {
      throw new Error('[release] candidate manifest specs require product, channel, and tag');
    }
  }
  const candidateBuildRunId = parseRunId(
    String(input.candidateBuildRunId ?? '').trim(),
    'build',
  );
  const rawCliCandidateBuildRunId = String(input.cliCandidateBuildRunId ?? '').trim();
  const cliCandidateBuildRunId = rawCliCandidateBuildRunId
    ? parseRunId(rawCliCandidateBuildRunId, 'CLI build')
    : candidateBuildRunId;
  const publicationRunId = parseRunId(
    String(input.publicationRunId ?? '').trim(),
    'publication',
  );
  const currentRunId = parseRunId(String(input.currentRunId ?? '').trim(), 'current');
  return {
    repository,
    candidateSourceSha,
    candidateBuildRunId,
    cliCandidateBuildRunId,
    publicationRunId,
    currentRunId,
    refs,
    tags,
    manifests,
  };
}

/**
 * @param {{
 *   candidateBuildRunId: number;
 *   cliCandidateBuildRunId: number;
 *   publicationRunId: number;
 *   currentRunId: number;
 *   manifests: Array<{ product: string; channel: string; tag: string }>;
 * }} input
 */
export function validateRunIdentityEvidence(input) {
  if (
    (
      input.candidateBuildRunId !== input.currentRunId
      || input.publicationRunId !== input.currentRunId
    )
    && input.manifests.length === 0
  ) {
    throw new Error(
      '[release] external build or publication run IDs require a published manifest relation',
    );
  }
  if (
    input.cliCandidateBuildRunId !== input.candidateBuildRunId
    && !input.manifests.some(isCliManifestSpec)
  ) {
    throw new Error(
      '[release] external CLI build run ID requires a published CLI manifest relation',
    );
  }
}

/**
 * @param {unknown} run
 * @param {{
 *   repository: string;
 *   runId: number;
 *   currentRunId: number;
 *   label: 'build' | 'publication';
 *   expectedWorkflowPaths: string[];
 * }} expected
 */
export function validateActionsRun(run, expected) {
  const record = asRecord(run);
  if (record.id !== expected.runId) {
    throw new Error(`[release] ${expected.label} workflow run ID does not match`);
  }
  if (
    String(asRecord(record.repository).full_name ?? '').toLowerCase()
    !== expected.repository.toLowerCase()
  ) {
    throw new Error(`[release] ${expected.label} workflow run repository does not match`);
  }
  const { workflowPath } = parseWorkflowRunPath(record.path);
  if (!expected.expectedWorkflowPaths.includes(workflowPath)) {
    throw new Error(`[release] ${expected.label} workflow run used an unexpected workflow path`);
  }
  const isCurrentRun = expected.runId === expected.currentRunId;
  const isSuccessfulCompleted = record.status === 'completed' && record.conclusion === 'success';
  if (isCurrentRun) {
    if (record.status !== 'in_progress' && !isSuccessfulCompleted) {
      throw new Error(`[release] current ${expected.label} workflow run is not active or successful`);
    }
  } else if (!isSuccessfulCompleted) {
    throw new Error(`[release] ${expected.label} workflow run is not a successful completed run`);
  }
}

/**
 * @param {unknown} manifest
 * @param {{
 *   product: string;
 *   channel: string;
 *   candidateSourceSha: string;
 *   candidateBuildRunId: number;
 *   publicationRunId: number;
 * }} expected
 */
export function validateCandidateManifest(manifest, expected) {
  const record = asRecord(manifest);
  const records = Array.isArray(record.records) ? record.records.map(asRecord) : [];
  if (
    record.product !== expected.product
    || record.channel !== expected.channel
    || records.length === 0
  ) {
    throw new Error('[release] published candidate manifest identity does not match');
  }
  for (const entry of records) {
    if (entry.product !== expected.product || entry.channel !== expected.channel) {
      throw new Error('[release] published candidate manifest record identity does not match');
    }
    const build = asRecord(entry.build);
    const publication = asRecord(entry.publication);
    if (
      String(build.commitSha ?? '').toLowerCase()
      !== expected.candidateSourceSha.toLowerCase()
    ) {
      throw new Error('[release] published candidate manifest source SHA does not match');
    }
    if (String(build.workflowRunId ?? '') !== String(expected.candidateBuildRunId)) {
      throw new Error('[release] published candidate manifest build workflow run ID does not match');
    }
    if (String(publication.workflowRunId ?? '') !== String(expected.publicationRunId)) {
      throw new Error(
        '[release] published candidate manifest publication workflow run ID does not match',
      );
    }
  }
}

/**
 * @param {{
 *   candidateSourceSha: string;
 *   resolved: Array<{ kind: 'ref' | 'tag'; name: string; sha: string }>;
 * }} input
 */
export function validateResolvedCandidateIdentities(input) {
  for (const identity of input.resolved) {
    if (identity.sha.toLowerCase() !== input.candidateSourceSha.toLowerCase()) {
      throw new Error(
        `[release] ${identity.kind} ${identity.name} does not identify the candidate source SHA`,
      );
    }
  }
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

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === 'object'
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {string} baseUrl
 * @param {string} repository
 * @param {string} refPath
 * @param {string} token
 */
async function resolveGitRef(baseUrl, repository, refPath, token) {
  const payload = asRecord(await githubJson(
    `${baseUrl}/repos/${repository}/git/ref/${encodeURI(refPath)}`,
    token,
  ));
  let object = asRecord(payload.object);
  for (let depth = 0; depth < 5 && object.type === 'tag'; depth += 1) {
    const tagSha = String(object.sha ?? '');
    const tagPayload = asRecord(await githubJson(
      `${baseUrl}/repos/${repository}/git/tags/${tagSha}`,
      token,
    ));
    object = asRecord(tagPayload.object);
  }
  if (object.type !== 'commit') {
    throw new Error(`[release] ${refPath} does not resolve to a commit`);
  }
  return String(object.sha ?? '').toLowerCase();
}

/**
 * @param {string} baseUrl
 * @param {string} repository
 * @param {string} tag
 * @param {string} token
 */
async function readRollingManifest(baseUrl, repository, tag, token) {
  const release = asRecord(await githubJson(
    `${baseUrl}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    token,
  ));
  const assets = Array.isArray(release.assets) ? release.assets.map(asRecord) : [];
  const matching = assets.filter((asset) => asset.name === 'latest.json');
  if (matching.length !== 1) {
    throw new Error(`[release] ${tag} must publish exactly one latest.json manifest`);
  }
  const downloadUrl = String(matching[0].browser_download_url ?? '');
  if (!downloadUrl) throw new Error(`[release] ${tag} latest.json download URL is missing`);
  return githubJson(downloadUrl, token);
}

/** @param {string[]} [argv] */
export async function main(argv = process.argv.slice(2)) {
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
      'candidate-build-run-id': { type: 'string' },
      'cli-candidate-build-run-id': { type: 'string', default: '' },
      'publication-run-id': { type: 'string' },
      'current-run-id': { type: 'string' },
      refs: { type: 'string', default: '' },
      tags: { type: 'string', default: '' },
      manifests: { type: 'string', default: '' },
      'derive-targets': { type: 'string', default: 'false' },
      'verify-deploy-ui': { type: 'string', default: 'false' },
      'verify-deploy-server': { type: 'string', default: 'false' },
      'verify-deploy-website': { type: 'string', default: 'false' },
      'verify-deploy-docs': { type: 'string', default: 'false' },
      'verify-cli-release': { type: 'string', default: 'false' },
      'verify-stack-release': { type: 'string', default: 'false' },
      'verify-server-release': { type: 'string', default: 'false' },
      'verify-ui-web-release': { type: 'string', default: 'false' },
      'api-base-url': { type: 'string', default: 'https://api.github.com' },
    },
    allowPositionals: false,
  });
  const candidateProduct = String(values['candidate-product'] ?? '');
  const candidateVersion = String(values['candidate-version'] ?? '');
  if (Boolean(candidateProduct) !== Boolean(candidateVersion)) {
    throw new Error('[release] --candidate-product and --candidate-version must be supplied together');
  }
  if (candidateProduct) {
    const product = candidateProduct === 'hstack' ? 'stack' : candidateProduct;
    if (!CANDIDATE_VERSION_PRODUCTS.includes(
      /** @type {'cli' | 'stack' | 'server' | 'ui-web'} */ (product),
    )) {
      throw new Error(`[release] unsupported candidate product: ${candidateProduct}`);
    }
    if ([
      values['candidate-cli-version'],
      values['candidate-stack-version'],
      values['candidate-server-version'],
      values['candidate-ui-web-version'],
    ].some(Boolean)) {
      throw new Error('[release] generic and product-specific candidate options cannot be combined');
    }
    const validated = validateCandidateVersions({
      channel: String(values.channel ?? ''),
      versions: {
        [product]: candidateVersion,
      },
    });
    const repository = String(values.repository ?? '').trim();
    const candidateSourceSha = String(values['candidate-source-sha'] ?? '').trim().toLowerCase();
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error('[release] repository must be owner/repo');
    if (!/^[a-f0-9]{40}$/.test(candidateSourceSha)) {
      throw new Error('[release] candidate source SHA must be a full lowercase commit ID');
    }
    const token = String(process.env.GITHUB_TOKEN ?? '').trim();
    if (!token) throw new Error('[release] GITHUB_TOKEN is required');
    const baseUrl = String(values['api-base-url'] ?? '').replace(/\/+$/u, '');
    const key = /** @type {'cli' | 'stack' | 'server' | 'ui-web'} */ (product);
    const version = validated.versions[key];
    const tag = `${IMMUTABLE_TAG_PREFIX[key]}${version}`;
    const sha = await resolveGitRef(baseUrl, repository, `tags/${tag}`, token);
    if (sha !== candidateSourceSha) {
      throw new Error(`[release] immutable tag ${tag} does not identify the candidate source SHA`);
    }
    const result = { ok: true, candidateSourceSha, channel: validated.channel, resolved: [{ product: key, version, tag, sha }] };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const validatedCandidates = validateCandidateVersions({
    channel: String(values.channel ?? ''),
    versions: {
      cli: String(values['candidate-cli-version'] ?? ''),
      stack: String(values['candidate-stack-version'] ?? ''),
      server: String(values['candidate-server-version'] ?? ''),
      'ui-web': String(values['candidate-ui-web-version'] ?? ''),
    },
  });
  const deriveTargets = parseBoolean(values['derive-targets'], '--derive-targets');
  const explicitTargets = {
    refs: parseCsv(String(values.refs ?? '')),
    tags: parseCsv(String(values.tags ?? '')),
    manifests: parseManifestSpecs(values.manifests),
  };
  if (deriveTargets && (
    explicitTargets.refs.length > 0
    || explicitTargets.tags.length > 0
    || explicitTargets.manifests.length > 0
  )) {
    throw new Error('[release] derived and explicit verification targets cannot be combined');
  }
  const targets = deriveTargets
    ? resolveCandidateVerificationTargets({
        channel: String(values.channel ?? ''),
        versions: validatedCandidates.versions,
        verifyDeploy: {
          ui: parseBoolean(values['verify-deploy-ui'], '--verify-deploy-ui'),
          server: parseBoolean(values['verify-deploy-server'], '--verify-deploy-server'),
          website: parseBoolean(values['verify-deploy-website'], '--verify-deploy-website'),
          docs: parseBoolean(values['verify-deploy-docs'], '--verify-deploy-docs'),
        },
        verifyRelease: {
          cli: parseBoolean(values['verify-cli-release'], '--verify-cli-release'),
          stack: parseBoolean(values['verify-stack-release'], '--verify-stack-release'),
          server: parseBoolean(values['verify-server-release'], '--verify-server-release'),
          'ui-web': parseBoolean(values['verify-ui-web-release'], '--verify-ui-web-release'),
        },
      })
    : explicitTargets;
  const input = validateCandidateIdentityInputs({
    repository: String(values.repository ?? ''),
    candidateSourceSha: String(values['candidate-source-sha'] ?? ''),
    candidateBuildRunId: String(values['candidate-build-run-id'] ?? ''),
    cliCandidateBuildRunId: String(values['cli-candidate-build-run-id'] ?? ''),
    publicationRunId: String(values['publication-run-id'] ?? ''),
    currentRunId: String(values['current-run-id'] ?? ''),
    refs: targets.refs,
    tags: targets.tags,
    manifests: targets.manifests,
  });
  const token = String(process.env.GITHUB_TOKEN ?? '').trim();
  if (!token) throw new Error('[release] GITHUB_TOKEN is required');
  const baseUrl = String(values['api-base-url'] ?? '').replace(/\/+$/u, '');
  const orchestratorWorkflowPaths = [
    '.github/workflows/release.yml',
    '.github/workflows/nightly-dev.yml',
  ];
  const expectedWorkflowPaths = {
    build: [
      ...orchestratorWorkflowPaths,
      '.github/workflows/publish-cli-binaries.yml',
      '.github/workflows/publish-hstack-binaries.yml',
      '.github/workflows/publish-server-runtime.yml',
    ],
    publication: orchestratorWorkflowPaths,
  };
  validateRunIdentityEvidence(input);
  const runIds = [{
    label: /** @type {'build'} */ ('build'),
    runId: input.candidateBuildRunId,
    workflowPaths: expectedWorkflowPaths.build,
  }];
  runIds.push({
    label: /** @type {'publication'} */ ('publication'),
    runId: input.publicationRunId,
    workflowPaths: expectedWorkflowPaths.publication,
  });
  const actionsRuns = new Map();
  /** @param {number} runId */
  const readActionsRun = async (runId) => {
    if (!actionsRuns.has(runId)) {
      actionsRuns.set(
        runId,
        await githubJson(
          `${baseUrl}/repos/${input.repository}/actions/runs/${runId}`,
          token,
        ),
      );
    }
    return actionsRuns.get(runId);
  };
  for (const { label, runId, workflowPaths } of runIds) {
    const run = await readActionsRun(runId);
    validateActionsRun(run, {
      repository: input.repository,
      runId,
      currentRunId: input.currentRunId,
      label,
      expectedWorkflowPaths: workflowPaths,
    });
  }
  const cliManifest = input.manifests.find(isCliManifestSpec);
  if (cliManifest) {
    const cliRun = await readActionsRun(input.cliCandidateBuildRunId);
    const { workflowPath } = parseWorkflowRunPath(asRecord(cliRun).path);
    if (
      input.cliCandidateBuildRunId !== input.candidateBuildRunId
      || workflowPath === '.github/workflows/publish-cli-binaries.yml'
    ) {
      validateCandidateRun(cliRun, {
        repository: input.repository,
        runId: input.cliCandidateBuildRunId,
        expectedWorkflowPath: '.github/workflows/publish-cli-binaries.yml',
        expectedHeadSha: input.candidateSourceSha,
        expectedChannel: cliManifest.channel,
      });
    } else if (!orchestratorWorkflowPaths.includes(workflowPath)) {
      throw new Error('[release] candidate build workflow is not valid for a CLI manifest');
    }
  }
  const resolved = [];
  for (const ref of input.refs) {
    resolved.push({
      kind: /** @type {'ref'} */ ('ref'),
      name: ref,
      sha: await resolveGitRef(baseUrl, input.repository, ref, token),
    });
  }
  for (const tag of input.tags) {
    resolved.push({
      kind: /** @type {'tag'} */ ('tag'),
      name: tag,
      sha: await resolveGitRef(baseUrl, input.repository, `tags/${tag}`, token),
    });
  }
  validateResolvedCandidateIdentities({
    candidateSourceSha: input.candidateSourceSha,
    resolved,
  });
  for (const manifest of input.manifests) {
    validateCandidateManifest(
      await readRollingManifest(baseUrl, input.repository, manifest.tag, token),
      {
        product: manifest.product,
        channel: manifest.channel,
        candidateSourceSha: input.candidateSourceSha,
        candidateBuildRunId: isCliManifestSpec(manifest)
          ? input.cliCandidateBuildRunId
          : input.candidateBuildRunId,
        publicationRunId: input.publicationRunId,
      },
    );
  }
  console.log(JSON.stringify({
    ok: true,
    candidateSourceSha: input.candidateSourceSha,
    candidateBuildRunId: input.candidateBuildRunId,
    cliCandidateBuildRunId: input.cliCandidateBuildRunId,
    publicationRunId: input.publicationRunId,
    resolved,
  }, null, 2));
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
