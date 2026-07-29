import type { PluginVoiceAccountOperationService } from '@happier-dev/plugin-sdk/runtime';

import { createXaiRealtimeCredentialOperations } from './providerOperations.js';

export function createXaiRealtimeVoiceUiClient(input: Readonly<{
  createAccountOperations(signal: AbortSignal): PluginVoiceAccountOperationService;
  operations?: ReturnType<typeof createXaiRealtimeCredentialOperations>;
}>) {
  const operations = input.operations ?? createXaiRealtimeCredentialOperations();
  return Object.freeze({
    async fetchVoiceCatalog(signal?: AbortSignal | null) {
      const operationSignal = signal ?? new AbortController().signal;
      return await operations.fetchCatalogWithAccountOperations({
        accountOperations: input.createAccountOperations(operationSignal),
        catalog: 'voices',
        signal: operationSignal,
      });
    },
  });
}
