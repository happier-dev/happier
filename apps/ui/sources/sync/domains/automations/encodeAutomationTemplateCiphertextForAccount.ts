import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';

import type { AutomationTemplate } from './automationTypes';
import { encodeAutomationTemplateForTransport } from './automationTemplateTransport';

export async function encodeAutomationTemplateCiphertextForAccount(params: Readonly<{
  credentials: AuthCredentials;
  template: AutomationTemplate;
  encryptRaw: (value: unknown) => Promise<string>;
}>): Promise<string> {
  const mode = await fetchAccountEncryptionMode(params.credentials);
  const accountMode = mode.mode === 'plain' ? 'plain' : 'e2ee';
  return await encodeAutomationTemplateForTransport({
    accountMode,
    template: params.template,
    encryptRaw: params.encryptRaw,
  });
}
