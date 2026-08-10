// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';

const OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  }).trim();
}

/**
 * @param {string} cwd
 * @param {string} objectId
 */
function hasCommitObject(cwd, objectId) {
  const result = spawnSync('git', ['cat-file', '-e', `${objectId}^{commit}`], {
    cwd,
    encoding: 'utf8',
    stdio: 'ignore',
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

/**
 * Resolve release-plan inputs from the remote without updating local branch, remote-tracking,
 * or tag refs. Missing advertised commit objects are fetched by immutable object ID, which
 * writes only FETCH_HEAD.
 *
 * @param {{
 *   repoRoot: string;
 *   remote?: string;
 *   branchNames: string[];
 *   optionalBranchNames?: string[];
 *   objectIds?: string[];
 *   tagPrefixes: string[];
 * }} opts
 */
export function resolveRemoteReleasePlanningRefs(opts) {
  const remote = String(opts.remote ?? 'origin').trim();
  if (!remote) throw new Error('remote is required');
  const objectIds = [...new Set((opts.objectIds ?? []).map((objectId) => String(objectId).trim()).filter(Boolean))];
  for (const objectId of objectIds) {
    if (!OBJECT_ID_PATTERN.test(objectId)) throw new Error(`Invalid immutable object ID: ${objectId}`);
  }
  const branchNames = [...new Set(opts.branchNames.map((name) => String(name).trim()).filter(Boolean))];
  const optionalBranchNames = [
    ...new Set((opts.optionalBranchNames ?? []).map((name) => String(name).trim()).filter(Boolean)),
  ].filter((name) => !branchNames.includes(name));
  const advertisedBranchNames = [...branchNames, ...optionalBranchNames];
  const tagPrefixes = [...new Set(opts.tagPrefixes.map((prefix) => String(prefix).trim()).filter(Boolean))];
  const patterns = [
    ...advertisedBranchNames.map((name) => `refs/heads/${name}`),
    ...tagPrefixes.map((prefix) => `refs/tags/${prefix}*`),
  ];
  const output = runGit(opts.repoRoot, ['ls-remote', remote, ...patterns]);

  /** @type {Record<string, string>} */
  const branches = {};
  /** @type {Record<string, string>} */
  const directTags = {};
  /** @type {Record<string, string>} */
  const peeledTags = {};

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [objectId, refName] = line.trim().split(/\s+/, 2);
    if (!OBJECT_ID_PATTERN.test(objectId ?? '') || !refName) {
      throw new Error(`Invalid git ls-remote result: ${line}`);
    }
    if (refName.startsWith('refs/heads/')) {
      branches[refName.slice('refs/heads/'.length)] = objectId;
      continue;
    }
    if (!refName.startsWith('refs/tags/')) continue;
    const rawTag = refName.slice('refs/tags/'.length);
    if (rawTag.endsWith('^{}')) {
      peeledTags[rawTag.slice(0, -3)] = objectId;
    } else {
      directTags[rawTag] = objectId;
    }
  }

  for (const branchName of branchNames) {
    if (!branches[branchName]) {
      throw new Error(`Remote '${remote}' does not advertise refs/heads/${branchName}`);
    }
  }

  /** @type {Record<string, string>} */
  const tags = {};
  for (const [tag, objectId] of Object.entries(directTags)) {
    tags[tag] = peeledTags[tag] ?? objectId;
  }

  const requiredObjects = [...new Set([...Object.values(branches), ...Object.values(tags), ...objectIds])];
  const missingObjects = requiredObjects.filter((objectId) => !hasCommitObject(opts.repoRoot, objectId));
  for (let index = 0; index < missingObjects.length; index += 64) {
    runGit(opts.repoRoot, ['fetch', '--no-tags', remote, ...missingObjects.slice(index, index + 64)]);
  }
  for (const objectId of requiredObjects) {
    if (!hasCommitObject(opts.repoRoot, objectId)) {
      throw new Error(`Remote advertised object ${objectId} is not an available commit after object-only fetch`);
    }
  }

  return { branches, tags };
}
