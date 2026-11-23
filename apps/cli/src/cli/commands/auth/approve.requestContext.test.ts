import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { openTerminalProvisioningV3Response } from '@happier-dev/protocol';
import {
  computeHomeQrBindingProofV2,
  createHomeQrReverseInviteV2,
  deriveHomeQrBindingKeyV2,
  deriveHomeQrRendezvousVerifierV2,
  encodeHomeQrInviteV2Payload,
} from '@happier-dev/protocol/crypto/qrProvisioningV2';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import {
  openAccountScopedBlobCiphertext,
  resolveAccountContentSecretKey,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol/crypto/accountScopedCipher';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';

const terminal = vi.hoisted(() => ({ answer: '', question: '' }));
vi.mock('node:readline', async (importOriginal) => {
  const { EventEmitter } = await import('node:events');
  return {
    ...(await importOriginal<typeof import('node:readline')>()),
    createInterface: () => Object.assign(new EventEmitter(), {
      question: (prompt: string, resolve: (answer: string) => void) => {
        terminal.question = prompt;
        resolve(terminal.answer);
      },
      close() {},
    }),
  };
});

describe('auth approve request pairing context', () => {
  const ttyInput = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const ttyOutput = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_HOME_CARRIER_POLICY',
  ] as const;

  let localHomeDir = '';
  let envScope = createEnvKeyScope(envKeys);

  beforeEach(async () => {
    envScope = createEnvKeyScope(envKeys);
    localHomeDir = await createTempDir('happier-cli-auth-approve-');
  });

  afterEach(async () => {
    envScope.restore();
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (ttyInput) Object.defineProperty(process.stdin, 'isTTY', ttyInput);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    if (ttyOutput) Object.defineProperty(process.stderr, 'isTTY', ttyOutput);
    else Reflect.deleteProperty(process.stderr, 'isTTY');
    await removeTempDir(localHomeDir);
  });

  function buildRequestEnvelope() {
    const terminalKeypair = tweetnacl.box.keyPair();
    const pairingSecret = new Uint8Array(32).fill(11);
    const createdAtMs = Date.now() - 60_000;
    const expiresAtMs = Date.now() + 3_600_000;
    const envelope = {
      publicKey: Buffer.from(terminalKeypair.publicKey).toString('base64'),
      publicKeyB64Url: Buffer.from(terminalKeypair.publicKey).toString('base64url'),
      claimSecret: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url'),
      pairing: {
        secretB64Url: Buffer.from(pairingSecret).toString('base64url'),
        createdAtMs,
        expiresAtMs,
      },
      supportsTokenOnly: true,
    };
    return { terminalKeypair, pairingSecret, createdAtMs, expiresAtMs, envelope };
  }

  it.each(['interactive approval', 'fallback label', 'explicit confirmation', 'keyless', 'other Account', 'wrong Home', 'decline', 'non-interactive'] as const)(
    'handles a requester-displayed app invite with %s',
    async (scenario) => {
      const origin = 'https://happier-auth.test';
      const home = {
        v: 1 as const, homeServerIdentityId: 'srv_fixture_home', canonicalServerUrl: origin,
        revision: 1, endpoints: [{ kind: 'https' as const, url: origin }],
      };
      const reverse = createHomeQrReverseInviteV2({
        home: scenario === 'wrong Home' ? { ...home, homeServerIdentityId: 'srv_other_home' } : home,
        nowMs: Date.now(),
        ...(scenario === 'fallback label' ? {} : { requestedDeviceLabel: 'Fixture Browser' }),
      });
      const { invite, qrSecret, requesterPublicKey, requesterSecretKey } = reverse;
      const link = `happier:///pair?v=2&payload=${encodeHomeQrInviteV2Payload(invite)}`;
      const expiresAt = new Date(invite.expiresAtMs).toISOString();
      const token = 'fixture-account-token';
      const secret = new Uint8Array(32).fill(9);
      const account = { type: 'legacy' as const, secret };
      const key = resolveAccountContentSecretKey(account);
      const contentKeyFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.box.keyPair.fromSecretKey(key).publicKey);
      const payload = { title: 'Existing encrypted Account content' };
      const ciphertext = sealAccountScopedBlobCiphertext({
        kind: 'account_settings', material: account, payload, randomBytes: tweetnacl.randomBytes,
      });
      let started = false;
      let openedContent: unknown;
      const posts: string[] = [];
      terminal.answer = scenario === 'decline' ? 'n' : 'yes';
      terminal.question = '';
      const interactive = ['interactive approval', 'fallback label', 'decline'].includes(scenario);
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: interactive });
      Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: interactive });
      envScope.patch({
        HAPPIER_HOME_DIR: localHomeDir, HAPPIER_SERVER_URL: origin,
        HAPPIER_PUBLIC_SERVER_URL: origin, HAPPIER_WEBAPP_URL: origin,
        HAPPIER_HOME_CARRIER_POLICY: 'standard_only',
      });
      vi.resetModules();
      const { writeCredentialsLegacy, writeCredentialsTokenOnly } = await import('@/persistence');
      if (scenario === 'keyless') await writeCredentialsTokenOnly({ token });
      else await writeCredentialsLegacy({ token, secret });
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
        const target = new URL(String(url));
        expect(target.origin).toBe(origin);
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
        if (target.pathname === '/v1/features/authenticated') {
          return Response.json({
            features: { auth: { pairing: { boundQrV2: { enabled: true } } } },
            capabilities: { serverIdentity: { serverIdentityId: home.homeServerIdentityId } },
            homeConnectionDescriptor: home,
          });
        }
        if (target.pathname === '/v1/account/profile') return Response.json({ id: 'fixture-account', username: 'fixture-user' });
        if (target.pathname === '/v1/account/encryption/currentness') {
          return Response.json(createAccountEncryptionCurrentnessFixture({ mode: 'e2ee', contentKeyFingerprint }));
        }
        if (init?.method === 'POST') posts.push(target.pathname);
        if (target.pathname === '/v1/auth/pairing/start') {
          expect(JSON.parse(String(init?.body))).toEqual({
            direction: 'requester_displays', pairId: invite.pairId, expiresAtMs: invite.expiresAtMs,
            secretHash: Buffer.from(deriveHomeQrRendezvousVerifierV2(qrSecret)).toString('base64url'),
          });
          if (scenario === 'other Account') return Response.json({ error: 'pair_id_conflict' }, { status: 409 });
          started = true;
          return Response.json({ pairId: invite.pairId, expiresAt });
        }
        if (target.pathname === '/v1/auth/pairing/status') {
          expect(started).toBe(true);
          expect(target.searchParams.get('pairId')).toBe(invite.pairId);
          return Response.json({
            state: 'requested', pairId: invite.pairId, expiresAt, homeServerIdentityId: home.homeServerIdentityId,
            requestedPublicKey: Buffer.from(requesterPublicKey).toString('base64'),
            bindingProof: computeHomeQrBindingProofV2({
              direction: invite.direction, qrSecret, pairId: invite.pairId,
              homeServerIdentityId: home.homeServerIdentityId, requesterPublicKey, expiresAtMs: invite.expiresAtMs,
            }),
            requestedDeviceLabel: 'Fixture Browser',
          });
        }
        if (target.pathname === '/v1/auth/pairing/consume') {
          expect(JSON.parse(String(init?.body))).toEqual({ pairId: invite.pairId, intent: 'reject' });
          return Response.json({ success: true });
        }
        if (target.pathname === '/v1/auth/account/response') {
          const body = JSON.parse(String(init?.body));
          expect(body).toMatchObject({
            pairId: invite.pairId, homeServerIdentityId: home.homeServerIdentityId,
            publicKey: Buffer.from(requesterPublicKey).toString('base64'), responseKind: 'dataKey',
          });
          const opened = openTerminalProvisioningV3Response({
            payload: Buffer.from(body.response, 'base64'), recipientSecretKeyOrSeed: requesterSecretKey,
            terminalEphemeralPublicKey: requesterPublicKey, pairingSecret: deriveHomeQrBindingKeyV2(qrSecret),
            createdAtMs: invite.issuedAtMs, expiresAtMs: invite.expiresAtMs, nowMs: Date.now(),
          });
          if (opened?.type === 'dataKey') {
            openedContent = openAccountScopedBlobCiphertext({
              kind: 'account_settings', ciphertext, material: { type: 'dataKey', machineKey: opened.key },
            })?.value;
          }
          return Response.json({ success: true });
        }
        throw new Error(`Unexpected fixture route ${target.pathname}`);
      }));
      const { handleAuthApprove } = await import('./approve');
      vi.spyOn(process, 'exit').mockImplementation((code): never => { throw new Error(`process.exit:${code}`); });
      const args = ['--json', link, ...(!interactive && scenario !== 'non-interactive' ? ['--confirm'] : [])];
      const refusals: Partial<Record<typeof scenario, string>> = {
        keyless: 'TERMINAL_PROVISIONING_MATERIAL_INVALID',
        'other Account': 'pair_id_conflict',
        'wrong Home': 'HOME_AUTHORITY_MISMATCH',
        decline: 'HOME_QR_APPROVAL_DECLINED',
        'non-interactive': 'HOME_QR_APPROVAL_CONFIRMATION_REQUIRED',
      };
      const code = refusals[scenario];
      if (scenario === 'non-interactive') {
        const { handleAuthCliCommand } = await import('../auth');
        const stdout = captureStdoutJsonOutput();
        const commandArgs = ['auth', 'approve', ...args];
        await expect(handleAuthCliCommand({ args: commandArgs, rawArgv: commandArgs, terminalRuntime: null }))
          .rejects.toThrow('process.exit:1');
        expect(stdout.json()).toMatchObject({ success: false, error: { code } });
        expect(posts).toEqual([]);
      } else if (code) {
        await expect(handleAuthApprove(args)).rejects.toMatchObject({ code });
        expect(posts).toEqual(scenario === 'other Account' ? ['/v1/auth/pairing/start']
          : scenario === 'keyless' ? ['/v1/auth/pairing/start', '/v1/auth/pairing/consume'] : []);
      } else {
        const stdout = captureStdoutJsonOutput();
        await expect(handleAuthApprove(args)).resolves.toBeUndefined();
        expect(stdout.json()).toEqual({ success: true });
        expect(openedContent).toEqual(payload);
      }
      if (interactive) {
        expect(terminal.question).toContain(scenario === 'fallback label' ? 'Unknown device' : 'Fixture Browser');
        expect(terminal.question).toContain(origin);
        expect(terminal.question).toContain('fixture-user');
      }
    },
  );

  it.each([false, true])('approves a pairing-bound v3 response with unattended Team access explicitly selected: %s', async (authorizeUnattendedTeamAccess) => {
    const { terminalKeypair, pairingSecret, createdAtMs, expiresAtMs, envelope } = buildRequestEnvelope();
    const envelopePath = join(localHomeDir, 'remote-auth-request.json');
    await writeFile(envelopePath, JSON.stringify(envelope, null, 2), 'utf8');

    const postedBodies: Array<Record<string, unknown>> = [];
    const app = fastify({ logger: false });
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
    app.post('/v1/auth/response', async (req, reply) => {
      postedBodies.push(req.body as Record<string, unknown>);
      return reply.send({ success: true });
    });
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://happier-auth.test' });

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: localHomeDir,
        HAPPIER_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
      });
      vi.resetModules();
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'local-token' });

      const { handleAuthApprove } = await import('./approve');
      const stdout = captureStdoutJsonOutput();
      await handleAuthApprove([
        '--json',
        '--public-key',
        envelope.publicKey,
        '--request-json-file',
        envelopePath,
        ...(authorizeUnattendedTeamAccess ? ['--authorize-unattended-team-access'] : []),
      ]);
      expect(stdout.json<{ success: boolean }>()).toEqual({ success: true });

      expect(postedBodies).toHaveLength(1);
      const body = postedBodies[0] ?? {};
      expect(body.publicKey).toBe(envelope.publicKey);
      expect(body.responseKind).toBe('tokenOnly');
      if (authorizeUnattendedTeamAccess) {
        expect(body.authorizeUnattendedTeamAccess).toBe(true);
      } else {
        expect(body).not.toHaveProperty('authorizeUnattendedTeamAccess');
      }
      expect(typeof body.response).toBe('string');
      const opened = openTerminalProvisioningV3Response({
        payload: new Uint8Array(Buffer.from(String(body.response), 'base64')),
        recipientSecretKeyOrSeed: terminalKeypair.secretKey,
        terminalEphemeralPublicKey: terminalKeypair.publicKey,
        pairingSecret,
        createdAtMs,
        expiresAtMs,
        nowMs: Date.now(),
      });
      expect(opened).toEqual({ type: 'tokenOnly' });
    } finally {
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);

  it('rejects a request envelope whose public key does not match --public-key', async () => {
    const { envelope } = buildRequestEnvelope();
    const envelopePath = join(localHomeDir, 'remote-auth-request.json');
    await writeFile(envelopePath, JSON.stringify(envelope, null, 2), 'utf8');

    const otherKeypair = tweetnacl.box.keyPair();
    const app = fastify({ logger: false });
    const postedBodies: Array<Record<string, unknown>> = [];
    app.post('/v1/auth/response', async (req, reply) => {
      postedBodies.push(req.body as Record<string, unknown>);
      return reply.send({ success: true });
    });
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://happier-auth.test' });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined): never => {
      throw new Error(`process.exit:${String(code ?? '')}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: localHomeDir,
        HAPPIER_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
      });
      vi.resetModules();
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'local-token' });

      const { handleAuthApprove } = await import('./approve');
      await expect(
        handleAuthApprove([
          '--json',
          '--public-key',
          Buffer.from(otherKeypair.publicKey).toString('base64'),
          '--request-json-file',
          envelopePath,
        ]),
      ).rejects.toThrow('process.exit:2');
      expect(errorSpy.mock.calls.some((args) => String(args[0]).includes('public key'))).toBe(true);
      expect(postedBodies).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);

  it('guides the operator to supply the request envelope when the approval lacks a pairing context', async () => {
    const app = fastify({ logger: false });
    const postedBodies: Array<Record<string, unknown>> = [];
    app.post('/v1/auth/response', async (req, reply) => {
      postedBodies.push(req.body as Record<string, unknown>);
      return reply.send({ success: true });
    });
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://happier-auth.test' });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined): never => {
      throw new Error(`process.exit:${String(code ?? '')}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: localHomeDir,
        HAPPIER_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
      });
      vi.resetModules();
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'local-token' });

      const terminalKeypair = tweetnacl.box.keyPair();
      const { handleAuthApprove } = await import('./approve');
      await expect(
        handleAuthApprove([
          '--json',
          '--public-key',
          Buffer.from(terminalKeypair.publicKey).toString('base64'),
        ]),
      ).rejects.toThrow('process.exit:1');
      expect(
        errorSpy.mock.calls.some((args) => String(args[0]).includes('--request-json-file')),
      ).toBe(true);
      expect(postedBodies).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);
});
