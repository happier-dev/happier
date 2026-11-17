import { expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { WorkspaceSyncTargetRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createWorkspaceSyncTargetContent, openWorkspaceSyncTargetContent } from './workspaceSyncTargetContent';

it('opens later continuation requests only for the original reply recipient and route', async () => {
  const keys = tweetnacl.sign.keyPair();
  const destination = { machineId: 'target', installationId: 'installation', installationPublicKey: encodeBase64(keys.publicKey, 'base64url') };
  const installation = { version: 1 as const, installationId: 'installation', createdAt: 1,
    publicKey: destination.installationPublicKey, privateKey: encodeBase64(keys.secretKey, 'base64url') };
  const routing = WorkspaceSyncTargetRoutingV1Schema.parse({ v: 1, phase: 'remove', operationId: 'sync', accountServerId: 'home',
    targetMachineId: 'target', targetRootPath: '/checkout', targetContext: { machineAdmission: {
      actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'target', installationId: 'installation', role: 'manage',
      encryptionMode: 'plain' }, callerAuthority: 'present_user', workspaceWrites: 'allow' } });
  const method = 'target:remove';
  const source = createWorkspaceSyncTargetContent({ destination, method, routing });
  const initial = await socketRpcCodec.encodeParams(source, { kind: 'remove' }, { method, callId: '11'.repeat(16) });
  const target = openWorkspaceSyncTargetContent({ ciphertext: String(initial), installation, machineId: 'target', method, routing });
  expect(target).not.toBeNull();
  const later = await socketRpcCodec.encodeParams(source, { kind: 'review' }, { method, callId: '22'.repeat(16) });
  expect(await socketRpcCodec.decodeRequestParams(target!, later, method)).toEqual({ params: { kind: 'review' }, callId: '22'.repeat(16) });
  const foreign = createWorkspaceSyncTargetContent({ destination, method, routing });
  const foreignFrame = await socketRpcCodec.encodeParams(foreign, { kind: 'review' }, { method, callId: '33'.repeat(16) });
  await expect(socketRpcCodec.decodeRequestParams(target!, foreignFrame, method)).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
});
