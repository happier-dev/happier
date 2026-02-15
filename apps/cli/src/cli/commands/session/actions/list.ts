import chalk from 'chalk';

import { listActionSpecs } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { serializeActionSpec } from './serializeActionSpec';

export async function cmdSessionActionsList(argv: string[]): Promise<void> {
  const json = wantsJson(argv);
  const actionSpecs = listActionSpecs().map(serializeActionSpec);

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_actions_list', data: { actionSpecs } });
    return;
  }

  console.log(chalk.green('✓'), 'actions listed');
  for (const spec of listActionSpecs()) {
    console.log(`- ${spec.id}: ${spec.title}`);
  }
}

