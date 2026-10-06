import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import {
  FeaturesResponseSchema,
  projectLegacySessionAccessCapabilitiesV1,
} from '@happier-dev/protocol';
import { createSessionTranscriptFollowLeaseRegistry } from '@/api/session/transcriptQueries';
import {
  createAccountEncryptionCurrentnessFixture,
  createCurrentSessionProjectionRecordFixture,
} from '@/testkit/backends/sessionFixtures';
import type { SessionSpawnDirectTargetTransport } from './createCliActionDeps';
import type { createCliActionExecutor as CreateCliActionExecutor } from './createCliActionExecutor';
import { configuration } from '@/configuration';

type CreateCliActionExecutorOptions = Parameters<typeof CreateCliActionExecutor>[0];

const execute = vi.fn();
const prepare = vi.fn();
const createCliActionExecutor = vi.fn((_options: CreateCliActionExecutorOptions) => ({ execute, prepare }));
const ensureCliActionPolicySettings = vi.fn();
const importHistoricalSessionTranscript = vi.fn();
const createAccountServerActionDeps = vi.fn(() => ({}));
const replaceSessionVoiceInclusions = vi.fn();
const createSessionFollowActionDeps = vi.fn(() => ({ replaceSessionVoiceInclusions }));
const createSessionTrackedTargetCompatibilityDep = vi.fn(() => ({}));
const createSessionFollowSourceKeyPreparationAfterSet = vi.fn(() => vi.fn());
const readSettings = vi.fn(async () => ({ machineId: 'machine-active-home' }));

function axiosResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  };
}

vi.mock('./createCliActionExecutor', () => ({
  createCliActionExecutor,
}));

vi.mock('./ensureCliActionPolicySettings', () => ({
  ensureCliActionPolicySettings,
}));

vi.mock('@/agent/runtime/session/follow/createSessionFollowSourceKeyPreparationAfterSet', () => ({ createSessionFollowSourceKeyPreparationAfterSet }));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>()),
  importHistoricalSessionTranscript,
}));

vi.mock('@/api/accountServerActionDeps', () => ({
  createAccountServerActionDeps,
}));

vi.mock('@/api/sessionFollowActionDeps', () => ({
  createSessionFollowActionDeps,
  createSessionTrackedTargetCompatibilityDep,
}));

vi.mock('@/session/transport/encryption/sessionEncryptionContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/session/transport/encryption/sessionEncryptionContext')>()),
  resolveSessionEncryptionContextFromCredentials: vi.fn(() => ({ kind: 'legacy' })),
}));

vi.mock('@/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence')>()),
  readSettings,
}));

describe('createCliActionExecutorFromCredentials', () => {
  beforeEach(() => {
    execute.mockClear();
    prepare.mockClear();
    createCliActionExecutor.mockClear();
    ensureCliActionPolicySettings.mockClear();
    importHistoricalSessionTranscript.mockClear();
    createAccountServerActionDeps.mockClear();
    createSessionFollowActionDeps.mockClear();
    createSessionTrackedTargetCompatibilityDep.mockClear();
    replaceSessionVoiceInclusions.mockClear();
    createSessionFollowSourceKeyPreparationAfterSet.mockClear();
    readSettings.mockClear();
  });

  it('requires and propagates one qualified Home identity with a fixed endpoint', async () => {
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const credentials = {
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const resolveServerFeaturesSnapshot = vi.fn();

    expect(() => createCliActionExecutorFromCredentials({
      credentials,
      serverApiUrl: 'https://home-b.example.test',
    } as Parameters<typeof createCliActionExecutorFromCredentials>[0])).toThrow('fixed_action_server_target_incomplete');
    expect(() => createCliActionExecutorFromCredentials({
      credentials,
      serverId: 'home-b',
    } as Parameters<typeof createCliActionExecutorFromCredentials>[0])).toThrow('fixed_action_server_target_incomplete');
    expect(() => createCliActionExecutorFromCredentials({
      credentials,
      serverId: 'home-b',
      serverApiUrl: '   ',
    })).toThrow('fixed_action_server_target_incomplete');

    createCliActionExecutorFromCredentials({
      credentials,
      serverId: 'home-b',
      serverApiUrl: 'https://home-b.example.test/',
      resolveServerFeaturesSnapshot,
    });

    expect(createAccountServerActionDeps).toHaveBeenLastCalledWith({
      token: 'token_test',
      credentials,
      resolveServerFeaturesSnapshot,
      serverId: 'home-b',
      serverHttpBaseUrl: 'https://home-b.example.test',
    });
    expect(createSessionFollowActionDeps).toHaveBeenLastCalledWith({
      token: 'token_test',
      serverId: 'home-b',
      serverHttpBaseUrl: 'https://home-b.example.test',
      prepareSourceKeyAfterSet: expect.any(Function),
    });
    expect(createSessionTrackedTargetCompatibilityDep).toHaveBeenLastCalledWith({
      serverId: 'home-b',
      replaceSessionVoiceInclusions,
    });
  });

  it('composes Follow source-key preparation through the shared authenticated runtime owner', async () => {
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const credentials = {
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    createCliActionExecutorFromCredentials({ credentials, serverId: 'home-b', serverApiUrl: 'https://home-b.example.test' });
    expect(createSessionFollowSourceKeyPreparationAfterSet).toHaveBeenCalledWith({
      credentials,
      serverHttpBaseUrl: 'https://home-b.example.test',
      resolveServerFeaturesSnapshot: expect.any(Function),
    });
  });

  it('loads action policy settings lazily before delegated action execution', async () => {
    const events: string[] = [];
    ensureCliActionPolicySettings.mockImplementationOnce(async () => {
      events.push('settings');
    });
    execute.mockImplementationOnce(async () => {
      events.push('execute');
      return { ok: true, result: { childSessionId: 'legacy-terminal-child' } };
    });

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const credentials = {
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };

    const executor = createCliActionExecutorFromCredentials({ credentials });

    expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
    await expect(executor.execute(
      'session.status.get',
      { sessionId: 'sess-1' },
      { surface: 'cli' },
    )).resolves.toEqual({ ok: true, result: { childSessionId: 'legacy-terminal-child' } });

    expect(createCliActionExecutor).toHaveBeenCalledTimes(1);
    expect(ensureCliActionPolicySettings).toHaveBeenCalledWith(credentials, configuration.apiServerUrl);
    expect(events).toEqual(['settings', 'execute']);
  });

  it('binds authenticated Home and current Machine routing facts before local approval admission', async () => {
    execute.mockResolvedValueOnce({ ok: true, result: { sessions: [] } });
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const credentials = {
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const resolveServerFeaturesSnapshot = vi.fn(async () => ({
      status: 'ready' as const,
      provenance: 'authenticated' as const,
      features: {
        capabilities: {
          serverIdentity: { serverIdentityId: 'srv_portable_home' },
        },
      },
    } as never));
    const executor = createCliActionExecutorFromCredentials({
      credentials,
      machineId: 'machine-current',
      resolveServerFeaturesSnapshot,
    });

    await executor.execute('session.list', {}, {
      surface: 'mcp',
      authority: 'account_automation',
      defaultSessionId: 'session-current',
      sessionListAccess: 'current_session',
      actionRequestId: 'request-1',
    });

    expect(execute).toHaveBeenLastCalledWith('session.list', {}, expect.objectContaining({
      serverIdentityId: 'srv_portable_home',
      defaultSessionMachineId: 'machine-current',
    }));
  });

  it('never borrows the active Home Machine for a fixed-Home executor', async () => {
    execute.mockResolvedValueOnce({ ok: true, result: { sessions: [] } });
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'token_home_b',
        encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
      },
      serverId: 'home-b',
      serverApiUrl: 'https://home-b.example.test',
      serverIdentityId: 'srv_home_b',
    });

    await executor.execute('session.list', {}, { surface: 'cli' });

    expect(readSettings).not.toHaveBeenCalled();
    expect(execute).toHaveBeenLastCalledWith('session.list', {}, expect.not.objectContaining({
      defaultSessionMachineId: 'machine-active-home',
    }));
  });

  it('resolves a collective-only Session through the credential Home feature fallback', async () => {
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const sessionId = 'c123456789012345678901234';
    const credentials = {
      token: 'token_home_b',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const features = FeaturesResponseSchema.parse({
      features: {
        sessions: { enabled: true },
        sharing: { session: { enabled: true } },
      },
      capabilities: {},
    });
    const row = createCurrentSessionProjectionRecordFixture({
      id: sessionId,
      encryptionMode: 'plain',
      effectiveAccess: {
        v: 1,
        level: 'view',
        sources: [{ kind: 'team', teamId: 'team-1', requiredByTeamPolicy: false }],
        capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
      },
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === 'https://home-b.example.test/v1/features/authenticated') {
        return new Response(JSON.stringify(features), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(input) === 'http://127.0.0.1:3005/v1/account/encryption/currentness') {
        return new Response(JSON.stringify(createAccountEncryptionCurrentnessFixture()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const axiosGet = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url) === 'http://127.0.0.1:3005/v1/account/encryption/currentness') {
        return axiosResponse(createAccountEncryptionCurrentnessFixture());
      }
      if (String(url) === `http://127.0.0.1:3005/v2/sessions/${sessionId}?accessProjectionVersion=1`) {
        return axiosResponse({ session: row });
      }
      if (String(url) === 'https://home-b.example.test/v1/account/encryption/currentness') {
        return axiosResponse(createAccountEncryptionCurrentnessFixture());
      }
      if (String(url) === `https://home-b.example.test/v2/sessions/${sessionId}?accessProjectionVersion=1`) {
        return axiosResponse({ session: row });
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });

    try {
      const executor = createCliActionExecutorFromCredentials({
        credentials,
        serverId: 'home-b',
        serverApiUrl: 'https://home-b.example.test',
      });

      await expect(executor.resolveSessionTarget(sessionId)).resolves.toEqual({ ok: true, sessionId });
      expect(readSettings).not.toHaveBeenCalled();
    } finally {
      axiosGet.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('acquires a collective-only transcript store through the credential Home feature fallback', async () => {
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const sessionId = 'c123456789012345678901234';
    const credentials = {
      token: 'token_home_b',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const features = FeaturesResponseSchema.parse({
      features: {
        sessions: { enabled: true },
        sharing: { session: { enabled: true } },
      },
      capabilities: {},
    });
    const row = createCurrentSessionProjectionRecordFixture({
      id: sessionId,
      encryptionMode: 'plain',
      effectiveAccess: {
        v: 1,
        level: 'view',
        sources: [{ kind: 'team', teamId: 'team-1', requiredByTeamPolicy: false }],
        capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
      },
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === 'https://home-b.example.test/v1/features/authenticated') {
        return new Response(JSON.stringify(features), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(input) === 'http://127.0.0.1:3005/v1/account/encryption/currentness') {
        return new Response(JSON.stringify(createAccountEncryptionCurrentnessFixture()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const axiosGet = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url) === 'http://127.0.0.1:3005/v1/account/encryption/currentness') {
        return axiosResponse(createAccountEncryptionCurrentnessFixture());
      }
      if (String(url) === `http://127.0.0.1:3005/v2/sessions/${sessionId}?accessProjectionVersion=1`) {
        return axiosResponse({ session: row });
      }
      if (String(url) === 'https://home-b.example.test/v1/account/encryption/currentness') {
        return axiosResponse(createAccountEncryptionCurrentnessFixture());
      }
      if (String(url) === `https://home-b.example.test/v2/sessions/${sessionId}?accessProjectionVersion=1`) {
        return axiosResponse({ session: row });
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });

    try {
      createCliActionExecutorFromCredentials({
        credentials,
        serverId: 'home-b',
        serverApiUrl: 'https://home-b.example.test',
      });
      const options = createCliActionExecutor.mock.calls.at(-1)?.[0];
      if (!options?.resolveTranscriptStore) throw new Error('Expected transcript store resolver');

      const store = await options.resolveTranscriptStore(sessionId);
      await expect(store.warm()).resolves.toBeUndefined();
      expect(readSettings).not.toHaveBeenCalled();
    } finally {
      axiosGet.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('loads action policy settings before preparation and preserves the prepared invocation', async () => {
    const events: string[] = [];
    const invocation = { run: vi.fn(async () => ({ ok: true as const, result: { childSessionId: 'child-1' } })) };
    ensureCliActionPolicySettings.mockImplementationOnce(async () => {
      events.push('settings');
    });
    prepare.mockImplementationOnce(async () => {
      events.push('prepare');
      return { kind: 'ready', invocation };
    });

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const credentials = {
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const executor = createCliActionExecutorFromCredentials({ credentials });
    const executeCallsBeforePrepare = execute.mock.calls.length;

    const prepared = await executor.prepare(
      'session.fork',
      { sessionId: 'sess-1' },
      { surface: 'rpc', authority: 'present_user', actionCaller: { kind: 'host' } },
    );
    expect(prepared).toMatchObject({ kind: 'ready' });
    expect(events).toEqual(['settings', 'prepare']);
    expect(execute).toHaveBeenCalledTimes(executeCallsBeforePrepare);
    expect(invocation.run).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected prepared invocation');
    await expect(prepared.invocation.run()).resolves.toEqual({ ok: true, result: { childSessionId: 'child-1' } });
    expect(invocation.run).toHaveBeenCalledTimes(1);
  });

  it('passes the live registered prompt adapter reader to the canonical CLI action deps', async () => {
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const credentials = {
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const readRegisteredPromptAssetAdapters = vi.fn(() => new Map());

    createCliActionExecutorFromCredentials({
      credentials,
      readRegisteredPromptAssetAdapters,
    });

    expect(createCliActionExecutor).toHaveBeenLastCalledWith(expect.objectContaining({
      readRegisteredPromptAssetAdapters,
    }));
  });

  it('passes both resolved runtime caller currentness callbacks to canonical CLI Action deps', async () => {
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const credentials = {
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const revalidatePluginActionCallerMaterialization = vi.fn(async () => true);
    const revalidatePluginActionCallerOccurrence = vi.fn(async () => true);

    createCliActionExecutorFromCredentials({
      credentials,
      revalidatePluginActionCallerMaterialization,
      revalidatePluginActionCallerOccurrence,
    });

    expect(createCliActionExecutor).toHaveBeenLastCalledWith(expect.objectContaining({
      revalidatePluginActionCallerMaterialization,
      revalidatePluginActionCallerOccurrence,
    }));
  });

  it('forwards target-action approval replay only when daemon composition injects it', async () => {
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const credentials = {
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const targetActionApprovalReplay = vi.fn<
      NonNullable<ActionExecutorDeps['targetActionApprovalReplay']>
    >();

    createCliActionExecutorFromCredentials({ credentials });
    expect(createCliActionExecutor).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ targetActionApprovalReplay: expect.any(Function) }),
    );

    createCliActionExecutorFromCredentials({ credentials, targetActionApprovalReplay });
    expect(createCliActionExecutor).toHaveBeenLastCalledWith(expect.objectContaining({
      targetActionApprovalReplay,
    }));
  });

  it('preserves the daemon-owned contributed, external-session, and exact-spawn Action seams', async () => {
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const credentials = {
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const invokeContributedAction = vi.fn<NonNullable<ActionExecutorDeps['invokeContributedAction']>>();
    const hostExternalSessionAction = vi.fn<NonNullable<ActionExecutorDeps['hostExternalSessionAction']>>();
    const sessionSpawnDirectTargetTransport = {
      machineId: 'machine-local',
      prepare: vi.fn(),
      start: vi.fn(),
    } as unknown as SessionSpawnDirectTargetTransport;

    createCliActionExecutorFromCredentials({
      credentials,
      invokeContributedAction,
      hostExternalSessionAction,
      sessionSpawnDirectTargetTransport,
    } as Parameters<typeof createCliActionExecutorFromCredentials>[0] & Readonly<{
      invokeContributedAction: NonNullable<ActionExecutorDeps['invokeContributedAction']>;
      hostExternalSessionAction: NonNullable<ActionExecutorDeps['hostExternalSessionAction']>;
      sessionSpawnDirectTargetTransport: SessionSpawnDirectTargetTransport;
    }>);

    expect(createCliActionExecutor).toHaveBeenLastCalledWith(expect.objectContaining({
      invokeContributedAction,
      hostExternalSessionAction,
      sessionSpawnDirectTargetTransport,
    }));
  });

  it('routes transcript.import through one historical batch request', async () => {
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const credentials = {
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const items = [
      { id: 'history-1', content: { t: 'plain', v: { role: 'user' } } },
      { id: 'history-2', content: { t: 'encrypted', c: 'ciphertext' } },
    ] as const;
    importHistoricalSessionTranscript.mockResolvedValueOnce({ imported: 2, cursor: '2' });

    createCliActionExecutorFromCredentials({ credentials });
    const options = createCliActionExecutor.mock.calls.at(-1)?.[0];
    if (!options?.writeTranscriptItems) {
      throw new Error('Expected the canonical CLI action executor to receive transcript persistence');
    }

    await expect(options.writeTranscriptItems('session-1', items)).resolves.toEqual({ imported: 2, cursor: '2' });
    expect(importHistoricalSessionTranscript).toHaveBeenCalledTimes(1);
    expect(importHistoricalSessionTranscript).toHaveBeenCalledWith({
      token: 'token_test',
      sessionId: 'session-1',
      items,
    });
  });

  it('preserves an injected process-lifetime transcript lease registry for bound invocations', async () => {
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const credentials = {
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const transcriptFollowLeaseRegistry = createSessionTranscriptFollowLeaseRegistry({
      maxLeases: 16,
      idleTtlMs: 1_000,
    });
    const executorCreationsBefore = createCliActionExecutor.mock.calls.length;

    const executor = createCliActionExecutorFromCredentials({
      credentials,
      transcriptFollowLeaseRegistry,
    });
    const controller = new AbortController();
    executor.bindInvocation(controller.signal);

    expect(createCliActionExecutor.mock.calls.slice(executorCreationsBefore)).toHaveLength(2);
    for (const [options] of createCliActionExecutor.mock.calls.slice(executorCreationsBefore)) {
      expect(options).toEqual(expect.objectContaining({ transcriptFollowLeaseRegistry }));
    }
  });

  it('uses one current credential snapshot per daemon plugin action and fails closed after logout', async () => {
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const initialCredentials = {
      token: 'token_initial',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const rotatedCredentials = {
      token: 'token_rotated',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(2) },
    };
    const readCredentials = vi.fn()
      .mockResolvedValueOnce(rotatedCredentials)
      .mockResolvedValueOnce(null);
    execute.mockResolvedValue({ ok: true, result: { ok: true } });

    const executor = createCliActionExecutorFromCredentials({
      credentials: initialCredentials,
      readCredentials,
    });

    await expect(executor.execute(
      'session.status.get',
      { sessionId: 'sess-1' },
      { surface: 'plugin' },
    )).resolves.toEqual({ ok: true, result: { ok: true } });
    expect(readCredentials).toHaveBeenCalledTimes(1);
    expect(createCliActionExecutor).toHaveBeenLastCalledWith(expect.objectContaining({
      token: 'token_rotated',
      credentials: rotatedCredentials,
    }));
    expect(ensureCliActionPolicySettings).toHaveBeenLastCalledWith(rotatedCredentials, configuration.apiServerUrl);

    const delegatedExecutionsBeforeLogout = execute.mock.calls.length;
    const policyReadsBeforeLogout = ensureCliActionPolicySettings.mock.calls.length;
    await expect(executor.execute(
      'session.status.get',
      { sessionId: 'sess-1' },
      { surface: 'plugin' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'not_authenticated',
      error: 'not_authenticated',
    });
    expect(readCredentials).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(delegatedExecutionsBeforeLogout);
    expect(ensureCliActionPolicySettings).toHaveBeenCalledTimes(policyReadsBeforeLogout);
  });
});
