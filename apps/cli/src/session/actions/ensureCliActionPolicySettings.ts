import type { Credentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';

export async function ensureCliActionPolicySettings(credentials: Credentials | null | undefined): Promise<void> {
  if (!credentials) return;
  await bootstrapAccountSettingsContext({
    credentials,
    mode: 'fast',
  });
}
