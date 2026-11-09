import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { RunnerIsolationEnvironmentKeyV1 } from '@happier-dev/protocol/ephemeralRunner/runnerEnvironment';

import { stripInheritedConnectedServiceEnvironment } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';
import { isValidProcessEnvKey, isWindowsSystemEnvKey } from '@/utils/processEnv/environmentKeys';
import {
  resolveCanonicalAbsolutePath,
  resolveHomeDirFromEnvironment,
} from '@/utils/path/expandHomeDirPath';

export type EphemeralRunnerLocalState = Readonly<{
  homeDirectory: string;
  /** Canonical home of the endpoint user, captured before Runner storage isolation. */
  endpointHomeDirectory: string;
  environment: NodeJS.ProcessEnv;
  /** Ambient keys removed again at the canonical Session launch boundary. */
  unsetEnvironmentVariables: readonly string[];
  dispose(): Promise<void>;
}>;

const RUNNER_PROCESS_STORAGE_ENVIRONMENT_KEYS = Object.freeze([
  'HAPPIER_HOME_DIR',
  'HOME',
  'USERPROFILE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'TEMP',
  'TMP',
  'TMPDIR',
] as const);

const SAFE_INHERITED_ENVIRONMENT_KEYS = new Set([
  'COLORTERM',
  'FORCE_COLOR',
  'LANG',
  'NO_COLOR',
  'NUMBER_OF_PROCESSORS',
  'PATH',
  'PROCESSOR_ARCHITECTURE',
  'SHELL',
  'TERM',
  'TZ',
]);

function environmentKeyIdentity(key: string): string {
  return key.toUpperCase();
}

/**
 * Establishes the standalone Runner's storage root before importing the broad
 * runtime graph. The Runner is a dedicated process, but returning an exact
 * restoration closure keeps module-isolation tests and embedded invocations
 * deterministic without reloading or mutating the configuration singleton.
 */
export function bindEphemeralRunnerProcessStorageEnvironment(
  localState: EphemeralRunnerLocalState,
): () => void {
  const affectedIdentities = new Set(
    RUNNER_PROCESS_STORAGE_ENVIRONMENT_KEYS.map(environmentKeyIdentity),
  );
  const previousEntries = Object.entries(process.env).filter(([key]) => (
    affectedIdentities.has(environmentKeyIdentity(key))
  ));
  for (const key of Object.keys(process.env)) {
    if (affectedIdentities.has(environmentKeyIdentity(key))) delete process.env[key];
  }
  for (const key of RUNNER_PROCESS_STORAGE_ENVIRONMENT_KEYS) {
    const value = localState.environment[key];
    if (typeof value === 'string') process.env[key] = value;
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const key of Object.keys(process.env)) {
      if (affectedIdentities.has(environmentKeyIdentity(key))) delete process.env[key];
    }
    for (const [key, value] of previousEntries) process.env[key] = value;
  };
}

function buildRunnerEnvironment(input: Readonly<{
  baseEnvironment: NodeJS.ProcessEnv;
  homeDirectory: string;
}>): Readonly<{
  environment: NodeJS.ProcessEnv;
  unsetEnvironmentVariables: readonly string[];
}> {
  const compactBase = Object.fromEntries(
    Object.entries(input.baseEnvironment)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const withoutParentConnectedServices = stripInheritedConnectedServiceEnvironment(compactBase);
  const safeBase = Object.fromEntries(
    Object.entries(withoutParentConnectedServices).filter(([key]) => {
      const identity = environmentKeyIdentity(key);
      return isWindowsSystemEnvKey(key) || SAFE_INHERITED_ENVIRONMENT_KEYS.has(identity) || identity.startsWith('LC_');
    }),
  );
  const environment = buildScopedProcessEnv({
    baseEnv: safeBase,
    explicitEnv: {
      HAPPIER_HOME_DIR: input.homeDirectory,
      HOME: input.homeDirectory,
      USERPROFILE: input.homeDirectory,
      XDG_CACHE_HOME: join(input.homeDirectory, '.cache'),
      XDG_CONFIG_HOME: join(input.homeDirectory, '.config'),
      XDG_DATA_HOME: join(input.homeDirectory, '.local', 'share'),
      TEMP: join(input.homeDirectory, 'tmp'),
      TMP: join(input.homeDirectory, 'tmp'),
      TMPDIR: join(input.homeDirectory, 'tmp'),
    } satisfies Record<RunnerIsolationEnvironmentKeyV1, string>,
  });
  const retained = new Set(Object.keys(environment).map(environmentKeyIdentity));
  const unsetEnvironmentVariables = Object.keys(compactBase).filter((key) => (
    isValidProcessEnvKey(key)
    && !retained.has(environmentKeyIdentity(key))
  ));
  return Object.freeze({
    environment: Object.freeze(environment),
    unsetEnvironmentVariables: Object.freeze(unsetEnvironmentVariables),
  });
}

function safeActivationPrefix(activationId: string): string {
  const value = activationId.trim();
  if (!/^[a-zA-Z0-9-]{1,191}$/.test(value)) {
    throw new Error('Invalid ephemeral Runner activation identity');
  }
  return `activation-${value}-`;
}

function isStrictDescendant(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
}

export async function createEphemeralRunnerLocalState(input: Readonly<{
  activationId: string;
  parentDirectory?: string;
  baseEnvironment?: NodeJS.ProcessEnv;
}>): Promise<EphemeralRunnerLocalState> {
  const baseEnvironment = input.baseEnvironment ?? process.env;
  const endpointHome = resolveCanonicalAbsolutePath(
    resolveHomeDirFromEnvironment(baseEnvironment, process.platform),
    { env: baseEnvironment, platform: process.platform },
  );
  if (endpointHome === null) throw new Error('Ephemeral Runner could not resolve the endpoint home directory');
  const requestedParent = resolve(input.parentDirectory ?? join(tmpdir(), 'happier-runner'));
  await mkdir(requestedParent, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(requestedParent, 0o700);
  const canonicalParent = await realpath(requestedParent);
  const prefix = safeActivationPrefix(input.activationId);
  const homeDirectory = await mkdtemp(join(canonicalParent, prefix));
  let canonicalHome: string | null = null;
  let scopedEnvironment: ReturnType<typeof buildRunnerEnvironment>;
  try {
    if (process.platform !== 'win32') await chmod(homeDirectory, 0o700);
    canonicalHome = await realpath(homeDirectory);
    if (!isStrictDescendant(canonicalParent, canonicalHome) || !basename(canonicalHome).startsWith(prefix)) {
      throw new Error('Ephemeral Runner state escaped its protected parent directory');
    }
    // Keep setup sequential so a rejected directory creation cannot race the
    // owner-local failure cleanup and recreate state after it has been removed.
    await mkdir(join(canonicalHome, '.cache'), { recursive: true, mode: 0o700 });
    await mkdir(join(canonicalHome, '.config'), { recursive: true, mode: 0o700 });
    await mkdir(join(canonicalHome, '.local', 'share'), { recursive: true, mode: 0o700 });
    await mkdir(join(canonicalHome, 'tmp'), { recursive: true, mode: 0o700 });
    scopedEnvironment = buildRunnerEnvironment({
      baseEnvironment,
      homeDirectory: canonicalHome,
    });
  } catch (error) {
    // mkdtemp established exact ownership before any later setup can fail.
    // Remove only those exact bytes; never derive this fallback from env.
    await rm(canonicalHome ?? homeDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  if (canonicalHome === null) throw new Error('Ephemeral Runner state setup did not establish its canonical Home');
  const ownedHome = canonicalHome;

  let disposed = false;
  return Object.freeze({
    homeDirectory: ownedHome,
    endpointHomeDirectory: endpointHome.path,
    environment: scopedEnvironment.environment,
    unsetEnvironmentVariables: scopedEnvironment.unsetEnvironmentVariables,
    async dispose() {
      if (disposed) return;
      disposed = true;
      // The target is the exact canonical directory returned by mkdtemp and is
      // checked again before recursive removal. Never derive cleanup from env.
      if (!isStrictDescendant(canonicalParent, ownedHome) || !basename(ownedHome).startsWith(prefix)) {
        throw new Error('Refusing unsafe ephemeral Runner cleanup target');
      }
      await rm(ownedHome, { recursive: true, force: true });
    },
  });
}
