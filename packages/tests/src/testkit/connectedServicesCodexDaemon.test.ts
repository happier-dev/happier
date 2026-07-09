import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { codexAuthPath } from './connectedServicesCodexDaemon';

async function writeMaterializedCodexAuth(daemonHomeDir: string, materializationKey: string): Promise<string> {
  const authPath = resolve(
    join(
      daemonHomeDir,
      'daemon',
      'connected-services',
      'materialized',
      materializationKey,
      'codex',
      'codex-home',
      'auth.json',
    ),
  );
  await mkdir(dirname(authPath), { recursive: true });
  await writeFile(authPath, '{}', 'utf8');
  return authPath;
}

function legacyCodexAuthPath(daemonHomeDir: string, serverId: string): string {
  return resolve(
    join(
      daemonHomeDir,
      'servers',
      serverId,
      'daemon',
      'connected-services',
      'homes',
      'openai-codex',
      'work',
      'codex',
      'codex-home',
      'auth.json',
    ),
  );
}

describe('codexAuthPath', () => {
  it('uses the materialized Codex auth path when exactly one candidate exists', async () => {
    const daemonHomeDir = await mkdtemp(join(tmpdir(), 'happier-codex-auth-path-single-'));

    try {
      const authPath = await writeMaterializedCodexAuth(daemonHomeDir, 'csm_single');

      expect(codexAuthPath({ daemonHomeDir, serverId: 'server-1' })).toBe(authPath);
    } finally {
      await rm(daemonHomeDir, { recursive: true, force: true });
    }
  });

  it('falls back to the server-scoped Codex auth path when materialized candidates are ambiguous', async () => {
    const daemonHomeDir = await mkdtemp(join(tmpdir(), 'happier-codex-auth-path-ambiguous-'));

    try {
      await writeMaterializedCodexAuth(daemonHomeDir, 'csm_first');
      await writeMaterializedCodexAuth(daemonHomeDir, 'csm_second');

      expect(codexAuthPath({ daemonHomeDir, serverId: 'server-1' })).toBe(
        legacyCodexAuthPath(daemonHomeDir, 'server-1'),
      );
    } finally {
      await rm(daemonHomeDir, { recursive: true, force: true });
    }
  });
});
