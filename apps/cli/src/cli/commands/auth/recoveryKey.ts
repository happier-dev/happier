import { parseRecoveryKey } from '@happier-dev/protocol/auth/recoveryKey';

import { assertCommandArguments, readFlagValue } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';

export async function handleRecoveryKeyValidation(args: string[]): Promise<void> {
  const kind = 'auth_recovery_key_validate';
  try {
    assertCommandArguments(args, {
      usage: 'Usage: happier auth recovery-key validate --key <recovery-key> [--json]',
      startIndex: 0,
      booleanFlags: ['--json'],
      valueFlags: ['--key'],
      maxPositionals: 0,
    });
    let key = readFlagValue(args, '--key');
    if (!key && !wantsJson(args)) {
      const { promptSecretInput } = await import('@/terminal/prompts/promptInput');
      key = await promptSecretInput('Recovery key: ');
    }
    if (!key) throw new Error('invalid_arguments');
    const parsed = parseRecoveryKey(key);
    if (!parsed.ok) {
      const data = { ok: false as const, reason: parsed.reason };
      if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
      else {
        console.error(`Invalid recovery key (${parsed.reason}).`);
        process.exitCode = 1;
      }
      return;
    }
    parsed.bytes.fill(0);
    const data = { ok: true as const };
    if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
    else console.log('Recovery key format is valid. Keep it private: anyone with it may be able to recover the Account.');
  } catch {
    const error = { code: 'invalid_arguments', message: 'Usage: happier auth recovery-key validate --key <recovery-key> [--json]' };
    if (wantsJson(args)) await printJsonEnvelope({ ok: false, kind, error });
    else {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
