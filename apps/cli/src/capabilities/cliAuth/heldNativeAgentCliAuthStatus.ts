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
 * Answers are held until the Agent's sign-in state changes on disk, where its cliAuth hook declares
 * that state observable (`signInState`: home-relative paths, and the platforms where sign-in really
 * writes them): the stat metadata (never contents) of those paths, re-rooted under the resolved
 * native home when an override (e.g. CLAUDE_CONFIG_DIR) moves it. A terminal sign-in or sign-out
 * writes there, so the next read checks again at once (P03 ORCH decision). Signed-out and unknown
 * (a CLI that does not answer its status probe, a timeout) are held only there. Where nothing is
 * declared for this platform (e.g. a macOS Keychain or other OS credential store sign-in), signed-in
 * is held per binary and signed-out/unknown are checked on every read.
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
}>): Promise<CliAuthStatus | null> {
  const env = params.processEnv ?? {};
  const presentAuthVariables = params.authEnvironmentVariables.filter((name) => Boolean(env[name]?.trim())).sort();
  const slot = JSON.stringify([params.agentId, params.resolvedPath, readConfigDir(params.nativeHome, env), presentAuthVariables]);
  const binary = await stat(params.resolvedPath)
    .then((file) => `${file.size}:${file.mtimeMs}:${file.ino}`)
    .catch(() => null);
  const readState = () => readSignInState(params.authSpec?.signInState, params.nativeHome, env);
  const signInState = await readState();
  const held = heldAuthBySlot.get(slot);
  if (!params.fresh && binary !== null && held?.binary === binary && held.signInState === signInState) {
    return { ...held.status, checkedAt: held.checkedAt };
  }
  const { nativeHome: _nativeHome, authEnvironmentVariables: _authEnvironmentVariables, fresh: _fresh,
    ...probe } = params;
  const status = await detectNativeAgentCliAuthStatus(probe);
  // Hold only an answer bracketed by the same sign-in state, and signed-out/unknown only when that state is knowable.
  const holdable = status?.state === 'logged_in'
    || ((status?.state === 'logged_out' || status?.state === 'unknown') && signInState !== null);
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
 * Stat metadata of the Agent's declared sign-in state; null when nothing is declared observable on
 * this platform. Paths under the default native home are re-rooted under the resolved one.
 */
async function readSignInState(
  declared: Readonly<{ paths: readonly string[]; platforms: readonly NodeJS.Platform[] }> | undefined,
  nativeHome: Parameters<typeof resolveConfiguredNativeHomePath>[0] | undefined,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (!declared || declared.paths.length === 0 || !declared.platforms.includes(platform)) return null;
  const resolvedHome = nativeHome ? readConfigDir(nativeHome, env) : null;
  const defaultHome = nativeHome ? resolve(resolveHomeDirFromEnvironment(env), nativeHome.defaultRelativePath) : null;
  const locations = declared.paths.map((path) => {
    const expanded = resolve(expandHomeDirPath(path, env));
    if (!resolvedHome || !defaultHome || resolvedHome === defaultHome) return expanded;
    const inside = relative(defaultHome, expanded);
    return inside && !inside.startsWith('..') && !isAbsolute(inside) ? join(resolvedHome, inside) : expanded;
  });
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
