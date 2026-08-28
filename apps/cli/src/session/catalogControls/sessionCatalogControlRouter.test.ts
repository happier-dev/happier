import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials, StoredCredentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { buildTestCodexRuntimeDescriptorV1 as buildCodexAgentRuntimeDescriptor } from '@/testkit/runtimeDescriptorFixtures';
const mocks = vi.hoisted(() => ({
  fetchAccountMachineReplacements: vi.fn(),
}));

vi.mock('@/api/machine/fetchAccountMachineReplacements', () => ({
  fetchAccountMachineReplacements: mocks.fetchAccountMachineReplacements,
}));

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

function createTokenOnlyCredentials(): StoredCredentials {
  return {
    token: 'token',
    encryption: null,
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

const e2eeCtx = {
  encryptionKey: new Uint8Array(32).fill(1),
  encryptionVariant: 'legacy' as const,
};

describe('routeSessionCatalogControl', () => {
  beforeEach(() => {
    mocks.fetchAccountMachineReplacements.mockReset();
    // The Account genuinely knows both machines and neither replaced the other,
    // so a refusal below is the guard deciding, not an empty chain.
    mocks.fetchAccountMachineReplacements.mockResolvedValue([
      { id: 'machine-local' },
      { id: 'machine-remote' },
    ]);
  });

  it('delegates inactive local catalog requests to the provider adapter', async () => {
    const listSkills = vi.fn(async () => ({ unsupported: false, skills: [{ name: 'test-skill' }] }));
    const resolveAdapter = vi.fn(async () => ({ listSkills }));

    await expect(routeSessionCatalogControl({
      token: 'token',
      credentials: createTokenOnlyCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ path: '/home/coder/project' }),
      metadata: createMetadata({
        path: '/home/coder/project',
        sessionWorkspaceLocationV1: {
          v: 1,
          machineId: 'machine-local',
          agentPath: '/home/coder/project',
          machinePath: '/Users/alice/project',
        },
      }),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      operation: 'skills',
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    })).resolves.toEqual({ unsupported: false, skills: [{ name: 'test-skill' }] });

    expect(resolveAdapter).toHaveBeenCalledWith('codex');
    expect(listSkills).toHaveBeenCalledWith(expect.objectContaining({
      credentials: createTokenOnlyCredentials(),
      sessionId: 'sess_1',
      cwd: '/Users/alice/project',
      ctx: null,
      mode: 'plain',
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
      ctx: e2eeCtx,
      mode: 'e2ee',
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
      ctx: e2eeCtx,
      mode: 'e2ee',
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
  /**
   * The user's ruling: replacing a machine must not strand the Sessions the
   * previous one hosted. Nothing re-homes a Session row, so its recorded host
   * stays the PREDECESSOR forever, and a replacement is a genuinely new host
   * that cannot earn the same-host-home proof.
   */
  it('delegates inactive catalog requests for a session whose recorded machine this one replaced', async () => {
    mocks.fetchAccountMachineReplacements.mockResolvedValue([
      { id: 'machine-old', replacedByMachineId: 'machine-new' },
      { id: 'machine-new' },
    ]);
    const listSkills = vi.fn(async () => ({ unsupported: false, skills: [{ name: 'inherited-skill' }] }));
    const resolveAdapter = vi.fn(async () => ({ listSkills }));

    await expect(routeSessionCatalogControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_replaced_catalog',
      rawSession: createRawSession({ id: 'sess_replaced_catalog', machineId: 'machine-old' }),
      metadata: createMetadata({ machineId: 'machine-old', host: 'old-laptop', homeDir: '/Users/leeroy' }),
      currentMachineId: 'machine-new',
      currentMachineHost: 'new-laptop',
      currentMachineHomeDir: '/Users/leeroy',
      ctx: e2eeCtx,
      mode: 'e2ee',
      operation: 'skills',
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    })).resolves.toEqual({ unsupported: false, skills: [{ name: 'inherited-skill' }] });

    expect(listSkills).toHaveBeenCalledWith(expect.objectContaining({
      currentMachineId: 'machine-new',
      sessionMachineId: 'machine-old',
    }));
  });

  it('still refuses inactive catalog requests when the replacement chain is unreadable', async () => {
    mocks.fetchAccountMachineReplacements.mockResolvedValue(null);
    const resolveAdapter = vi.fn(async () => ({ listSkills: vi.fn() }));

    await expect(routeSessionCatalogControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ machineId: 'machine-old' }),
      metadata: createMetadata({ machineId: 'machine-old' }),
      currentMachineId: 'machine-new',
      ctx: e2eeCtx,
      mode: 'e2ee',
      operation: 'skills',
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    })).resolves.toMatchObject({
      unsupported: true,
      diagnostic: 'session_catalog_control_remote_unavailable',
    });

    expect(resolveAdapter).not.toHaveBeenCalled();
  });
});
