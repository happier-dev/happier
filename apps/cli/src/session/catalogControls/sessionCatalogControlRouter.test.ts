import { buildCodexAgentRuntimeDescriptor } from '@happier-dev/agents';
import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { routeSessionCatalogControl } from './sessionCatalogControlRouter';

function createCredentials(): Credentials {
  return {
    token: 'token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(9),
    },
  };
}

function createRawSession(overrides: Partial<RawSessionRecord> = {}): RawSessionRecord {
  return {
    id: 'sess_1',
    active: false,
    path: '/repo',
    machineId: 'machine-local',
    metadata: '{}',
    metadataVersion: 1,
    encryptionMode: 'plain',
    ...overrides,
  } as RawSessionRecord;
}

function createMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    machineId: 'machine-local',
    agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
      backendMode: 'appServer',
      providerSessionId: 'thread-1',
    }),
    ...overrides,
  };
}

const ctx = {
  encryptionKey: new Uint8Array(32).fill(1),
  encryptionVariant: 'legacy' as const,
};

describe('routeSessionCatalogControl', () => {
  it('delegates inactive local catalog requests to the provider adapter', async () => {
    const listSkills = vi.fn(async () => ({ unsupported: false, skills: [{ name: 'test-skill' }] }));
    const resolveAdapter = vi.fn(async () => ({ listSkills }));

    await expect(routeSessionCatalogControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      operation: 'skills',
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    })).resolves.toEqual({ unsupported: false, skills: [{ name: 'test-skill' }] });

    expect(resolveAdapter).toHaveBeenCalledWith('codex');
    expect(listSkills).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      cwd: '/repo',
    }));
  });

  it('does not delegate remote inactive catalog requests', async () => {
    const resolveAdapter = vi.fn(async () => ({ listSkills: vi.fn() }));

    await expect(routeSessionCatalogControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ machineId: 'machine-remote' }),
      metadata: createMetadata({ machineId: 'machine-remote' }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      operation: 'skills',
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    })).resolves.toEqual({
      unsupported: true,
      skills: [],
      diagnostic: 'session_catalog_control_remote_unavailable',
    });

    expect(resolveAdapter).not.toHaveBeenCalled();
  });

  it('delegates inactive catalog requests from a stale machine id when the current daemon proves same host and home', async () => {
    const listSkills = vi.fn(async () => ({ unsupported: false, skills: [{ name: 'local-skill' }] }));
    const resolveAdapter = vi.fn(async () => ({ listSkills }));

    await expect(routeSessionCatalogControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_stale_catalog',
      rawSession: createRawSession({
        id: 'sess_stale_catalog',
        path: 'C:\\Users\\Leeroy\\workspace\\repo',
        machineId: 'machine-before-restart',
      }),
      metadata: createMetadata({
        machineId: 'machine-before-restart',
        host: 'LEEROY-MBP.local',
        homeDir: 'C:\\Users\\Leeroy\\',
      }),
      currentMachineId: 'machine-after-restart',
      currentMachineHost: 'leeroy-mbp',
      currentMachineHomeDir: 'c:/users/leeroy',
      ctx,
      mode: 'plain',
      operation: 'skills',
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    })).resolves.toEqual({ unsupported: false, skills: [{ name: 'local-skill' }] });

    expect(resolveAdapter).toHaveBeenCalledWith('codex');
    expect(listSkills).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_stale_catalog',
      currentMachineId: 'machine-after-restart',
      sessionMachineId: 'machine-before-restart',
      cwd: 'C:\\Users\\Leeroy\\workspace\\repo',
    }));
  });
});
