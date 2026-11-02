import { describe, expect, it } from 'vitest';
import { ConnectedServiceBindingsV1Schema } from '@happier-dev/protocol';
import { projectProviderObservedAccountMetadata } from './providerObservedAccountMetadata';

describe('provider-observed account metadata', () => {
  const binding = { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'fallback' };
  const metadata = { connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': binding } }, other: 'preserved' };
  const observation = { serviceId: 'claude-subscription' as const, groupId: 'pool', profileId: 'observed' };

  it('publishes explicit applied account evidence without changing group fallback or selection', () => {
    const next = projectProviderObservedAccountMetadata(metadata, observation);
    expect(ConnectedServiceBindingsV1Schema.parse(next.connectedServices).bindingsByServiceId['claude-subscription']).toEqual({
      ...binding, appliedProfileId: 'observed',
    });
    expect(next.other).toBe('preserved');
    expect(metadata.connectedServices.bindingsByServiceId['claude-subscription']).toEqual(binding);
  });

  it('does not overwrite a changed selection or a missing binding', () => {
    expect(projectProviderObservedAccountMetadata(metadata, { ...observation, groupId: 'other' })).toBe(metadata);
    expect(projectProviderObservedAccountMetadata({}, observation)).toEqual({});
  });
});
