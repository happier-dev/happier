import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

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

import { createDaemonExternalActionTargetResolver, createDaemonApprovalExecutionOriginCurrentness } from './daemonExternalActionTargetResolver';
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
    id: 'c111111111111111111111111',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    activeAt: 1,
    encryptionMode: 'plain',
    metadata: '{}',
    share: null,
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
  let accountMode: 'plain' | 'e2ee' = 'plain';
  beforeEach(() => {
    accountMode = 'plain';
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
      get mode() { return accountMode; }, version: 1,
      get signingKeyFingerprint() { return accountMode === 'plain' ? null : 'a'.repeat(64); },
      get contentKeyFingerprint() { return accountMode === 'plain' ? null : 'b'.repeat(64); }, updatedAt: 1,
    } });
    mocks.fetchSessionById.mockReset();
    mocks.fetchAccountMachineReplacements.mockReset();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('requires daemon locality for a Companion client read while retaining remote Account reads', async () => {
    const target = { kind: 'session' as const, sessionId: session('machine-elsewhere').id };
    mocks.fetchSessionById.mockResolvedValue(session('machine-elsewhere'));
    const resolver = createDaemonExternalActionTargetResolver({ credentials: TOKEN_ONLY_CREDENTIALS });
    const surface = { serverId: 'home', accountId: 'account-1', owner: { kind: 'companion' as const, sessionId: target.sessionId } };
    await expect(resolver({ actionId: 'widgets.instance.inputs.get', target, currentMachineId: 'machine-local',
      actionInput: { ref: { surface, instanceId: 'checks' } } })).resolves.toBeNull();
    await expect(resolver({ actionId: 'widgets.instance.inputs.get', target, currentMachineId: 'machine-local',
      actionInput: { ref: { surface: { ...surface, owner: { kind: 'home' } }, instanceId: 'checks' } } })).resolves.toEqual(target);
  });

  it('keeps a local Session caller approval current for an Account effect on a led remote Session', async () => {
    mocks.fetchSessionById.mockResolvedValue({ ...session('machine-elsewhere'), id: 'led-remote' });
    mocks.fetchAccountMachineReplacements.mockResolvedValue([]);
    const resolveTarget = createDaemonExternalActionTargetResolver({ credentials: TOKEN_ONLY_CREDENTIALS });
    const isCurrent = createDaemonApprovalExecutionOriginCurrentness({
      accountId: 'account-1', machineId: 'machine-local', serverId: 'home-1', resolveTarget,
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'home-1', machineId: 'machine-local' }),
      listAccountApiTokens: async () => ({ tokens: [] }),
      isSessionCallerCurrent: async ({ caller }) => caller.sessionId === 'local-caller',
      resolveCurrentPermissionMode: async () => 'default',
    });
    const executionOrigin = { v: 1 as const, authority: 'account_automation' as const, surface: 'agent' as const,
      caller: { kind: 'session' as const, sessionId: 'local-caller', starterDepth: 0, turnDepth: 0 }, serverId: 'home-1', accountId: 'account-1',
      machineId: 'machine-local', sessionId: 'led-remote', target: { kind: 'session' as const, sessionId: 'led-remote' },
      callerPermissionMode: 'default' as const, actionId: 'session.trigger.add' as const, requestId: 'approved-request' };
    await expect(isCurrent({ origin: executionOrigin })).resolves.toBe(true);
    expect(mocks.fetchSessionById).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'led-remote' }));
    // Explicit Machine restrictions still constrain the execution host.
    await expect(isCurrent({ origin: { ...executionOrigin, target: { kind: 'machine', machineId: 'machine-elsewhere' } } }))
      .resolves.toBe(false);
    mocks.fetchSessionById.mockResolvedValue(null);
    await expect(isCurrent({ origin: executionOrigin })).resolves.toBe(false);
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
      target: { kind: 'session', sessionId: 'c111111111111111111111111' },
      currentMachineId: 'machine-local',
      signal,
    })).resolves.toEqual({ kind: 'session', sessionId: 'c111111111111111111111111' });

    expect(mocks.fetchSessionById).toHaveBeenCalledWith({
      token: 'daemon-token',
      sessionId: 'c111111111111111111111111',
      signal: expect.any(AbortSignal),
      deadlineAtMs: expect.any(Number),
    });
    expect(mocks.fetchAccountMachineReplacements).not.toHaveBeenCalled();
  });

  it('uses the daemon exact-Home snapshot for collective Session target resolution', async () => {
    const serverFeaturesSnapshot = {
      status: 'unsupported' as const,
      reason: 'endpoint_missing' as const,
    };
    const resolveServerFeaturesSnapshot = vi.fn(async () => serverFeaturesSnapshot);
    mocks.fetchSessionById.mockResolvedValue(session('machine-local'));
    const resolver = createDaemonExternalActionTargetResolver({
      credentials: TOKEN_ONLY_CREDENTIALS,
      serverApiUrl: 'https://home.example.test',
      resolveServerFeaturesSnapshot,
    });

    await expect(resolver({
      actionId: 'session.open',
      target: { kind: 'session', sessionId: 'c111111111111111111111111' },
      currentMachineId: 'machine-local',
    })).resolves.toEqual({ kind: 'session', sessionId: 'c111111111111111111111111' });

    expect(resolveServerFeaturesSnapshot).toHaveBeenCalledOnce();
    expect(mocks.fetchSessionById).toHaveBeenCalledWith({
      token: 'daemon-token',
      sessionId: 'c111111111111111111111111',
      serverFeaturesSnapshot,
      signal: expect.any(AbortSignal),
      deadlineAtMs: expect.any(Number),
    });
  });

  it('uses the encrypted Session metadata machine identity instead of a stale raw row projection', async () => {
    accountMode = 'e2ee';
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
      target: { kind: 'session', sessionId: 'c111111111111111111111111' },
      currentMachineId: 'machine-local',
    })).resolves.toEqual({ kind: 'session', sessionId: 'c111111111111111111111111' });

    expect(mocks.fetchAccountMachineReplacements).not.toHaveBeenCalled();
  });

  it('refuses a Session owned by another machine when no replacement proof exists', async () => {
    mocks.fetchSessionById.mockResolvedValue(session('machine-elsewhere'));
    mocks.fetchAccountMachineReplacements.mockResolvedValue([]);
    const resolver = createDaemonExternalActionTargetResolver({ credentials: TOKEN_ONLY_CREDENTIALS });

    await expect(resolver({
      actionId: 'session.open',
      target: { kind: 'session', sessionId: 'c111111111111111111111111' },
      currentMachineId: 'machine-local',
    })).resolves.toBeNull();
  });
});
