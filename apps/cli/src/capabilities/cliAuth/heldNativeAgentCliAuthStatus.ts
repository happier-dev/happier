import { stat } from 'node:fs/promises';
import { resolveConfiguredNativeHomePath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';

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
 * Only `logged_in` is held. A signed-out or unknown observation is probed again on the
 * next spawn, so signing in is seen at once and a key that ignores secret values can
 * never refuse a launch on a stale observation. A held fact that went stale (signed out
 * natively since) surfaces as the provider's own sign-in failure at start.
 */
/** Only the binary identity and when it was observed: no account label, email or other probe output. */
const heldSignedInBySlot = new Map<string, Readonly<{ binary: string; checkedAt: number }>>();

export async function readHeldNativeAgentCliAuthStatus(params: Parameters<typeof detectNativeAgentCliAuthStatus>[0] & Readonly<{
  /** The Agent's declared native home; the credential-bearing config dir defaults to HOME. */
  nativeHome?: Parameters<typeof resolveConfiguredNativeHomePath>[0];
  /** Declared auth environment variable names; only their presence joins the key. */
  authEnvironmentVariables: readonly string[];
}>): Promise<CliAuthStatus | null> {
  const env = params.processEnv ?? {};
  const presentAuthVariables = params.authEnvironmentVariables.filter((name) => Boolean(env[name]?.trim())).sort();
  const slot = JSON.stringify([params.agentId, params.resolvedPath, readConfigDir(params.nativeHome, env), presentAuthVariables]);
  const binary = await stat(params.resolvedPath)
    .then((file) => `${file.size}:${file.mtimeMs}:${file.ino}`)
    .catch(() => null);
  const held = heldSignedInBySlot.get(slot);
  if (binary !== null && held?.binary === binary) return { state: 'logged_in', checkedAt: held.checkedAt };
  const { nativeHome: _nativeHome, authEnvironmentVariables: _authEnvironmentVariables, ...probe } = params;
  const status = await detectNativeAgentCliAuthStatus(probe);
  if (binary !== null && status?.state === 'logged_in') heldSignedInBySlot.set(slot, { binary, checkedAt: status.checkedAt });
  else heldSignedInBySlot.delete(slot);
  return status;
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
