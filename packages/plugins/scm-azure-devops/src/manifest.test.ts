import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';
import { AZURE_DEVOPS_NETWORK_HOST_ACCESS_ID } from './triage/descriptor.js';

describe('Azure DevOps network authority', () => {
  it('requests read-only verbs, because nothing in this plugin writes over the host network', () => {
    const network = PLUGIN_MANIFEST.hostAccess.required
      .find((entry) => entry.id === AZURE_DEVOPS_NETWORK_HOST_ACCESS_ID);

    // Every host-network call this plugin makes goes through
    // `triage/client.ts`, whose `method` defaults to `GET` and which no
    // production caller overrides; the pull-request write path runs through the
    // declared Azure CLI process capability instead. A granted verb nothing
    // exercises is authority the user approved for nothing, so a write verb may
    // only appear here together with the exact human-confirmed mutation that
    // needs it.
    expect(network?.scope).toMatchObject({ methods: ['GET'] });
  });

  it('remains an ingestible manifest with that authority', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
  });
});
