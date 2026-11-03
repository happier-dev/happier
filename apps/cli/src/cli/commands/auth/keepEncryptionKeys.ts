import { isAccountModeDowngradeUnverifiedError } from '@happier-dev/sync-client';
import { cmd, fail, gray, neutral, ok, warn } from '@happier-dev/cli-common/output';

import { fetchAccountEncryptionCurrentnessFromServer } from '@/api/client/accountEncryptionCurrentness';
import { configuration } from '@/configuration';
import { readAccountE2eeCustody, readStoredCredentialsForServerId, writeAccountE2eeCustodyForServerId } from '@/persistence';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';

/**
 * The person's one local confirmation that moves this computer's active keys
 * to history after the Account was switched to unencrypted elsewhere. A Home's
 * report alone never does this; removing keys stays a separate decision.
 */
export async function handleAuthKeepEncryptionKeys(argv: string[] = [], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await applyServerSelectionFromArgs(argv);
  const serverId = configuration.activeServerId;
  const credentials = await readStoredCredentialsForServerId(serverId);
  if (!credentials) {
    console.log(fail('Not authenticated'));
    console.log(gray(`  Run ${cmd('happier auth login')} to sign in.`));
    return;
  }
  if (readAccountE2eeCustody(credentials) !== 'active') {
    console.log(neutral('This computer holds no active encryption keys for this Account. Nothing to change.'));
    return;
  }
  try {
    await fetchAccountEncryptionCurrentnessFromServer({ credentials: credentials, token: credentials.token, ...(signal ? { signal } : {}) });
    console.log(neutral('This Account is end-to-end encrypted. Nothing to change.'));
    return;
  } catch (error) {
    if (!isAccountModeDowngradeUnverifiedError(error)) throw error;
  }
  console.log(warn('This Account was switched to unencrypted on another device'));
  console.log(gray('  This computer still holds its encryption keys. If no one on your account made this change, answer no.'));
  const keep = await promptConfirmYesNo('Keep this computer\'s keys for your older encrypted history and continue unencrypted?',
    { default: 'no', ...(signal ? { signal } : {}) });
  if (!keep) {
    console.log(gray('  Nothing changed. Account writes from this computer stay paused.'));
    return;
  }
  if (!await writeAccountE2eeCustodyForServerId(serverId, credentials.token, 'historical')) {
    throw new Error('Stored credentials changed while confirming. Run the command again.');
  }
  console.log(ok('Kept the keys for older encrypted history'));
  console.log(gray(`  A running daemon applies this when it reconnects; run ${cmd('happier daemon restart')} to apply it now.`));
}
