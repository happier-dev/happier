import chalk from 'chalk';

import { getSerializedActionSpecForSurface } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { isActionEnabledByEnv } from '@/settings/actionsSettings';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import type { Credentials } from '@/persistence';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';

export async function cmdSessionActionsDescribe(
  argv: string[],
  deps?: Readonly<{ readCredentialsFn?: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const id = String(argv[2] ?? '').trim();
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
      printJsonEnvelope({ ok: false, kind: 'session_actions_describe', error: { code: 'unsupported' } });
      return;
    }
    throw new Error(`Unknown or disabled action: ${id}`);
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_actions_describe', data: { actionSpec: serialized } });
    return;
  }

  console.log(chalk.green('✓'), 'action described');
  console.log(JSON.stringify(serialized, null, 2));
}
