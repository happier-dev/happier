import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createOpenCodeExternalSessionObservationContribution } from './observation.js';

describe('OpenCode external-session observation identity', () => {
  it('shares the endpoint resource while keeping directory links distinct', () => {
    const endpoint = 'http://127.0.0.1:49196';
    const contribution = createOpenCodeExternalSessionObservationContribution({
      env: { HAPPIER_OPENCODE_SERVER_URL: endpoint },
    });
    const first = contribution.describeResource({
      source: { kind: 'opencodeServer', baseUrl: endpoint, directory: '/fixture/project-a' },
      remoteSessionId: 'opencode-native-session-fixture', linkData: {},
    });
    const otherDirectory = contribution.describeResource({
      source: { kind: 'opencodeServer', baseUrl: endpoint, directory: '/fixture/project-b' },
      remoteSessionId: 'opencode-native-session-fixture', linkData: {},
    });

    expect(first.resourceKey).toBe(otherDirectory.resourceKey);
    expect(first.linkKey).not.toBe(otherDirectory.linkKey);
  });

  it('prefers native observation without registering external-session hooks', async () => {
    const activateSource = await readFile(
      new URL('../../../../activate.ts', import.meta.url),
      'utf8',
    );

    expect(activateSource).not.toMatch(/\bregisterExternalSessionHooks\s*\(/u);
    expect(activateSource).not.toMatch(/\bregisterExternalSessionHookRecipes\s*\(/u);
  });
});
