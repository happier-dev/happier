import chalk from 'chalk';

import { getSerializedActionSpecForSurface } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { readCommandPositionals } from '@/cli/commands/shared/argvFlags';
import { isActionEnabledByEnv } from '@/settings/actionsSettings';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import type { StoredCredentials } from '@/persistence';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';

export async function cmdSessionActionsDescribe(
  argv: string[],
  deps?: Readonly<{ readCredentialsFn?: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const [id = ''] = readCommandPositionals(argv, { startIndex: 2 });
  if (!id) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.actionsDescribe}`);
  }

  const credentials = deps?.readCredentialsFn ? await deps.readCredentialsFn() : null;
  await ensureCliActionPolicySettings(credentials);

  let serialized = null;
  try {
    serialized = getSerializedActionSpecForSurface({
      id: id as any,
      surface: 'cli',
      isActionEnabled: (actionId) => isActionEnabledByEnv(actionId, { surface: 'cli', placement: null }),
    });
  } catch {
    serialized = null;
  }

  if (!serialized) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_actions_describe', error: { code: 'unsupported' } });
      return;
    }
    throw new Error(`Unknown or disabled action: ${id}`);
  }

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_actions_describe', data: { actionSpec: serialized } });
    return;
  }

  console.log(chalk.green('✓'), 'action described');
  await writeJsonStdout(serialized, { pretty: true });
}
