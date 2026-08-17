import { describe, expect, it } from 'vitest';

import {
  derivePluginDaemonContributionRegistrationRights,
  getPluginContributionCatalogEntryV2,
} from './catalog.js';
import { PluginContributesV2Schema } from './v2.js';

describe('background service contributions', () => {
  it('strictly parses descriptors and derives one daemon registration right per service', () => {
    const contributes = PluginContributesV2Schema.parse({
      backgroundServices: [
        { id: 'memory-indexer', title: 'Memory indexer' },
        { id: 'session-reconciler', title: { key: 'service.title', fallback: 'Session reconciler' } },
      ],
    });

    expect(contributes.backgroundServices).toEqual([
      { id: 'memory-indexer', title: 'Memory indexer' },
      { id: 'session-reconciler', title: { key: 'service.title', fallback: 'Session reconciler' } },
    ]);
    expect(derivePluginDaemonContributionRegistrationRights(contributes)).toEqual([
      { family: 'backgroundServices', localId: 'memory-indexer', target: { realm: 'daemon' } },
      { family: 'backgroundServices', localId: 'session-reconciler', target: { realm: 'daemon' } },
    ]);
    expect(getPluginContributionCatalogEntryV2('backgroundServices')).toMatchObject({
      activationDemand: 'registration',
      allowedRuntimeRegistration: 'backgroundServices',
      registrationHost: 'daemon',
      consumer: 'background-service-runner',
    });
  });

  it('rejects duplicate ids, unknown descriptor fields, and unknown contribution families', () => {
    expect(PluginContributesV2Schema.safeParse({
      backgroundServices: [{ id: 'same' }, { id: 'same' }],
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({
      backgroundServices: [{ id: 'indexer', schedule: '* * * * *' }],
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({
      backgroundWorkers: [{ id: 'indexer' }],
    }).success).toBe(false);
  });
});
