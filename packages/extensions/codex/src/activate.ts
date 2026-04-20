import type { ExtensionApiV1 } from '@happier-dev/extension-sdk';

import { CODEX_BACKEND_DEFINITION } from './protocol/backendDefinition.js';
import { CODEX_PROVIDER_DEFINITION } from './protocol/providerDefinition.js';

type ExtensionApiForCodexV1 = Pick<ExtensionApiV1, 'registerBackend' | 'registerProvider'>;

export function activate(api: ExtensionApiForCodexV1): void {
  api.registerProvider(CODEX_PROVIDER_DEFINITION);
  api.registerBackend(CODEX_BACKEND_DEFINITION);
}
