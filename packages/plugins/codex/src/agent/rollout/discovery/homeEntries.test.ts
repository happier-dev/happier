import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  homeEntries,
  resolveConfiguredCodexHomePath,
} from './homeEntries';

describe('Codex external session home entries', () => {
  it('resolves CODEX_HOME relative to the caller environment home', () => {
    expect(resolveConfiguredCodexHomePath({
      CODEX_HOME: '~/custom-codex',
      HOME: '/tmp/codex-user',
    })).toBe(resolve('/tmp/codex-user', 'custom-codex'));
  });

  it('falls back to the caller environment home when CODEX_HOME is unset', () => {
    expect(resolveConfiguredCodexHomePath({
      HOME: '/tmp/codex-user',
    })).toBe(resolve('/tmp/codex-user', '.codex'));
  });

  it('uses an exact connected-service group homePath', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-group-home-'));
    const activeServerDir = join(root, 'servers', 'cloud');
    const groupCodexHome = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'openai-codex',
      '__groups',
      'team',
      'codex',
      'codex-home',
    );
    await mkdir(join(groupCodexHome, 'sessions'), { recursive: true });
    await writeFile(join(groupCodexHome, 'sessions', 'rollout-2026-01-01T00-00-00-11111111-1111-1111-1111-111111111111.jsonl'), '', 'utf8');
    const verifiedGroupCodexHome = await realpath(groupCodexHome);

    const entries = await homeEntries({
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceGroupId: 'team',
        homePath: groupCodexHome,
      },
      activeServerDir,
      env: {},
    });

    expect(entries).toEqual([
      {
        codexHome: verifiedGroupCodexHome,
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceGroupId: 'team',
          homePath: verifiedGroupCodexHome,
        },
      },
    ]);
  });
});
