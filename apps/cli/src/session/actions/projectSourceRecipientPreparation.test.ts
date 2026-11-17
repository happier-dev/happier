import { randomBytes } from 'node:crypto';
import axios from 'axios';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { afterEach, expect, it, vi } from 'vitest';
import { encodeBase64, decodeBase64, sealEncryptedDataKeyEnvelopeV1, openEncryptedDataKeyEnvelopeV1,
  computeContentPublicKeyFingerprint, signAccountContentKeyBindingV1 } from '@happier-dev/protocol';
import { ProjectSharedSetupV1Schema } from '@happier-dev/protocol/projects/projectSetupV1';
import { ProjectSourceV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { ArtifactRecipientKeyEnvelopeCommitInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { encryptWithDataKey } from '@/api/encryption';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliProjectSourceActionDeps } from './projectSourceActionDeps';

afterEach(() => vi.restoreAllMocks());

it.each(['attach', 'audience', 'recipient_refused'] as const)('prepares the proposed Source audience once before %s through the existing Artifact key owner', async scenario => {
  const ownerSecret = randomBytes(32);
  const ownerPublic = x25519.getPublicKey(ownerSecret);
  const recipientSecret = randomBytes(32);
  const recipientPublic = x25519.getPublicKey(recipientSecret);
  const signingSecret = randomBytes(32);
  const signingPublic = ed25519.getPublicKey(signingSecret);
  const key = randomBytes(32);
  const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: ownerPublic, randomBytes }));
  const projectSourcePatch = { owner: { kind: 'team' as const, teamId: 'team' }, audience: [] };
  const attachment = { purpose: 'setup' as const, ref: { kind: 'doc' as const, artifactId: 'setup' }, contentRevision: { headerVersion: 1, bodyVersion: 1 } };
  const source = ProjectSourceV1Schema.parse({ id: 'source', revision: 1, name: 'App', audience: [], createdByAccountId: 'owner', attachments: [attachment] });
  const setup = ProjectSharedSetupV1Schema.parse({ kind: 'project_setup.v1', manifest: { version: 1 } });
  const effects: string[] = [];
  const signedRequests: { method: string; path: string; body?: unknown }[] = [];
  const store = createAccountArtifactStore({ credentials: { token: 'owner-token', encryption: { type: 'dataKey',
    publicKey: ownerPublic, machineKey: ownerSecret } }, getAccountEncryptionMode: async () => 'e2ee' });
  // HTTP is the boundary: decoding, recipient binding verification, sealing and Source preparation stay real.
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const target = new URL(String(url));
    effects.push(`GET ${target.pathname}`);
    expect(target.searchParams.get('projectSourceId')).toBe('source');
    if (target.pathname.endsWith('/recipients')) {
      expect(JSON.parse(target.searchParams.get('projectSourcePatch')!)).toEqual(projectSourcePatch);
      return { status: 200, data: { artifactId: 'setup', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
        dataEncryptionKey: envelope, callerDataEncryptionKey: envelope, recipients: [{ recipientAccountId: 'recipient',
          contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipientPublic), encryptedDataKey: null,
          recipientContentPublicKeyFingerprint: null, contentKey: { status: 'available',
            accountSigningPublicKey: Buffer.from(signingPublic).toString('hex'), contentPublicKey: encodeBase64(recipientPublic),
            contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({
              accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]), contentPublicKey: recipientPublic })) } }] } };
    }
    return { status: 200, data: { id: 'setup', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
      header: encodeBase64(encryptWithDataKey({ kind: setup.kind }, key)), body: encodeBase64(encryptWithDataKey({ body: JSON.stringify(setup) }, key)),
      dataEncryptionKey: envelope, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
    effects.push(`POST ${new URL(String(url)).pathname}`);
    const input = ArtifactRecipientKeyEnvelopeCommitInputV1Schema.parse(raw);
    expect(input).toMatchObject({ projectSourceId: 'source', projectSourcePatch });
    expect(input.recipientKeyEnvelopes).toHaveLength(1);
    expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(input.recipientKeyEnvelopes[0]!.encryptedDataKey),
      recipientSecretKeyOrSeed: recipientSecret })).toEqual(new Uint8Array(key));
    return scenario === 'recipient_refused' ? { status: 403, data: { error: 'artifact_access_unavailable' } }
      : { status: 200, data: { appliedRecipientAccountIds: ['recipient'], skippedRecipientAccountIds: [] } };
  });
  vi.spyOn(axios, 'request').mockImplementation(async request => {
    effects.push(`${request.method} ${new URL(String(request.url)).pathname}`);
    return { status: 200, data: { ok: true, canManage: true, source } };
  });
  const deps = createCliProjectSourceActionDeps({ serverHttpBaseUrl: 'https://source.test', admitAccount: () => null,
    resolveRequestHeaders: async (_context, _action, request) => { signedRequests.push(request); return { Authorization: 'Bearer owner-token' }; },
    readArtifact: (ref, options) => runWithServerHttpBaseUrl('https://source.test', () => store.read(ref.artifactId, {
      ...options,
      authorizationHeaders: async request => { signedRequests.push(request); return { Authorization: 'Bearer owner-token' }; },
    })),
  });
  const result = await deps.projectSourcesUpdate!({ serverId: 'home', sourceId: 'source', expectedRevision: 1,
    patch: { ...projectSourcePatch, ...(scenario === 'attach' ? { attachment: { kind: 'attach' as const, attachment } } : {}) } },
  { surface: 'cli', bypassApprovals: true });
  expect(result).toMatchObject(scenario === 'recipient_refused' ? { ok: false, error: 'artifact_unavailable' } : { ok: true });
  expect(effects).toEqual([...(scenario === 'attach' ? [] : ['GET /v1/projects/sources/source']), 'GET /v1/artifacts/setup',
    'GET /v1/artifacts/setup/access/recipients', 'POST /v1/artifacts/setup/access/key-envelopes',
    ...(scenario === 'recipient_refused' ? [] : ['PATCH /v1/projects/sources/source'])]);
  const signedCensus = signedRequests.find(request => request.path.includes('/access/recipients'));
  expect(new URL(signedCensus!.path, 'https://source.test').searchParams.get('projectSourceId')).toBe('source');
  expect(new URL(signedCensus!.path, 'https://source.test').searchParams.get('projectSourcePatch')).toBe(JSON.stringify(projectSourcePatch));
});
