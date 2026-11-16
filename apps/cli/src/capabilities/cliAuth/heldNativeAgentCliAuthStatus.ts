import { stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { resolveConfiguredNativeHomePath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';

import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

import { detectNativeAgentCliAuthStatus } from './detectNativeAgentCliAuthStatus';
import type { CliAuthStatus } from './types';

/**
 * The daemon's held "Agent signed in" fact (P03 S4).
 *
 * A native auth probe spawns the Agent CLI (72–132 ms for `claude auth status`), so a
 * signed-in observation is held in memory for the next spawn with the same identity:
 * Agent, resolved CLI path, the binary's stat identity (a replaced or updated CLI is
 * observed again), the credential-bearing config dir, and which declared auth variables
 * are present (names only). No secret value or anything derived from one is part of the
 * key, and nothing here is persisted or logged.
 *
 * Signed-in and signed-out answers are held until the Agent's sign-in state changes on disk:
 * the stat metadata (never the contents) of the credential files the Agent's catalog entry
 * declares, their directories, and its declared native home. A terminal sign-in or sign-out
 * writes there, so the next read checks again at once (P03 ORCH decision). An Agent that
 * declares nothing on disk (e.g. a keychain-only sign-in) keeps the earlier rule: signed-in
 * is held per binary, signed-out and unknown are checked on every read. Unknown is never held.
 */
/** State and when it was observed: no account label, email or other identifying probe output. */
const heldAuthBySlot = new Map<string, Readonly<{
  binary: string;
  signInState: string | null;
  status: Readonly<Pick<CliAuthStatus, 'state' | 'reason'>>;
  checkedAt: number;
}>>();

export async function readHeldNativeAgentCliAuthStatus(params: Parameters<typeof detectNativeAgentCliAuthStatus>[0] & Readonly<{
  /** The Agent's declared native home; the credential-bearing config dir defaults to HOME. */
  nativeHome?: Parameters<typeof resolveConfiguredNativeHomePath>[0];
  /** Declared auth environment variable names; only their presence joins the key. */
  authEnvironmentVariables: readonly string[];
  /** An explicit refresh probes even a held signed-in fact, and records what it observes. */
  fresh?: boolean;
  /** The catalog-declared files a terminal sign-in writes (`cli.auth.credentialPaths`); stat only. */
  credentialPaths?: readonly string[];
}>): Promise<CliAuthStatus | null> {
  const env = params.processEnv ?? {};
  const presentAuthVariables = params.authEnvironmentVariables.filter((name) => Boolean(env[name]?.trim())).sort();
  const slot = JSON.stringify([params.agentId, params.resolvedPath, readConfigDir(params.nativeHome, env), presentAuthVariables]);
  const binary = await stat(params.resolvedPath)
    .then((file) => `${file.size}:${file.mtimeMs}:${file.ino}`)
    .catch(() => null);
  const readState = () => readSignInState(params.credentialPaths ?? [], params.nativeHome, env);
  const signInState = await readState();
  const held = heldAuthBySlot.get(slot);
  if (!params.fresh && binary !== null && held?.binary === binary && held.signInState === signInState) {
    return { ...held.status, checkedAt: held.checkedAt };
  }
  const { nativeHome: _nativeHome, authEnvironmentVariables: _authEnvironmentVariables, fresh: _fresh,
    credentialPaths: _credentialPaths, ...probe } = params;
  const status = await detectNativeAgentCliAuthStatus(probe);
  // Hold only an answer bracketed by the same sign-in state, and signed-out only when that state is knowable.
  const holdable = status?.state === 'logged_in' || (status?.state === 'logged_out' && signInState !== null);
  if (binary !== null && holdable && await readState() === signInState) {
    heldAuthBySlot.set(slot, { binary, signInState, checkedAt: status.checkedAt,
      status: { state: status.state, ...(status.reason ? { reason: status.reason } : {}) } });
  } else heldAuthBySlot.delete(slot);
  return status;
}

function statMetadata(info: Readonly<{ ino: number; size: number; mtimeMs: number }> | null): unknown {
  return info ? [info.ino, info.size, info.mtimeMs] : null;
}

/**
 * Stat metadata of where the Agent's sign-in lives; null when the Agent declares nothing on disk.
 * Declared credential files are re-rooted under the resolved native home when an override
 * (e.g. CLAUDE_CONFIG_DIR) moves it, and are watched as files: a sign-in creates or rewrites them,
 * a sign-out removes them. Only an Agent that declares no files is keyed on its native home dir.
 */
async function readSignInState(
  credentialPaths: readonly string[],
  nativeHome: Parameters<typeof resolveConfiguredNativeHomePath>[0] | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  if (credentialPaths.length === 0 && !nativeHome) return null;
  const resolvedHome = nativeHome ? readConfigDir(nativeHome, env) : null;
  const defaultHome = nativeHome ? resolve(resolveHomeDirFromEnvironment(env), nativeHome.defaultRelativePath) : null;
  const locations = credentialPaths.length > 0
    ? credentialPaths.map((path) => {
      const expanded = resolve(expandHomeDirPath(path, env));
      if (!resolvedHome || !defaultHome || resolvedHome === defaultHome) return expanded;
      const inside = relative(defaultHome, expanded);
      return inside && !inside.startsWith('..') && !isAbsolute(inside) ? join(resolvedHome, inside) : expanded;
    })
    : [resolvedHome!];
  const facts = await Promise.all([...new Set(locations)].sort().map(async (location) => [location,
    statMetadata(await stat(location).catch(() => null))]));
  return JSON.stringify(facts);
}

function readConfigDir(
  nativeHome: Parameters<typeof resolveConfiguredNativeHomePath>[0] | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (!nativeHome) return resolveHomeDirFromEnvironment(env);
  try {
    return resolveConfiguredNativeHomePath(nativeHome, env);
  } catch {
    // A malformed override is the Agent's own launch problem; it still names a distinct dir.
    return JSON.stringify([nativeHome.sourceEnvironmentKey, nativeHome.environmentKey, ...(nativeHome.fallbackEnvironmentKeys ?? [])]
      .map((key) => (key ? env[key] ?? null : null)));
  }
}
