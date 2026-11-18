import { expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

it('declares a configured durable-push PR lifecycle with a registered setup and authenticated receiver', async () => {
  const event = PLUGIN_MANIFEST.contributes.events.find(({ id }) => id === 'automation/pull-request-lifecycle-v1');
  expect(event?.automation?.source).toMatchObject({ sourceContractVersion: 1, supportedObservationTransports: ['durablePush'],
    setupActionRef: { pluginId: PLUGIN_MANIFEST.id, localId: 'bitbucket/setup-repository-event' },
    webhookContributionRef: { pluginId: PLUGIN_MANIFEST.id, localId: 'bitbucket-events' },
  });
  const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  try {
    expect(kit.registration('actions', 'bitbucket/setup-repository-event')).toEqual(expect.any(Function));
    expect(kit.registration('actions', 'bitbucket/accept-webhook')).toEqual(expect.any(Function));
    expect(PLUGIN_MANIFEST.contributes.webhooks).toContainEqual(expect.objectContaining({ id: 'bitbucket-events',
      verifier: { kind: 'bitbucket_hmac_sha256_v1', routing: 'accountEndpoint' } }));
  } finally { await kit.dispose(); }
});
