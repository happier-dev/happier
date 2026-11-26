import { join } from 'node:path';

import { findConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { expandHomeDirPath, resolveHomeDirFromEnvironment } from '@/utils/path/expandHomeDirPath';

/**
 * Undocumented `agy` switch (present in 1.5.18, absent in 1.5.15). With it, the profile token file
 * is the only credential source and refreshes stay in that file; without it an empty profile
 * silently falls back to the machine keyring login.
 */
export const AGY_FILE_TOKEN_STORAGE_ENV_KEY = 'AGY_CLI_FORCE_FILE_TOKEN_STORAGE';
/** `agy acp --app-data-dir` default: the profile subdirectory holding the token, conversations and settings. */
export const AGY_APP_DATA_DIR = 'antigravity-cli';
const CONNECTED_ACCOUNT_MINIMUM_VERSION = [1, 5, 18] as const;

export type AgyAcpLaunch = Readonly<{
  kind: 'machine' | 'connected';
  /** The `--gemini-dir` profile root, or null for the CLI default (`~/.gemini`). */
  profileDir: string | null;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  unsetEnv: readonly string[];
  admitInitializedAgent?: (agent: Readonly<{ version: string | null }>) => void;
}>;

/** The machine login's profile root: released `GEMINI_HOME` semantics, else `~/.gemini`. */
export function resolveAgyMachineProfileDir(env: NodeJS.ProcessEnv): string {
  const configured = env.GEMINI_HOME?.trim();
  return configured ? expandHomeDirPath(configured, env) : join(resolveHomeDirFromEnvironment(env), '.gemini');
}

function parseVersion(version: string | null): number[] | null {
  const match = version?.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function isAtLeast(version: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] !== minimum[index]) return version[index]! > minimum[index]!;
  }
  return true;
}

function admitConnectedAccountAgent(agent: Readonly<{ version: string | null }>): void {
  const version = parseVersion(agent.version);
  if (version && isAtLeast(version, CONNECTED_ACCOUNT_MINIMUM_VERSION)) return;
  const found = agent.version?.trim() ? ` (found ${agent.version.trim()})` : '';
  throw new Error(
    `Connected Antigravity accounts need Antigravity CLI ${CONNECTED_ACCOUNT_MINIMUM_VERSION.join('.')} or newer${found}. `
    + 'Run `agy update` on this machine, then try again.',
  );
}

/**
 * The single Antigravity launch decision for sessions, resumes, execution runs and probes.
 * Connected accounts run in their materialized profile with file-only token storage, so the
 * machine keyring login can neither be used nor changed; machine login never forces file storage.
 */
export function resolveAgyAcpLaunch(env: NodeJS.ProcessEnv): AgyAcpLaunch {
  if (!findConnectedServiceChildSelection(env, 'antigravity')) {
    const profileDir = env.GEMINI_HOME?.trim() ? resolveAgyMachineProfileDir(env) : null;
    return {
      kind: 'machine',
      profileDir,
      args: profileDir ? ['--gemini-dir', profileDir] : [],
      env: {},
      unsetEnv: [AGY_FILE_TOKEN_STORAGE_ENV_KEY],
    };
  }
  const profileDir = env.GEMINI_HOME?.trim();
  if (!profileDir) {
    throw new Error('The selected Antigravity account profile is not available on this machine. Select the account again.');
  }
  return {
    kind: 'connected',
    profileDir,
    args: ['--gemini-dir', profileDir, '--app-data-dir', AGY_APP_DATA_DIR],
    env: { [AGY_FILE_TOKEN_STORAGE_ENV_KEY]: '1' },
    unsetEnv: [],
    admitInitializedAgent: admitConnectedAccountAgent,
  };
}
