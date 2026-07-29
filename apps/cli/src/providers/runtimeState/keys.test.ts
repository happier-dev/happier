import { describe, expect, it } from 'vitest';

import { ProviderEndpointRuntimeStateRecordV1Schema } from '@happier-dev/protocol';

import {
  replaceProviderRuntimeStateRecord,
  serializeProviderRuntimeStateRecordKey,
} from './keys';

const endpointRecord = (lastAccessedAt: number) => ProviderEndpointRuntimeStateRecordV1Schema.parse({
  key: {
    machineId: 'machine_a', connectionId: 'pc_a', endpointTemplateId: 'responses',
    endpointFingerprint: 'endpoint-observation:v1:a',
    observationAuthorizationFingerprint: 'observation-authorization:v1:a',
  },
  state: { status: 'available' as const, activity: 'idle' as const, observedAt: 1 },
  lastAccessedAt,
});

describe('provider runtime-state keys', () => {
  it('replaces the exact semantic key without creating a duplicate', () => {
    const replaced = replaceProviderRuntimeStateRecord(
      'endpointHealth',
      [endpointRecord(1)],
      endpointRecord(2),
    );
    expect(replaced).toEqual([endpointRecord(2)]);
  });

  it('uses collision-safe typed key serialization for every record family', () => {
    expect(JSON.parse(serializeProviderRuntimeStateRecordKey('endpointHealth', endpointRecord(1))))
      .toEqual([
        'machine_a', 'pc_a', 'responses',
        'endpoint-observation:v1:a', 'observation-authorization:v1:a',
      ]);
    expect(() => replaceProviderRuntimeStateRecord(
      'endpointHealth',
      [endpointRecord(1), endpointRecord(2)],
      endpointRecord(3),
    )).toThrowError(/duplicate/u);
  });
});
