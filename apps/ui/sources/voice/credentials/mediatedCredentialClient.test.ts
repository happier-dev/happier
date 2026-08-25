import { beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => vi.fn());
vi.mock('@/log', () => ({ log: { log: logSpy, warn: vi.fn(), error: vi.fn() } }));

const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: machineRpc,
}));
// The ambient Voice target is re-derived from mutable ordering on every read,
// so it has to be able to move for the captured pin to mean anything.
const ambientMachine = vi.hoisted(() => ({ id: null as string | null }));
vi.mock('@/voice/settings/executionMachine', () => ({
  resolveVoiceExecutionMachineId: () => ambientMachine.id,
}));

import { createVoiceClientMediatedCredentialHeadersMaterializer } from './mediatedCredentialClient';

const contribution = Object.freeze({ pluginId: 'happier.openai', localId: 'realtime' });
const service = Object.freeze({ pluginId: 'happier.agent.codex', localId: 'openai-codex' });
const selection = Object.freeze({
  kind: 'account' as const,
  account: Object.freeze({ service, accountId: 'account-a' }),
});
const cacheIdentity = Object.freeze({
  pluginId: contribution.pluginId,
  contributionId: contribution.localId,
  artifactDigest: `sha256:${'a'.repeat(64)}` as const,
  hostAppVersion: '1.0.0',
  hostUiApiVersion: '1',
  reactVersion: '19.0.0',
  reactNativeVersion: '0.79.0',
  platform: 'web',
  channel: 'stable',
  nativeCapabilitiesDigest: `sha256:${'b'.repeat(64)}` as const,
  projectionGeneration: 12,
});

function materializer(
  invoke: (method: string, payload: unknown, signal?: AbortSignal | null) => Promise<unknown>,
  overrides?: Readonly<{ isInvocationCurrent?: () => boolean }>,
) {
  return createVoiceClientMediatedCredentialHeadersMaterializer({
    contribution,
    platform: 'web',
    phase: 'prepare',
    declarationAuthority: { kind: 'projected', cacheIdentity },
    machineId: 'machine-a',
    isCurrent: () => true,
    isInvocationCurrent: overrides?.isInvocationCurrent ?? (() => true),
    client: { invoke },
  });
}

describe('createVoiceClientMediatedCredentialHeadersMaterializer', () => {
  beforeEach(() => {
    logSpy.mockReset();
    machineRpc.mockReset();
    ambientMachine.id = null;
  });

  it('preserves an unreachable execution machine as distinct from credential failure', async () => {
    const materialize = materializer(async () => {
      throw Object.assign(new Error('machine_unavailable'), { code: 'machine_unavailable' });
    });

    await expect(materialize({
      operationId: 'mint-client-secret',
      selection,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'execution_machine_unavailable' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = String(logSpy.mock.calls[0]?.[0]);
    expect(line).toContain('machine_unavailable');
    expect(line).toContain('mint-client-secret');
  });

  it('names a rejected daemon materialization distinctly from an unreachable machine', async () => {
    const materialize = materializer(async () => ({
      ok: false,
      errorCode: 'plugin_voice_provider_result_invalid',
    }));

    await expect(materialize({
      operationId: 'mint-client-secret',
      selection,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'voice_account_operation_unauthorized' });

    const line = String(logSpy.mock.calls[0]?.[0]);
    expect(line).toContain('plugin_voice_provider_result_invalid');
    expect(line).not.toContain('machine_unavailable');
  });

  it('never logs the materialized credential headers', async () => {
    const materialize = materializer(async () => ({
      ok: true,
      headers: { authorization: 'Bearer super-secret-value' },
    }));

    await expect(materialize({
      operationId: 'mint-client-secret',
      selection,
      signal: new AbortController().signal,
    })).resolves.toEqual({ authorization: 'Bearer super-secret-value' });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('sends the captured declaration authority and Connected Account selection to the daemon', async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      headers: { authorization: 'Bearer account-a' },
    }));
    const materialize = materializer(invoke);

    await expect(materialize({
      operationId: 'mint-client-secret',
      selection,
      signal: new AbortController().signal,
    })).resolves.toEqual({ authorization: 'Bearer account-a' });

    expect(invoke).toHaveBeenCalledWith(
      'daemon.voice.client.mediatedCredential.materialize',
      {
        contribution,
        platform: 'web',
        phase: 'prepare',
        operationId: 'mint-client-secret',
        declarationAuthority: { kind: 'projected', cacheIdentity },
        expectedSelection: selection,
      },
      expect.any(AbortSignal),
    );
  });

  it('refuses to materialize after the Voice execution machine captured with the authority changed', async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      headers: { authorization: 'Bearer account-a' },
    }));
    let machineIsStillCaptured = true;
    const materialize = materializer(invoke, {
      isInvocationCurrent: () => machineIsStillCaptured,
    });
    machineIsStillCaptured = false;

    await expect(materialize({
      operationId: 'mint-client-secret',
      selection,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'voice_account_operation_cancelled' });

    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not return headers the pinned machine produced after the target changed mid-call', async () => {
    let machineIsStillCaptured = true;
    const invoke = vi.fn(async () => {
      machineIsStillCaptured = false;
      return { ok: true, headers: { authorization: 'Bearer account-a' } };
    });
    const materialize = materializer(invoke, {
      isInvocationCurrent: () => machineIsStillCaptured,
    });

    await expect(materialize({
      operationId: 'mint-client-secret',
      selection,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'voice_account_operation_cancelled' });

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  /**
   * The captured machine is part of this credential authority. Without an
   * injected client the materializer must still dispatch to the machine the
   * authority was captured on, not to whatever the ambient resolver now names.
   */
  it('dispatches to the machine captured with the authority after the ambient target moved', async () => {
    machineRpc.mockResolvedValue({ ok: true, headers: { authorization: 'Bearer account-a' } });
    const materialize = createVoiceClientMediatedCredentialHeadersMaterializer({
      contribution,
      platform: 'web',
      phase: 'prepare',
      declarationAuthority: { kind: 'projected', cacheIdentity },
      machineId: 'machine-a',
      isCurrent: () => true,
      isInvocationCurrent: () => true,
    });
    ambientMachine.id = 'machine-b';

    await expect(materialize({
      operationId: 'mint-client-secret',
      selection,
      signal: new AbortController().signal,
    })).resolves.toEqual({ authorization: 'Bearer account-a' });

    expect(machineRpc).toHaveBeenCalledTimes(1);
    expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-a',
      method: 'daemon.voice.client.mediatedCredential.materialize',
    }));
  });

  it('reports execution-machine recovery instead of falling back to the ambient machine when no target was captured', async () => {
    machineRpc.mockResolvedValue({ ok: true, headers: { authorization: 'Bearer account-a' } });
    const materialize = createVoiceClientMediatedCredentialHeadersMaterializer({
      contribution,
      platform: 'web',
      phase: 'prepare',
      declarationAuthority: { kind: 'projected', cacheIdentity },
      machineId: null,
      isCurrent: () => true,
      isInvocationCurrent: () => true,
    });
    ambientMachine.id = 'machine-b';

    await expect(materialize({
      operationId: 'mint-client-secret',
      selection,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'execution_machine_unavailable' });

    expect(machineRpc).not.toHaveBeenCalled();
  });
});
