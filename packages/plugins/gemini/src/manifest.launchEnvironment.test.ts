import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('Gemini launch-environment authority', () => {
  it('declares every environment key emitted by the native Gemini session runtime', () => {
    const processAccess = PLUGIN_MANIFEST.hostAccess.required.find(
      (request) => request.id === 'gemini-process',
    );

    expect(processAccess?.scope.envKeys).toEqual([
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GOOGLE_GENAI_USE_VERTEXAI',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_LOCATION',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'HAPPIER_GEMINI_ACP_AUTH_METHOD',
      'HAPPIER_GEMINI_ACP_AUTH_META',
      'GEMINI_CLI_HOME',
      'HOME',
      'XDG_CONFIG_HOME',
    ]);
  });
});
