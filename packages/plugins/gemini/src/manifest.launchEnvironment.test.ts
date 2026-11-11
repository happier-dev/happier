import { describe, expect, it } from 'vitest';

import { GEMINI_PROVIDER_OWNED_ENV_KEYS } from './agent/providerBinding.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Gemini launch-environment authority', () => {
  it('declares every environment key emitted by the native Gemini session runtime', () => {
    const processAccess = PLUGIN_MANIFEST.hostAccess.required.find(
      (request) => request.id === 'gemini-process',
    );

    expect(processAccess?.scope.envKeys).toEqual([
      ...GEMINI_PROVIDER_OWNED_ENV_KEYS, 'GEMINI_CLI_HOME', 'HOME', 'XDG_CONFIG_HOME',
    ]);
  });
});
