import chalk from 'chalk';

import { listActionSpecsForCatalogSurface, serializeActionSpec } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { isActionEnabledByEnv } from '@/settings/actionsSettings';
import type { StoredCredentials } from '@/persistence';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';

export async function cmdSessionActionsList(
  argv: string[],
  deps?: Readonly<{ readCredentialsFn?: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const credentials = deps?.readCredentialsFn ? await deps.readCredentialsFn() : null;
  await ensureCliActionPolicySettings(credentials);
  const availableSpecs = listActionSpecsForCatalogSurface({
    surface: 'cli',
    isActionEnabled: (id) => isActionEnabledByEnv(id, { surface: 'cli', placement: null }),
  });
  const actionSpecs = availableSpecs.map(serializeActionSpec);

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_actions_list', data: { actionSpecs } });
    return;
  }

  console.log(chalk.green('✓'), 'actions listed');
  for (const spec of availableSpecs) {
    console.log(`- ${spec.id}: ${spec.title}`);
  }
}
