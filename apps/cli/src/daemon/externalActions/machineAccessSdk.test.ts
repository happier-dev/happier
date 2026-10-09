import { describe, expect, it } from 'vitest';
import fastify from 'fastify';
import nacl from 'tweetnacl';
import { connect } from '@happier-dev/sdk';
import { createActionExecutor, ExternalActionRequestEnvelopeV1Schema, isApprovalRequiredByActionsSettings, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealEncryptedDataKeyEnvelopeV1, openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { computeMachineOwnerEnvelopeFingerprintV1 } from '@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1';
import { MachineRecipientKeyEnvelopeCommitInputV1Schema, type MachineAccessRecipientCensusResponseV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { reconcileExternalActionTarget, resolveExternalActionMachineTarget } from './reconcileExternalActionTarget';

// Inline Home HTTP is the genuine boundary; this source test needs no compiled CLI or external service.
describe('advertised SDK key preparation on a distinct trusted key holder', () => {
  it('executes on Bob while preparing Alice current-Manage resource and seals the real recipient key', async () => {
    const sdkToken = 'hap_v1_123e4567-e89b-42d3-a456-426614174000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const manager = nacl.box.keyPair();
    const recipient = nacl.box.keyPair();
    const signing = nacl.sign.keyPair();
    const dataKey = new Uint8Array(32).fill(19);
    const callerDataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey,
      recipientPublicKey: manager.publicKey, randomBytes: nacl.randomBytes }));
    const fingerprint = computeContentPublicKeyFingerprint(recipient.publicKey);
    const resource = { serverId: 'home', machineId: 'alice-resource' };
    const holder = { kind: 'machine', machineId: 'bob-holder' } as const;
    const page: MachineAccessRecipientCensusResponseV1 = {
      machineId: resource.machineId, custodianAccountId: 'alice', encryptionMode: 'e2ee', callerDataEncryptionKey,
      machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(decodeBase64(callerDataEncryptionKey)),
      nextCursor: null,
      content: { metadata: createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: dataKey, encryptionVariant: 'dataKey' }).encodeStored({
        host: 'host', platform: 'linux', happyCliVersion: '0.3', homeDir: '/home/bob', happyHomeDir: '/home/bob/.happier',
      }), metadataVersion: 3, daemonState: null, daemonStateVersion: 4 },
      recipients: [{ recipientAccountId: 'teammate', contentKey: { status: 'available',
        accountSigningPublicKey: Buffer.from(signing.publicKey).toString('hex'), contentPublicKey: encodeBase64(recipient.publicKey),
        contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: recipient.publicKey })),
      }, contentPublicKeyFingerprint: fingerprint, encryptedDataKey: null, recipientContentPublicKeyFingerprint: null }],
    };
    const app = fastify();
    let delivered: Uint8Array | null = null;
    let origin = '';
    app.get('/v1/machines/alice-resource/data-key-envelopes', async request => {
      // The network fixture stands in for current server Manage admission.
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      expect(request.query).toEqual({ state: 'action_required' });
      return { ...page, recipients: delivered ? [] : page.recipients };
    });
    app.patch('/v1/machines/alice-resource/data-key-envelopes', async request => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      const body = MachineRecipientKeyEnvelopeCommitInputV1Schema.parse({ ...(request.body as object), machineId: resource.machineId });
      expect(body.expectedCallerDataEncryptionKey).toBe(callerDataEncryptionKey);
      expect(body.expectedMachineOwnerEnvelopeFingerprint).toBe(page.machineOwnerEnvelopeFingerprint);
      const envelope = body.recipientKeyEnvelopes[0]!;
      expect(envelope.recipientAccountId).toBe('teammate');
      expect(envelope.recipientContentPublicKeyFingerprint).toBe(fingerprint);
      delivered = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(envelope.encryptedDataKey), recipientSecretKeyOrSeed: recipient.secretKey });
      return { appliedRecipientAccountIds: ['teammate'], skippedRecipientAccountIds: [] };
    });
    app.post('/*', async request => {
      expect(request.headers.authorization).toBe(`Bearer ${sdkToken}`);
      const actionId = decodeURIComponent(request.url.split('/').at(-1)!);
      expect(actionId).toBe('machines.access.prepareKeys');
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.body);
      expect(envelope.input).toEqual(resource);
      expect(envelope.target).toEqual(holder);
      const selected = resolveExternalActionMachineTarget({ actionId: 'machines.access.prepareKeys', rawInput: envelope.input, target: envelope.target });
      expect(selected).toEqual({ kind: 'ready', machineId: holder.machineId });
      const reconciled = reconcileExternalActionTarget({ actionId: 'machines.access.prepareKeys', rawInput: envelope.input,
        target: envelope.target, currentMachineId: holder.machineId });
      expect(reconciled.kind).toBe('ready');
      const executor = createActionExecutor({ ...createAccountServerActionDeps({ token,
        credentials: { token, encryption: { type: 'dataKey', publicKey: manager.publicKey, machineKey: manager.secretKey } },
        serverId: resource.serverId, serverHttpBaseUrl: origin }),
        isActionApprovalRequired: ((id, context) => isApprovalRequiredByActionsSettings(id,
          { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.access.prepareKeys': ['api'] } }, context)) satisfies NonNullable<ActionExecutorDeps['isActionApprovalRequired']>,
      } as unknown as ActionExecutorDeps);
      const execution = await executor.execute('machines.access.prepareKeys', envelope.input,
        { surface: 'api', serverId: resource.serverId, runtimeAccountId: 'bob' });
      return { v: 1, actionId, ...(envelope.requestId ? { requestId: envelope.requestId } : {}), execution };
    });
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = connect({ endpoint: origin, token: sdkToken });
    try {
      expect(await client.actions.machines.access.prepareKeys(resource, { target: holder })).toEqual({ kind: 'prepared' });
      expect(delivered).toEqual(dataKey);
    } finally { await client.close(); await app.close(); }
  });
});
