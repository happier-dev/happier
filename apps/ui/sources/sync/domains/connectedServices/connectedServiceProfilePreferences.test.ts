import { describe, expect, it } from 'vitest';

import {
  connectedServiceProfileKey,
  pruneQualifiedConnectedAccountPreferences,
  resolveConnectedServiceDefaultProfileId,
  resolveConnectedServiceProfileLabel,
  resolveQualifiedConnectedAccountDefaultId,
  resolveQualifiedConnectedAccountLabel,
  updateQualifiedConnectedAccountDefaultId,
  updateQualifiedConnectedAccountLabel,
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

  it('prefers qualified account preferences and falls back only to its mapped built-in key', () => {
    expect(resolveQualifiedConnectedAccountLabel({
      service: qualifiedGithubService,
      legacyServiceId: 'github',
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

  it('writes only the qualified owner and removes its mapped compatibility preference', () => {
    expect(updateQualifiedConnectedAccountLabel({
      service: qualifiedGithubService,
      legacyServiceId: 'github',
      accountId: 'work',
      label: ' Team ',
      labelsByKey: {
        'github/work': 'Legacy',
        'openai/voice': 'Voice',
      },
    })).toEqual({
      'happier.scm.forge.github%2Fgithub-account/work': 'Team',
      'openai/voice': 'Voice',
    });
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

  it('prunes only the deleted exact account across qualified and mapped compatibility keys', () => {
    expect(pruneQualifiedConnectedAccountPreferences({
      service: qualifiedGithubService,
      legacyServiceId: 'github',
      accountId: 'work',
      defaultAccountByServiceKey: {
        'happier.scm.forge.github/github-account': 'personal',
        github: 'work',
        openai: 'voice',
      },
      labelsByKey: {
        'happier.scm.forge.github%2Fgithub-account/work': 'Qualified',
        'github/work': 'Legacy',
        'github/personal': 'Personal',
      },
    })).toEqual({
      connectedServicesDefaultProfileByServiceId: {
        'happier.scm.forge.github/github-account': 'personal',
        openai: 'voice',
      },
      connectedServicesProfileLabelByKey: {
        'github/personal': 'Personal',
      },
    });
  });
});
