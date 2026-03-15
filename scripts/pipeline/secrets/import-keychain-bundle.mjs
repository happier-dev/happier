// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { parseDotenv } from '../env/parse-dotenv.mjs';
import { readKeychainBundle } from './read-keychain-bundle.mjs';
import { writeKeychainBundle } from './write-keychain-bundle.mjs';

/**
 * @param {unknown} err
 */
function isKeychainNotFoundError(err) {
  const anyErr = /** @type {{ stderr?: unknown; message?: unknown }} */ (err ?? {});
  const stderr = typeof anyErr?.stderr === 'string' ? anyErr.stderr : '';
  const message = typeof anyErr?.message === 'string' ? anyErr.message : String(err ?? '');
  const hay = `${stderr}\n${message}`.toLowerCase();
  return hay.includes('could not be found') || hay.includes('secitemcopymatching') || hay.includes('the specified item could not be found');
}

/**
 * @param {Record<string, string>} env
 */
function dropEmptyValues(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    const key = String(k ?? '').trim();
    const value = typeof v === 'string' ? v : '';
    if (!key) continue;
    if (!String(value ?? '').trim()) continue;
    out[key] = value;
  }
  return out;
}

/**
 * @param {{ filePath: string; ignoreMissing: boolean }} opts
 */
function readEnvFile(opts) {
  const exists = fs.existsSync(opts.filePath);
  if (!exists) {
    if (opts.ignoreMissing) return { env: {}, missing: true };
    throw new Error(`[pipeline] missing env file: ${opts.filePath}`);
  }
  const raw = fs.readFileSync(opts.filePath, 'utf8');
  return { env: parseDotenv(raw), missing: false };
}

/**
 * Import dotenv-style env files into the Keychain bundle secret (merge/upsert).
 *
 * IMPORTANT:
 * - Never prints secret values.
 * - By default, keys present in input overwrite the same key in the bundle (upsert).
 * - Does not delete keys that are absent from input.
 *
 * @param {{
 *   repoRoot: string;
 *   envFiles: string[];
 *   keychainService: string;
 *   keychainAccount?: string;
 *   onlyMissing: boolean;
 *   ignoreMissing: boolean;
 *   dryRun: boolean;
 * }} opts
 * @returns {{
 *   ok: true;
 *   service: string;
 *   account: string;
 *   sources: string[];
 *   missingSources: string[];
 *   importedKeys: number;
 *   added: string[];
 *   updated: string[];
 *   skipped: string[];
 *   unchanged: number;
 *   wrote: boolean;
 * }}
 */
export function importDotenvIntoKeychainBundle(opts) {
  if (process.platform !== 'darwin') {
    throw new Error('[pipeline] Keychain import is only supported on macOS (darwin).');
  }

  const repoRoot = path.resolve(String(opts.repoRoot ?? ''));
  const service = String(opts.keychainService ?? '').trim();
  if (!service) throw new Error('[pipeline] --keychain-service is required');

  const account = String(opts.keychainAccount ?? '').trim();
  const envFiles = Array.isArray(opts.envFiles) ? opts.envFiles : [];
  if (envFiles.length === 0) throw new Error('[pipeline] no env files provided');

  const sources = [];
  const missingSources = [];
  /** @type {Record<string, string>} */
  let mergedEnv = {};

  for (const rel of envFiles) {
    const resolved = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
    const { env, missing } = readEnvFile({ filePath: resolved, ignoreMissing: opts.ignoreMissing });
    if (missing) {
      missingSources.push(rel);
      continue;
    }
    sources.push(rel);
    mergedEnv = { ...mergedEnv, ...env };
  }

  const imported = dropEmptyValues(mergedEnv);

  /** @type {Record<string, string>} */
  let existing = {};
  try {
    existing = readKeychainBundle({ service, account: account || undefined });
  } catch (err) {
    if (!isKeychainNotFoundError(err)) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    existing = {};
  }

  const onlyMissing = opts.onlyMissing === true;
  /** @type {Record<string, string>} */
  const next = { ...existing };

  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const updated = [];
  /** @type {string[]} */
  const skipped = [];
  let unchanged = 0;

  for (const [k, v] of Object.entries(imported)) {
    if (onlyMissing && Object.prototype.hasOwnProperty.call(existing, k)) {
      skipped.push(k);
      continue;
    }
    const prev = existing[k];
    if (typeof prev === 'string' && prev === v) {
      unchanged += 1;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(existing, k)) updated.push(k);
    else added.push(k);
    next[k] = v;
  }

  const wrote = !opts.dryRun && (added.length > 0 || updated.length > 0);
  if (wrote) {
    writeKeychainBundle({ service, account: account || undefined, bundle: next });
  }

  return {
    ok: true,
    service,
    account,
    sources,
    missingSources,
    importedKeys: Object.keys(imported).length,
    added: added.sort(),
    updated: updated.sort(),
    skipped: skipped.sort(),
    unchanged,
    wrote,
  };
}

