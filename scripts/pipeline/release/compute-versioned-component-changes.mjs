// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { classifyChangedPaths, deriveVersionedComponentChanges, versionedComponents } from './component-registry.mjs';

function fail(msg) {
  process.stderr.write(`[compute-versioned-component-changes] ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const v = argv[i + 1];
    if (v && !v.startsWith('--')) {
      out.set(a, v);
      i++;
    } else {
      out.set(a, 'true');
    }
  }
  return out;
}

function runGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const err = String(result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed: ${err}`);
  }
  return String(result.stdout ?? '');
}

function parseTagChannel(tag, prefix) {
  if (!tag.startsWith(prefix)) return null;
  const version = tag.slice(prefix.length);
  if (!version) return null;
  if (version.includes('-dev.')) return 'dev';
  if (version.includes('-preview.')) return 'preview';
  if (version.includes('-')) return 'other';
  return 'stable';
}

function allowedChannelsForEnvironment(environment) {
  if (environment === 'dev') return new Set(['dev', 'preview', 'stable']);
  if (environment === 'preview') return new Set(['preview', 'stable']);
  if (environment === 'production') return new Set(['stable']);
  fail(`--environment must be 'dev', 'preview', or 'production' (got: ${environment})`);
}

function listMergedTags(head, prefix) {
  return runGit(['tag', '--merged', head, '--list', `${prefix}*`, '--sort=-creatordate'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function createRemoteReachabilityIndex(head) {
  const graph = new Map();
  for (const line of runGit(['rev-list', '--parents', head]).split('\n')) {
    const [commit, ...parents] = line.trim().split(/\s+/);
    if (commit) graph.set(commit, parents);
  }
  const distanceCache = new Map();
  return {
    distanceFromHead(commit) {
      if (!graph.has(commit)) return null;
      if (distanceCache.has(commit)) return distanceCache.get(commit);
      const reachable = new Set();
      const pending = [commit];
      while (pending.length > 0) {
        const current = pending.pop();
        if (!current || reachable.has(current) || !graph.has(current)) continue;
        reachable.add(current);
        pending.push(...graph.get(current));
      }
      const distance = graph.size - reachable.size;
      distanceCache.set(commit, distance);
      return distance;
    },
  };
}

function listTrackedPaths() {
  return runGit(['ls-files'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function listChangedPathsSince(baseRef, head) {
  return runGit(['diff', '--name-only', `${baseRef}..${head}`])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveBaselineTag({ environment, head, prefix, remoteTagRefs, remoteReachability }) {
  const allowedChannels = allowedChannelsForEnvironment(environment);
  const candidates = remoteTagRefs === null
    ? listMergedTags(head, prefix).map((tag) => ({ tag, ref: tag, distance: null }))
    : Object.entries(remoteTagRefs)
        .filter(([tag]) => tag.startsWith(prefix))
        .map(([tag, ref]) => ({ tag, ref, distance: remoteReachability.distanceFromHead(ref) }))
        .filter(({ distance }) => distance !== null);
  let best = null;

  for (const { tag, ref, distance: knownDistance } of candidates) {
    const channel = parseTagChannel(tag, prefix);
    if (channel === null || !allowedChannels.has(channel)) continue;
    const tagCommit = remoteTagRefs === null ? runGit(['rev-list', '-n', '1', ref]).trim() : ref;
    if (!tagCommit) continue;
    const distance = knownDistance ?? Number(runGit(['rev-list', '--count', `${tagCommit}..${head}`]).trim());
    if (!Number.isFinite(distance) || distance < 0) continue;
    if (best === null || distance < best.distance) {
      best = { tag, ref: tagCommit, distance };
    }
  }

  return best;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const environment = String(args.get('--environment') ?? '').trim();
  const head = String(args.get('--head') ?? '').trim();
  const outPath = String(args.get('--out') ?? '').trim();
  const tagRefsJson = args.get('--tag-refs-json');

  if (!environment) fail('--environment is required');
  if (!head) fail('--head is required');

  let remoteTagRefs = null;
  if (tagRefsJson !== undefined) {
    const parsed = JSON.parse(String(tagRefsJson));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('--tag-refs-json must be a JSON object');
    }
    remoteTagRefs = Object.fromEntries(
      Object.entries(parsed).map(([tag, ref]) => {
        const normalizedRef = String(ref ?? '').trim();
        if (!tag.trim() || !normalizedRef) fail('--tag-refs-json entries must have non-empty tag names and refs');
        return [tag, normalizedRef];
      }),
    );
  }

  /** @type {Record<string, string>} */
  const outputs = {};
  const remoteReachability = remoteTagRefs === null ? null : createRemoteReachabilityIndex(head);

  for (const [key, definition] of Object.entries(versionedComponents)) {
    const baseline = resolveBaselineTag({
      environment,
      head,
      prefix: definition.baselineTagPrefix,
      remoteTagRefs,
      remoteReachability,
    });
    const paths = baseline ? listChangedPathsSince(baseline.ref, head) : listTrackedPaths();
    const classified = classifyChangedPaths(paths);
    const derived = deriveVersionedComponentChanges(classified);

    outputs[`changed_${key}`] = derived[key] ? 'true' : 'false';
    outputs[`${key}_baseline_tag`] = baseline?.tag ?? '';
  }

  if (outPath) {
    const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
    fs.appendFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
    return;
  }

  process.stdout.write(`${JSON.stringify(outputs)}\n`);
}

Promise.resolve()
  .then(() => main())
  .catch((err) => fail(err?.stack || String(err)));
