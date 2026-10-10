import { describe, expect, it } from 'vitest';

import {
  connectedServiceProfileKey,
  resolveConnectedServiceDefaultProfileId,
  resolveConnectedServiceProfileLabel,
  resolveQualifiedConnectedAccountDefaultId,
  resolveQualifiedConnectedAccountLabel,
  resolveQualifiedConnectedAccountProfilePreference,
  updateQualifiedConnectedAccountDefaultId,
  updateQualifiedConnectedAccountProfilePreference,
} from './connectedServiceProfilePreferences';

const qualifiedGithubService = {
  pluginId: 'happier.scm.forge.github',
  localId: 'github-account',
};

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

  it('reads and writes a per-account preference through the qualified key and its released alias', () => {
    const account = { service: qualifiedGithubService, legacyServiceId: 'github' as const, accountId: 'work' };
    const qualifiedKey = 'happier.scm.forge.github%2Fgithub-account/work';

    expect(resolveQualifiedConnectedAccountProfilePreference({
      ...account,
      valuesByKey: { 'github/work': ['weekly'], 'github/other': ['daily'] },
    })).toEqual(['weekly']);
    expect(resolveQualifiedConnectedAccountProfilePreference({
      ...account,
      valuesByKey: { 'github/work': ['weekly'], [qualifiedKey]: ['five_hour'] },
    })).toEqual(['five_hour']);

    expect(updateQualifiedConnectedAccountProfilePreference({
      ...account,
      valuesByKey: { 'github/work': ['weekly'], 'github/other': ['daily'] },
      value: ['weekly', 'five_hour'],
    })).toEqual({ 'github/other': ['daily'], [qualifiedKey]: ['weekly', 'five_hour'] });
    expect(updateQualifiedConnectedAccountProfilePreference({
      ...account,
      valuesByKey: { [qualifiedKey]: ['weekly'], 'github/other': ['daily'] },
      value: null,
    })).toEqual({ 'github/other': ['daily'] });
  });

  it('uses canonical labels while retaining released default preference aliases', () => {
    expect(resolveQualifiedConnectedAccountLabel({
      service: qualifiedGithubService,
      accountId: 'work',
      labelsByKey: {
        'github/work': 'Legacy',
        'happier.scm.forge.github%2Fgithub-account/work': 'Qualified',
      },
    })).toBe('Qualified');
    expect(resolveQualifiedConnectedAccountDefaultId({
      service: qualifiedGithubService,
      legacyServiceId: 'github',
      connectedAccountIds: ['personal', 'work'],
      defaultAccountByServiceKey: {
        github: 'work',
      },
    })).toBe('work');
  });

  it('writes only the qualified default owner and removes its mapped compatibility preference', () => {
    expect(updateQualifiedConnectedAccountDefaultId({
      service: qualifiedGithubService,
      legacyServiceId: 'github',
      accountId: 'work',
      defaultAccountByServiceKey: {
        github: 'personal',
        openai: 'voice',
      },
    })).toEqual({
      'happier.scm.forge.github/github-account': 'work',
      openai: 'voice',
    });
  });

});
