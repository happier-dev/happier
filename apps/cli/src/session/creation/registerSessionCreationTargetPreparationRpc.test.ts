import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionCreationTargetPreparationRequestV1Schema, SessionCreationTargetPreparationResultV1Schema } from '@happier-dev/protocol';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { registerSessionCreationTargetPreparationRpc } from './registerSessionCreationTargetPreparationRpc';

describe('registerSessionCreationTargetPreparationRpc', () => {
  it('keeps materializing preparation private while permitting a shared directory read', async () => {
    // Home admission is the substituted boundary; the registered read-only
    // preparation owner still decides which directory requests are permitted.
    const rpc = new RpcHandlerManager({ scopePrefix: 'guest', encryptionMode: 'plain', logger() {},
      authorizeRequest: async () => ({ ok: true }) });
    registerSessionCreationTargetPreparationRpc({ rpcHandlerManager: rpc });
    const controller = new AbortController();
    const machineAdmission = { actorAccountId: 'requester', custodianAccountId: 'owner', machineId: 'guest',
      installationId: 'install', role: 'use', encryptionMode: 'plain' } as const;
    const invoke = (input: unknown) => rpc.invokeLocal(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT, input,
      { signal: controller.signal, rpcContext: { machineAdmission } });
    const sessionCreationTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'owner', creationKey: 'managed' });
    for (const input of [{ directory: { kind: 'managed' }, sessionCreationTag },
      { directory: { kind: 'path', path: tmpdir() }, checkoutCreationDraft: { kind: 'git_worktree', displayName: 'private', baseRef: null } }]) {
      await expect(invoke(input)).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
    }
    expect(await invoke({ directory: { kind: 'path', path: tmpdir() } })).toMatchObject({ ok: true, directoryCreationRequired: false });
    expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE, { directory: { kind: 'managed' }, sessionCreationTag },
      { rpcContext: { machineAdmission: { ...machineAdmission, actorAccountId: 'owner', role: 'manage' } } }))
      .toMatchObject({ ok: true, directoryKind: 'managed' });
  });
  it('binds the narrow preparation contract to the target daemon and forwards cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-test-clean-preparation-'));
    const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: 'target-machine', encryptionMode: 'plain', logger() {} });
    registerSessionCreationTargetPreparationRpc({ rpcHandlerManager });
    const request = SessionCreationTargetPreparationRequestV1Schema.parse({ directory: { kind: 'path', path: directory } });
    const controller = new AbortController();
    try {
      const result = await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE, request,
        { signal: controller.signal });
      expect(SessionCreationTargetPreparationResultV1Schema.parse(result)).toEqual({
        ok: true, directory, directoryKind: 'path', directoryCreationRequired: false, checkout: null,
      });
      // Check the actual cancellation outcome, rather than a collaborator call.
      const reason = new Error('Caller cancelled preparation');
      controller.abort(reason);
      await expect(rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE, request,
        { signal: controller.signal })).rejects.toBe(reason);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
