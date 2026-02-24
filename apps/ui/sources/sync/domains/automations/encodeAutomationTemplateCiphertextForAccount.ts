import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol';

import type { AutomationTemplate } from './automationTypes';
import { encodeAutomationTemplateForTransport } from './automationTemplateTransport';

export async function encodeAutomationTemplateCiphertextForAccount(params: Readonly<{
  credentials: AuthCredentials;
  template: AutomationTemplate;
  encryptRaw: (value: unknown) => Promise<string>;
}>): Promise<string> {
  const response = await serverFetch('/v1/account/encryption', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${params.credentials.token}`,
      'Content-Type': 'application/json',
    },
  }, { includeAuth: false });

  if (!response.ok) {
    throw new Error(`Failed to fetch account encryption mode (${response.status})`);
  }

  const json: unknown = await response.json();
  const parsed = AccountEncryptionModeResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error('Failed to parse account encryption mode response');
  }

  const accountMode = parsed.data.mode === 'plain' ? 'plain' : 'e2ee';
  return await encodeAutomationTemplateForTransport({
    accountMode,
    template: params.template,
    encryptRaw: params.encryptRaw,
  });
}

