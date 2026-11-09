import { describe, expect, it } from 'vitest';
import * as provisioners from './index.js';

describe('native machine read observation', () => {
  it('round-trips the same deletion rule, native date and explicit withdrawal through the public schemas', () => {
    const ruleOnly: provisioners.MachineProvisionerDeletionNoticeV1 = {
      kind: 'stopped-storage', rule: { kind: 'after-stop', afterMs: 14 * 24 * 60 * 60 * 1_000 },
      consequence: 'disk-deleted',
    };
    const retention: provisioners.MachineProvisionerContributionV1['retention'] = {
      supportedIntents: ['start', 'stop'], deletionNotices: [ruleOnly],
    };
    const options = provisioners.MachineProvisionerOptionsResultV1Schema.parse({
      dimensions: { size: [], image: [], location: [], network: [], duration: [] },
      base: { launch: {}, retention },
    });
    expect(options.base?.retention).toEqual(retention);
    for (const deletionNotices of [[{ ...ruleOnly, at: 1_000 }], []]) {
      const observation = provisioners.observeMachineProvisionerNativeRead(125, {
        kind: 'present', power: deletionNotices.length ? 'stopped' : 'running', deletionNotices,
      });
      expect(provisioners.MachineProvisionerObservationV1Schema.parse(JSON.parse(JSON.stringify(observation))))
        .toEqual({ observedAt: 125, availability: 'present',
          power: deletionNotices.length ? 'stopped' : 'running', deletionNotices });
    }
  });

  it('keeps proven absence distinct from an uncertain native read and preserves native facts', () => {
    const absent = provisioners.observeMachineProvisionerNativeRead(123, {
      kind: 'absent', storage: 'lost', billing: { location: 'cloud', stoppedBilling: 'not-billed' },
    });
    const unknown = provisioners.observeMachineProvisionerNativeRead(124, {
      kind: 'unknown', reason: 'authorization', nativeCause: { httpStatusClass: '4xx' },
    });
    const present = provisioners.observeMachineProvisionerNativeRead(125, {
      kind: 'present', power: 'suspended', storage: 'retained', nativeExpiry: 456,
    });
    expect(provisioners.MachineProvisionerObservationV1Schema.parse(absent)).toEqual({
      observedAt: 123, availability: 'absent', storage: 'lost', billing: { location: 'cloud', stoppedBilling: 'not-billed' },
    });
    expect(provisioners.MachineProvisionerObservationV1Schema.parse(unknown)).toEqual({
      observedAt: 124, availability: 'unavailable', reason: 'authorization', nativeCause: { httpStatusClass: '4xx' },
    });
    expect(provisioners.MachineProvisionerObservationV1Schema.parse(present)).toEqual({
      observedAt: 125, availability: 'present', power: 'suspended', storage: 'retained', nativeExpiry: 456,
    });
  });
});
