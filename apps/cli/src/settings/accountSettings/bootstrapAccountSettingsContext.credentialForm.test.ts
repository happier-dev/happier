import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveAccountMachineKeyFromRecoverySecret,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol/crypto/accountScopedCipher';
import { readSessionRuntimeFailureCause } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import nacl from 'tweetnacl';
import { expect, it } from 'vitest';

import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import type { Credentials } from '@/persistence';
import {
  deriveSettingsSecretsKeyForCredentials,
  deriveSettingsSecretsReadKeysForCredentials,
} from '@/settings/secrets/settingsSecretsKey';
import {
  bootstrapAccountSettingsContext,
  resetInMemoryAccountSettingsContextForTests,
} from '@/settings/accountSettings/bootstrapAccountSettingsContext';

it.each([
  ['legacy', 'dataKey'],
  ['dataKey', 'legacy'],
] as const)('boots a second hosted Session at revision 1 after switching from %s to %s credentials', async (first, second) => {
  const home = await mkdtemp(join(tmpdir(), 'settings-credential-form-'));
  try {
    const recoverySecret = nacl.randomBytes(32);
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);
    const material = {
      legacy: { type: 'legacy', secret: recoverySecret },
      dataKey: { type: 'dataKey', machineKey, publicKey: nacl.box.keyPair.fromSecretKey(machineKey).publicKey },
    } satisfies Record<typeof first, Credentials['encryption']>;
    const token = `test.${Buffer.from(JSON.stringify({ sub: 'same-account' })).toString('base64url')}.test`;
    const credentials = {
      legacy: { token, encryption: material.legacy },
      dataKey: { token, encryption: material.dataKey },
    } satisfies Record<typeof first, Credentials>;
    expect(Buffer.from(deriveSettingsSecretsKeyForCredentials(credentials.legacy))
      .equals(deriveSettingsSecretsKeyForCredentials(credentials.dataKey))).toBe(true);
    expect(deriveSettingsSecretsReadKeysForCredentials(credentials.legacy)).toHaveLength(2);
    expect(deriveSettingsSecretsReadKeysForCredentials(credentials.dataKey)).toHaveLength(1);

    const settingsContent = {
      t: 'encrypted',
      c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material: material.dataKey,
        payload: { themePreference: 'dark' }, randomBytes: nacl.randomBytes }),
    } as const;
    const start = (startingCredentials: Credentials) => runAddedHostedSession({
      environment: { HAPPIER_ACCOUNT_SETTINGS_MODE: 'auto' },
      workingDirectory: home,
      end() {},
    }, async () => {
      try {
        const context = await bootstrapAccountSettingsContext({
          credentials: startingCredentials,
          mode: 'fast',
          refresh: 'force',
          minSettingsVersion: 1,
          expectedAccountEncryptionMode: 'e2ee',
          deps: {
            resolveCachePath: () => join(home, 'settings.json'),
            fetchFromServer: async () => ({ settingsContent, settingsVersion: 1 }),
          },
        });
        const settled = context.whenRefreshed ? await context.whenRefreshed : context;
        return {
          settingsVersion: settled.settingsVersion,
          theme: settled.settings.themePreference,
          readKeyCount: settled.settingsSecretsReadKeys.length,
        };
      } catch (error) {
        const branch = error && typeof error === 'object' && 'branch' in error ? error.branch : undefined;
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        return { failure: readSessionRuntimeFailureCause(error), branch, code };
      }
    });

    expect(await start(credentials[first])).toEqual({
      settingsVersion: 1, theme: 'dark', readKeyCount: first === 'legacy' ? 2 : 1,
    });
    expect(await start({ token, encryption: { type: 'legacy', secret: nacl.randomBytes(32) } }))
      .toMatchObject({ code: 'ACCOUNT_SETTINGS_DECRYPT_FAILED' });
    expect(await start(credentials[second])).toEqual({
      settingsVersion: 1, theme: 'dark', readKeyCount: second === 'legacy' ? 2 : 1,
    });
  } finally {
    resetInMemoryAccountSettingsContextForTests();
    await rm(home, { recursive: true, force: true });
  }
});
