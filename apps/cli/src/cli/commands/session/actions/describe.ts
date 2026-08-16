import chalk from 'chalk';

import { getActionSpec, serializeActionSpec } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { readCommandPositionals } from '@/cli/commands/shared/argvFlags';

export async function cmdSessionActionsDescribe(argv: string[]): Promise<void> {
  const json = wantsJson(argv);
  const [id = ''] = readCommandPositionals(argv, { startIndex: 2 });
  if (!id) {
    throw new Error('Usage: happier session actions describe <action-id> [--json]');
  }

  const spec = getActionSpec(id as any);
  const serialized = serializeActionSpec(spec);

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_actions_describe', data: { actionSpec: serialized } });
    return;
  }

  console.log(chalk.green('✓'), 'action described');
  await writeJsonStdout(serialized, { pretty: true });
}
