import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  fetchAccountMachineReplacements: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: mocks.fetchSessionById,
}));

vi.mock('@/api/machine/fetchAccountMachineReplacements', () => ({
  fetchAccountMachineReplacements: mocks.fetchAccountMachineReplacements,
}));

import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';

const ENCRYPTION_KEY = new Uint8Array(32).fill(7);
const TOKEN_ONLY_CREDENTIALS = {
  token: 'daemon-token',
  encryption: null,
};
const ENCRYPTED_CREDENTIALS = {
  token: 'daemon-token',
  encryption: { type: 'legacy' as const, secret: ENCRYPTION_KEY },
};

function session(machineId: string) {
  return {
    id: 'session-1',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    activeAt: 1,
    metadata: '{}',
    metadataVersion: 1,
    dataEncryptionKey: null,
    machineId,
  };
}

function encryptedSessionMetadata(params: Readonly<{
  machineId: string;
  host?: string;
  homeDir?: string;
  rawMachineId?: string;
}>) {
  return {
    ...session(params.rawMachineId ?? 'legacy-row-machine-id'),
    encryptionMode: 'e2ee',
    metadata: encryptSessionPayload({
      ctx: { encryptionKey: ENCRYPTION_KEY, encryptionVariant: 'legacy' },
      payload: {
        machineId: params.machineId,
        ...(params.host ? { host: params.host } : {}),
        ...(params.homeDir ? { homeDir: params.homeDir } : {}),
      },
    }),
  };
}

describe('createDaemonExternalActionTargetResolver', () => {
  beforeEach(() => {
    mocks.fetchSessionById.mockReset();
    mocks.fetchAccountMachineReplacements.mockReset();
  });

  it('defaults an omitted target to this daemon machine without an Account lookup', async () => {
    const resolver = createDaemonExternalActionTargetResolver({ credentials: TOKEN_ONLY_CREDENTIALS });

    await expect(resolver({
      actionId: 'session.spawn_new',
      target: undefined,
      currentMachineId: 'machine-local',
    })).resolves.toEqual({ kind: 'machine', machineId: 'machine-local' });

    expect(mocks.fetchSessionById).not.toHaveBeenCalled();
  });

  it('refuses an explicitly different machine without looking up a Session', async () => {
    const resolver = createDaemonExternalActionTargetResolver({ credentials: TOKEN_ONLY_CREDENTIALS });

    await expect(resolver({
      actionId: 'session.spawn_new',
      target: { kind: 'machine', machineId: 'machine-elsewhere' },
      currentMachineId: 'machine-local',
    })).resolves.toBeNull();

    expect(mocks.fetchSessionById).not.toHaveBeenCalled();
  });

  it('re-resolves an explicit Session against the canonical session owner immediately before execution', async () => {
    const signal = new AbortController().signal;
    mocks.fetchSessionById.mockResolvedValue(session('machine-local'));
    const resolver = createDaemonExternalActionTargetResolver({ credentials: TOKEN_ONLY_CREDENTIALS });

    await expect(resolver({
      actionId: 'session.open',
      target: { kind: 'session', sessionId: 'session-1' },
      currentMachineId: 'machine-local',
      signal,
    })).resolves.toEqual({ kind: 'session', sessionId: 'session-1' });

    expect(mocks.fetchSessionById).toHaveBeenCalledWith({
      token: 'daemon-token',
      sessionId: 'session-1',
      signal,
    });
    expect(mocks.fetchAccountMachineReplacements).not.toHaveBeenCalled();
  });

  it('uses the encrypted Session metadata machine identity instead of a stale raw row projection', async () => {
    mocks.fetchSessionById.mockResolvedValue(encryptedSessionMetadata({
      machineId: 'machine-local',
      host: 'host-local',
      homeDir: '/home/local',
      rawMachineId: 'machine-elsewhere',
    }));
    const resolver = createDaemonExternalActionTargetResolver({
      credentials: ENCRYPTED_CREDENTIALS,
      currentMachineHost: 'host-local',
      currentMachineHomeDir: '/home/local',
    });

    await expect(resolver({
      actionId: 'session.open',
      target: { kind: 'session', sessionId: 'session-1' },
      currentMachineId: 'machine-local',
    })).resolves.toEqual({ kind: 'session', sessionId: 'session-1' });

    expect(mocks.fetchAccountMachineReplacements).not.toHaveBeenCalled();
  });

  it('refuses a Session owned by another machine when no replacement proof exists', async () => {
    mocks.fetchSessionById.mockResolvedValue(session('machine-elsewhere'));
    mocks.fetchAccountMachineReplacements.mockResolvedValue([]);
    const resolver = createDaemonExternalActionTargetResolver({ credentials: TOKEN_ONLY_CREDENTIALS });

    await expect(resolver({
      actionId: 'session.open',
      target: { kind: 'session', sessionId: 'session-1' },
      currentMachineId: 'machine-local',
    })).resolves.toBeNull();
  });
});
