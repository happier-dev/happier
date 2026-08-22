import type { StoredCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';

export async function ensureCliActionPolicySettings(credentials: StoredCredentials | null | undefined): Promise<void> {
  if (!credentials) return;
  await bootstrapAccountSettingsContext({
    credentials,
    mode: 'fast',
  });
}
