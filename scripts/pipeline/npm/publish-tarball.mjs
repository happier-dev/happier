// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {boolean}
 */
function parseBoolString(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be 'true' or 'false' (got: ${value})`);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: Record<string, string>; dryRun?: boolean; stdio?: 'inherit' | 'pipe' }} [opts]
 */
function run(cmd, args, opts) {
  const dryRun = opts?.dryRun === true;
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  if (dryRun) {
    console.log(`[dry-run] ${printable}`);
    return '';
  }

  return execFileSync(cmd, args, {
    env: { ...process.env, ...(opts?.env ?? {}) },
    encoding: 'utf8',
    stdio: opts?.stdio === 'pipe' ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: 5 * 60_000,
  });
}

/**
 * @param {string} npmVersion
 * @param {string[]} args
 * @returns {{ cmd: string; args: string[] }}
 */
function npmInvocation(npmVersion, args) {
  if (npmVersion) return { cmd: 'npx', args: ['-y', `npm@${npmVersion}`, ...args] };
  return { cmd: 'npm', args };
}

/**
 * @param {string} npmVersion
 * @param {string[]} args
 * @param {{ env: Record<string, string>; dryRun?: boolean; stdio?: 'inherit' | 'pipe' }} opts
 */
function runNpm(npmVersion, args, opts) {
  const invocation = npmInvocation(npmVersion, args);
  return run(invocation.cmd, invocation.args, opts);
}

/**
 * @param {string} tarballDir
 * @returns {string}
 */
function resolveSingleTarballFromDir(tarballDir) {
  if (!fs.existsSync(tarballDir) || !fs.statSync(tarballDir).isDirectory()) {
    fail(`--tarball-dir must be a directory (got: ${tarballDir})`);
  }

  const entries = fs.readdirSync(tarballDir);
  const candidates = entries
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => path.join(tarballDir, name))
    .filter((fullPath) => {
      try {
        return fs.statSync(fullPath).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b));

  if (candidates.length === 0) {
    fail(`No .tgz files found under --tarball-dir: ${tarballDir}`);
  }

  return candidates[0];
}

/**
 * @param {string} tarballPath
 * @returns {{ name: string; version: string; integrity: string }}
 */
function readTarballPackageMetadata(tarballPath) {
  let raw;
  try {
    raw = execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`Unable to read package metadata from tarball: ${message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`Tarball package.json is invalid: ${message}`);
  }

  const name = String(parsed?.name ?? '').trim();
  const version = String(parsed?.version ?? '').trim();
  if (!name || !version) fail('Tarball package.json must include name and version');

  const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tarballPath)).digest('base64')}`;
  return { name, version, integrity };
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isNpmNotFoundError(err) {
  if (!err || typeof err !== 'object') return false;
  const candidate = /** @type {{ status?: unknown; stderr?: unknown; message?: unknown }} */ (err);
  const status = Number(candidate.status);
  const stderr = Buffer.isBuffer(candidate.stderr) ? candidate.stderr.toString('utf8') : String(candidate.stderr ?? '');
  const message = String(candidate.message ?? '');
  return status === 404 || /\bE404\b|(?:\bHTTP\s*)?404\b/i.test(`${stderr}\n${message}`);
}

/**
 * @param {{ npmVersion: string; env: Record<string, string>; packageSpec: string }} opts
 * @returns {string | null}
 */
function queryPublishedIntegrity(opts) {
  try {
    const output = String(
      runNpm(opts.npmVersion, ['view', opts.packageSpec, 'dist.integrity', '--json'], {
        env: opts.env,
        stdio: 'pipe',
      }) ?? '',
    ).trim();
    if (!output || output === 'null' || output === 'undefined') {
      throw new Error(`npm returned no integrity for ${opts.packageSpec}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch {
      parsed = output;
    }
    const integrity = String(parsed ?? '').trim();
    if (!integrity) throw new Error(`npm returned no integrity for ${opts.packageSpec}`);
    return integrity;
  } catch (err) {
    if (isNpmNotFoundError(err)) return null;
    throw err;
  }
}

/**
 * @param {{ npmVersion: string; env: Record<string, string>; packageName: string }} opts
 * @returns {Record<string, string>}
 */
function queryDistTags(opts) {
  const output = String(
    runNpm(opts.npmVersion, ['view', opts.packageName, 'dist-tags', '--json'], {
      env: opts.env,
      stdio: 'pipe',
    }) ?? '',
  ).trim();
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to parse npm dist-tags response: ${message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('npm dist-tags response must be an object');
  }
  return Object.fromEntries(Object.entries(parsed).map(([tag, version]) => [tag, String(version)]));
}

/**
 * @param {{ npmVersion: string; env: Record<string, string>; packageName: string; version: string; distTag: string }} opts
 */
function ensureDistTag(opts) {
  const current = queryDistTags(opts);
  if (current[opts.distTag] === opts.version) {
    console.log(`[pipeline] npm dist-tag verified: ${opts.distTag} -> ${opts.version}`);
    return;
  }

  console.log(`[pipeline] repairing npm dist-tag: ${opts.distTag} -> ${opts.version}`);
  runNpm(opts.npmVersion, ['dist-tag', 'add', `${opts.packageName}@${opts.version}`, opts.distTag], {
    env: opts.env,
  });
  const verified = queryDistTags(opts);
  if (verified[opts.distTag] !== opts.version) {
    throw new Error(`npm dist-tag verification failed: ${opts.distTag} does not point to ${opts.version}`);
  }
  console.log(`[pipeline] npm dist-tag verified: ${opts.distTag} -> ${opts.version}`);
}

/**
 * @param {string} channel
 * @returns {'latest' | 'next'}
 */
function defaultDistTagForChannel(channel) {
  if (channel === 'production') return 'latest';
  if (channel === 'preview') return 'next';
  fail(`--channel must be 'production' or 'preview' (got: ${channel})`);
}

/**
 * npm does not implicitly read NODE_AUTH_TOKEN unless an npmrc references it.
 * GitHub Actions' setup-node generates that npmrc; local runs usually don't.
 *
 * This helper makes token-based auth work everywhere without mutating any global config.
 *
 * @param {string} npmToken
 * @returns {{ env: Record<string, string> }}
 */
function createIsolatedNpmConfigEnv(npmToken) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-npmrc-'));
  const userconfig = path.join(dir, '.npmrc');
  const globalconfig = path.join(dir, '.npmrc-global');

  fs.writeFileSync(
    userconfig,
    `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${npmToken}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  fs.writeFileSync(globalconfig, '', { encoding: 'utf8', mode: 0o600 });

  return {
    env: {
      NPM_CONFIG_USERCONFIG: userconfig,
      NPM_CONFIG_GLOBALCONFIG: globalconfig,
    },
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      channel: { type: 'string' },
      tag: { type: 'string', default: '' },
      tarball: { type: 'string', default: '' },
      'tarball-dir': { type: 'string', default: '' },
      access: { type: 'string', default: 'public' },
      provenance: { type: 'string', default: 'auto' },
      'npm-version': { type: 'string', default: '11.5.1' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const channel = String(values.channel ?? '').trim();
  if (!channel) fail('--channel is required');

  const overrideTag = String(values.tag ?? '').trim();
  const distTag = overrideTag || defaultDistTagForChannel(channel);

  const tarballRaw = String(values.tarball ?? '').trim();
  const tarballDirRaw = String(values['tarball-dir'] ?? '').trim();
  if (!tarballRaw && !tarballDirRaw) {
    fail('One of --tarball or --tarball-dir is required');
  }

  const tarballPath = tarballRaw
    ? path.resolve(tarballRaw)
    : resolveSingleTarballFromDir(path.resolve(tarballDirRaw));

  if (!fs.existsSync(tarballPath) || !fs.statSync(tarballPath).isFile()) {
    fail(`tarball does not exist: ${tarballPath}`);
  }

  const access = String(values.access ?? 'public').trim() || 'public';
  const provenanceRaw = String(values.provenance ?? '').trim().toLowerCase() || 'auto';
  if (provenanceRaw !== 'auto' && provenanceRaw !== 'true' && provenanceRaw !== 'false') {
    fail(`--provenance must be 'auto', 'true', or 'false' (got: ${values.provenance})`);
  }

  // Default behavior:
  // - Local runs: do not force provenance (it usually requires CI OIDC/trusted publishing context).
  // - GitHub Actions: enable provenance by default for better supply-chain guarantees.
  // An explicit --provenance true/false always wins.
  let provenance = false;
  if (provenanceRaw === 'auto') {
    if (process.env.NPM_CONFIG_PROVENANCE != null && String(process.env.NPM_CONFIG_PROVENANCE).trim() !== '') {
      provenance = parseBoolString(process.env.NPM_CONFIG_PROVENANCE, 'NPM_CONFIG_PROVENANCE');
    } else {
      provenance = String(process.env.GITHUB_ACTIONS ?? '').trim().toLowerCase() === 'true';
    }
  } else {
    provenance = provenanceRaw === 'true';
  }
  const npmVersion = String(values['npm-version'] ?? '').trim();
  const dryRun = values['dry-run'] === true;

  const npmToken = String(process.env.NODE_AUTH_TOKEN ?? process.env.NPM_TOKEN ?? '').trim();
  /** @type {Record<string, string>} */
  const publishEnv = {};
  // Ensure the resolved provenance mode is applied even when a package's publishConfig forces it.
  // This matters for local runs where provenance is typically unsupported and would otherwise fail.
  publishEnv.NPM_CONFIG_PROVENANCE = provenance ? 'true' : 'false';
  if (npmToken) {
    console.log('[pipeline] npm auth: using isolated npmrc');
    Object.assign(publishEnv, createIsolatedNpmConfigEnv(npmToken).env);
  }

  const publishArgs = [
    'publish',
    tarballPath,
    ...(provenance ? ['--provenance'] : []),
    '--access',
    access,
    '--tag',
    distTag,
  ];

  if (dryRun) {
    runNpm(npmVersion, publishArgs, { env: publishEnv, dryRun });
    return;
  }

  const metadata = readTarballPackageMetadata(tarballPath);
  const packageSpec = `${metadata.name}@${metadata.version}`;
  const existingIntegrity = queryPublishedIntegrity({
    npmVersion,
    env: publishEnv,
    packageSpec,
  });

  if (existingIntegrity) {
    if (existingIntegrity !== metadata.integrity) {
      fail(
        `Refusing to publish ${packageSpec}: npm already has a different integrity (${existingIntegrity})`,
      );
    }
    console.log(`[pipeline] npm version already published with matching integrity: ${packageSpec}`);
  } else {
    try {
      runNpm(npmVersion, publishArgs, { env: publishEnv });
    } catch (publishError) {
      console.warn('[pipeline] npm publish outcome ambiguous; re-querying published integrity');
      let recoveredIntegrity;
      try {
        recoveredIntegrity = queryPublishedIntegrity({
          npmVersion,
          env: publishEnv,
          packageSpec,
        });
      } catch {
        throw publishError;
      }
      if (recoveredIntegrity !== metadata.integrity) throw publishError;
      console.log(`[pipeline] recovered npm publication with matching integrity: ${packageSpec}`);
    }
  }

  ensureDistTag({
    npmVersion,
    env: publishEnv,
    packageName: metadata.name,
    version: metadata.version,
    distTag,
  });
}

main();
