#!/usr/bin/env node

// @ts-check

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { normalizePublicReleaseChannel } from './lib/public-release-rings.mjs';
import { normalizeRollingBaseVersion } from './lib/rolling-version-allocation.mjs';
import { validateCandidateVersions } from './verify-release-candidate-identity.mjs';

const PRODUCT_ORDER = /** @type {const} */ (['cli', 'stack', 'server', 'ui-web']);
const PRODUCT_SCRIPT = Object.freeze({
  cli: 'publish-cli-binaries.mjs',
  stack: 'publish-hstack-binaries.mjs',
  server: 'publish-server-runtime.mjs',
  'ui-web': 'publish-ui-web.mjs',
});

/** @typedef {typeof PRODUCT_ORDER[number]} CandidateProduct */

/** @param {string} value */
export function parseCandidateVersions(value) {
  /** @type {Partial<Record<CandidateProduct, string>>} */
  const candidates = {};
  for (const rawEntry of String(value ?? '').split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const separator = entry.indexOf('=');
    if (separator < 1 || separator === entry.length - 1) {
      throw new Error('[release] --candidates entries must use product=version');
    }
    const product = entry.slice(0, separator).trim();
    const version = entry.slice(separator + 1).trim();
    if (!PRODUCT_ORDER.includes(/** @type {CandidateProduct} */ (product))) {
      throw new Error(`[release] unsupported candidate product: ${product}`);
    }
    const candidateProduct = /** @type {CandidateProduct} */ (product);
    if (candidates[candidateProduct]) {
      throw new Error(`[release] duplicate candidate product: ${candidateProduct}`);
    }
    candidates[candidateProduct] = version;
  }
  if (Object.keys(candidates).length === 0) {
    throw new Error('[release] --candidates must contain at least one product=version entry');
  }
  return candidates;
}

/**
 * @param {{
 *   channel: string;
 *   sourceSha: string;
 *   repository: string;
 *   candidates: Partial<Record<CandidateProduct, string>>;
 *   phase: 'publish-immutable' | 'verify' | 'promote-rolling' | 'all';
 *   releaseMessage: string;
 * }} input
 */
export function buildLocalCandidateCommands(input) {
  const channel = normalizePublicReleaseChannel(input.channel);
  if (!channel) throw new Error(`[release] unsupported release channel: ${input.channel || '<empty>'}`);
  if (!/^[a-f0-9]{40}$/u.test(input.sourceSha)) {
    throw new Error('[release] source SHA must be a full lowercase commit ID');
  }
  if (!/^[^/\s]+\/[^/\s]+$/u.test(input.repository)) {
    throw new Error('[release] repository must be owner/repo');
  }
  if (!['publish-immutable', 'verify', 'promote-rolling', 'all'].includes(input.phase)) {
    throw new Error('[release] phase must be publish-immutable|verify|promote-rolling|all');
  }
  const validated = validateCandidateVersions({ channel, versions: input.candidates });
  const products = PRODUCT_ORDER.filter((product) => validated.versions[product]);
  if (products.length === 0) throw new Error('[release] no valid candidate versions were supplied');
  const allowStable = channel === 'stable' ? 'true' : 'false';
  /** @type {Array<{ stage: string; args: string[] }>} */
  const commands = [];

  const includeImmutable = input.phase === 'publish-immutable' || input.phase === 'all';
  const includeVerify = input.phase === 'verify' || input.phase === 'all';
  const includePromote = input.phase === 'promote-rolling' || input.phase === 'all';

  if (includeImmutable) {
    for (const [index, product] of products.entries()) {
      const version = validated.versions[product];
      commands.push({
        stage: `publish-immutable:${product}`,
        args: [
          path.join('scripts', 'pipeline', 'release', PRODUCT_SCRIPT[product]),
          '--channel', channel,
          '--allow-stable', allowStable,
          '--release-message', input.releaseMessage,
          '--phase', 'publish-immutable',
          '--base-version', normalizeRollingBaseVersion(version),
          '--version', version,
          '--authorized-sha', input.sourceSha,
          '--run-contracts', index === 0 ? 'true' : 'false',
          '--check-installers', index === 0 ? 'true' : 'false',
        ],
      });
    }
  }
  if (includeVerify) {
    for (const product of products) {
      commands.push({
        stage: `verify:${product}`,
        args: [
          path.join('scripts', 'pipeline', 'release', 'verify-release-candidate-identity.mjs'),
          '--repository', input.repository,
          '--channel', channel,
          '--candidate-source-sha', input.sourceSha,
          '--candidate-product', product,
          '--candidate-version', validated.versions[product],
        ],
      });
    }
  }
  if (includePromote) {
    for (const product of products) {
      const version = validated.versions[product];
      commands.push({
        stage: `promote-rolling:${product}`,
        args: [
          path.join('scripts', 'pipeline', 'release', PRODUCT_SCRIPT[product]),
          '--channel', channel,
          '--allow-stable', allowStable,
          '--release-message', input.releaseMessage,
          '--phase', 'promote-rolling',
          '--version', version,
          '--authorized-sha', input.sourceSha,
          '--run-contracts', 'false',
          '--check-installers', 'false',
        ],
      });
    }
  }
  return commands;
}

/** @param {string[]} [argv] */
export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      channel: { type: 'string' },
      'source-sha': { type: 'string' },
      repository: { type: 'string' },
      candidates: { type: 'string' },
      phase: { type: 'string', default: 'all' },
      'release-message': { type: 'string', default: '' },
      confirm: { type: 'string', default: '' },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const dryRun = values['dry-run'] === true;
  if (values.json === true && !dryRun) {
    throw new Error('[release] --json requires --dry-run because it emits a plan without executing it');
  }
  if (!dryRun && values.confirm !== 'execute local release candidates') {
    throw new Error('[release] non-dry local execution requires --confirm "execute local release candidates"');
  }
  const commands = buildLocalCandidateCommands({
    channel: String(values.channel ?? ''),
    sourceSha: String(values['source-sha'] ?? ''),
    repository: String(values.repository ?? ''),
    candidates: parseCandidateVersions(String(values.candidates ?? '')),
    phase: /** @type {'publish-immutable' | 'verify' | 'promote-rolling' | 'all'} */ (String(values.phase ?? 'all')),
    releaseMessage: String(values['release-message'] ?? ''),
  });
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify({ kind: 'happier.local-candidate-execution.v1', commands }, null, 2)}\n`);
    return commands;
  }
  const repoRoot = path.resolve(process.cwd());
  for (const command of commands) {
    console.log(`[pipeline] local release stage: ${command.stage}`);
    if (dryRun) {
      console.log(`[pipeline] exec: ${process.execPath} ${command.args.map((arg) => JSON.stringify(arg)).join(' ')}`);
      continue;
    }
    execFileSync(process.execPath, command.args, {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    });
  }
  return commands;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
