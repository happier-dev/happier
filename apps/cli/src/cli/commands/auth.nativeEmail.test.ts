import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import axios from 'axios';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import tweetnacl from 'tweetnacl';
import {
  CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
  createKeyChallengeV2SigningInput,
  decodeBase64,
  deriveAccountMachineKeyFromRecoverySecret,
  formatRecoveryKey,
  machineStoredContentMatchesAccountMode,
  verifyAccountContentKeyBindingV1,
} from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';

const terminalBearer = `header.${Buffer.from(JSON.stringify({ sub: 'account-1', tokenEpoch: 0,
  provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
})).toString('base64url')}.signature`;

function installNativeAuthTransport(app: ReturnType<typeof fastify>, mode: 'plain' | 'e2ee' = 'plain', failRegistration = false): () => void {
  // Machine registration is real; only the Home's HTTP boundary is substituted.
  app.get('/v1/account/encryption', async () => ({ mode, updatedAt: 1 }));
  app.post('/v1/machines', async (request: FastifyRequest, reply: FastifyReply) => {
    if (failRegistration) return reply.code(503).send({ error: 'unavailable', token: terminalBearer });
    const body = request.body as { id: string; metadata: string; dataEncryptionKey?: string };
    expect(machineStoredContentMatchesAccountMode({ mode, ...body })).toBe(true);
    return { machine: { id: body.id, metadata: body.metadata, metadataVersion: 1, daemonState: null, daemonStateVersion: 0, dataEncryptionKey: body.dataEncryptionKey ?? null } };
  });
  return installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
}

describe('native email and recovery CLI commands', () => {
  const env = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_TOKEN',
  ]);
  let home = '';

  beforeEach(async () => {
    home = await createTempDir('happier-native-email-command-');
    env.patch({
      HAPPIER_HOME_DIR: home,
      HAPPIER_SERVER_URL: 'http://account.test',
      HAPPIER_PUBLIC_SERVER_URL: 'http://account.test',
      HAPPIER_LOCAL_SERVER_URL: undefined,
      HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_WEBAPP_URL: 'http://account.test',
      HAPPIER_TOKEN: undefined,
    });
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (...[input, init]: Parameters<typeof fetch>) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      // Ink's real Yoga initializer fetches its packaged data-URL WASM.
      if (url.protocol === 'data:') return await nativeFetch(input, init);
      if (url.origin !== 'http://account.test' || url.pathname !== '/v1/features') throw new Error('Unexpected fixture fetch target');
      return new Response(JSON.stringify({
      features: {},
      capabilities: {
        serverIdentity: { serverIdentityId: 'srv_home' },
        accountStoredContentCompatibility: { v: 1, currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
          minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1' },
      },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    env.restore();
    process.exitCode = 0;
    await removeTempDir(home);
  });

  it('preserves the exact Plain password supplied through stdin', async () => {
    const app = fastify();
    const password = '  exact password with surrounding spaces  ';
    app.post('/v1/auth/email/prelogin', async () => ({ v: 1, kind: 'plain_password' }));
    app.post('/v1/auth/email/login', async (request) => {
      expect(request.body).toEqual({ v: 1, email: 'person@example.test', password, credentialKind: 'terminal' });
      return { token: terminalBearer };
    });
    const restore = installNativeAuthTransport(app);
    const output = captureConsoleJsonOutput<unknown>();
    try {
      // Surface module-readiness errors instead of the command's secret-safe projection.
      await import('@/ui/auth');
      const { expandAuthSecretsFromStdin } = await import('./auth/stdinSecrets');
      const args = await expandAuthSecretsFromStdin(
        ['login', '--email', 'person@example.test', '--json', '--secrets-json-stdin'],
        Readable.from([JSON.stringify({ v: 1, secrets: { password } })]),
      );
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand(args);
      const envelope = output.json();
      expect(envelope).toEqual(expect.objectContaining({ ok: true, data: expect.objectContaining({ accountId: 'account-1' }) }));
      expect(output.logs.join('\n')).not.toContain(password);
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });

  it.each([
    { canonicalUrl: 'http://account.test', audienceOrigin: 'http://account.test', identity: 'srv_home', succeeds: true },
    { canonicalUrl: 'https://public.account.test', audienceOrigin: 'https://public.account.test', identity: 'srv_home', succeeds: true },
    { canonicalUrl: 'https://public.account.test', audienceOrigin: 'http://account.test', identity: 'srv_home', succeeds: false },
    { canonicalUrl: 'https://public.account.test', audienceOrigin: 'https://other.account.test', identity: 'srv_home', succeeds: false },
    { canonicalUrl: 'https://public.account.test', audienceOrigin: 'https://public.account.test', identity: 'srv_other', succeeds: false },
    { canonicalUrl: 'https://public.account.test', audienceOrigin: 'https://public.account.test', identity: 'srv_home', succeeds: true, failRegistration: true },
  ])('binds recovery login to canonical $canonicalUrl and audience $audienceOrigin / $identity ($failRegistration)', async ({ canonicalUrl, audienceOrigin, identity, succeeds, failRegistration }) => {
    env.patch({ HAPPIER_PUBLIC_SERVER_URL: canonicalUrl, HAPPIER_LOCAL_SERVER_URL: 'http://account.test', HAPPIER_ACTIVE_SERVER_ID: 'stack_qa__id_default' });
    const app = fastify();
    const recoverySecret = new Uint8Array(32).fill(7);
    const recoveryKey = formatRecoveryKey(recoverySecret);
    const challenge = {
      challengeId: 'challenge-existing-account',
      nonce: 'nonce-existing-account',
      issuedAt: '2026-09-10T10:00:00.000Z',
      expiresAt: '2026-09-10T18:00:00.000Z',
      audience: { origin: audienceOrigin, serverIdentityId: identity },
    } as const;
    let redeemed = false;
    app.post('/v1/auth/challenge', async () => challenge);
    app.post('/v1/auth', async (request) => {
      redeemed = true;
      expect(request.body).toMatchObject({
        challengeId: 'challenge-existing-account',
        requireExistingAccount: true,
        credentialKind: 'terminal',
      });
      const body = request.body as { publicKey: string; signature: string; contentPublicKey?: string; contentPublicKeySig?: string };
      expect(tweetnacl.sign.detached.verify(
        createKeyChallengeV2SigningInput({ ...challenge, requireExistingAccount: true }),
        decodeBase64(body.signature),
        decodeBase64(body.publicKey),
      )).toBe(true);
      const contentPrivateKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);
      expect(decodeBase64(body.contentPublicKey ?? '')).toEqual(
        tweetnacl.box.keyPair.fromSecretKey(contentPrivateKey).publicKey,
      );
      expect(verifyAccountContentKeyBindingV1({
        accountSigningPublicKey: decodeBase64(body.publicKey),
        contentPublicKey: decodeBase64(body.contentPublicKey ?? ''),
        signature: decodeBase64(body.contentPublicKeySig ?? ''),
      })).not.toBeNull();
      return { success: true, token: terminalBearer };
    });
    const restore = installNativeAuthTransport(app, 'e2ee', failRegistration);
    // A failed HTTP adapter may carry secrets in its Error text as well as
    // its attached request/response. Keep that boundary shape realistic.
    const interceptor = axios.interceptors.response.use(undefined, (error: unknown) => {
      if (failRegistration && axios.isAxiosError(error)) {
        error.message = `Registration refused ${recoveryKey} ${terminalBearer} ${Buffer.from(recoverySecret).toString('base64')}`;
        error.stack = `AxiosError: ${error.message}\n    at generatedRegistrationFixture (fixture.ts:1:1)`;
      }
      return Promise.reject(error);
    });
    const output = captureConsoleJsonOutput<unknown>();
    try {
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand(['recovery-key', 'login', '--key', recoveryKey, '--json']);
      const envelope = output.json();
      if (failRegistration) {
        expect(envelope).toMatchObject({ ok: false, error: { code: 'ERR_BAD_RESPONSE', phase: 'machine_registration' } });
        const { logger } = await import('@/ui/logger');
        logger.flushSync();
        const log = await readFile(logger.logFilePath, 'utf8');
        expect(log).toContain('ERR_BAD_RESPONSE');
        expect(log).toContain('503');
        expect(log).toContain('machine_registration');
        expect(log).toContain('Registration refused');
        expect(log).toContain('generatedRegistrationFixture');
        expect(log).not.toContain(recoveryKey);
        expect(log).not.toContain(terminalBearer);
        expect(log).not.toContain(Buffer.from(recoverySecret).toString('base64'));
        const { readStoredCredentials } = await import('@/persistence');
        expect(await readStoredCredentials()).toBeNull();
      } else if (succeeds) {
        expect(envelope).toEqual(expect.objectContaining({ ok: true, data: expect.objectContaining({ accountId: 'account-1' }) }));
        const { readStoredCredentials } = await import('@/persistence');
        expect(await readStoredCredentials()).toMatchObject({ token: terminalBearer, encryption: { type: 'legacy', secret: recoverySecret } });
      } else {
        expect(envelope).toMatchObject({ ok: false, error: { code: 'authentication_failed' } });
        const { readStoredCredentials } = await import('@/persistence');
        expect(await readStoredCredentials()).toBeNull();
      }
      expect(redeemed).toBe(succeeds);
      expect(output.logs.join('\n')).not.toContain(recoveryKey);
    } finally {
      axios.interceptors.response.eject(interceptor);
      output.restore();
      restore();
      await app.close();
    }
  });

  it('keeps reset requests existence-neutral and dispatches them through the selected Home', async () => {
    const app = fastify();
    app.post('/v1/auth/password/reset/request', async (request) => {
      expect(request.body).toEqual({ v: 1, email: 'person@example.test' });
      return { accepted: true };
    });
    const restore = installNativeAuthTransport(app);
    const output = captureConsoleText();
    try {
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand(['email', 'reset-request', '--email', 'Person@Example.Test', '--json']);
      expect(JSON.parse(output.text())).toEqual({
        v: 1,
        ok: true,
        kind: 'auth_password_reset_request',
        data: { accepted: true },
      });
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });

  it.each([
    { operation: 'reset-request', path: '/v1/auth/password/reset/request', responseDelayMs: 31_000 },
    { operation: 'change-complete', path: '/v1/account/email/change', responseDelayMs: 16_000 },
  ])('lets the caller own the lifetime of a slow $operation request', async ({ operation, path, responseDelayMs }) => {
    const app = fastify();
    app.get('/v1/features', async () => ({
      features: {},
      capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } },
    }));
    app.post(path, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, responseDelayMs));
      return operation === 'reset-request' ? { accepted: true } : { v: 1, status: 'updated' };
    });
    // A real HTTP socket exercises Axios's request deadline; the injection
    // adapter deliberately does not model socket timeout behavior.
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    env.patch({ HAPPIER_LOCAL_SERVER_URL: origin });
    vi.unstubAllGlobals();
    const output = captureConsoleJsonOutput<unknown>();
    try {
      if (operation === 'change-complete') {
        const { writeCredentialsTokenOnly } = await import('@/persistence');
        await writeCredentialsTokenOnly({ token: 'interactive' });
      }
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand(operation === 'reset-request'
        ? ['email', operation, '--email', 'person@example.test', '--json']
        : ['email', operation, '--verification-token', 'V'.repeat(43), '--json']);
      expect(output.json()).toMatchObject({ ok: true });
    } finally {
      output.restore();
      await app.close();
    }
    // The real socket delay exceeds the package's 30s test default; leave room
    // for command initialization and socket cleanup, not a product deadline.
  }, 120_000);

  it('requests invitation-scoped mailbox proof before transferable invitation provisioning', async () => {
    const app = fastify();
    const invitationToken = 'I'.repeat(43);
    let provisionRequests = 0;
    app.post('/v1/auth/email/verify/request', async (request) => {
      expect(request.body).toEqual({
        v: 1,
        email: 'person@example.test',
        admission: { kind: 'team_invitation', token: invitationToken },
      });
      return { accepted: true };
    });
    app.post('/v1/auth/email/provision', async () => {
      provisionRequests += 1;
      return {};
    });
    const restore = installNativeAuthTransport(app);
    const output = captureConsoleText();
    try {
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand([
        'email', 'provision',
        '--email', 'person@example.test',
        '--invitation-token', invitationToken,
        '--json',
      ]);

      expect(JSON.parse(output.text())).toMatchObject({
        ok: true,
        kind: 'auth_email_provision',
        data: { verificationRequested: true },
      });
      expect(provisionRequests).toBe(0);
      expect(output.text()).not.toContain(invitationToken);
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });

  it('preserves reset password bytes from stdin and projects the canonical typed failure', async () => {
    const app = fastify();
    const password = '  replacement password bytes  ';
    const resetToken = 'R'.repeat(43);
    app.post('/v1/auth/password/reset/submit', async (request, reply) => {
      expect(request.body).toEqual({ v: 1, token: resetToken, password });
      return reply.code(400).send({ error: 'invalid_reset' });
    });
    const restore = installNativeAuthTransport(app);
    const output = captureConsoleText();
    try {
      const { expandAuthSecretsFromStdin } = await import('./auth/stdinSecrets');
      const args = await expandAuthSecretsFromStdin(
        ['email', 'reset-submit', '--json', '--secrets-json-stdin'],
        Readable.from([JSON.stringify({ v: 1, secrets: { resetToken, newPassword: password } })]),
      );
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand(args);
      const envelope = JSON.parse(output.text());
      expect(envelope).toMatchObject({ ok: false, kind: 'auth_password_reset_submit', error: { code: 'invalid_reset' } });
      expect(output.text()).not.toContain(password);
      expect(output.text()).not.toContain(resetToken);
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });

  it('completes sign-in email changes with the stored interactive credential and typed errors', async () => {
    const app = fastify();
    const verificationToken = 'V'.repeat(43);
    app.post('/v1/account/email/change', async (request, reply) => {
      expect(request.headers.authorization).toBe('Bearer interactive');
      expect(request.body).toEqual({ v: 1, verificationToken });
      return reply.code(400).send({ error: 'verification_invalid' });
    });
    const restore = installNativeAuthTransport(app);
    const output = captureConsoleText();
    try {
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'interactive' });
      const { expandAuthSecretsFromStdin } = await import('./auth/stdinSecrets');
      const args = await expandAuthSecretsFromStdin(
        ['email', 'change-complete', '--json', '--secrets-json-stdin'],
        Readable.from([JSON.stringify({ v: 1, secrets: { verificationToken } })]),
      );
      const { handleAuthCommand } = await import('./auth');
      await handleAuthCommand(args);
      const envelope = JSON.parse(output.text());
      expect(envelope).toMatchObject({ ok: false, kind: 'auth_email_change_complete', error: { code: 'verification_invalid' } });
      expect(output.text()).not.toContain(verificationToken);
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });
});
