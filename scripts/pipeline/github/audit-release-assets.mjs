// @ts-check

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { CLI_STACK_TARGETS, SERVER_TARGETS, resolveTargets } from '../release/lib/binary-release.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
function parseCsv(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string[]}
 */
function parseAssetsJson(value, name) {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`${name} must be valid JSON (got invalid JSON)`);
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
    fail(`${name} must be a JSON array of strings`);
  }
  return parsed.map((s) => s.trim()).filter(Boolean);
}

/**
 * @param {'cli' | 'stack' | 'server'} kind
 */
function productForKind(kind) {
  if (kind === 'cli') return 'happier';
  if (kind === 'stack') return 'hstack';
  return 'happier-server';
}

/**
 * @param {'cli' | 'stack' | 'server'} kind
 */
function targetsForKind(kind) {
  if (kind === 'server') return SERVER_TARGETS;
  return CLI_STACK_TARGETS;
}

/**
 * @param {string[]} assets
 * @param {string} product
 * @returns {string}
 */
function inferVersionFromAssets(assets, product) {
  const pattern = new RegExp(`^${product}-v(.+)-[a-z]+-(x64|arm64)\\.tar\\.gz$`);
  for (const name of assets) {
    const m = pattern.exec(String(name ?? '').trim());
    if (m?.[1]) return m[1];
  }
  return '';
}

/**
 * @param {{ tag: string; repo: string }} opts
 * @returns {string[]}
 */
function fetchReleaseAssets({ tag, repo }) {
  const out = execFileSync(
    'gh',
    ['release', 'view', tag, '--repo', repo, '--json', 'assets', '--jq', '.assets[].name'],
    {
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );
  return String(out ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: 'string' },
      kind: { type: 'string' },
      version: { type: 'string', default: '' },
      targets: { type: 'string', default: '' },
      repo: { type: 'string', default: '' },
      'assets-json': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });

  const tag = String(values.tag ?? '').trim();
  const kindRaw = String(values.kind ?? '').trim();
  const kind = kindRaw === 'cli' || kindRaw === 'stack' || kindRaw === 'server' ? kindRaw : '';
  if (!tag) fail('--tag is required');
  if (!kind) fail(`--kind must be 'cli', 'stack', or 'server' (got: ${kindRaw || '<empty>'})`);

  const repo = String(values.repo ?? '').trim()
    || String(process.env.GH_REPO ?? '').trim()
    || String(process.env.GITHUB_REPOSITORY ?? '').trim();
  const assetsJson = String(values['assets-json'] ?? '').trim();

  /** @type {string[]} */
  let assets = [];
  if (assetsJson) {
    assets = parseAssetsJson(values['assets-json'], '--assets-json');
  } else {
    if (!repo) {
      fail('--repo is required when --assets-json is not provided (or set GH_REPO/GITHUB_REPOSITORY)');
    }
    assets = fetchReleaseAssets({ tag, repo });
  }

  const product = productForKind(kind);
  const availableTargets = targetsForKind(kind);
  const requestedTargets = String(values.targets ?? '').trim();
  const targets = resolveTargets({
    availableTargets,
    requested: requestedTargets || undefined,
  });

  const version = String(values.version ?? '').trim() || inferVersionFromAssets(assets, product);
  if (!version) {
    fail(`Unable to infer version for '${product}' from assets. Pass --version explicitly.`);
  }

  const expected = new Set();
  for (const t of targets) {
    expected.add(`${product}-v${version}-${t.os}-${t.arch}.tar.gz`);
  }
  expected.add(`checksums-${product}-v${version}.txt`);
  expected.add(`checksums-${product}-v${version}.txt.minisig`);

  const found = new Set(assets);
  const missing = [...expected].filter((name) => !found.has(name));
  const extra = assets.filter((name) => !expected.has(name));

  const header = [
    `[pipeline] audit release assets: tag=${tag} kind=${kind}`,
    ...(repo ? [`[pipeline] repo: ${repo}`] : []),
    `[pipeline] version: ${version}`,
    `[pipeline] expected: ${expected.size} found: ${assets.length}`,
  ].join('\n');

  if (missing.length === 0) {
    console.log(`${header}\n[pipeline] OK`);
    return;
  }

  const lines = [
    header,
    '',
    '[pipeline] MISSING assets:',
    ...missing.map((name) => `- ${name}`),
  ];
  if (extra.length > 0) {
    lines.push('', '[pipeline] EXTRA assets (ignored):', ...extra.map((name) => `- ${name}`));
  }
  console.error(lines.join('\n'));
  process.exit(1);
}

main();

