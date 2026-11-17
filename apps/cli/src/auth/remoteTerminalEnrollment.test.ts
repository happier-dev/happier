import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import axios, { AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { sealTerminalProvisioningV3Payload, sealTerminalProvisioningV3TokenOnlyPayload } from '@happier-dev/protocol/crypto/terminalProvisioningV2';
import { decodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import tweetnacl from 'tweetnacl';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
// Collect the real CLI graph before individual test lifetimes; reload its
// environment-bound configuration per case after setting the isolated Home.
import './remoteTerminalEnrollment';

const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_managed_home', canonicalServerUrl: 'https://home.example.test', revision: 1, endpoints: [{ kind: 'https' as const, url: 'https://home.example.test' }] };
const target = resolveHomeTargetFromDescriptor({ descriptor, authority: 'trusted_enrollment' });
const correlation = { homeId: descriptor.homeServerIdentityId, managedId: 'managed-1', requestId: 'request-1', expectedIntentRevision: 1, controller: { machineId: 'controller', installationId: 'installation' }, resource: { contributionRef: { pluginId: 'test.provisioner', localId: 'vm' }, schemaVersion: 1, value: { nativeId: 'retained-1' } } };
const deploymentAppCorrelation = { source: 'deploymentApp' as const, homeId: descriptor.homeServerIdentityId,
  environmentId: 'environment-collector', deploymentId: 'deployment-collector', actionOperationId: 'operation-collector',
  controller: { machineId: 'controller', installationId: 'installation' } };
const deploymentAppBinding = { serviceName: 'private-collector-service', port: 4318 };

describe('managed remote terminal enrollment', () => {
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_API_TOKEN']);
  afterEach(() => { env.restore(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

  it.each([{ source: 'managed', enrollment: correlation }, { source: 'deploymentApp', enrollment: deploymentAppCorrelation }])('rejects a different admitted Home before any $source authentication request', async ({ enrollment }) => {
    const fetchBoundary = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchBoundary);
    const post = vi.spyOn(axios, 'post');
    const { runRemoteTerminalEnrollment } = await import('./remoteTerminalEnrollment');
    await expect(runRemoteTerminalEnrollment({ target, managedEnrollment: { ...enrollment, homeId: 'srv_other_home' }, timeoutMs: 5_000, onPairingRequest: () => undefined })).rejects.toMatchObject({ code: 'AUTH_ENROLL_REMOTE_IDENTITY_MISMATCH' });
    expect(fetchBoundary).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('identifies cancellation at the terminal-auth owner before starting any request', async () => {
    const controller = new AbortController();
    controller.abort();
    const { runRemoteTerminalEnrollment } = await import('./remoteTerminalEnrollment');
    await expect(runRemoteTerminalEnrollment({ target, signal: controller.signal, timeoutMs: 5_000,
      onPairingRequest: () => undefined })).rejects.toMatchObject({ code: 'AUTH_ENROLL_REMOTE_CANCELLED' });
  });

  it.each([
    { mode: 'plain', refused: false, postClaimDescriptor: true, enrollment: correlation }, { mode: 'e2ee', refused: false, postClaimDescriptor: true, enrollment: correlation },
    { mode: 'plain', refused: true, postClaimDescriptor: true, enrollment: correlation }, { mode: 'e2ee', refused: true, postClaimDescriptor: true, enrollment: correlation },
    { mode: 'plain', refused: false, postClaimDescriptor: false, enrollment: correlation },
    { mode: 'plain', refused: false, postClaimDescriptor: true, enrollment: deploymentAppCorrelation },
    { mode: 'e2ee', refused: false, postClaimDescriptor: true, enrollment: deploymentAppCorrelation },
  ] as const)('persists only the requester $mode credential after managed registration (refused=$refused, post-claim descriptor=$postClaimDescriptor)', async ({ mode, refused, postClaimDescriptor, enrollment }) => {
    await withTempDir('happier-requester-enrollment-', async homeDir => {
      env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: descriptor.canonicalServerUrl, HAPPIER_API_TOKEN: undefined });
      vi.resetModules();
      const { default: transport } = await import('axios');
      const { configuration } = await import('@/configuration');
      const persistence = await import('@/persistence');
      const { readAccountIdFromToken } = await import('@/cloud/decodeJwtPayload');
      const fixtureToken = (sub: string) => `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
      const requesterToken = fixtureToken('requester-account');
      const custodianToken = fixtureToken('custodian-account');
      const approvedToken = refused ? custodianToken : requesterToken;
      const requesterKey = new Uint8Array(randomBytes(32));
      const custodianKey = new Uint8Array(randomBytes(32));
      const issuedKey = refused ? custodianKey : requesterKey;
      let response = '';
      let registrationAttempts = 0;
      let registeredRow: Record<string, unknown> | undefined;
      const expiresAt = Date.now() + 240_000;
      const httpResult = (data: unknown) => ({ data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
      const credentialFiles = async () => (await readdir(homeDir, { recursive: true })).filter(path => /(?:^|[\\/])access\.key$/u.test(path));
      // Only Home HTTP is substituted. V3 pairing, Machine registration/proof,
      // Account mode, encrypted Machine content and credential-file IO stay real.
      vi.spyOn(transport, 'get').mockImplementation(async url => {
        const path = String(url);
        if (path.endsWith('/v1/account/encryption')) return httpResult({ mode, updatedAt: 1 });
        if (path.includes('/v1/machines/') && registeredRow) return httpResult({ machine: registeredRow });
        if (path.includes('/v1/machines/')) throw new transport.AxiosError('Absent Machine', 'ERR_BAD_REQUEST', undefined, undefined, {
          status: 404, statusText: 'Not Found', data: {}, headers: {}, config: { headers: new AxiosHeaders() },
        });
        return httpResult({ status: 'authorized' });
      });
      vi.spyOn(transport, 'post').mockImplementation(async (url, body: unknown, options) => {
        const path = String(url);
        if (path.endsWith('/claim')) return httpResult({ state: 'authorized', serverIdentityId: descriptor.homeServerIdentityId,
          token: approvedToken, response });
        if (!path.endsWith('/v1/machines')) return httpResult({ state: 'requested', expiresAt });
        registrationAttempts++;
        expect(await credentialFiles()).toEqual([]);
        expect(options?.headers?.Authorization).toBe(`Bearer ${approvedToken}`);
        if (!body || typeof body !== 'object') throw new Error('Expected registration body');
        const input = body as Record<string, unknown>;
        expect(input.managedEnrollment).toEqual(enrollment);
        expect(input).not.toHaveProperty('deploymentAppBinding');
        expect(input).not.toHaveProperty('serviceName');
        expect(input).not.toHaveProperty('port');
        expect(JSON.stringify(input.managedEnrollment)).not.toContain(deploymentAppBinding.serviceName);
        if (mode === 'plain') expect(input.contentPublicKey).toBeUndefined();
        else expect(input.contentPublicKey).toBe(Buffer.from(tweetnacl.box.keyPair.fromSecretKey(issuedKey).publicKey).toString('base64'));
        if (refused) throw new transport.AxiosError('Wrong enrollment Account', 'ERR_BAD_REQUEST', undefined, undefined, {
          status: 409, statusText: 'Conflict', data: { error: 'invalid-params', reason: 'resource_mismatch' }, headers: {},
          config: { headers: new AxiosHeaders() },
        });
        if (typeof input.metadata !== 'string') throw new Error('Expected published Machine metadata');
        if (mode === 'plain') expect(decodePlainMachineStoredContent(input.metadata)).toMatchObject({ displayName: 'Managed design box' });
        else {
          expect(input.metadata).not.toContain('Managed design box');
          expect(JSON.stringify(input)).not.toContain(deploymentAppBinding.serviceName);
        }
        registeredRow = { ...input, metadataVersion: 0, daemonState: null, daemonStateVersion: 0, storageMode: mode };
        return httpResult({ machine: registeredRow });
      });
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => new Response(JSON.stringify({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } },
        ...(postClaimDescriptor && String(url).endsWith('/v1/features/authenticated') ? { homeConnectionDescriptor: descriptor } : {}),
      }), { status: 200 })));
      const { runRemoteTerminalEnrollment } = await import('./remoteTerminalEnrollment');
      const enrollmentInput = { target, managedEnrollment: enrollment, timeoutMs: 5_000,
        machineDisplayName: 'Managed design box',
        ...('source' in enrollment ? { deploymentAppBinding } : {}),
        onPairingRequest(request: Parameters<Parameters<typeof runRemoteTerminalEnrollment>[0]['onPairingRequest']>[0]) {
          const context = { terminalEphemeralPublicKey: Buffer.from(request.publicKey, 'base64'),
            pairingSecret: Buffer.from(request.pairing.secretB64Url, 'base64url'), createdAtMs: request.pairing.createdAtMs,
            expiresAtMs: request.pairing.expiresAtMs, randomBytes: (length: number) => new Uint8Array(randomBytes(length)) };
          response = Buffer.from(mode === 'plain' ? sealTerminalProvisioningV3TokenOnlyPayload(context)
            : sealTerminalProvisioningV3Payload({ ...context, contentPrivateKey: issuedKey })).toString('base64');
        },
      };
      const completion = runRemoteTerminalEnrollment(enrollmentInput);
      if (!postClaimDescriptor) {
        await expect(completion).rejects.toMatchObject({ code: 'HOME_AUTHORITY_MISMATCH', authorityReason: 'descriptor' });
        // This non-retryable authority refusal settles after the first authenticated
        // observation; it must never re-poll or register/persist the credential.
        expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/v1/features/authenticated'))).toHaveLength(1);
        expect(await credentialFiles()).toEqual([]);
        expect(await persistence.readStoredCredentialsForServerId(configuration.activeServerId)).toBeNull();
      } else if (refused) {
        await expect(completion).rejects.toMatchObject({ response: { status: 409, data: { reason: 'resource_mismatch' } } });
        expect(await credentialFiles()).toEqual([]);
        expect(await persistence.readStoredCredentialsForServerId(configuration.activeServerId)).toBeNull();
      } else {
        expect(await completion).toMatchObject({ success: true, encryptionType: mode === 'plain' ? 'tokenOnly' : 'dataKey' });
        const credentials = await persistence.readStoredCredentialsForServerId(configuration.activeServerId);
        expect(credentials?.token).toBe(requesterToken);
        expect(readAccountIdFromToken(credentials!.token)).toBe('requester-account');
        expect(await credentialFiles()).toHaveLength(1);
        if ('source' in enrollment) {
          const { ApiClient } = await import('@/api/api');
          const api = await ApiClient.create(credentials!);
          expect((await api.getMachine(String(registeredRow!.id)))?.metadata?.deploymentApp).toEqual(deploymentAppBinding);
        }
        const raw = await readFile(configuration.privateKeyFile, 'utf8');
        expect(raw).not.toContain(custodianToken);
        expect(raw).not.toContain(Buffer.from(custodianKey).toString('base64'));
        if (mode === 'plain') expect(credentials?.encryption).toBeNull();
        else expect(credentials?.encryption).toEqual({ type: 'dataKey', machineKey: requesterKey,
          publicKey: tweetnacl.box.keyPair.fromSecretKey(requesterKey).publicKey });
      }
      expect(registrationAttempts).toBe(postClaimDescriptor ? 1 : 0);
    });
  });

  it('recovers a post-claim feature 503 within the relay lifetime, then preserves cancellation before bearer persistence', async () => {
    await withTempDir('happier-managed-enrollment-cancel-', async (homeDir) => {
      env.patch({ HAPPIER_HOME_DIR: homeDir });
      const controller = new AbortController();
      let response = '';
      const expiresAt = Date.now() + 240_000;
      let observedExpiry: number | undefined;
      let authenticatedObservations = 0;
      let claims = 0;
      // HTTP is the only mocked boundary: pairing, crypto, Home verification and credential IO stay real.
      const httpResult = (data: unknown) => ({ data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
      vi.spyOn(axios, 'post').mockImplementation(async (url) => {
        if (String(url).endsWith('/claim')) {
          claims++;
          return httpResult({ state: 'authorized', serverIdentityId: descriptor.homeServerIdentityId, token: 'full-account-bearer', response });
        }
        return httpResult({ state: 'requested', expiresAt });
      });
      vi.spyOn(axios, 'get').mockResolvedValue(httpResult({ status: 'authorized' }));
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith('/authenticated')) {
          authenticatedObservations++;
          if (authenticatedObservations === 1) return new Response('{}', { status: 503 });
          controller.abort();
        }
        return new Response(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } }, homeConnectionDescriptor: descriptor }), { status: 200 });
      }));
      const { runRemoteTerminalEnrollment } = await import('./remoteTerminalEnrollment');
      await expect(runRemoteTerminalEnrollment({ target, managedEnrollment: correlation, timeoutMs: 5_000, signal: controller.signal,
        onPairingRequest: (request) => {
          observedExpiry = request.pairing.expiresAtMs;
          response = Buffer.from(sealTerminalProvisioningV3TokenOnlyPayload({
            terminalEphemeralPublicKey: Buffer.from(request.publicKey, 'base64'),
            pairingSecret: Buffer.from(request.pairing.secretB64Url, 'base64url'),
            createdAtMs: request.pairing.createdAtMs, expiresAtMs: request.pairing.expiresAtMs,
            randomBytes: (length) => new Uint8Array(randomBytes(length)),
          })).toString('base64');
        },
      })).rejects.toThrow(/cancel|abort/i);
      expect(observedExpiry).toBe(expiresAt);
      expect(authenticatedObservations).toBe(2);
      expect(claims).toBe(1);
      expect((await readdir(homeDir, { recursive: true })).some((path) => /(?:^|[\\/])access\.key$/u.test(path))).toBe(false);
    });
  });
});
