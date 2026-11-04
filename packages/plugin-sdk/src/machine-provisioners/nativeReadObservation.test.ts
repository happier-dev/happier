import { describe, expect, it } from 'vitest';
import * as provisioners from './index.js';

describe('native machine read observation', () => {
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
