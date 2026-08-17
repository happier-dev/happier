import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';

import type { AutomationTemplate } from './automationTypes';
import { encodeAutomationTemplateForTransport } from './automationTemplateTransport';
import { AutomationTemplateEncryptionMaterialUnavailableError } from './automationTemplateAvailability';

export async function encodeAutomationTemplateCiphertextForAccount(params: Readonly<{
  credentials: AuthCredentials;
  template: AutomationTemplate;
  encryptRaw?: (value: unknown) => Promise<string>;
}>): Promise<string> {
  const mode = await fetchAccountEncryptionMode(params.credentials);
  const accountMode = mode.mode === 'plain' ? 'plain' : 'e2ee';
  try {
    return await encodeAutomationTemplateForTransport({
      accountMode,
      template: params.template,
      ...(params.encryptRaw ? { encryptRaw: params.encryptRaw } : {}),
    });
  } catch (error) {
    if (
      accountMode === 'e2ee'
      || (
        error instanceof Error
        && error.message === 'encryptRaw is required to encode encrypted automation templates'
      )
    ) {
      throw new AutomationTemplateEncryptionMaterialUnavailableError();
    }
    throw error;
  }
}
