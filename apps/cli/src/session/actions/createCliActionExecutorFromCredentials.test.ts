import { describe, expect, it, vi } from 'vitest';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { createSessionTranscriptFollowLeaseRegistry } from '@/api/session/transcriptQueries';
import type { SessionSpawnDirectTargetTransport } from './createCliActionDeps';
import type { createCliActionExecutor as CreateCliActionExecutor } from './createCliActionExecutor';

type CreateCliActionExecutorOptions = Parameters<typeof CreateCliActionExecutor>[0];

const execute = vi.fn();
const prepare = vi.fn();
const createCliActionExecutor = vi.fn((_options: CreateCliActionExecutorOptions) => ({ execute, prepare }));
const ensureCliActionPolicySettings = vi.fn();
const importHistoricalSessionTranscript = vi.fn();

vi.mock('./createCliActionExecutor', () => ({
  createCliActionExecutor,
}));

vi.mock('./ensureCliActionPolicySettings', () => ({
  ensureCliActionPolicySettings,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  importHistoricalSessionTranscript,
}));

vi.mock('@/session/transport/encryption/sessionEncryptionContext', () => ({
  resolveSessionEncryptionContextFromCredentials: vi.fn(() => ({ kind: 'legacy' })),
}));

describe('createCliActionExecutorFromCredentials', () => {
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
    expect(ensureCliActionPolicySettings).toHaveBeenCalledWith(credentials);
    expect(events).toEqual(['settings', 'execute']);
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

    await expect(executor.prepare(
      'session.fork',
      { sessionId: 'sess-1' },
      { surface: 'rpc', authority: 'present_user', actionCaller: { kind: 'host' } },
    )).resolves.toEqual({ kind: 'ready', invocation });
    expect(events).toEqual(['settings', 'prepare']);
    expect(execute).toHaveBeenCalledTimes(executeCallsBeforePrepare);
    expect(invocation.run).not.toHaveBeenCalled();
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
    const revalidatePluginActionCallerImmutableGeneration = vi.fn(async () => true);

    createCliActionExecutorFromCredentials({
      credentials,
      revalidatePluginActionCallerMaterialization,
      revalidatePluginActionCallerImmutableGeneration,
    });

    expect(createCliActionExecutor).toHaveBeenLastCalledWith(expect.objectContaining({
      revalidatePluginActionCallerMaterialization,
      revalidatePluginActionCallerImmutableGeneration,
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
    expect(ensureCliActionPolicySettings).toHaveBeenLastCalledWith(rotatedCredentials);

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
