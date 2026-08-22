import { fileURLToPath } from 'node:url';

import { ConnectedServiceIdSchema } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { runPackedPluginTest } from './packedTest';

const consumerFixtureRoot = fileURLToPath(
  new URL('./fixtures/connectedAccountsConformance', import.meta.url),
);
const producerFixtureRoot = fileURLToPath(
  new URL('./fixtures/connectedAccountsConformanceProducer', import.meta.url),
);
const collisionPeerFixtureRoot = fileURLToPath(
  new URL('./fixtures/connectedAccountsCollisionPeer', import.meta.url),
);

const consumerPluginId = 'acme.connected-accounts-conformance-consumer';
const producerPluginId = 'acme.connected-accounts-conformance-producer';
const collisionPeerPluginId = 'acme.connected-accounts-collision-peer';

describe('packed public Connected Accounts conformance', () => {
  it('keeps producer registration separate from consumer materialization and preserves only durable selection across restart', async () => {
    const result = await runPackedPluginTest({
      projectRoot: consumerFixtureRoot,
      prerequisiteLocators: [producerFixtureRoot, collisionPeerFixtureRoot],
      connectedAccountsFixturePluginId: consumerPluginId,
      connectedAccountPurposeRemovalReaddActionLocalId: 'verify-removal-readd',
      expectedRedactedValues: [
        'Bearer packed-header-secret',
        'packed-environment-secret',
        'packed-file-secret',
      ],
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      mode: 'packed',
      pluginId: consumerPluginId,
      prerequisitePlugins: [
        { pluginId: producerPluginId },
        { pluginId: collisionPeerPluginId },
      ],
      initialInvocation: {
        actionId: `${consumerPluginId}/verify`,
        result: {
          phase: 'initial',
          binding: {
            purpose: 'fixed',
            service: {
              pluginId: producerPluginId,
              localId: 'vault',
            },
            account: {
              service: {
                pluginId: producerPluginId,
                localId: 'vault',
              },
              accountId: 'fixed',
            },
          },
          expectedAccountMatchedCurrentBinding: true,
          expectedAccountRejectedSupersededBinding: true,
          expectedAccountRevalidatedAfterMaterialization: true,
          groupCurrentnessRejected: true,
        },
      },
      invocation: {
        actionId: `${consumerPluginId}/verify`,
        result: {
          phase: 'replacement-generation',
          binding: {
            purpose: 'fixed',
            service: {
              pluginId: producerPluginId,
              localId: 'vault',
            },
            account: {
              service: {
                pluginId: producerPluginId,
                localId: 'vault',
              },
              accountId: 'fixed',
            },
          },
          durableSelection: true,
          rematerialized: true,
          watchWasNonDurable: true,
        },
      },
      daemon: {
        authenticatedControl: true,
        staleIncarnationRejected: true,
      },
      publicationRemovalReadd: {
        removed: true,
        readded: true,
        target: expect.objectContaining({
          plugin: expect.objectContaining({ id: consumerPluginId }),
          admission: expect.objectContaining({
            decision: 'installAndTrust',
          }),
        }),
        invocation: {
          actionId: `${consumerPluginId}/verify-removal-readd`,
          result: {
            phase: 'removal-readd',
            durableSelectionWasAbsent: true,
            rematerializedAfterReselection: true,
          },
        },
      },
    });
    if (!result.ok || !result.invocation?.result || typeof result.invocation.result !== 'object') {
      throw new Error('Packed Connected Accounts fixture did not return its selected service identity');
    }
    expect(result.publicationRemovalReadd?.target).toEqual(result.target);
    const binding = (result.invocation.result as {
      binding?: {
        service?: { pluginId?: unknown; localId?: unknown };
        account?: { service?: { pluginId?: unknown; localId?: unknown }; accountId?: unknown };
      };
    }).binding;
    const service = binding?.service;
    expect(service).toEqual({
      pluginId: producerPluginId,
      localId: 'vault',
    });
    expect(binding?.account).toEqual({
      service,
      accountId: 'fixed',
    });
    expect(ConnectedServiceIdSchema.safeParse(service?.localId).success).toBe(false);
  }, 180_000);
});
