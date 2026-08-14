// @ts-check

import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

const OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function resolveGitExecutable() {
  const names = process.platform === 'win32' ? ['git.exe', 'git'] : ['git'];
  for (const directory of String(process.env.PATH ?? '').split(delimiter)) {
    for (const name of names) {
      const candidate = join(directory || process.cwd(), name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return 'git';
}

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  }).trim();
}

function findMissingCommitObjects(cwd, objectIds) {
  if (objectIds.length === 0) return [];
  const output = execFileSync(resolveGitExecutable(), ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    cwd,
    encoding: 'utf8',
    input: `${objectIds.map((objectId) => `${objectId}^{commit}`).join('\n')}\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  const rows = output.trim().split(/\r?\n/);
  if (rows.length !== objectIds.length) {
    throw new Error(`git cat-file --batch-check returned ${rows.length} rows for ${objectIds.length} objects`);
  }
  return objectIds.filter((_objectId, index) => !/^[0-9a-f]{40}(?:[0-9a-f]{24})? commit$/.test(rows[index]));
}

/**
 * Resolve remote planning identities without updating local branch, remote-tracking, or tag refs.
 * Missing advertised objects are fetched by immutable object ID, which writes only FETCH_HEAD.
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
  const output = runGit(opts.repoRoot, [
    'ls-remote',
    remote,
    ...advertisedBranchNames.map((name) => `refs/heads/${name}`),
    ...tagPrefixes.map((prefix) => `refs/tags/${prefix}*`),
  ]);
  const branches = {};
  const directTags = {};
  const peeledTags = {};
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [objectId, refName] = line.trim().split(/\s+/, 2);
    if (!OBJECT_ID_PATTERN.test(objectId ?? '') || !refName) throw new Error(`Invalid git ls-remote result: ${line}`);
    if (refName.startsWith('refs/heads/')) {
      branches[refName.slice('refs/heads/'.length)] = objectId;
    } else if (refName.startsWith('refs/tags/')) {
      const rawTag = refName.slice('refs/tags/'.length);
      if (rawTag.endsWith('^{}')) peeledTags[rawTag.slice(0, -3)] = objectId;
      else directTags[rawTag] = objectId;
    }
  }
  for (const branchName of branchNames) {
    if (!branches[branchName]) throw new Error(`Remote '${remote}' does not advertise refs/heads/${branchName}`);
  }
  const tags = {};
  for (const [tag, objectId] of Object.entries(directTags)) tags[tag] = peeledTags[tag] ?? objectId;
  const requiredObjects = [...new Set([...Object.values(branches), ...Object.values(tags), ...objectIds])];
  const missing = findMissingCommitObjects(opts.repoRoot, requiredObjects);
  for (let index = 0; index < missing.length; index += 64) {
    runGit(opts.repoRoot, ['fetch', '--no-tags', remote, ...missing.slice(index, index + 64)]);
  }
  const unavailable = findMissingCommitObjects(opts.repoRoot, requiredObjects);
  if (unavailable.length > 0) {
    throw new Error(`Remote advertised object ${unavailable[0]} is not an available commit after object-only fetch`);
  }
  return { branches, tags };
}
