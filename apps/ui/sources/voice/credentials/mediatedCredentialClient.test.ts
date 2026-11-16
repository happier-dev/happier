import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHydratedPlainMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { log } from '@/log';

vi.mock('socket.io-client', async original => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(original));
const machineRpc = vi.fn<(request: Readonly<{ machineId: string; method: string; payload: unknown }>) => Promise<unknown>>();
const requests = installSessionActionRpcBoundary(request => {
  const separator = request.method.indexOf(':');
  return machineRpc({ machineId: request.method.slice(0, separator),
    method: request.method.slice(separator + 1), payload: request.params });
});

const { storage } = await import('@/sync/domains/state/storage');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { resolveVoiceExecutionMachineId } = await import('@/voice/settings/executionMachine');
const { createVoiceClientAccountOperationExecutor } = await import('./mediatedCredentialClient');
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

function credentialLogLines() {
  return log.getLogs().filter(line => line.startsWith('[voiceMediatedCredential]'));
}

function selectMachine(machineId: string) {
  storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
    voice: { ...storage.getState().settings.voice, executionMachine: { mode: 'fixed', machineId } },
  }, storage.getState().settings));
}

const contribution = Object.freeze({ pluginId: 'happier.openai', localId: 'realtime' });
const service = Object.freeze({ pluginId: 'happier.agent.codex', localId: 'openai-codex' });
const selection = Object.freeze({
  kind: 'account' as const,
  account: Object.freeze({ service, accountId: 'account-a' }),
});
const operationResponse = { status: 200, finalUrl: 'https://voice.example.test/client-secret', headers: { 'content-type': 'application/json' }, bodyBase64: 'eyJ2YWx1ZSI6ImVwaGVtZXJhbCJ9' };
const decodedResponse = { status: 200, finalUrl: operationResponse.finalUrl, headers: operationResponse.headers, body: new TextEncoder().encode('{"value":"ephemeral"}') };

const cacheIdentity = Object.freeze({
  artifactDigest: `sha256:${'a'.repeat(64)}` as const,
});

function materializer(
  invoke: (method: string, payload: unknown, signal?: AbortSignal | null) => Promise<unknown>,
  overrides?: Readonly<{ isInvocationCurrent?: () => boolean }>,
) {
  machineRpc.mockImplementation(request => invoke(request.method, request.payload));
  return createVoiceClientAccountOperationExecutor({
    contribution,
    platform: 'web',
    phase: 'prepare',
    declarationAuthority: { kind: 'projected', cacheIdentity },
    machineId: 'machine-a',
    isCurrent: () => true,
    isInvocationCurrent: overrides?.isInvocationCurrent ?? (() => true),
  });
}

describe('createVoiceClientAccountOperationExecutor', () => {
  beforeEach(async () => {
    log.clear();
    machineRpc.mockReset();
    requests.length = 0;
    account = await restoreServerAccountForTest({
      serverUrl: 'https://voice-credential.test', accountId: 'account-a', credentialScope: 'restored-home',
      request: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
        if (path === '/v1/machines') return Response.json(['machine-a', 'machine-b'].map(id => createPlainMachineRowFixture({ id, accountId: 'account-a' })));
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
          id => createPlainMachineRowFixture({ id, accountId: 'account-a' }));
        const machine = /^\/v1\/machines\/([^/]+)$/.exec(path);
        if (machine) return Response.json({ machine: createPlainMachineRowFixture({ id: machine[1]!, accountId: 'account-a' }) });
        return null;
      },
    });
    const machines = ['machine-a', 'machine-b'].map(id => createHydratedPlainMachineFixture({ id, accountId: 'account-a', machine: { activeAt: Date.now() } }));
    await publishMachineInventoryForTest({ serverId: account.home.id, accountId: 'account-a' }, machines);
    selectMachine('machine-a');
  });
  afterEach(async () => { await account?.dispose(); account = null; });

  it('preserves an unreachable execution machine as distinct from credential failure', async () => {
    const materialize = materializer(async () => {
      throw Object.assign(new Error('machine_unavailable'), { code: 'machine_unavailable' });
    });

    await expect(materialize({
      operationId: 'mint-client-secret',
      parameters: {},
      selection,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'execution_machine_unavailable' });

    expect(credentialLogLines()).toHaveLength(1);
    const line = credentialLogLines()[0]!;
    expect(line).toContain('machine_unavailable');
    expect(line).toContain('mint-client-secret');
  });

  it('names a rejected daemon operation distinctly from an unreachable machine', async () => {
    const materialize = materializer(async () => ({
      ok: false,
      errorCode: 'plugin_voice_provider_result_invalid',
    }));

    await expect(materialize({
      operationId: 'mint-client-secret',
      parameters: {},
      selection,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'voice_account_operation_unauthorized' });

    const line = credentialLogLines()[0]!;
    expect(line).toContain('plugin_voice_provider_result_invalid');
    expect(line).not.toContain('machine_unavailable');
  });

  it('keeps a transport timeout retryable instead of asking to replace valid credentials', async () => {
    const materialize = materializer(async () => {
      throw Object.assign(new Error('RPC timed out'), { code: 'machine_rpc_timeout' });
    });
    await expect(materialize({
      operationId: 'mint-client-secret', parameters: {}, selection,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'service_temporarily_unavailable' });
  });

  it('never logs the ephemeral operation response', async () => {
    const materialize = materializer(async () => ({
      ok: true,
      response: operationResponse,
    }));

    await expect(materialize({
      operationId: 'mint-client-secret',
      parameters: {},
      selection,
      signal: new AbortController().signal,
    })).resolves.toEqual(decodedResponse);

    expect(credentialLogLines()).toEqual([]);
    expect(JSON.stringify(log.getLogs())).not.toContain(operationResponse.bodyBase64);
    expect(JSON.stringify(log.getLogs())).not.toContain('"value":"ephemeral"');
  });

  it('rejects a header-export response without logging the source credential', async () => {
    const execute = materializer(async () => ({
      ok: true, headers: { authorization: 'Bearer long-lived-source-secret' },
    }));
    await expect(execute({
      operationId: 'mint-client-secret', parameters: {}, selection,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
    expect(JSON.stringify(log.getLogs())).not.toContain('long-lived-source-secret');
  });

  it('sends the captured declaration authority and Connected Account selection to the daemon', async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      response: operationResponse,
    }));
    const materialize = materializer(invoke);

    await expect(materialize({
      operationId: 'mint-client-secret',
      parameters: {},
      selection,
      signal: new AbortController().signal,
    })).resolves.toEqual(decodedResponse);

    expect(invoke).toHaveBeenCalledWith(
      'daemon.voice.client.accountOperation.request',
      {
        contribution,
        platform: 'web',
        phase: 'prepare',
        operationId: 'mint-client-secret',
        parameters: {},
        declarationAuthority: { kind: 'projected', cacheIdentity },
        expectedSelection: selection,
      },
    );
  });

  it('refuses to materialize after the Voice execution machine captured with the authority changed', async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      response: operationResponse,
    }));
    let machineIsStillCaptured = true;
    const materialize = materializer(invoke, {
      isInvocationCurrent: () => machineIsStillCaptured,
    });
    machineIsStillCaptured = false;

    await expect(materialize({
      operationId: 'mint-client-secret',
      parameters: {},
      selection,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'voice_account_operation_cancelled' });

    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not return an artifact the pinned machine produced after the target changed mid-call', async () => {
    let machineIsStillCaptured = true;
    const invoke = vi.fn(async () => {
      machineIsStillCaptured = false;
      return { ok: true, response: operationResponse };
    });
    const materialize = materializer(invoke, {
      isInvocationCurrent: () => machineIsStillCaptured,
    });

    await expect(materialize({
      operationId: 'mint-client-secret',
      parameters: {},
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
    machineRpc.mockResolvedValue({ ok: true, response: operationResponse });
    const materialize = createVoiceClientAccountOperationExecutor({
      contribution,
      platform: 'web',
      phase: 'prepare',
      declarationAuthority: { kind: 'projected', cacheIdentity },
      machineId: 'machine-a',
      isCurrent: () => true,
      isInvocationCurrent: () => true,
    });
    selectMachine('machine-b');
    expect(resolveVoiceExecutionMachineId()).toBe('machine-b');

    await expect(materialize({
      operationId: 'mint-client-secret',
      parameters: {},
      selection,
      signal: new AbortController().signal,
    })).resolves.toEqual(decodedResponse);

    expect(machineRpc).toHaveBeenCalledTimes(1);
    expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-a',
      method: 'daemon.voice.client.accountOperation.request',
    }));
  });

  it('reports execution-machine recovery instead of falling back to the ambient machine when no target was captured', async () => {
    machineRpc.mockResolvedValue({ ok: true, response: operationResponse });
    const materialize = createVoiceClientAccountOperationExecutor({
      contribution,
      platform: 'web',
      phase: 'prepare',
      declarationAuthority: { kind: 'projected', cacheIdentity },
      machineId: null,
      isCurrent: () => true,
      isInvocationCurrent: () => true,
    });
    selectMachine('machine-b');
    expect(resolveVoiceExecutionMachineId()).toBe('machine-b');

    await expect(materialize({
      operationId: 'mint-client-secret',
      parameters: {},
      selection,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'execution_machine_unavailable' });

    expect(machineRpc).not.toHaveBeenCalled();
  });
});
