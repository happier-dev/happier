import { expect } from 'vitest';
import nacl from 'tweetnacl';
import { socketRpcCodec } from '@happier-dev/sync-client';
import type { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readSessionInputRequestV1, settleSessionInputRequestV1, withSessionInputAuthorityV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { SessionMessageContentSchema, UserMessageSchema } from '@/api/types';
import { openSessionMessageContent, sealSessionStoredContent, type SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import type { CliActionMachineAdmissionTransport } from '../createCliActionExecutorFromCredentials';

/** The origin's external socket and Machine input boundary; admission/replay stay real. */
export async function createDeferredOutcomeDeliveryBoundary(input: Readonly<{
  accountId: string; serverId: string; serverIdentityId: string; machineId: string; sessionId: string;
  sessionCrypto: SessionStoredContentCryptoContext;
  callerAuthority: 'present_user' | 'account_automation';
  readReceiver(): Pick<ReturnType<typeof createActionExecutor>, 'replayApprovedApprovalRequest'>;
}>) {
  const currentness = await createRequesterCurrentnessSocketHarness();
  const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
  const retained = new Map<string, ReturnType<typeof SessionMessageContentSchema.parse>>();
  const admittedInputs: ReturnType<typeof UserMessageSchema.parse>[] = [];
  const delivered = new Set<string>();
  const replayArtifacts: unknown[] = [];
  let machineAdmissionRequests = 0;
  const machineAdmissionTransport: CliActionMachineAdmissionTransport = async request => {
    machineAdmissionRequests++;
    expect(request.sessionId).toBe(input.sessionId);
    expect(request.targetMachineId).toBe(input.machineId);
    expect(request.localId.startsWith('approval-result:')).toBe(true);
    expect(request.requestedAction).toEqual({ v: 1, kind: 'enqueue' });
    const content = SessionMessageContentSchema.parse(request.content);
    const authored = UserMessageSchema.parse(openSessionMessageContent({ ...input.sessionCrypto, content }));
    if (authored.content.type !== 'text') throw new Error('Expected outcome text');
    const originalRequest = readSessionInputRequestV1(authored.meta);
    if (!originalRequest) throw new Error('Expected protected outcome input');
    const authority = settleSessionInputRequestV1({ request: originalRequest,
      currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' } });
    retained.set(request.localId, sealSessionStoredContent({ ...input.sessionCrypto, payload: { ...authored,
      meta: { ...withSessionInputAuthorityV1(authored.meta, authority), happierProvenanceV1: authored.meta?.happierProvenanceV1 } } }));
    admittedInputs.push(authored);
    delivered.add(request.localId);
    return { status: 'accepted', localId: request.localId };
  };
  currentness.server.on('connection', socket => socket.on('rpc-call', async (
    packet: { method: string; params: unknown }, acknowledge: (value: unknown) => void,
  ) => {
    const content = { mode: 'plain' } as const;
    const decoded = await socketRpcCodec.decodeRequestParams(content, packet.params, packet.method);
    expect(packet.method).toBe(`${input.machineId}:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`);
    const args = decoded.params;
    if (!args || typeof args !== 'object' || !('artifactId' in args) || typeof args.artifactId !== 'string') {
      throw new Error('Expected outcome replay Artifact');
    }
    expect(Object.keys(args)).toEqual(['artifactId']);
    replayArtifacts.push(args);
    const outcome = await input.readReceiver().replayApprovedApprovalRequest({ artifactId: args.artifactId,
      currentAccount: { accountId: input.accountId, serverId: input.serverId, serverIdentityId: input.serverIdentityId },
      callerAuthority: input.callerAuthority });
    acknowledge({ ok: true, result: await socketRpcCodec.encodeResponse(content, outcome, decoded.callId) });
  }));
  return { currentness, installation, machineAdmissionTransport, admittedInputs, delivered, replayArtifacts,
    readMachineAdmissionRequests: () => machineAdmissionRequests,
    machine: { id: input.machineId, kind: 'persistent', active: true, installationId: 'installation',
      installationPublicKey: encodeBase64(installation.publicKey), revokedAt: null, replacedByMachineId: null,
      storageMode: 'plain', access: { custodian: { accountId: input.accountId, displayName: 'Owner' }, role: 'manage',
        resourceMode: 'plain', accessState: 'ready' } },
    readRetainedContent: (localId: string) => retained.get(localId),
    setRetainedContent: (localId: string, content: ReturnType<typeof SessionMessageContentSchema.parse>) => retained.set(localId, content),
    readMessage(localId: string) {
      const content = retained.get(localId);
      return content ? { id: 'delivered-outcome', seq: 1, localId, content, createdAt: 2, updatedAt: 2 } : null;
    },
    close: () => currentness.close(),
  };
}
