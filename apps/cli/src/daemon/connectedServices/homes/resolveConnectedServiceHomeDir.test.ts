import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveConnectedServiceGroupHomeDir,
  resolveConnectedServiceHomeDir,
} from './resolveConnectedServiceHomeDir';

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

  it('separates profile homes from account group homes with a reserved segment', () => {
    const profileHome = resolveConnectedServiceHomeDir({
      activeServerDir: join('/', 'tmp', 'happier-server'),
      serviceId: 'openai-codex',
      profileId: 'groups',
      agentId: 'codex',
    });
    const groupHome = resolveConnectedServiceGroupHomeDir({
      activeServerDir: join('/', 'tmp', 'happier-server'),
      serviceId: 'openai-codex',
      groupId: 'groups',
      agentId: 'codex',
    });

    expect(profileHome).toBe(join('/', 'tmp', 'happier-server', 'daemon', 'connected-services', 'homes', 'openai-codex', 'groups', 'codex'));
    expect(groupHome).toBe(join('/', 'tmp', 'happier-server', 'daemon', 'connected-services', 'homes', 'openai-codex', '__groups', 'groups', 'codex'));
    expect(profileHome).not.toBe(groupHome);
  });
});
