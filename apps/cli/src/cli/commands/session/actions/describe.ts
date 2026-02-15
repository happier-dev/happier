import chalk from 'chalk';

import { getActionSpec } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { serializeActionSpec } from './serializeActionSpec';

export async function cmdSessionActionsDescribe(argv: string[]): Promise<void> {
  const json = wantsJson(argv);
  const id = String(argv[2] ?? '').trim();
  if (!id) {
    throw new Error('Usage: happier session actions describe <action-id> [--json]');
  }

  const spec = getActionSpec(id as any);
  const serialized = serializeActionSpec(spec);

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_actions_describe', data: { actionSpec: serialized } });
    return;
  }

  console.log(chalk.green('✓'), 'action described');
  console.log(JSON.stringify(serialized, null, 2));
}

