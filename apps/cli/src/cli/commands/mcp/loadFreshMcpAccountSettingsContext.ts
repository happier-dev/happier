import type { AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { Credentials } from '@/persistence';

import type { McpCommandDeps } from './deps';

export async function loadFreshMcpAccountSettingsContext(
  credentials: Credentials,
  deps: McpCommandDeps,
): Promise<AccountSettingsContext> {
  return deps.bootstrapAccountSettingsContext({
    credentials,
    mode: 'blocking',
    refresh: 'force',
  } as const);
}
