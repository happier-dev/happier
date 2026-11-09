import { describe, expect, it } from 'vitest';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol';
import { projectProviderObservedAccountMetadata } from './providerObservedAccountMetadata';

describe('provider-observed account metadata', () => {
  const binding = { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'fallback' };
  const metadata = { connectedServices: { v: 2, bindingsByServiceId: { 'happier.agent.claude/claude-subscription': binding } }, other: 'preserved' };
  const observation = { serviceId: 'happier.agent.claude/claude-subscription' as const, groupId: 'pool', profileId: 'observed' };

  it('publishes explicit applied account evidence without changing group fallback or selection', () => {
    const next = projectProviderObservedAccountMetadata(metadata, observation);
    expect(ConnectedServiceBindingsV2Schema.parse(next.connectedServices).bindingsByServiceId['happier.agent.claude/claude-subscription']).toEqual({
      ...binding, appliedProfileId: 'observed',
    });
    expect(next.other).toBe('preserved');
    expect(projectProviderObservedAccountMetadata(next, observation)).toBe(next);
    expect(ConnectedServiceBindingsV2Schema.parse(projectProviderObservedAccountMetadata(next, { ...observation, profileId: 'adopted' }).connectedServices).bindingsByServiceId[observation.serviceId]).toEqual({ ...binding, appliedProfileId: 'adopted' });
    expect(metadata.connectedServices.bindingsByServiceId['happier.agent.claude/claude-subscription']).toEqual(binding);
  });

  it('does not overwrite a changed selection or a missing binding', () => {
    expect(projectProviderObservedAccountMetadata(metadata, { ...observation, groupId: 'other' })).toBe(metadata);
    expect(projectProviderObservedAccountMetadata({}, observation)).toEqual({});
  });
});
