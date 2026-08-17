import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ManagedDependencyDescriptorSchema as ProtocolManagedDependencyDescriptorSchema,
  type ManagedDependencyDescriptor as ProtocolManagedDependencyDescriptor,
} from '../managedDependencies.js';
import type {
  ManagedExecutableRef as ProtocolManagedExecutableRef,
  PluginManagedDependencyContributionV2,
} from '@happier-dev/protocol';

import * as managedServices from './index.js';
import {
  ManagedDependencyDescriptorSchema,
  type ManagedDependencyContribution,
  type ManagedDependencyDescriptor,
  type ManagedExecutableRef,
} from './index.js';

describe('managed-services canonical projections', () => {
  it('re-exports the existing managed-dependency schema by runtime identity', () => {
    expect(ManagedDependencyDescriptorSchema).toBe(ProtocolManagedDependencyDescriptorSchema);
  });

  it('aliases existing Protocol and SDK declaration types without restating them', () => {
    expectTypeOf<ManagedDependencyDescriptor>()
      .toEqualTypeOf<ProtocolManagedDependencyDescriptor>();
    expectTypeOf<ManagedDependencyContribution>()
      .toEqualTypeOf<PluginManagedDependencyContributionV2>();
    expectTypeOf<ManagedExecutableRef>().toEqualTypeOf<ProtocolManagedExecutableRef>();
  });

  it('does not project host-private request-auth capability-file authority', () => {
    expect(Object.keys(managedServices)).not.toEqual(expect.arrayContaining([
      'ConnectedAccountRequestAuthCapabilityDocumentV2',
      'parseConnectedAccountRequestAuthCapabilityDocument',
      'readConnectedAccountRequestAuthCapabilityFile',
      'resolveConnectedAccountRequestAuthCapabilityPath',
    ]));
  });
});
