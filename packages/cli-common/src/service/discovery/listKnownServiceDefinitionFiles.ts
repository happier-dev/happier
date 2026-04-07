import { readdir } from 'node:fs/promises';
import { extname, basename, join } from 'node:path';

import type {
  ServiceDefinitionFile,
  ServiceDiscoveryRoot,
  ServiceDefinitionKind,
} from './serviceDiscoveryTypes.js';

function resolveServiceDefinitionKind(filePath: string): ServiceDefinitionKind | null {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.plist') return 'launchd-plist';
  if (ext === '.service') return 'systemd-unit';
  if (ext === '.ps1') return 'windows-wrapper-ps1';
  return null;
}

function resolveLabel(filePath: string): string {
  const name = basename(filePath);
  const suffix = extname(name);
  return suffix ? name.slice(0, name.length - suffix.length) : name;
}

export async function listKnownServiceDefinitionFiles(params: Readonly<{
  roots: readonly ServiceDiscoveryRoot[];
}>): Promise<readonly ServiceDefinitionFile[]> {
  const files: ServiceDefinitionFile[] = [];

  for (const root of params.roots ?? []) {
    const rootPath = String(root?.path ?? '').trim();
    if (!rootPath) continue;

    let entries;
    try {
      entries = await readdir(rootPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(rootPath, entry.name);
      const kind = resolveServiceDefinitionKind(entry.name);
      if (!kind) continue;
      files.push({
        path,
        scope: root.scope,
        kind,
        label: resolveLabel(entry.name),
      });
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}
