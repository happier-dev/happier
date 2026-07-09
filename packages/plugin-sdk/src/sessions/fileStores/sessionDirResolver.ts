import { lstat, readdir, readFile } from 'node:fs/promises';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SessionFileStoreProductDescriptorV1 } from './productDescriptor.js';
import type { SessionFileStoreRootDescriptorV1 } from './sessionRootDescriptor.js';
import { canonicalizePath, canonicalizePathSync, resolveConfiguredPath } from './paths.js';
import { validateSessionFileStoreRootDescriptor } from './sessionRootDescriptor.js';

export type SessionFileStoreDirSource =
  | 'grantedRoot'
  | 'agentDirEnv'
  | 'legacySessionDirEnv'
  | 'settingsSessionDir'
  | 'productDefault';

export type SessionFileStoreResolutionInputV1 = Readonly<{
  product: SessionFileStoreProductDescriptorV1;
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  cwd?: string;
  grantedRoot?: SessionFileStoreRootDescriptorV1 | null;
}>;

export type SessionFileStoreResolutionV1 = Readonly<{
  agentDir: string;
  sessionsRoot: string;
  resolvedFrom: SessionFileStoreDirSource;
}>;

function readNonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function validateGrantedRootSync(
  input: SessionFileStoreResolutionInputV1,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  if (!input.grantedRoot) return null;
  if (input.grantedRoot.v !== 1) return null;
  if (!Object.is(input.grantedRoot.productId, input.product.productId)) return null;
  const agentDir = canonicalizePathSync(resolveConfiguredPath(input.grantedRoot.agentDir, input));
  if (input.grantedRoot.grantedBy !== 'host-external-session-source') return agentDir;
  const configuredAgentDir = readNonEmpty(env[input.product.agentDirEnvVar]);
  if (!configuredAgentDir) return agentDir;
  const canonicalConfigured = canonicalizePathSync(resolveConfiguredPath(configuredAgentDir, input));
  return Object.is(canonicalConfigured, agentDir) ? agentDir : null;
}

function defaultAgentDir(product: SessionFileStoreProductDescriptorV1, homeDir?: string): string {
  return join(homeDir ?? homedir(), ...product.defaultAgentDirSegments);
}

async function readSettingsSessionDir(params: Readonly<{
  product: SessionFileStoreProductDescriptorV1;
  agentDir: string;
  homeDir?: string;
  cwd?: string;
}>): Promise<string | null> {
  if (!params.product.readsSettingsSessionDir) return null;
  const files = [
    join(params.agentDir, 'settings.json'),
    ...(params.cwd ? [join(params.cwd, params.product.configDirName, 'settings.json')] : []),
  ];
  for (const filePath of files) {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const sessionDir = readNonEmpty((parsed as Record<string, unknown>).sessionDir);
      if (!sessionDir) continue;
      return resolveConfiguredPath(sessionDir, { homeDir: params.homeDir, cwd: params.cwd, relativeTo: filePath });
    } catch {
      // Invalid or missing settings do not make discovery fail.
    }
  }
  return null;
}

function readSettingsSessionDirSync(params: Readonly<{
  product: SessionFileStoreProductDescriptorV1;
  agentDir: string;
  homeDir?: string;
  cwd?: string;
}>): string | null {
  if (!params.product.readsSettingsSessionDir) return null;
  const files = [
    join(params.agentDir, 'settings.json'),
    ...(params.cwd ? [join(params.cwd, params.product.configDirName, 'settings.json')] : []),
  ];
  for (const filePath of files) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const sessionDir = readNonEmpty((parsed as Record<string, unknown>).sessionDir);
      if (!sessionDir) continue;
      return resolveConfiguredPath(sessionDir, { homeDir: params.homeDir, cwd: params.cwd, relativeTo: filePath });
    } catch {
      // Invalid or missing settings do not make discovery fail.
    }
  }
  return null;
}

export async function resolveSessionFileStoreDirs(
  input: SessionFileStoreResolutionInputV1,
): Promise<SessionFileStoreResolutionV1> {
  const env = input.env ?? {};
  if (input.grantedRoot) {
    const validation = await validateSessionFileStoreRootDescriptor({
      descriptor: input.grantedRoot,
      product: input.product,
      env,
    });
    if (validation.ok) {
      return {
        agentDir: validation.canonicalAgentDir,
        sessionsRoot: join(validation.canonicalAgentDir, 'sessions'),
        resolvedFrom: 'grantedRoot',
      };
    }
  }

  const envAgentDir = readNonEmpty(env[input.product.agentDirEnvVar]);
  if (envAgentDir) {
    const agentDir = await canonicalizePath(resolveConfiguredPath(envAgentDir, input));
    return { agentDir, sessionsRoot: join(agentDir, 'sessions'), resolvedFrom: 'agentDirEnv' };
  }

  const defaultDir = await canonicalizePath(defaultAgentDir(input.product, input.homeDir));
  const legacySessionDir = input.product.legacySessionDirEnvVars
    .map((envVar) => readNonEmpty(env[envVar]))
    .find((value): value is string => value != null);
  if (legacySessionDir) {
    return {
      agentDir: defaultDir,
      sessionsRoot: await canonicalizePath(resolveConfiguredPath(legacySessionDir, input)),
      resolvedFrom: 'legacySessionDirEnv',
    };
  }

  const settingsSessionDir = await readSettingsSessionDir({
    product: input.product,
    agentDir: defaultDir,
    homeDir: input.homeDir,
    cwd: input.cwd,
  });
  if (settingsSessionDir) {
    return {
      agentDir: defaultDir,
      sessionsRoot: await canonicalizePath(settingsSessionDir),
      resolvedFrom: 'settingsSessionDir',
    };
  }

  return { agentDir: defaultDir, sessionsRoot: join(defaultDir, 'sessions'), resolvedFrom: 'productDefault' };
}

export function resolveSessionFileStoreDirsSync(
  input: SessionFileStoreResolutionInputV1,
): SessionFileStoreResolutionV1 {
  const env = input.env ?? {};
  const grantedAgentDir = validateGrantedRootSync(input, env);
  if (grantedAgentDir) {
    const agentDir = grantedAgentDir;
    return { agentDir, sessionsRoot: join(agentDir, 'sessions'), resolvedFrom: 'grantedRoot' };
  }

  const envAgentDir = readNonEmpty(env[input.product.agentDirEnvVar]);
  if (envAgentDir) {
    const agentDir = canonicalizePathSync(resolveConfiguredPath(envAgentDir, input));
    return { agentDir, sessionsRoot: join(agentDir, 'sessions'), resolvedFrom: 'agentDirEnv' };
  }

  const defaultDir = canonicalizePathSync(defaultAgentDir(input.product, input.homeDir));
  const legacySessionDir = input.product.legacySessionDirEnvVars
    .map((envVar) => readNonEmpty(env[envVar]))
    .find((value): value is string => value != null);
  if (legacySessionDir) {
    return {
      agentDir: defaultDir,
      sessionsRoot: canonicalizePathSync(resolveConfiguredPath(legacySessionDir, input)),
      resolvedFrom: 'legacySessionDirEnv',
    };
  }

  const settingsSessionDir = readSettingsSessionDirSync({
    product: input.product,
    agentDir: defaultDir,
    homeDir: input.homeDir,
    cwd: input.cwd,
  });
  if (settingsSessionDir) {
    return {
      agentDir: defaultDir,
      sessionsRoot: canonicalizePathSync(settingsSessionDir),
      resolvedFrom: 'settingsSessionDir',
    };
  }

  return { agentDir: defaultDir, sessionsRoot: join(defaultDir, 'sessions'), resolvedFrom: 'productDefault' };
}

export async function listSessionFileStoreRoots(
  resolution: Pick<SessionFileStoreResolutionV1, 'sessionsRoot'>,
): Promise<readonly string[]> {
  try {
    const entries = await readdir(resolution.sessionsRoot, { withFileTypes: true });
    const roots: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = join(resolution.sessionsRoot, entry.name);
      try {
        if ((await lstat(path)).isDirectory()) roots.push(path);
      } catch {
        // Ignore disappearing roots.
      }
    }
    return roots;
  } catch {
    return [];
  }
}

export function listSessionFileStoreRootsSync(
  resolution: Pick<SessionFileStoreResolutionV1, 'sessionsRoot'>,
): readonly string[] {
  try {
    return readdirSync(resolution.sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(resolution.sessionsRoot, entry.name))
      .filter((path) => {
        try {
          return lstatSync(path).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}
