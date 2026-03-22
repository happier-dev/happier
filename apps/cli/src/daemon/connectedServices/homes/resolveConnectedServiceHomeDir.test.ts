import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceHomeDir } from './resolveConnectedServiceHomeDir';

describe('resolveConnectedServiceHomeDir', () => {
  it('scopes homes under the active server dir', () => {
    const dir = resolveConnectedServiceHomeDir({
      activeServerDir: join('/', 'tmp', 'happier-server'),
      serviceId: 'openai-codex',
      profileId: 'work',
      agentId: 'codex',
    });

    expect(dir).toBe(join('/', 'tmp', 'happier-server', 'daemon', 'connected-services', 'homes', 'openai-codex', 'work', 'codex'));
  });

  it('does not allow providerScopedKey to escape the base directory', () => {
    const base = resolveConnectedServiceHomeDir({
      activeServerDir: join('/', 'tmp', 'happier-server'),
      serviceId: 'openai-codex',
      profileId: 'work',
      agentId: 'codex',
    });

    const derived = resolveConnectedServiceHomeDir({
      activeServerDir: join('/', 'tmp', 'happier-server'),
      serviceId: 'openai-codex',
      profileId: 'work',
      agentId: 'codex',
      providerScopedKey: '../evil/../../key',
    });

    expect(resolve(derived).startsWith(resolve(base))).toBe(true);
    expect(derived).not.toContain('evil');
  });
});

