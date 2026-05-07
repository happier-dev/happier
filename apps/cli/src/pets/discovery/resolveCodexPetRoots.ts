import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import { resolveCodexHomeEntriesForDirectSessionsSource } from '@/backends/codex/directSessions/resolveCodexHomeEntriesForDirectSessionsSource';
import { resolveConfiguredCodexHome } from '@/backends/codex/utils/resolveConfiguredCodexHome';
import type { PetDiscoveryDiagnosticV1 } from '@happier-dev/protocol';

import { createPetSourceKey } from './createPetSourceKey';

export type CodexPetRoot = Readonly<{
  kind: 'detectedCodexHome';
  homeKind: 'user' | 'connectedService';
  homePath: string;
  petsPath: string;
  sourceKey: string;
}>;

export type ManagedLocalPetRoot = Readonly<{
  kind: 'happierManagedLocal';
  petsPath: string;
  sourceKey: string;
}>;

export type PetDiscoveryRoot = CodexPetRoot | ManagedLocalPetRoot;

export type ResolveCodexPetRootsResult = Readonly<{
  roots: CodexPetRoot[];
  diagnostics: PetDiscoveryDiagnosticV1[];
  partial: boolean;
}>;

function isSafeConnectedServiceId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);
}

async function listConnectedServiceIds(activeServerDir: string, maxRoots: number): Promise<Readonly<{
  serviceIds: string[];
  truncated: boolean;
  rootPath: string;
}>> {
  const base = join(activeServerDir, 'daemon', 'connected-services', 'homes');
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const serviceIds = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && isSafeConnectedServiceId(entry.name))
    .map((entry) => entry.name)
    .sort();
  return {
    serviceIds: serviceIds.slice(0, maxRoots),
    truncated: serviceIds.length > maxRoots,
    rootPath: base,
  };
}

export async function resolveCodexPetRootsWithDiagnostics(input: Readonly<{
  env?: NodeJS.ProcessEnv;
  activeServerDir?: string;
  includeUserCodexHome?: boolean;
  includeConnectedServiceCodexHomes?: boolean;
  maxConnectedServiceRoots?: number;
}> = {}): Promise<ResolveCodexPetRootsResult> {
  const env = input.env ?? process.env;
  const roots: CodexPetRoot[] = [];
  const diagnostics: PetDiscoveryDiagnosticV1[] = [];
  let partial = false;

  if (input.includeUserCodexHome !== false) {
    const codexHome = resolveConfiguredCodexHome(env);
    roots.push({
      kind: 'detectedCodexHome',
      homeKind: 'user',
      homePath: codexHome,
      petsPath: join(codexHome, 'pets'),
      sourceKey: createPetSourceKey(['detectedCodexHome', 'user', codexHome]),
    });
  }

  if (input.includeConnectedServiceCodexHomes !== false) {
    const activeServerDir = input.activeServerDir ?? configuration.activeServerDir;
    const maxRoots = input.maxConnectedServiceRoots ?? 256;
    let connectedServiceRootCount = 0;
    let rootLimitDiagnosticAdded = false;
    const addRootLimitDiagnostic = (rootPath: string) => {
      if (rootLimitDiagnosticAdded) return;
      diagnostics.push({
        code: 'root_limit_exceeded',
        message: 'Connected-service Codex home enumeration exceeded the root budget.',
        rootPath,
      });
      rootLimitDiagnosticAdded = true;
      partial = true;
    };
    const listed = await listConnectedServiceIds(activeServerDir, maxRoots);
    if (listed.truncated) {
      addRootLimitDiagnostic(listed.rootPath);
    }

    const serviceIds = listed.serviceIds;
    for (const connectedServiceId of serviceIds) {
      if (connectedServiceRootCount >= maxRoots) {
        addRootLimitDiagnostic(listed.rootPath);
        break;
      }
      const entries = await resolveCodexHomeEntriesForDirectSessionsSource({
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId,
        },
        activeServerDir,
        env,
      });

      for (const entry of entries) {
        if (connectedServiceRootCount >= maxRoots) {
          addRootLimitDiagnostic(listed.rootPath);
          break;
        }
        roots.push({
          kind: 'detectedCodexHome',
          homeKind: 'connectedService',
          homePath: entry.codexHome,
          petsPath: join(entry.codexHome, 'pets'),
          sourceKey: createPetSourceKey(['detectedCodexHome', 'connectedService', entry.codexHome]),
        });
        connectedServiceRootCount += 1;
      }
    }
  }

  return { roots, diagnostics, partial };
}

export async function resolveCodexPetRoots(input: Parameters<typeof resolveCodexPetRootsWithDiagnostics>[0] = {}): Promise<CodexPetRoot[]> {
  const resolved = await resolveCodexPetRootsWithDiagnostics(input);
  return resolved.roots;
}
