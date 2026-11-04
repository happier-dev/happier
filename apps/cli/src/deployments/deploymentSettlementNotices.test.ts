import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { readOwnedNoticeArtifactV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { artifactListResponse, artifactReadResponse } from '@/testkit/http/artifactHome';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createDeploymentSettlementNotices } from './deploymentSettlementNotices';
import type { OwnServerDeploymentRequest, OwnServerDeploymentTargetHostInput } from './targets/ownServer/ownServerDeploymentTarget';

afterEach(() => vi.restoreAllMocks());

describe('settlement notice admission and arrival cost', () => {
  it.each(['plain', 'e2ee'] as const)('consumes the settled pair without reopening Source access for a %s notice write', async mode => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-owner' })).toString('base64url')}.signature`;
    const machineKey = new Uint8Array(randomBytes(32));
    const credentials = { token, encryption: mode === 'plain' ? null
      : { type: 'dataKey' as const, machineKey, publicKey: x25519.getPublicKey(machineKey) } };
    const environment = createDeploymentEnvironmentDetailV1();
    const receipt = createDeploymentReceiptDetailV1();
    const admitted = { environment: structuredClone(environment), receipt: structuredClone(receipt) };
    const link = environment.targetLinks[0].targetLink;
    link.activeDeploymentId = receipt.deployment.id;
    const request: OwnServerDeploymentRequest = { actionId: 'deployments.deploy',
      input: { serverId: environment.environment.serverId, environmentId: environment.environment.id,
        expectedRevision: environment.environment.revision, targetLinkId: link.id, expectedTargetLinkRevision: link.revision,
        requestKey: 'notice-arrival', contentArtifactId: receipt.deployment.contentArtifactId,
        contentHeaderVersion: receipt.deployment.contentHeaderVersion, contentBodyVersion: receipt.deployment.contentBodyVersion },
      receipt: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
        deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state }, context: {} };
    const baseUrl = 'http://settlement-home.test';
    let environmentReads = 0;
    let receiptReads = 0;
    let mutations = 0;
    let advanceDuringNoticeRead = false;
    const rows = new Map<string, { id: string } & Record<string, unknown>>();
    // Only HTTP/storage adapters are substituted. Notice encoding, encryption,
    // retained-condition updates and delivery decisions use the real owners.
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200,
        data: createAccountEncryptionCurrentnessFixture({ mode }) };
      if (advanceDuringNoticeRead) { receipt.deployment.revision++; advanceDuringNoticeRead = false; }
      if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(url, [...rows.values()]) };
      const row = rows.get(path.split('/')[3]!);
      if (row && path.endsWith('/recipients')) return { status: 200, data: {
        artifactId: row.id, ownerAccountId: 'account-owner', access: 'owner', encryptionMode: mode,
        dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey, recipients: [],
        provenanceDataEncryptionKey: row.provenanceDataEncryptionKey,
        callerProvenanceDataEncryptionKey: row.provenanceDataEncryptionKey,
      } };
      return { status: row ? 200 : 404, data: row ?? {} };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url: string, input: unknown) => {
      if (new URL(url).pathname === '/v1/artifacts/read') return artifactReadResponse(input, id => rows.get(id) ?? null);
      const mutation = readCarrierMutation(input);
      const id = typeof mutation.id === 'string' ? mutation.id : new URL(url).pathname.split('/').at(-1)!;
      const prior = rows.get(id);
      const version = Number(prior?.bodyVersion ?? 0) + 1;
      mutations++;
      rows.set(id, { ...prior, ...mutation, id, ownerAccountId: 'account-owner', access: 'owner',
        publicAudience: 'none', encryptionMode: mode, headerVersion: version, bodyVersion: version,
        seq: version, createdAt: 1, updatedAt: version });
      return { status: 200, data: { id, success: true, headerVersion: version, bodyVersion: version } };
    });
    const host: OwnServerDeploymentTargetHostInput = { credentials, serverId: environment.environment.serverId,
      serverHttpBaseUrl: baseUrl, machineId: environment.environment.controllerMachineId!,
      async readEnvironment() { environmentReads++; return structuredClone(environment); },
      async readReceipt() { receiptReads++; return structuredClone(receipt); },
      async writeTransition() { throw new Error('Notices cannot settle deployments'); },
      runtime: { async acquire() { throw new Error('Notices cannot acquire native effects'); } } };
    const publish = createDeploymentSettlementNotices(host);
    const arrive = async (supplySettled = true) => {
      environmentReads = 0; receiptReads = 0;
      await publish(request, admitted, supplySettled
        ? { environment: structuredClone(environment), receipt: structuredClone(receipt) } : undefined);
      const expectedReads = supplySettled ? 0 : 1;
      expect.soft({ environmentReads, receiptReads }, 'acquire a fresh pair only when the settlement owner has not supplied it')
        .toEqual({ environmentReads: expectedReads, receiptReads: expectedReads });
    };
    receipt.deployment.state = 'failed'; receipt.deployment.revision++;
    await arrive(false);
    expect(mutations).toBe(1);
    receipt.deployment.state = 'succeeded'; receipt.deployment.revision++;
    await arrive();
    expect(mutations).toBe(2);
    const store = createCredentialedAccountArtifactStore(credentials);
    const artifact = await runWithServerHttpBaseUrl(baseUrl, () => store.read([...rows.keys()][0]!, { includeSharedAudience: false }));
    expect(artifact && readOwnedNoticeArtifactV1(artifact, 'account-owner')).toMatchObject({ healthPhase: 'recovered' });
    await arrive();
    await arrive();
    expect(mutations, 'equal settled arrivals publish nothing and do not reopen Source content').toBe(2);
    receipt.deployment.state = 'failed'; receipt.deployment.revision++;
    advanceDuringNoticeRead = true;
    await arrive();
    expect(mutations, 'an admitted private notice may finish after the receipt revision changes').toBe(3);
    const lateArtifact = await runWithServerHttpBaseUrl(baseUrl,
      () => store.read([...rows.keys()][0]!, { includeSharedAudience: false }));
    expect(lateArtifact && readOwnedNoticeArtifactV1(lateArtifact, 'account-owner')).toMatchObject({ healthPhase: 'open' });
  });
});
