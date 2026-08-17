import { beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => vi.fn());
vi.mock('@/log', () => ({ log: { log: logSpy, warn: vi.fn(), error: vi.fn() } }));

import { createVoiceClientMediatedCredentialHeadersMaterializer } from './mediatedCredentialClient';

const contribution = Object.freeze({ pluginId: 'happier.openai', localId: 'realtime' });

function materializer(invoke: (method: string, payload: unknown, signal?: AbortSignal | null) => Promise<unknown>) {
  return createVoiceClientMediatedCredentialHeadersMaterializer({
    contribution,
    platform: 'web',
    phase: 'prepare',
    isCurrent: () => true,
    client: { invoke },
  });
}

describe('createVoiceClientMediatedCredentialHeadersMaterializer', () => {
  beforeEach(() => {
    logSpy.mockReset();
  });

  it('names the failing pre-flight step and its cause when the machine cannot be reached', async () => {
    const materialize = materializer(async () => {
      throw Object.assign(new Error('machine_unavailable'), { code: 'machine_unavailable' });
    });

    await expect(materialize({
      operationId: 'mint-client-secret',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'credential_unavailable' });

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
      signal: new AbortController().signal,
    })).resolves.toEqual({ authorization: 'Bearer super-secret-value' });

    expect(logSpy).not.toHaveBeenCalled();
  });
});
