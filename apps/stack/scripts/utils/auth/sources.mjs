import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { getStacksStorageRoot, resolveStackEnvPath } from '../paths/paths.mjs';
import { findAnyCredentialPathInCliHome } from './credentials_paths.mjs';
import { parseEnvToObject } from '../env/dotenv.mjs';
import { getCliHomeDirFromEnvOrDefault } from '../stack/dirs.mjs';

function resolveStackCliHomeDir(stackName, env = process.env) {
  const { baseDir, envPath } = resolveStackEnvPath(stackName, env);
  let stackEnv = {};
  try {
    if (existsSync(envPath)) {
      stackEnv = parseEnvToObject(readFileSync(envPath, 'utf-8'));
    }
  } catch {
    stackEnv = {};
  }
  return getCliHomeDirFromEnvOrDefault({ stackBaseDir: baseDir, env: stackEnv });
}

function listLocalStackNames(env = process.env) {
  const root = getStacksStorageRoot(env);
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !String(entry.name ?? '').startsWith('.'))
      .map((entry) => String(entry.name ?? '').trim())
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

export function stackHasAccessKey(stackName, { env = process.env } = {}) {
  try {
    const { baseDir, envPath } = resolveStackEnvPath(stackName, env);
    if (!existsSync(envPath)) return false;
    return Boolean(findAnyCredentialPathInCliHome({ cliHomeDir: resolveStackCliHomeDir(stackName, env) || join(baseDir, 'cli') }));
  } catch {
    return false;
  }
}

/**
 * Seed sources that are safe to reuse locally.
 *
 * Note: deliberately does NOT include legacy ~/.happy sources; in many contexts we cannot reliably
 * seed DB Account rows, which leads to broken stacks.
 */
export function detectSeedableAuthSources({ env = process.env, excludeStackNames = [] } = {}) {
  const excluded = new Set(
    Array.isArray(excludeStackNames)
      ? excludeStackNames.map((name) => String(name ?? '').trim()).filter(Boolean)
      : []
  );
  const out = [];
  const addCandidate = (stackName) => {
    const name = String(stackName ?? '').trim();
    if (!name || excluded.has(name) || out.includes(name)) return;
    if (stackHasAccessKey(name, { env })) out.push(name);
  };

  addCandidate('dev-auth');
  for (const stackName of listLocalStackNames(env)) {
    if (stackName === 'dev-auth' || stackName === 'main') continue;
    addCandidate(stackName);
  }
  addCandidate('main');
  return out;
}

export function resolveReusableAuthSeedCandidates({ env = process.env, requestedSeed = '', excludeStackNames = [] } = {}) {
  const configuredSeed = String(requestedSeed ?? '').trim();
  const candidates = detectSeedableAuthSources({ env, excludeStackNames });
  if (!configuredSeed) return candidates;
  if (!candidates.includes(configuredSeed)) return candidates;
  return [configuredSeed, ...candidates.filter((seed) => seed !== configuredSeed)];
}

export function resolveReusableAuthSeedSource({ env = process.env, requestedSeed = '', excludeStackNames = [] } = {}) {
  const configuredSeed = String(requestedSeed ?? '').trim();
  const candidates = resolveReusableAuthSeedCandidates({ env, requestedSeed, excludeStackNames });
  if (configuredSeed && candidates.includes(configuredSeed)) {
    return { seed: configuredSeed, reason: 'configured' };
  }
  if (configuredSeed) {
    return candidates[0]
      ? { seed: candidates[0], reason: 'fallback_missing_configured_source', configuredSeed }
      : { seed: null, reason: 'missing_configured_source', configuredSeed };
  }
  return candidates[0] ? { seed: candidates[0], reason: 'detected' } : { seed: null, reason: 'no_seed_sources' };
}
