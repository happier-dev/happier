import { afterEach, describe, expect, it } from 'vitest';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol';

import { reloadConfiguration } from '@/configuration';
import { writeCredentialsDataKey, writeCredentialsLegacy, writeCredentialsTokenOnly } from '@/persistence';
import { createAccountProfileFixture, createAccountTokenFixture } from '@/testkit/backends/accountFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';

import { approveTerminalAuthRequest } from './terminalAuthApproval';
import { openTerminalProvisioningResponse } from './terminalProvisioningResponse';

const origin = 'http://happier-approval.test';
const accountId = 'account-retained-credentials';
const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL']);
const tokenForAccount = (revision: number) => createAccountTokenFixture(accountId, { revision });
const currentSecret = new Uint8Array(32).fill(12);
const currentMachineKey = deriveAccountMachineKeyFromRecoverySecret(currentSecret);
const profile = createAccountProfileFixture({ accountId, signingSeed: currentSecret });

afterEach(() => {
  envScope.restore();
  reloadConfiguration();
});

async function withApprovalServer(
  params: Readonly<{ mode: 'plain' | 'e2ee' | 'unknown'; legacyProfile?: boolean; supportsTokenOnly?: boolean }>,
  run: (boundary: Readonly<{ responses: unknown[]; profileReads: string[] }>) => Promise<void>,
): Promise<void> {
  await withTempDir('happier-terminal-approval-', async (home) => {
    envScope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: origin, HAPPIER_PUBLIC_SERVER_URL: origin });
    reloadConfiguration();
    const app = fastify({ logger: false });
    const responses: unknown[] = [];
    const profileReads: string[] = [];
    app.get('/v1/account/encryption', async (_request, reply) => {
      if (params.mode === 'unknown') return reply.code(503).send({ error: 'unavailable' });
      return { mode: params.mode, updatedAt: 1 };
    });
    app.get('/v1/auth/request/status', async () => ({
      status: 'pending', supportsV2: true,
      ...(params.supportsTokenOnly === undefined ? {} : { supportsTokenOnly: params.supportsTokenOnly }),
    }));
    app.get<{ Params: { id: string } }>('/v1/user/:id', async (request) => {
      profileReads.push(request.params.id);
      expect(request.headers.authorization).toBe(`Bearer ${tokenForAccount(2)}`);
      return { user: params.legacyProfile ? { ...profile, contentPublicKey: null, contentPublicKeySig: null } : profile };
    });
    app.post('/v1/auth/response', async (request) => {
      responses.push(request.body);
      return { success: true };
    });
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin });
    try {
      await run({ responses, profileReads });
    } finally {
      restoreAxios();
      await app.close();
    }
  });
}

function openApprovedResponse(response: unknown, terminal: tweetnacl.BoxKeyPair, requirement: 'v3' | null = null) {
  expect(response).toMatchObject({ publicKey: Buffer.from(terminal.publicKey).toString('base64'), response: expect.any(String) });
  if (!response || typeof response !== 'object' || !('response' in response) || typeof response.response !== 'string') return null;
  return openTerminalProvisioningResponse({
    payload: Buffer.from(response.response, 'base64'),
    terminalSecretKey: terminal.secretKey,
    terminalPublicKey: terminal.publicKey,
    pairing: null,
    requirement,
    nowMs: Date.now(),
  });
}

describe('terminal approval account key readiness', () => {
  it('refuses a retained stale data key after the same account publishes its first E2EE root', async () => {
    await withApprovalServer({ mode: 'e2ee' }, async ({ responses }) => {
      const oldMachineKey = new Uint8Array(32).fill(4);
      await writeCredentialsDataKey({
        token: tokenForAccount(1),
        machineKey: oldMachineKey,
        publicKey: tweetnacl.box.keyPair.fromSecretKey(oldMachineKey).publicKey,
      });
      await writeCredentialsTokenOnly({ token: tokenForAccount(2) });
      const terminal = tweetnacl.box.keyPair();

      await expect(approveTerminalAuthRequest({ publicKey: Buffer.from(terminal.publicKey).toString('base64') }))
        .rejects.toMatchObject({ code: 'account_key_provisioning_unavailable' });
      expect(responses).toEqual([]);
    });
  });

  it.each(['e2ee', 'plain'] as const)('preserves genuine data-key approval for %s accounts', async (mode) => {
    await withApprovalServer({ mode }, async ({ responses, profileReads }) => {
      const machineKey = mode === 'e2ee' ? currentMachineKey : new Uint8Array(32).fill(4);
      await writeCredentialsDataKey({
        token: tokenForAccount(2), machineKey,
        publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
      });
      const terminal = tweetnacl.box.keyPair();

      await approveTerminalAuthRequest({ publicKey: Buffer.from(terminal.publicKey).toString('base64') });

      expect(responses).toHaveLength(1);
      expect(openApprovedResponse(responses[0], terminal)).toEqual({ type: 'dataKey', key: machineKey, authenticated: false });
      expect(profileReads).toEqual(mode === 'e2ee' ? [accountId] : []);
    });
  });

  it('approves a genuine legacy recovery secret when an older server has no published content key', async () => {
    await withApprovalServer({ mode: 'e2ee', legacyProfile: true }, async ({ responses }) => {
      await writeCredentialsLegacy({ token: tokenForAccount(2), secret: currentSecret });
      const terminal = tweetnacl.box.keyPair();

      await approveTerminalAuthRequest({ publicKey: Buffer.from(terminal.publicKey).toString('base64') });

      expect(responses).toHaveLength(1);
      expect(openApprovedResponse(responses[0], terminal)).toEqual({ type: 'dataKey', key: currentMachineKey, authenticated: false });
    });
  });

  it('refuses to provision when the current account mode cannot be loaded', async () => {
    await withApprovalServer({ mode: 'unknown' }, async ({ responses }) => {
      await writeCredentialsLegacy({ token: tokenForAccount(2), secret: currentSecret });
      const terminal = tweetnacl.box.keyPair();

      await expect(approveTerminalAuthRequest({ publicKey: Buffer.from(terminal.publicKey).toString('base64') }))
        .rejects.toMatchObject({ code: 'account_key_provisioning_unavailable' });
      expect(responses).toEqual([]);
    });
  });

  it('provisions token-only authorization to an explicitly capable terminal in a plain account', async () => {
    await withApprovalServer({ mode: 'plain', supportsTokenOnly: true }, async ({ responses, profileReads }) => {
      await writeCredentialsTokenOnly({ token: tokenForAccount(2) });
      const terminal = tweetnacl.box.keyPair();

      await approveTerminalAuthRequest({ publicKey: Buffer.from(terminal.publicKey).toString('base64') });

      expect(responses).toHaveLength(1);
      expect(openApprovedResponse(responses[0], terminal)).toEqual({ type: 'tokenOnly', authenticated: false });
      expect(openApprovedResponse(responses[0], terminal, 'v3')).toBeNull();
      expect(profileReads).toEqual([]);
    });
  });

  it.each([false, undefined])('refuses token-only approval without explicit reader support: %s', async (supportsTokenOnly) => {
    await withApprovalServer({ mode: 'plain', supportsTokenOnly }, async ({ responses }) => {
      await writeCredentialsTokenOnly({ token: tokenForAccount(2) });
      const terminal = tweetnacl.box.keyPair();

      await expect(approveTerminalAuthRequest({ publicKey: Buffer.from(terminal.publicKey).toString('base64') }))
        .rejects.toMatchObject({ code: 'terminal_credential_variant_unsupported' });
      expect(responses).toEqual([]);
    });
  });

  it('refuses token-only approval in an E2EE account even when the terminal supports it', async () => {
    await withApprovalServer({ mode: 'e2ee', supportsTokenOnly: true }, async ({ responses }) => {
      await writeCredentialsTokenOnly({ token: tokenForAccount(2) });
      const terminal = tweetnacl.box.keyPair();

      await expect(approveTerminalAuthRequest({ publicKey: Buffer.from(terminal.publicKey).toString('base64') }))
        .rejects.toMatchObject({ code: 'account_key_provisioning_unavailable' });
      expect(responses).toEqual([]);
    });
  });
});
