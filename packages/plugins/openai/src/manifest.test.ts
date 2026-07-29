import {
  derivePluginDaemonContributionRegistrationRights,
  ingestPluginManifestV2,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('OpenAI Voice plugin manifest', () => {
  it('owns the standard OpenAI API-key Connected Account selected by qualified consumers', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors).toEqual([{
      id: 'openai',
      title: 'OpenAI API key',
      authentication: {
        defaultModeId: 'api-key',
        modes: [{
          id: 'api-key',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [{
            id: 'token',
            title: 'OpenAI API key',
            schema: { type: 'string', minLength: 1 },
            secret: true,
          }],
        }],
      },
    }]);
  });

  it('publishes its API-key descriptor for daemon runtime activation', () => {
    expect(derivePluginDaemonContributionRegistrationRights(
      PLUGIN_MANIFEST.contributes,
    )).toContainEqual(expect.objectContaining({
      family: 'connectedAccountDescriptors',
      localId: 'openai',
    }));
  });

  it('binds the realtime client-auth action to the exact qualified OpenAI purpose', () => {
    expect(PLUGIN_MANIFEST.hostAccess.required).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'realtime-openai-account',
        capability: 'connectedAccounts',
        scope: {
          serviceRefs: ['openai'],
          operations: ['select', 'use'],
          materializationKinds: ['httpHeaders'],
        },
      }),
      expect.objectContaining({
        id: 'realtime-openai-api',
        capability: 'network',
        scope: {
          targets: [{ kind: 'fixedOrigin', origin: 'https://api.openai.com' }],
          methods: ['POST'],
        },
      }),
      expect.objectContaining({
        id: 'realtime-openai-codex-account',
        capability: 'connectedAccounts',
        scope: {
          serviceRefs: [{
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
          }],
          operations: ['select', 'use'],
          materializationKinds: ['httpHeaders'],
        },
      }),
    ]));
    expect(PLUGIN_MANIFEST.contributes.actions).toContainEqual(expect.objectContaining({
      id: 'mint-realtime-client-auth',
      surfaces: ['ui'],
      hostAccess: ['realtime-openai-account', 'realtime-openai-api'],
    }));
    expect(PLUGIN_MANIFEST.contributes.actions).toContainEqual(expect.objectContaining({
      id: 'mint-realtime-client-auth-with-codex-oauth',
      surfaces: ['ui'],
      hostAccess: ['realtime-openai-codex-account', 'realtime-openai-api'],
    }));
  });
});
