import { describe, expect, it } from 'vitest';

import {
  connectedServiceProfileKey,
  resolveConnectedServiceDefaultProfileId,
  resolveConnectedServiceProfileLabel,
} from './connectedServiceProfilePreferences';

describe('connectedServiceProfilePreferences', () => {
  it('builds a stable profile key', () => {
    expect(connectedServiceProfileKey({ serviceId: 'anthropic', profileId: 'work' })).toBe('anthropic/work');
  });

  it('escapes profile key segments to avoid collisions', () => {
    expect(connectedServiceProfileKey({ serviceId: 'anthropic', profileId: 'work/team' })).toBe('anthropic/work%2Fteam');
  });

  it('resolves a profile label by key (trimmed)', () => {
    const label = resolveConnectedServiceProfileLabel({
      labelsByKey: { 'anthropic/work': ' Work Account ' },
      serviceId: 'anthropic',
      profileId: 'work',
    });
    expect(label).toBe('Work Account');
  });

  it('resolves legacy profile label keys when stored without escaping', () => {
    const label = resolveConnectedServiceProfileLabel({
      labelsByKey: { 'anthropic/work/team': 'Legacy Account' },
      serviceId: 'anthropic',
      profileId: 'work/team',
    });
    expect(label).toBe('Legacy Account');
  });

  it('returns null when a profile label is missing', () => {
    const label = resolveConnectedServiceProfileLabel({
      labelsByKey: {},
      serviceId: 'anthropic',
      profileId: 'work',
    });
    expect(label).toBeNull();
  });

  it('picks the default profile when it is connected', () => {
    const selected = resolveConnectedServiceDefaultProfileId({
      serviceId: 'anthropic',
      connectedProfileIds: ['personal', 'work'],
      defaultProfileByServiceId: { anthropic: 'work' },
    });
    expect(selected).toBe('work');
  });

  it('falls back to the first connected profile when the default is unavailable', () => {
    const selected = resolveConnectedServiceDefaultProfileId({
      serviceId: 'anthropic',
      connectedProfileIds: ['personal', 'work'],
      defaultProfileByServiceId: { anthropic: 'missing' },
    });
    expect(selected).toBe('personal');
  });
});
