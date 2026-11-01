import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LoadedLinkedDirectSession } from '@/api/directSessions/takeover/loadLinkedDirectSession';
import { validateDirectMachineSource } from '@/api/directSessions/security/validateDirectMachineSource';
import { buildClaudeSubprocessEnv } from '../spawn/buildClaudeSubprocessEnv';
import { claudeDirectSessionProviderOps } from './providerOps';

function linkedSession(configDir?: string | null): LoadedLinkedDirectSession {
  return {
    rawSession: {
      id: 'linked-session', seq: 0, createdAt: 0, updatedAt: 0, active: false, activeAt: 0,
      metadata: '{}', metadataVersion: 0, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
    },
    metadata: {},
    sessionPath: join(process.cwd(), 'project'),
    providerId: 'claude',
    machineId: 'machine',
    remoteSessionId: 'native-session',
    source: { kind: 'claudeConfig', configDir },
    codexBackendMode: null,
  };
}

describe('Claude Direct takeover authentication environment', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('preserves unset authentication when validation resolves a symlinked default store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-takeover-native-'));
    try {
      const store = join(root, 'native-store');
      await mkdir(store);
      await symlink(store, join(root, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');
      vi.stubEnv('HOME', root);
      vi.stubEnv('USERPROFILE', root);
      vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
      vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', undefined);
      const linked = linkedSession();
      const validation = validateDirectMachineSource({ providerId: 'claude', source: linked.source, env: process.env });
      if (!validation.ok) throw new Error(validation.error);
      const options = await claudeDirectSessionProviderOps.resolveTakeoverSpawnOptions!({
        linked: { ...linked, source: validation.source }, sessionId: 'linked-session', transcriptStorage: 'direct',
      });

      expect(options?.environmentVariables?.CLAUDE_CONFIG_DIR).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([undefined, null, '   '])('preserves unset native config when source configDir is %s', async (configDir) => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', undefined);
    const linked = linkedSession(configDir);
    const validation = validateDirectMachineSource({ providerId: 'claude', source: linked.source, env: process.env });
    if (!validation.ok) throw new Error(validation.error);
    const options = await claudeDirectSessionProviderOps.resolveTakeoverSpawnOptions!({
      linked: { ...linked, source: validation.source }, sessionId: 'linked-session', transcriptStorage: 'direct',
    });

    expect(options).toMatchObject({ existingSessionId: 'linked-session', resume: 'native-session' });
    expect(options?.environmentVariables?.CLAUDE_CONFIG_DIR).toBeUndefined();
    const childEnv = buildClaudeSubprocessEnv({ baseEnv: process.env, envOverlay: options?.environmentVariables });
    expect(childEnv).not.toHaveProperty('CLAUDE_CONFIG_DIR');
  });

  it.each(['native', 'happier'] as const)('retains the explicit default directory selected by %s', async (selection) => {
    const configDir = join(process.cwd(), '.claude');
    vi.stubEnv('HOME', process.cwd());
    vi.stubEnv('CLAUDE_CONFIG_DIR', selection === 'native' ? configDir : undefined);
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', selection === 'happier' ? configDir : undefined);
    const options = await claudeDirectSessionProviderOps.resolveTakeoverSpawnOptions!({
      linked: linkedSession(configDir),
      sessionId: 'linked-session', transcriptStorage: 'direct',
    });

    expect(options?.environmentVariables?.CLAUDE_CONFIG_DIR).toBe(configDir);
  });

  it('lets an explicit source override inherited config using the native path expansion', async () => {
    vi.stubEnv('HOME', process.cwd());
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(process.cwd(), 'ambient-claude'));
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', join(process.cwd(), 'happier-claude'));
    const options = await claudeDirectSessionProviderOps.resolveTakeoverSpawnOptions!({
      linked: linkedSession(' ~/selected-claude '), sessionId: 'linked-session', transcriptStorage: 'direct',
    });

    expect(options?.environmentVariables?.CLAUDE_CONFIG_DIR).toBe(join(process.cwd(), 'selected-claude'));
  });
});
