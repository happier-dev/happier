import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import axios, { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sealTerminalProvisioningV3TokenOnlyPayload } from '@happier-dev/protocol/crypto/terminalProvisioningV2';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_buffered_home', canonicalServerUrl: 'https://home.example.test', revision: 1,
  endpoints: [{ kind: 'https' as const, url: 'https://home.example.test' }] };
const homeTarget = { kind: 'descriptor' as const, descriptor, authority: 'trusted_enrollment' as const };
const managedEnrollment = { homeId: descriptor.homeServerIdentityId, managedId: 'managed-1', requestId: 'request-1', expectedIntentRevision: 1,
  controller: { machineId: 'controller', installationId: 'installation' },
  resource: { contributionRef: { pluginId: 'test.provisioner', localId: 'vm' }, schemaVersion: 1, value: { nativeId: 'retained-1' } } };

describe('buffered normal auth request/wait', () => {
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  afterEach(() => { env.restore(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

  it.each(['current', 'retired'] as const)('retains the admitted tuple privately and saves the Account bearer only for a %s normal registration', async (admission) => {
    await withTempDir('happier-buffered-auth-', async (homeDir) => {
      env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
      const outputs: string[] = [];
      // Process pipes and HTTP are genuine system boundaries. All auth,
      // profile, pending-state, crypto and registration logic remains real.
      const writePipe: typeof process.stdout.write = (chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        outputs.push(String(chunk));
        const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
        done?.();
        return true;
      };
      vi.spyOn(process.stdout, 'write').mockImplementation(writePipe);
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } }, homeConnectionDescriptor: descriptor }), { status: 200 })));
      let response = '';
      let registration: unknown;
      const httpResult = (data: unknown) => ({ data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
      vi.spyOn(axios, 'get').mockImplementation(async (url) => {
        if (String(url).endsWith('/v1/auth/request/status')) return httpResult({ status: 'authorized' });
        if (String(url).includes('/encryption')) return httpResult({ mode: 'plain', updatedAt: 0 });
        throw new AxiosError('not found', 'ERR_BAD_REQUEST', undefined, undefined, { ...httpResult({}), status: 404 });
      });
      vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        if (String(url).endsWith('/claim')) return httpResult({ state: 'authorized', serverIdentityId: descriptor.homeServerIdentityId,
          token: 'full-account-bearer', response });
        if (String(url).endsWith('/v1/machines')) {
          registration = body;
          if (admission === 'current') {
            if (!body || typeof body !== 'object') throw new Error('Missing normal registration input');
            const input = body as Record<string, unknown>;
            return httpResult({ machine: { id: input.id, metadata: input.metadata, dataEncryptionKey: input.dataEncryptionKey,
              metadataVersion: 0, daemonState: null, daemonStateVersion: 0, storageMode: 'plain' } });
          }
          throw new AxiosError('retired managed row', 'ERR_BAD_REQUEST', undefined, undefined,
            { ...httpResult({ error: 'invalid-params', reason: 'managed_intent_changed' }), status: 409 });
        }
        return httpResult({});
      });
      const { handleAuthRequest } = await import('./request');
      const { handleAuthWait } = await import('./wait');
      await handleAuthRequest(['--json', '--remote-enrollment', '--home-target-stdin', '--managed-enrollment-stdin'], undefined,
        Readable.from([JSON.stringify({ homeTarget, managedEnrollment })]));
      const request = JSON.parse(outputs[0]!) as { publicKey: string; remoteProfileId: string; pairing: { secretB64Url: string; createdAtMs: number; expiresAtMs: number } };
      expect(JSON.parse(outputs[0]!)).toMatchObject({ kind: 'remote_home_enrollment_pairing_request', homeServerIdentityId: descriptor.homeServerIdentityId });
      const pending = (await readdir(homeDir, { recursive: true })).find((path) => /auth[\\/]pending[\\/].*\.json$/u.test(path));
      expect(pending).toBeDefined();
      expect(JSON.parse(await readFile(join(homeDir, pending!), 'utf8'))).toMatchObject({ managedEnrollment, serverIdentityId: descriptor.homeServerIdentityId });
      expect(outputs[0]).not.toContain('claimSecret');
      expect(outputs[0]).not.toContain(managedEnrollment.managedId);
      response = Buffer.from(sealTerminalProvisioningV3TokenOnlyPayload({
        terminalEphemeralPublicKey: Buffer.from(request.publicKey, 'base64'),
        pairingSecret: Buffer.from(request.pairing.secretB64Url, 'base64url'),
        createdAtMs: request.pairing.createdAtMs, expiresAtMs: request.pairing.expiresAtMs,
        randomBytes: (length) => new Uint8Array(randomBytes(length)),
      })).toString('base64');
      // A second guest process does not inherit the first process's ephemeral
      // Home selection. Only the non-secret returned profile identifies its
      // incumbent profile-scoped pending state.
      env.patch({ HAPPIER_SERVER_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined, HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
      (await import('@/configuration')).reloadConfiguration();
      const wait = handleAuthWait(['--json', '--remote-enrollment', '--server', request.remoteProfileId, '--no-persist', '--public-key', request.publicKey]);
      if (admission === 'current') {
        await wait;
        expect(JSON.parse(outputs.at(-1)!)).toMatchObject({ kind: 'remote_home_enrollment_result', homeServerIdentityId: descriptor.homeServerIdentityId,
          encryptionType: 'tokenOnly', remoteProfileId: request.remoteProfileId, machineId: expect.any(String) });
      } else {
        await expect(wait).rejects.toThrow('retired managed row');
      }
      expect(registration).toMatchObject({ managedEnrollment });
      expect((await readdir(homeDir, { recursive: true })).some((path) => /(?:^|[\\/])access\.key$/u.test(path))).toBe(admission === 'current');
      expect(outputs.join('')).not.toContain('full-account-bearer');
    });
  });
});
