import { fileURLToPath } from 'node:url';

import { ConnectedServiceIdSchema } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { runPackedPluginTest } from './packedTest';

const fixtureRoot = fileURLToPath(
  new URL('./fixtures/connectedAccountsConformance', import.meta.url),
);

describe('packed public Connected Accounts conformance', () => {
  it('crosses the production invocation host and preserves only durable selection across restart', async () => {
    const result = await runPackedPluginTest({
      projectRoot: fixtureRoot,
      connectedAccountsFixturePluginId: 'acme.connected-accounts-conformance',
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
      pluginId: 'acme.connected-accounts-conformance',
        invocation: {
          actionId: 'acme.connected-accounts-conformance/verify',
          result: {
            phase: 'replacement-generation',
            service: {
              pluginId: 'acme.connected-accounts-conformance',
              localId: 'vault',
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
        invocation: {
          actionId: 'acme.connected-accounts-conformance/verify-removal-readd',
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
    const service = (result.invocation.result as {
      service?: { pluginId?: unknown; localId?: unknown };
    }).service;
    expect(service).toEqual({
      pluginId: 'acme.connected-accounts-conformance',
      localId: 'vault',
    });
    expect(ConnectedServiceIdSchema.safeParse(service?.localId).success).toBe(false);
  }, 180_000);
});
