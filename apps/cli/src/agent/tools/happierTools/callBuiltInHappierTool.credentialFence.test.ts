import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ACCOUNT_SECURITY_PATH_V1, AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';

import type { StoredCredentials } from '@/persistence';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { callBuiltInHappierTool } from './callBuiltInHappierTool';

function storedSessionCredentials(token: string): StoredCredentials {
  return {
    token,
    encryption: null,
    credentialProvenance: 'stored_session',
  };
}

describe('callBuiltInHappierTool one-shot CLI credential fence', () => {
  const sessionId = 'c123456789012345678901234';
  let app: FastifyInstance;
  let restoreAdapter: (() => void) | undefined;
  let settingsObserved = false;
  const requests: { method: string; path: string; authorization: string | undefined }[] = [];

  beforeEach(async () => {
    resetActiveAccountSettingsSnapshotForTests();
    requests.length = 0;
    settingsObserved = false;
    app = fastify({ logger: false });
    app.addHook('onRequest', async (request) => {
      requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
    });
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture());
    const session = createSessionRecordFixture({
      id: sessionId, encryptionMode: 'plain', metadata: JSON.stringify({ t: 'plain', v: {} }), machineId: 'machine-1',
    });
    app.get('/v1/sessions/:id', async () => ({ session }));
    app.get('/v2/sessions/:id', async () => ({ session }));
    app.get(ACCOUNT_SECURITY_PATH_V1, async () => AccountSecurityGetResponseV1Schema.parse({
      v: 1, encryptionMode: 'plain', terminalPresentUserPolicy: 'allowed', nativeEmail: null,
      password: { status: 'not_enrolled', revision: null },
    }));
    app.get('/v2/account/settings', async () => {
      settingsObserved = true;
      return AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 1 });
    });
    await app.ready();
    restoreAdapter = installAxiosFastifyAdapter({ app, origin: new URL(resolveServerHttpBaseUrl()).origin });
  });

  afterEach(async () => {
    restoreAdapter?.();
    restoreAdapter = undefined;
    await app.close();
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('settles an already-rotated credential before any session or Action transport', async () => {
    const initial = storedSessionCredentials('hap_v1_initial');
    const rotated = storedSessionCredentials('hap_v1_rotated');
    await expect(callBuiltInHappierTool({
      credentials: initial,
      sessionId,
      toolName: 'action_execute',
      args: {
        actionId: 'session.access.grant.set',
        input: {
          sessionId,
          principal: { kind: 'account', accountId: 'recipient-1' },
          level: 'edit',
        },
      },
      surface: 'cli',
      readCredentials: async () => rotated,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'not_authenticated',
      error: 'not_authenticated',
    });

    expect(requests).toEqual([]);
  }, 120_000);

  it('uses the canonical executor currentness fence when credentials rotate after session resolution', async () => {
    const initial = storedSessionCredentials('hap_v1_initial');
    const rotated = storedSessionCredentials('hap_v1_rotated');
    // Rotation is observed at the HTTP boundary after Session resolution; the
    // canonical settings bootstrap and credential fence both remain real.
    const readCredentials = async () => settingsObserved ? rotated : initial;

    await expect(callBuiltInHappierTool({
      credentials: initial,
      sessionId,
      toolName: 'action_execute',
      args: {
        actionId: 'session.access.grant.set',
        input: {
          sessionId,
          principal: { kind: 'account', accountId: 'recipient-1' },
          level: 'edit',
        },
      },
      surface: 'cli',
      readCredentials,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'not_authenticated',
      error: 'not_authenticated',
    });

    expect(settingsObserved).toBe(true);
    expect(requests.map(({ path }) => path)).toEqual(expect.arrayContaining([
      '/v1/account/encryption/currentness', '/v2/account/settings',
    ]));
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
    expect(requests.every(({ authorization }) => authorization === 'Bearer hap_v1_initial')).toBe(true);
  }, 120_000);

});
