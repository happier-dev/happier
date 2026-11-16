import { describe, expect, it } from 'vitest';

import { ingestPluginManifestV2 } from '../manifest/ingest.js';
import { PluginContributesV2Schema } from './v2.js';

const declaration = { id: 'capture-launch', environmentNames: ['DATABASE_URL', '_PRIVATE_2'] };

describe('service launch environment manifest declarations', () => {
  it('admits names through the canonical manifest family while keeping private values out', () => {
    expect(PluginContributesV2Schema.parse({ serviceLaunchEnvironments: [declaration] })
      .serviceLaunchEnvironments).toEqual([declaration]);
    expect(ingestPluginManifestV2({
      schemaVersion: 2,
      id: 'com.acme.capture',
      version: '1.0.0',
      displayName: 'Capture fixture',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/plugin.js' },
      hostAccess: { required: [], optional: [] },
      contributes: { serviceLaunchEnvironments: [declaration] },
    })).toMatchObject({ ok: true, manifest: { contributes: { serviceLaunchEnvironments: [declaration] } } });

    expect(PluginContributesV2Schema.safeParse({ serviceLaunchEnvironments: [{
      ...declaration, projectedEnvironment: { DATABASE_URL: 'private-value' },
    }] }).success).toBe(false);
  });

  it('rejects invalid environment names and executable runtime data at the serialized boundary', () => {
    for (const name of ['DATABASE-URL', '1_DATABASE_URL', 'DATABASE_URL\n']) {
      expect(PluginContributesV2Schema.safeParse({ serviceLaunchEnvironments: [{
        ...declaration, environmentNames: [name],
      }] }).success).toBe(false);
    }
    expect(PluginContributesV2Schema.safeParse({ serviceLaunchEnvironments: [{
      ...declaration, runtime: { prepare: () => ({ kind: 'unchanged' }) },
    }] }).success).toBe(false);
  });
});
