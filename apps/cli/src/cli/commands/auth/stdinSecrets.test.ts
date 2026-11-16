import { redactProcessArgv } from '@/processes/redaction/redactProcessCommand';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { expandAuthSecretsFromStdin } from './stdinSecrets';

describe('auth stdin secret document', () => {
  it('materializes representative auth secrets without requiring secret-bearing process argv', async () => {
    const password = 'password-from-stdin';
    const recoveryKey = 'recovery-from-stdin';
    const invitationToken = 'invitation-from-stdin';
    const verificationToken = 'verification-from-stdin';
    const processArgv = ['happier', 'auth', 'password', 'enroll', '--secrets-json-stdin'];
    const expanded = await expandAuthSecretsFromStdin(
      processArgv.slice(2),
      Readable.from([JSON.stringify({
        v: 1,
        secrets: { password, recoveryKey, invitationToken, verificationToken,
          currentPassword: 'fixture-current', newPassword: 'fixture-new', resetToken: 'fixture-reset' },
      })]),
    );

    expect(processArgv.join(' ')).not.toContain(password);
    expect(processArgv.join(' ')).not.toContain(recoveryKey);
    expect(processArgv.join(' ')).not.toContain(invitationToken);
    expect(processArgv.join(' ')).not.toContain(verificationToken);
    expect(expanded).toEqual(expect.arrayContaining([
      '--password', password,
      '--key', recoveryKey,
      '--invitation-token', invitationToken,
      '--verification-token', verificationToken,
      '--current-password', 'fixture-current',
      '--new-password', 'fixture-new',
      '--token', 'fixture-reset',
    ]));
  });

  it('rejects unknown fields and argv/stdin ambiguity', async () => {
    await expect(expandAuthSecretsFromStdin(
      ['password', 'change', '--secrets-json-stdin'],
      Readable.from(['{"v":1,"secrets":{"unknown":"secret"}}']),
    )).rejects.toThrow('Invalid auth secret field');
    await expect(expandAuthSecretsFromStdin(
      ['password', 'change', '--new-password', 'argv-secret', '--secrets-json-stdin'],
      Readable.from(['{"v":1,"secrets":{"newPassword":"stdin-secret"}}']),
    )).rejects.toThrow('Do not combine');
  });

  it('leaves secret-size validation to the canonical consuming protocol instead of inventing a stdin limit', async () => {
    const password = `valid-consumer-owned-prefix-${'x'.repeat(70 * 1024)}`;
    const expanded = await expandAuthSecretsFromStdin(
      ['email', 'login', '--secrets-json-stdin'],
      Readable.from([JSON.stringify({ v: 1, secrets: { password } })]),
    );

    expect(expanded).toEqual(['email', 'login', '--password', password]);
  });

  it('redacts every retained secret-bearing compatibility flag from diagnostics', () => {
    const secrets = ['PAT_VALUE_123', 'PASS_VALUE_123', 'KEY_VALUE_123', 'REC_VALUE_123', 'INV_VALUE_123', 'VER_VALUE_123', 'PROOF_VALUE_123'];
    const redacted = redactProcessArgv([
      '--api-token', secrets[0], '--password', secrets[1], '--recovery-key', secrets[2],
      '--key', secrets[3], `--invitation-token=${secrets[4]}`, '--verification-token', secrets[5],
      '--reauth-proof-json', secrets[6],
    ]).join(' ');
    for (const secret of secrets) expect(redacted).not.toContain(secret);
  });
});
