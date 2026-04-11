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

function resolveBaselineTag({ environment, head, prefix }) {
  const allowedChannels = allowedChannelsForEnvironment(environment);
  const candidates = listMergedTags(head, prefix);
  /** @type {{ tag: string; distance: number } | null} */
  let best = null;

  for (const tag of candidates) {
    const channel = parseTagChannel(tag, prefix);
    if (channel === null || !allowedChannels.has(channel)) continue;
    const tagCommit = runGit(['rev-list', '-n', '1', tag]).trim();
    if (!tagCommit) continue;
    const distanceRaw = runGit(['rev-list', '--count', `${tagCommit}..${head}`]).trim();
    const distance = Number(distanceRaw);
    if (!Number.isFinite(distance) || distance < 0) continue;
    if (best === null || distance < best.distance) {
      best = { tag, distance };
    }
  }

  return best?.tag ?? '';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const environment = String(args.get('--environment') ?? '').trim();
  const head = String(args.get('--head') ?? '').trim();
  const outPath = String(args.get('--out') ?? '').trim();

  if (!environment) fail('--environment is required');
  if (!head) fail('--head is required');

  /** @type {Record<string, string>} */
  const outputs = {};

  for (const [key, definition] of Object.entries(versionedComponents)) {
    const baselineTag = resolveBaselineTag({
      environment,
      head,
      prefix: definition.baselineTagPrefix,
    });
    const paths = baselineTag ? listChangedPathsSince(baselineTag, head) : listTrackedPaths();
    const classified = classifyChangedPaths(paths);
    const derived = deriveVersionedComponentChanges(classified);

    outputs[`changed_${key}`] = derived[key] ? 'true' : 'false';
    outputs[`${key}_baseline_tag`] = baselineTag;
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
