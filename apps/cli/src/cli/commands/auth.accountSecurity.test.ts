import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  AccountSettingsSchema,
  createPasswordCredentialMutationDigestV1,
  createPasswordCredentialTargetDigestV1,
  type E2eeAccountPasswordCredentialV1,
  type PlainAccountPasswordCredentialV1,
} from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

const externalAuthBoundary = vi.hoisted(() => ({
  capture: vi.fn(),
  openBrowser: vi.fn(),
}));

vi.mock('@/cloud/loopbackOauthPkce', () => ({
  captureLoopbackOauthRedirect: externalAuthBoundary.capture,
}));
vi.mock('@/ui/openBrowser', () => ({ openBrowser: externalAuthBoundary.openBrowser }));

// Ink/Yoga is a terminal-rendering system boundary unrelated to these
// non-interactive JSON commands. The full CLI Action dependency graph retains
// the real Account Security logic beneath this renderer boundary.
vi.mock('ink', () => ({ render: vi.fn() }));

function plainCredentialFixture(): PlainAccountPasswordCredentialV1 {
  return {
    v: 1,
    kind: 'plain_password_hash',
    hash: {
      v: 1,
      algorithm: 'scrypt',
      parameters: { n: 16384, r: 8, p: 5, keyLength: 32 },
      salt: 'AwMDAwMDAwMDAwMDAwMDAw',
      digest: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
    },
  };
}

function plainEnrollmentRequestDigest(targetCredential: PlainAccountPasswordCredentialV1): string {
  return createPasswordCredentialMutationDigestV1({
    v: 1,
    action: 'connect',
    accountId: 'account-1',
    expectedCredentialRevision: null,
    normalizedNativeEmail: 'person@example.test',
    newCredentialDigest: createPasswordCredentialTargetDigestV1(targetCredential),
  });
}

function registerPlainEnrollmentExternalAuth(
  app: FastifyInstance,
  targetCredential: PlainAccountPasswordCredentialV1,
  onPreparation?: (body: unknown) => void,
): void {
  app.get('/v1/account/security', async () => ({
    v: 1,
    terminalPresentUserPolicy: 'allowed',
    encryptionMode: 'plain',
    nativeEmail: null,
    password: { status: 'not_enrolled', revision: null },
  }));
  app.get('/v1/account/profile', async () => ({
    id: 'account-1',
    linkedProviders: [{
      id: 'github',
      login: 'person',
      displayName: 'Person',
      avatarUrl: null,
      profileUrl: null,
      showOnProfile: false,
    }],
  }));
  app.post('/v1/auth/entry', async (request) => {
    expect(request.headers.authorization).toBe('Bearer interactive');
    expect(request.body).toEqual({ v: 1, scope: { kind: 'home' } });
    return {
      v: 1,
      state: 'ready',
      scope: { kind: 'home' },
      autoRedirect: null,
      actions: [{
        kind: 'authenticate',
        methodId: 'github',
        action: 'login',
        mode: 'keyless',
        origin: 'home',
        presentation: { displayName: 'GitHub' },
      }],
    };
  });
  app.post('/v1/auth/password/mutation/challenge', async (request) => {
    onPreparation?.(request.body);
    return { targetCredential };
  });
}

describe('trusted interactive CLI Account Security vertical', () => {
  const env = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_TOKEN',
    'HAPPIER_ACCOUNT_SETTINGS_MODE',
    'HAPPIER_ACTIONS_SETTINGS_V1',
  ]);
  let home = '';
  beforeEach(async () => {
    home = await createTempDir('happier-account-security-');
    env.patch({
      HAPPIER_HOME_DIR: home,
      HAPPIER_SERVER_URL: 'http://account.test',
      HAPPIER_PUBLIC_SERVER_URL: 'http://account.test',
      HAPPIER_LOCAL_SERVER_URL: undefined,
      HAPPIER_WEBAPP_URL: 'http://account.test',
      HAPPIER_TOKEN: undefined,
      HAPPIER_ACCOUNT_SETTINGS_MODE: 'never',
      HAPPIER_ACTIONS_SETTINGS_V1: undefined,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      features: {},
      capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    externalAuthBoundary.openBrowser.mockReset();
    externalAuthBoundary.openBrowser.mockResolvedValue(true);
    externalAuthBoundary.capture.mockReset();
    externalAuthBoundary.capture.mockImplementation(async (options: {
      resolveAuthorizationUrl(callbackOrigin: string): Promise<string>;
      openAuthorizationUrl(url: string): Promise<void>;
    }) => {
      const url = await options.resolveAuthorizationUrl('http://127.0.0.1:32109');
      await options.openAuthorizationUrl(url);
      return { flow: 'auth', mode: 'keyless', purpose: 'account_password_enrollment', pending: 'pending-1' };
    });
    vi.resetModules();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    env.restore();
    process.exitCode = 0;
    await removeTempDir(home);
  });

  it('reads Account security through the shared present_user Action without exposing credential material', async () => {
    const app = fastify();
    app.get('/v1/account/security', async (request) => {
      expect(request.headers.authorization).toBe('Bearer interactive');
      return { v: 1, terminalPresentUserPolicy: 'allowed', encryptionMode: 'plain', nativeEmail: 'ada@example.test', password: { status: 'enrolled', revision: 3 } };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'interactive' });
      const { handleAuthSecurityGet } = await import('./auth/accountSecurity');
      await handleAuthSecurityGet(['get', '--json']);
      const envelope = JSON.parse(output.text());
      expect(envelope.ok).toBe(true);
      expect(envelope.data.nativeEmail).toBe('ada@example.test');
      expect(JSON.stringify(envelope)).not.toContain('hash');
      expect(JSON.stringify(envelope)).not.toContain('envelope');
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });

  it('reads and changes CLI approval policy through the security owners', async () => {
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('CLI command exited before policy operation'); });
    const app = fastify();
    let policy = 'allowed';
    app.get('/v1/account/security', async () => ({
      v: 1, encryptionMode: 'plain', nativeEmail: null,
      password: { status: 'not_enrolled', revision: null }, terminalPresentUserPolicy: policy,
    }));
    app.post('/v1/account/security/terminal-present-user', async (request) => {
      expect(request.headers.authorization).toBe('Bearer interactive');
      expect(request.body).toEqual({ policy: 'disallowed' });
      policy = 'disallowed';
      return { policy };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'interactive' });
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand(['cli-approvals', 'get', '--json']);
      expect(JSON.parse(output.text()).error).toBeUndefined();
      expect(JSON.parse(output.text())).toMatchObject({ ok: true, data: { policy: 'allowed' } });
      output.lines.length = 0;
      await handleAuthCommand(['cli-approvals', 'set', 'disallowed', '--yes', '--json']);
      expect(JSON.parse(output.text())).toMatchObject({ ok: true, data: { policy: 'disallowed' } });
      expect(policy).toBe('disallowed');
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });

  it('refuses invalid, unconfirmed and API-token CLI approval-policy mutations before HTTP writes', async () => {
    const app = fastify();
    let writes = 0;
    app.post('/v1/account/security/terminal-present-user', async () => {
      writes += 1;
      return { policy: 'allowed' };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'interactive' });
      const { handleAuthCliApprovals } = await import('./auth/accountSecurity');
      await handleAuthCliApprovals(['set', 'invalid', '--yes', '--json']);
      expect(JSON.parse(output.text())).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
      output.lines.length = 0;
      await handleAuthCliApprovals(['set', 'allowed', '--json']);
      expect(JSON.parse(output.text())).toMatchObject({ ok: false, error: { code: 'confirmation_declined' } });
      env.patch({ HAPPIER_TOKEN: `hap_v1_12345678-1234-4234-8234-123456789abc_${'A'.repeat(43)}` });
      output.lines.length = 0;
      await handleAuthCliApprovals(['set', 'allowed', '--yes', '--json']);
      expect(JSON.parse(output.text())).toMatchObject({ ok: false, error: { code: 'present_user_required' } });
      expect(writes).toBe(0);
    } finally { output.restore(); restore(); await app.close(); }
  });

  it('reads the safe Account security projection with an authenticated API token', async () => {
    const app = fastify();
    const tokenId = '12345678-1234-4234-8234-123456789abc';
    const apiToken = `hap_v1_${tokenId}_${'A'.repeat(43)}`;
    app.get('/v1/account/security', async (request) => {
      expect(request.headers.authorization).toBe(`Bearer ${apiToken}`);
      return {
        v: 1,
        terminalPresentUserPolicy: 'allowed',
        encryptionMode: 'plain',
        nativeEmail: 'automation@example.test',
        password: { status: 'enrolled', revision: 2 },
      };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      env.patch({ HAPPIER_TOKEN: apiToken });
      const { handleAuthSecurityGet } = await import('./auth/accountSecurity');
      await handleAuthSecurityGet(['get', '--json']);
      expect(JSON.parse(output.text())).toMatchObject({
        ok: true,
        data: { encryptionMode: 'plain', nativeEmail: 'automation@example.test' },
      });
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });

  it.each([404, 405, 501])(
    'reports Account security as unsupported for an API token when an old Home answers HTTP %s',
    async (status) => {
      const app = fastify();
      const tokenId = '12345678-1234-4234-8234-123456789abc';
      const apiToken = `hap_v1_${tokenId}_${'A'.repeat(43)}`;
      app.get('/v1/account/security', async (_request, reply) => reply.code(status).send({
        statusCode: status,
        error: 'Not Found',
        message: 'Account Security is unavailable on this Home.',
      }));
      const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
      const output = captureConsoleText();
      try {
        env.patch({ HAPPIER_TOKEN: apiToken });
        const { handleAuthSecurityGet } = await import('./auth/accountSecurity');
        await handleAuthSecurityGet(['get', '--json']);
        expect(JSON.parse(output.text())).toMatchObject({
          ok: false,
          error: { code: 'unsupported' },
        });
      } finally {
        output.restore();
        restore();
        await app.close();
      }
    },
  );

  it('refuses Account security mutations for API-token callers with present_user_required and no effects', async () => {
    const app = fastify();
    let hits = 0;
    app.post('/v1/account/password/change', async () => {
      hits += 1;
      return { v: 1, status: 'updated' };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'interactive' });
      const tokenId = '12345678-1234-4234-8234-123456789abc';
      env.patch({ HAPPIER_TOKEN: `hap_v1_${tokenId}_${'A'.repeat(43)}` });
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand([
        'password',
        'change',
        '--current-password',
        'fifteen characters here',
        '--new-password',
        'sixteen characters here!',
        '--yes',
        '--json',
      ]);
      const envelope = JSON.parse(output.text());
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe('present_user_required');
      expect(hits).toBe(0);
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });

  it('requests first-enrollment mailbox verification from the exact selected Home with present_user', async () => {
    const app = fastify();
    app.post('/v1/account/password/enroll/email/request', async (request) => {
      expect(request.headers.authorization).toBe('Bearer interactive');
      expect(request.body).toEqual({ v: 1, email: 'Person@Example.Test' });
      return { v: 1, status: 'verification_sent' };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'interactive' });
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand([
        'password', 'enroll-email-request', '--email', 'Person@Example.Test', '--json',
      ]);
      expect(JSON.parse(output.text())).toMatchObject({
        ok: true,
        kind: 'auth_password_enroll_email_request',
        data: { status: 'verification_sent' },
      });
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });

  it('carries mailbox verification into Plain enrollment and preserves external reauthentication', async () => {
    const app = fastify();
    const verificationToken = 'V'.repeat(43);
    const targetCredential: PlainAccountPasswordCredentialV1 = {
      v: 1,
      kind: 'plain_password_hash',
      hash: {
        v: 1,
        algorithm: 'scrypt',
        parameters: { n: 16384, r: 8, p: 5, keyLength: 32 },
        salt: 'AwMDAwMDAwMDAwMDAwMDAw',
        digest: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
      },
    };
    const requestDigest = plainEnrollmentRequestDigest(targetCredential);
    let preparedBody: unknown;
    const proofQuery: Record<string, unknown> = {};
    let finalBody: unknown;
    registerPlainEnrollmentExternalAuth(app, targetCredential, (body) => { preparedBody = body; });
    app.get('/v1/auth/external/github/params', async (request) => {
      Object.assign(proofQuery, request.query);
      expect(request.headers.authorization).toBe('Bearer interactive');
      expect(request.headers.origin).toBe('http://127.0.0.1:32109');
      return { url: 'https://github.example/authorize' };
    });
    app.post('/v1/account/password/enroll', async (request) => {
      finalBody = request.body;
      return { v: 1, status: 'enrolled' };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'interactive' });
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand([
        'password', 'enroll', '--email', 'Person@Example.Test',
        '--password', 'new enrollment password', '--verification-token', verificationToken,
        '--yes', '--json',
      ]);
      expect(JSON.parse(output.text())).toMatchObject({ ok: true, data: { status: 'enrolled' } });
      expect(preparedBody).toEqual({
        v: 1,
        action: 'connect',
        expectedCredentialRevision: null,
        normalizedNativeEmail: 'person@example.test',
        newPlainPassword: 'new enrollment password',
      });
      expect(finalBody).toEqual({
        v: 1,
        kind: 'plain',
        email: 'person@example.test',
        targetCredential,
        verificationToken,
        reauthentication: {
          provider: 'github',
          pending: 'pending-1',
          proof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        },
      });
      expect(proofQuery).toMatchObject({
        mode: 'keyless',
        purpose: 'account_password_enrollment',
        requestDigest,
        proofHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const submittedProof = (finalBody as { reauthentication: { proof: string } }).reauthentication.proof;
      expect(proofQuery.proofHash).toBe(createHash('sha256').update(submittedProof, 'utf8').digest('hex'));
      expect(externalAuthBoundary.openBrowser).toHaveBeenCalledWith('https://github.example/authorize');
      expect(JSON.stringify(finalBody)).not.toContain('new enrollment password');
      expect(output.text()).not.toContain(verificationToken);
      expect(output.text()).not.toContain('new enrollment password');
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  }, 120_000);

  it('uses the Home Account mode rather than local credential shape for password enrollment', async () => {
    const app = fastify();
    let preparations = 0;
    app.get('/v1/account/security', async () => ({
      v: 1,
      terminalPresentUserPolicy: 'allowed',
      encryptionMode: 'e2ee',
      nativeEmail: null,
      password: { status: 'not_enrolled', revision: null },
    }));
    app.post('/v1/auth/password/mutation/challenge', async () => {
      preparations += 1;
      return { targetCredential: plainCredentialFixture() };
    });
    app.get('/v1/account/profile', async () => ({ id: 'account-one', linkedProviders: [] }));
    app.post('/v1/auth/entry', async () => ({
      v: 1,
      state: 'ready',
      scope: { kind: 'home' },
      autoRedirect: null,
      actions: [],
    }));
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'interactive' });
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand([
        'password', 'enroll', '--email', 'person@example.test',
        '--password', 'new enrollment password', '--yes', '--json',
      ]);
      expect(JSON.parse(output.text())).toMatchObject({
        ok: false,
        error: { code: 'recovery_secret_required' },
      });
      expect(preparations).toBe(0);
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });

  it.each(['change', 'remove'] as const)(
    'uses the Home Account mode rather than token-only local credentials for password %s',
    async (operation) => {
      const app = fastify();
      let preparations = 0;
      let mutations = 0;
      app.get('/v1/account/security', async () => ({
        v: 1,
        terminalPresentUserPolicy: 'allowed',
        encryptionMode: 'e2ee',
        nativeEmail: 'person@example.test',
        password: { status: 'enrolled', revision: 3 },
      }));
      app.post('/v1/auth/password/mutation/challenge', async () => {
        preparations += 1;
        return { error: 'invalid_request' };
      });
      app.post(`/v1/account/password/${operation}`, async () => {
        mutations += 1;
        return { v: 1, status: operation === 'change' ? 'updated' : 'removed' };
      });
      const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
      const output = captureConsoleText();
      try {
        const { writeCredentialsTokenOnly } = await import('@/persistence');
        await writeCredentialsTokenOnly({ token: 'interactive' });
        const { handleAuthCommand } = await import('./auth');
        await handleAuthCommand([
          'password', operation,
          ...(operation === 'change'
            ? ['--current-password', 'current password long', '--new-password', 'replacement password long']
            : ['--current-password', 'current password long']),
          '--yes', '--json',
        ]);
        expect(JSON.parse(output.text())).toMatchObject({
          ok: false,
          error: { code: 'recovery_secret_required' },
        });
        expect(preparations).toBe(0);
        expect(mutations).toBe(0);
      } finally {
        output.restore();
        restore();
        await app.close();
      }
    },
    300_000,
  );

  it('rejects a mismatched Plain enrollment callback before the final mutation', async () => {
    const app = fastify();
    let finalMutations = 0;
    const targetCredential: PlainAccountPasswordCredentialV1 = {
      v: 1,
      kind: 'plain_password_hash',
      hash: {
        v: 1,
        algorithm: 'scrypt',
        parameters: { n: 16384, r: 8, p: 5, keyLength: 32 },
        salt: 'AwMDAwMDAwMDAwMDAwMDAw',
        digest: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
      },
    };
    registerPlainEnrollmentExternalAuth(app, targetCredential);
    externalAuthBoundary.capture.mockResolvedValueOnce({
      flow: 'auth', mode: 'keyless', purpose: 'account_encryption_first_key', pending: 'pending-1',
    });
    app.get('/v1/auth/external/github/params', async () => ({ url: 'https://github.example/authorize' }));
    app.post('/v1/account/password/enroll', async () => {
      finalMutations += 1;
      return { v: 1, status: 'enrolled' };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'interactive' });
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand([
        'password', 'enroll', '--email', 'person@example.test',
        '--password', 'new enrollment password',
        '--yes', '--json',
      ]);
      expect(JSON.parse(output.text())).toMatchObject({
        ok: false,
        error: { code: 'reauthentication_required' },
      });
      expect(finalMutations).toBe(0);
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  }, 120_000);

  it('uses a linked mTLS login for the direct purpose-bound enrollment proof', async () => {
    const app = fastify();
    const targetCredential = plainCredentialFixture();
    const requestDigest = plainEnrollmentRequestDigest(targetCredential);
    let mtlsBody: unknown;
    let finalBody: unknown;
    app.get('/v1/account/security', async () => ({
      v: 1,
      terminalPresentUserPolicy: 'allowed',
      encryptionMode: 'plain',
      nativeEmail: null,
      password: { status: 'not_enrolled', revision: null },
    }));
    app.get('/v1/account/profile', async () => ({
      id: 'account-1',
      linkedProviders: [{
        id: 'mtls', login: 'person@example.test', displayName: 'Person', avatarUrl: null,
        profileUrl: null, showOnProfile: false,
      }],
    }));
    app.post('/v1/auth/entry', async () => ({
      v: 1, state: 'ready', scope: { kind: 'home' }, autoRedirect: null,
      actions: [{
        kind: 'authenticate', methodId: 'mtls', action: 'login', mode: 'keyless', origin: 'home',
        presentation: { displayName: 'Client certificate' },
      }],
    }));
    app.post('/v1/auth/password/mutation/challenge', async () => ({ targetCredential }));
    app.post('/v1/auth/mtls', async (request) => {
      mtlsBody = request.body;
      return { success: true, pending: 'mtls-pending-1' };
    });
    app.post('/v1/account/password/enroll', async (request) => {
      finalBody = request.body;
      return { v: 1, status: 'enrolled' };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'interactive' });
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand([
        'password', 'enroll', '--email', 'person@example.test',
        '--password', 'new enrollment password', '--yes', '--json',
      ]);
      expect(JSON.parse(output.text())).toMatchObject({ ok: true, data: { status: 'enrolled' } });
      expect(mtlsBody).toMatchObject({
        purpose: 'account_password_enrollment',
        requestDigest,
        proofHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(finalBody).toMatchObject({
        kind: 'plain', targetCredential,
        reauthentication: {
          provider: 'mtls', pending: 'mtls-pending-1', proof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        },
      });
      expect(externalAuthBoundary.capture).not.toHaveBeenCalled();
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  }, 120_000);

  it('cancels the in-process OAuth enrollment ceremony without a final mutation', async () => {
    const app = fastify();
    let finalMutations = 0;
    registerPlainEnrollmentExternalAuth(app, plainCredentialFixture());
    app.get('/v1/auth/external/github/params', async () => ({ url: 'https://github.example/authorize' }));
    app.post('/v1/account/password/enroll', async () => {
      finalMutations += 1;
      return { v: 1, status: 'enrolled' };
    });
    externalAuthBoundary.capture.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'interactive' });
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand([
        'password', 'enroll', '--email', 'person@example.test',
        '--password', 'new enrollment password', '--yes', '--json',
      ]);
      expect(JSON.parse(output.text())).toMatchObject({ ok: false, error: { code: 'cancelled' } });
      expect(finalMutations).toBe(0);
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  }, 120_000);

  it('changes a Plain password through the shared Action with canonical confirmation and secret-safe errors', async () => {
    const app = fastify();
    app.get('/v1/account/security', async () => ({
      v: 1,
      terminalPresentUserPolicy: 'allowed',
      encryptionMode: 'plain',
      nativeEmail: 'person@example.test',
      password: { status: 'enrolled', revision: 3 },
    }));
    app.post('/v1/account/password/change', async (request) => {
      expect(request.headers.authorization).toBe('Bearer interactive');
      const body = request.body as Record<string, unknown>;
      expect(body.kind).toBe('plain');
      expect(body.expectedCredentialRevision).toBe(3);
      // Secret material reaches the domain route as strict input, never into logs.
      expect(typeof body.currentPassword).toBe('string');
      expect(typeof body.newPassword).toBe('string');
      return { v: 1, status: 'updated' };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'interactive' });
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand([
        'password',
        'change',
        '--current-password',
        'fifteen characters here',
        '--new-password',
        'sixteen characters here!',
        '--yes',
        '--json',
      ]);
      const envelope = JSON.parse(output.text());
      expect(envelope.ok).toBe(true);
      expect(envelope.data.status).toBe('updated');
      expect(output.text()).not.toContain('fifteen characters here');
      expect(output.text()).not.toContain('sixteen characters here!');
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });

  it('preserves the exact password bytes materialized from stdin, including surrounding spaces', async () => {
    const app = fastify();
    const currentPassword = '  current password with spaces  ';
    const newPassword = '  replacement password with spaces  ';
    app.get('/v1/account/security', async () => ({
      v: 1,
      terminalPresentUserPolicy: 'allowed',
      encryptionMode: 'plain',
      nativeEmail: 'person@example.test',
      password: { status: 'enrolled', revision: 4 },
    }));
    app.post('/v1/account/password/change', async (request) => {
      expect(request.body).toMatchObject({
        v: 1,
        kind: 'plain',
        expectedCredentialRevision: 4,
        currentPassword,
        newPassword,
      });
      return { v: 1, status: 'updated' };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'interactive' });
      const { handleAuthCommand } = await import('./auth');
      const { expandAuthSecretsFromStdin } = await import('./auth/stdinSecrets');
      const expanded = await expandAuthSecretsFromStdin([
        'password', 'change', '--yes', '--json', '--secrets-json-stdin',
      ], Readable.from([JSON.stringify({
        v: 1,
        secrets: { currentPassword, newPassword },
      })]));
      await handleAuthCommand(expanded);
      expect(JSON.parse(output.text())).toMatchObject({ ok: true, data: { status: 'updated' } });
      expect(output.text()).not.toContain(currentPassword);
      expect(output.text()).not.toContain(newPassword);
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });

  it('does not let direct CLI confirmation waive an explicitly required Action approval', async () => {
    const app = fastify();
    let mutations = 0;
    app.get('/v1/account/security', async () => ({
      v: 1,
      terminalPresentUserPolicy: 'allowed',
      encryptionMode: 'plain',
      nativeEmail: 'person@example.test',
      password: { status: 'enrolled', revision: 1 },
    }));
    app.post('/v1/account/password/change', async () => {
      mutations += 1;
      return { v: 1, status: 'updated' };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    const settingsSnapshot = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
    try {
      const interactiveToken = 'interactive';
      const { resolveAccountSettingsScopeKeyForToken } = await import(
        '@/settings/accountSettings/accountSettingsScopeKey'
      );
      settingsSnapshot.setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: AccountSettingsSchema.parse({
          actionsSettingsV1: {
            v: 1,
            actions: { 'account.password.change': { approvalRequiredSurfaces: ['cli'] } },
          },
        }),
        settingsVersion: 1,
        loadedAtMs: Date.now(),
        settingsSecretsReadKeys: [],
        scopeKey: resolveAccountSettingsScopeKeyForToken(interactiveToken),
      });
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: interactiveToken });
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand([
        'password', 'change', '--current-password', 'current password long',
        '--new-password', 'replacement password long', '--yes', '--json',
      ], AbortSignal.timeout(250));
      expect(JSON.parse(output.text())).toMatchObject({ ok: false });
      expect(mutations).toBe(0);
    } finally {
      settingsSnapshot.resetActiveAccountSettingsSnapshotForTests();
      output.restore();
      restore();
      await app.close();
    }
  });

  it('changes an E2EE password through canonical preparation without rotating the recovery secret', async () => {
    env.patch({ HAPPIER_PUBLIC_SERVER_URL: 'https://public.account.test', HAPPIER_LOCAL_SERVER_URL: 'http://account.test' });
    const app = fastify();
    const secret = new Uint8Array(32).fill(17);
    let preparedEnvelope: unknown;
    app.get('/v1/account/security', async () => ({
      v: 1,
      terminalPresentUserPolicy: 'allowed',
      encryptionMode: 'e2ee',
      nativeEmail: 'person@example.test',
      password: { status: 'enrolled', revision: 4 },
    }));
    app.get('/v1/account/profile', async () => ({ id: 'account-1' }));
    app.post('/v1/auth/password/mutation/challenge', async (request) => {
      const body = request.body as {
        action: 'change'; expectedCredentialRevision: number; normalizedNativeEmail: string;
        newE2eePassword: { envelope: E2eeAccountPasswordCredentialV1['envelope'] };
      };
      preparedEnvelope = body.newE2eePassword.envelope;
      const targetCredential: E2eeAccountPasswordCredentialV1 = {
        v: 1,
        kind: 'e2ee_password_envelope',
        envelope: body.newE2eePassword.envelope,
        authVerifier: {
          v: 1,
          hash: {
            v: 1,
            algorithm: 'scrypt',
            parameters: { n: 16384, r: 8, p: 5, keyLength: 32 },
            salt: 'AwMDAwMDAwMDAwMDAwMDAw',
            digest: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
          },
        },
      };
      return {
        targetCredential,
        challenge: {
          v: 1,
          challengeId: 'challenge-change',
          nonce: 'nonce',
          issuedAt: '2026-09-08T00:00:00.000Z',
          expiresAt: '2026-09-08T00:05:00.000Z',
          audience: { origin: 'https://public.account.test', serverIdentityId: 'srv_home' },
          expectedAccountId: 'account-1',
          operationKind: 'password_credential_mutation_v1',
          operationDigest: createPasswordCredentialMutationDigestV1({
            v: 1,
            action: body.action,
            accountId: 'account-1',
            expectedCredentialRevision: body.expectedCredentialRevision,
            normalizedNativeEmail: body.normalizedNativeEmail,
            newCredentialDigest: createPasswordCredentialTargetDigestV1(targetCredential),
          }),
        },
      };
    });
    app.post('/v1/account/password/change', async (request) => {
      const body = request.body as Record<string, unknown>;
      expect(body).toMatchObject({ kind: 'e2ee', action: 'change', expectedCredentialRevision: 4 });
      expect((body.targetCredential as { envelope: unknown }).envelope).toEqual(preparedEnvelope);
      expect(JSON.stringify(body)).not.toContain('replacement password');
      return { v: 1, status: 'updated' };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsLegacy } = await import('@/persistence');
      await writeCredentialsLegacy({ token: 'interactive', secret });
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand([
        'password', 'change', '--new-password', 'replacement password long', '--yes', '--json',
      ]);
      const envelope = JSON.parse(output.text());
      expect(envelope).toMatchObject({ ok: true, data: { status: 'updated' } });
      expect(output.text()).not.toContain('replacement password long');
    } finally {
      secret.fill(0);
      output.restore();
      restore();
      await app.close();
    }
  }, 240_000);

  it('enrolls an E2EE password through the canonical connect preparation and Action input', async () => {
    const app = fastify();
    const secret = new Uint8Array(32).fill(23);
    let preparedEnvelope: unknown;
    app.get('/v1/account/security', async () => ({
      v: 1,
      terminalPresentUserPolicy: 'allowed',
      encryptionMode: 'e2ee',
      nativeEmail: null,
      password: { status: 'not_enrolled', revision: null },
    }));
    app.get('/v1/account/profile', async () => ({ id: 'account-1' }));
    app.post('/v1/auth/password/mutation/challenge', async (request) => {
      const body = request.body as {
        action: 'connect'; normalizedNativeEmail: string;
        newE2eePassword: { envelope: E2eeAccountPasswordCredentialV1['envelope'] };
      };
      expect(body.action).toBe('connect');
      expect(body.normalizedNativeEmail).toBe('person@example.test');
      preparedEnvelope = body.newE2eePassword.envelope;
      const targetCredential: E2eeAccountPasswordCredentialV1 = {
        v: 1,
        kind: 'e2ee_password_envelope',
        envelope: body.newE2eePassword.envelope,
        authVerifier: {
          v: 1,
          hash: {
            v: 1,
            algorithm: 'scrypt',
            parameters: { n: 16384, r: 8, p: 5, keyLength: 32 },
            salt: 'AwMDAwMDAwMDAwMDAwMDAw',
            digest: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
          },
        },
      };
      return {
        targetCredential,
        challenge: {
          v: 1,
          challengeId: 'challenge-connect',
          nonce: 'nonce',
          issuedAt: '2026-09-08T00:00:00.000Z',
          expiresAt: '2026-09-08T00:05:00.000Z',
          audience: { origin: 'http://account.test', serverIdentityId: 'srv_home' },
          expectedAccountId: 'account-1',
          operationKind: 'password_credential_mutation_v1',
          operationDigest: createPasswordCredentialMutationDigestV1({
            v: 1,
            action: 'connect',
            accountId: 'account-1',
            expectedCredentialRevision: null,
            normalizedNativeEmail: body.normalizedNativeEmail,
            newCredentialDigest: createPasswordCredentialTargetDigestV1(targetCredential),
          }),
        },
      };
    });
    const verificationToken = 'V'.repeat(43);
    app.post('/v1/account/password/enroll', async (request) => {
      const body = request.body as Record<string, unknown>;
      expect(body).toMatchObject({ kind: 'e2ee', email: 'person@example.test', verificationToken });
      expect((body.targetCredential as { envelope: unknown }).envelope).toEqual(preparedEnvelope);
      expect(JSON.stringify(body)).not.toContain('new enrollment password');
      return { v: 1, status: 'enrolled' };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsLegacy } = await import('@/persistence');
      await writeCredentialsLegacy({ token: 'interactive', secret });
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand([
        'email', 'connect', '--email', 'Person@Example.Test',
        '--password', 'new enrollment password', '--verification-token', verificationToken,
        '--yes', '--json',
      ]);
      expect(JSON.parse(output.text())).toMatchObject({ ok: true, data: { status: 'enrolled' } });
      expect(output.text()).not.toContain('new enrollment password');
      expect(output.text()).not.toContain(verificationToken);
    } finally {
      secret.fill(0);
      output.restore();
      restore();
      await app.close();
    }
  }, 240_000);

  it('removes an E2EE password wrapper through the canonical signed challenge', async () => {
    const app = fastify();
    const secret = new Uint8Array(32).fill(31);
    app.get('/v1/account/security', async () => ({
      v: 1,
      terminalPresentUserPolicy: 'allowed',
      encryptionMode: 'e2ee',
      nativeEmail: 'person@example.test',
      password: { status: 'enrolled', revision: 9 },
    }));
    app.get('/v1/account/profile', async () => ({ id: 'account-1' }));
    app.post('/v1/auth/password/mutation/challenge', async (request) => {
      expect(request.body).toMatchObject({
        action: 'remove', expectedCredentialRevision: 9, normalizedNativeEmail: 'person@example.test',
      });
      return {
        challenge: {
          v: 1,
          challengeId: 'challenge-remove',
          nonce: 'nonce',
          issuedAt: '2026-09-08T00:00:00.000Z',
          expiresAt: '2026-09-08T00:05:00.000Z',
          audience: { origin: 'http://account.test', serverIdentityId: 'srv_home' },
          expectedAccountId: 'account-1',
          operationKind: 'password_credential_mutation_v1',
          operationDigest: createPasswordCredentialMutationDigestV1({
            v: 1,
            action: 'remove',
            accountId: 'account-1',
            expectedCredentialRevision: 9,
            normalizedNativeEmail: 'person@example.test',
            newCredentialDigest: null,
          }),
        },
      };
    });
    app.post('/v1/account/password/remove', async (request) => {
      expect(request.body).toMatchObject({ kind: 'e2ee', expectedCredentialRevision: 9 });
      expect(JSON.stringify(request.body)).not.toContain('secret');
      return { v: 1, status: 'removed' };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsLegacy } = await import('@/persistence');
      await writeCredentialsLegacy({ token: 'interactive', secret });
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand(['password', 'remove', '--yes', '--json']);
      expect(JSON.parse(output.text())).toMatchObject({ ok: true, data: { status: 'removed' } });
    } finally {
      secret.fill(0);
      output.restore();
      restore();
      await app.close();
    }
  }, 120_000);

  it('reports pre-dispatch cancellation as typed cancellation with no server effects', async () => {
    const app = fastify();
    let hits = 0;
    app.all('*', async () => {
      hits += 1;
      return { error: 'invalid_request' };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'interactive' });
      const abort = new AbortController();
      abort.abort();
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand([
        'password', 'change', '--current-password', 'current password long',
        '--new-password', 'replacement password long', '--yes', '--json',
      ], abort.signal);
      expect(JSON.parse(output.text())).toMatchObject({ ok: false, error: { code: 'cancelled' } });
      expect(hits).toBe(0);
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });

  it('projects a missing enrollment mailbox proof as the Home typed failure', async () => {
    const app = fastify();
    const targetCredential = plainCredentialFixture();
    registerPlainEnrollmentExternalAuth(app, targetCredential);
    app.get('/v1/auth/external/github/params', async () => ({ url: 'https://github.example/authorize' }));
    app.post('/v1/account/password/enroll', async (_request, reply) => {
      return await reply.code(401).send({ error: 'reauthentication_required' });
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'interactive' });
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand([
        'password', 'enroll', '--email', 'person@example.test',
        '--password', 'new enrollment password',
        '--yes', '--json',
      ]);
      expect(JSON.parse(output.text())).toMatchObject({
        ok: false,
        error: { code: 'reauthentication_required' },
      });
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });

  it('projects a rejected enrollment mailbox bearer as invalid_token', async () => {
    const app = fastify();
    const targetCredential = plainCredentialFixture();
    registerPlainEnrollmentExternalAuth(app, targetCredential);
    app.get('/v1/auth/external/github/params', async () => ({ url: 'https://github.example/authorize' }));
    app.post('/v1/account/password/enroll', async (_request, reply) => {
      return await reply.code(401).send({ error: 'invalid_token' });
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'interactive' });
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand([
        'password', 'enroll', '--email', 'person@example.test',
        '--password', 'new enrollment password', '--verification-token', 'W'.repeat(43),
        '--yes', '--json',
      ]);
      expect(JSON.parse(output.text())).toMatchObject({
        ok: false,
        error: { code: 'invalid_token' },
      });
      expect(output.text()).not.toContain('W'.repeat(43));
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });

  it('validates recovery keys without revealing secret material', async () => {
    const output = captureConsoleText();
    try {
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand(['recovery-key', 'validate', '--key', 'not-a-key', '--json']);
      const envelope = JSON.parse(output.text());
      expect(envelope.ok).toBe(true);
      expect(envelope.data.ok).toBe(false);
      expect(JSON.stringify(envelope)).not.toContain('not-a-key');
    } finally {
      output.restore();
    }
  });

  it('dispatches native email actions exhaustively without mTLS/OAuth fallthrough', async () => {
    const output = captureConsoleText();
    try {
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand(['email', 'bogus-action', '--json']);
      expect(process.exitCode).toBe(1);
      expect(output.text()).toContain('Usage');
    } finally {
      output.restore();
      process.exitCode = 0;
    }
  });

  it('advertises the trusted Account Security and native email commands in canonical help', async () => {
    const output = captureConsoleText();
    try {
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand(['help']);
      const text = output.text();
      expect(text).toContain('security get');
      expect(text).toContain('password change');
      expect(text).toContain('email login');
      expect(text).toContain('recovery-key validate');
      expect(text).toContain('present_user');
    } finally {
      output.restore();
    }
  });
});
