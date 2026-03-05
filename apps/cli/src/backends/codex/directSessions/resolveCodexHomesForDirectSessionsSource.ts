import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { DirectSessionsSource } from '@happier-dev/protocol';

export async function resolveCodexHomesForDirectSessionsSource(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
}>): Promise<string[]> {
  if (params.source.kind !== 'codexHome') return [];

  if (params.source.home === 'user') {
    const codexHome =
      typeof params.env.CODEX_HOME === 'string' && params.env.CODEX_HOME.trim().length > 0
        ? params.env.CODEX_HOME.trim()
        : join(homedir(), '.codex');
    return [codexHome];
  }

  const serviceId = typeof (params.source as any).connectedServiceId === 'string' ? String((params.source as any).connectedServiceId).trim() : '';
  if (!serviceId) return [];

  const homes: string[] = [];
  const base = join(params.activeServerDir, 'daemon', 'connected-services', 'homes', serviceId);

  let profiles: any[];
  try {
    profiles = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of profiles) {
    if (!entry.isDirectory()) continue;
    if (entry.isSymbolicLink()) continue;
    const profileId = typeof entry.name === 'string' ? entry.name : String(entry.name);
    const codexHome = join(base, profileId, 'codex', 'codex-home');
    try {
      const s = await stat(codexHome);
      if (s.isDirectory()) homes.push(codexHome);
    } catch {
      // ignore missing
    }
  }

  return homes;
}

