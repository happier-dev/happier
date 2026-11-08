import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '@/api/encryption';
import { registerPathMutationHandlers } from '@/rpc/handlers/fileSystem/pathMutationHandlers';
import { RpcHandlerManager } from './RpcHandlerManager';

describe.each(['legacy', 'dataKey'] as const)('encrypted RPC binding (%s)', (variant) => {
  it('binds method, target, call and direction, rejects unbound or malformed content, and preserves values', async () => {
    const key = new Uint8Array(32).fill(18);
    const content: SocketRpcContent = { mode: 'e2ee', cipher: {
      encryptRaw: async (value) => encodeBase64(encrypt(key, variant, value)),
      decryptRaw: async (value) => decrypt(key, variant, decodeBase64(value)),
    } };
    const callId = '0123456789abcdef0123456789abcdef';
    const otherCall = 'abcdef0123456789abcdef0123456789';
    const method = 'machine:statFile';
    const params = await socketRpcCodec.encodeParams(content, { path: 'keep.txt' }, { method, callId });
    for (const swappedMethod of ['machine:deletePath', 'other:statFile']) {
      await expect(socketRpcCodec.decodeRequestParams(content, params, swappedMethod))
        .rejects.toMatchObject({ rpcErrorCode: 'RPC_UPDATE_REQUIRED' });
    }
    for (const value of [{ path: 'keep.txt' }, null, { v: 2, k: 'req', m: method, c: 'relay-id', p: {} },
      { v: 2, k: 'req', m: method, c: callId, p: {}, extra: true }]) {
      const unbound = await content.cipher.encryptRaw(value);
      await expect(socketRpcCodec.decodeRequestParams(content, unbound, method))
        .rejects.toMatchObject({ rpcErrorCode: 'RPC_UPDATE_REQUIRED' });
    }
    await expect(socketRpcCodec.decodeResult(content, { ok: true, result: params }, callId))
      .rejects.toMatchObject({ rpcErrorCode: 'RPC_UPDATE_REQUIRED' });
    for (const value of [{ exists: true }, null, undefined]) {
      const response = await socketRpcCodec.encodeResponse(content, value, callId);
      expect(await socketRpcCodec.decodeResult(content, { ok: true, result: response }, callId)).toEqual(value);
      await expect(socketRpcCodec.decodeResult(content, { ok: true, result: response }, otherCall))
        .rejects.toMatchObject({ rpcErrorCode: 'RPC_UPDATE_REQUIRED' });
      await expect(socketRpcCodec.decodeRequestParams(content, response, method))
        .rejects.toMatchObject({ rpcErrorCode: 'RPC_UPDATE_REQUIRED' });
    }
    expect(await socketRpcCodec.decodeRequestParams(content, params, method))
      .toEqual({ params: { path: 'keep.txt' }, callId });
    expect(await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, null, method))
      .toEqual({ params: null, callId: null });
    expect(await socketRpcCodec.encodeResponse({ mode: 'plain' }, { exists: true }, null)).toEqual({ exists: true });
  });

  it('refuses statFile ciphertext redirected to the real deletePath handler', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-rpc-binding-'));
    const key = new Uint8Array(32).fill(17);
    const content: SocketRpcContent = { mode: 'e2ee', cipher: {
      encryptRaw: async (value) => encodeBase64(encrypt(key, variant, value)),
      decryptRaw: async (value) => decrypt(key, variant, decodeBase64(value)),
    } };
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionKey: key, encryptionVariant: variant, logger: () => {} });
    registerPathMutationHandlers(rpc, { workingDirectory: directory, accessPolicy: { kind: 'restrictedRoots', roots: [directory] },
      getAdditionalAllowedReadDirs: () => [], getAdditionalAllowedWriteDirs: () => [] });
    const callId = '0123456789abcdef0123456789abcdef';
    const path = join(directory, 'keep.txt');
    try {
      await writeFile(path, 'keep me');
      const params = await socketRpcCodec.encodeParams(content, { path }, { method: `machine:${RPC_METHODS.STAT_FILE}`, callId });
      const response = await rpc.handleRequest({ method: `machine:${RPC_METHODS.DELETE_PATH}`, params });
      expect(await readFile(path, 'utf8')).toBe('keep me');
      await expect(socketRpcCodec.decodeResult(content, { ok: true, result: response }, callId))
        .rejects.toMatchObject({ rpcErrorCode: 'RPC_UPDATE_REQUIRED' });
      const valid = await rpc.handleRequest({ method: `machine:${RPC_METHODS.STAT_FILE}`, params });
      expect(await socketRpcCodec.decodeResult(content, { ok: true, result: valid }, callId))
        .toMatchObject({ success: true, exists: true, kind: 'file' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});


describe.each(['plain', 'e2ee'] as const)('structured Machine routing binding (%s)', mode => {
  it.each([RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN])('refuses Session substitution and raw payloads behind admitted routing before %s dispatch', async rpcMethod => {
    const key = new Uint8Array(32).fill(28);
    const content: SocketRpcContent = mode === 'plain' ? { mode: 'plain' } : { mode: 'e2ee', cipher: {
      encryptRaw: async value => encodeBase64(encrypt(key, 'dataKey', value)),
      decryptRaw: async value => decrypt(key, 'dataKey', decodeBase64(value)),
    } };
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine',
      encryptionMode: mode, encryptionKey: key, encryptionVariant: 'dataKey', logger: () => {},
      // Home is the genuine authorization boundary; the binding below stays real.
      authorizeRequest: () => ({ ok: true }) });
    let effects = 0;
    rpc.registerHandler(rpcMethod, () => ({ effects: ++effects }));
    const raw = { machineId: 'machine', qualifiedActionId: 'acme.composer/submit', executionSurface: 'cli',
      expectedContributorOccurrenceId: 'current', input: {} };
    const admitted = { actorAccountId: 'requester', custodianAccountId: 'custodian', machineId: 'machine',
      installationId: 'installed', role: 'use', encryptionMode: mode,
      structuredMessageRouting: { v: 1, machineId: 'machine', sessionIds: ['own-session'] } };
    const method = `machine:${rpcMethod}`;
    const callId = '28'.repeat(16);
    const run = async (input: unknown, admission: unknown = admitted) => {
      const payload = rpcMethod === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN
        ? { machineId: 'machine', resource: { actionRead: input } } : input;
      const response = await rpc.handleRequest({ method, params: await socketRpcCodec.encodeParams(content, payload, { method, callId }),
        machineAdmission: admission } as Parameters<typeof rpc.handleRequest>[0]);
      return socketRpcCodec.decodeResult(content, { ok: true, result: response }, callId);
    };
    const bound = { ...raw, invocation: { kind: 'clientPluginAction', clientActionBinding: {
      pluginId: 'acme.composer', contributionLocalId: 'submit', occurrenceId: 'current' } }, sessionId: 'own-session' };
    expect(await run(bound)).toEqual({ effects: 1 });
    for (const changed of [raw, { ...bound, sessionId: 'foreign-session' },
      { ...bound, messageActionReference: { v: 1, sessionId: 'foreign-session', messageId: 'secret', observedRevision: '1' } },
      { ...bound, machineId: 'other-machine' }]) {
      expect(await run(changed)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    }
    expect(await run(bound, { ...admitted, structuredMessageRouting: undefined })).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(effects).toBe(1);
  });
});
