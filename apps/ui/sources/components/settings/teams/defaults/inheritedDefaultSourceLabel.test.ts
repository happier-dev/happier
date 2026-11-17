import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import { describeInheritedDefaultSource } from './inheritedDefaultSourceLabel';

const names = {
  teamName: 'Acme',
  projectName: 'acme/web',
  organization: 'Acme Corp',
};

describe('describeInheritedDefaultSource', () => {
  it('names the owner of each inherited layer with the lab vocabulary', () => {
    expect(describeInheritedDefaultSource('personal-project', names)).toBe(
      t('teams.settings.memberDefaults.sourceYours'),
    );
    expect(describeInheritedDefaultSource('member', names)).toBe(
      t('teams.settings.memberDefaults.sourceYours'),
    );
    expect(describeInheritedDefaultSource('project', names)).toBe(
      t('teams.settings.memberDefaults.sourceTeamProject', {
        team: 'Acme',
        project: 'acme/web',
      }),
    );
    expect(describeInheritedDefaultSource('team', names)).toBe('Acme');
    expect(describeInheritedDefaultSource('policy', names)).toBe('Acme Corp');
  });

  it('says nothing for a value chosen here or the Agent’s own default', () => {
    expect(describeInheritedDefaultSource('explicit', names)).toBeNull();
    expect(describeInheritedDefaultSource('none', names)).toBeNull();
    expect(describeInheritedDefaultSource(null, names)).toBeNull();
  });

  it('falls back to the kind of default when the deciding read carried no names', () => {
    expect(describeInheritedDefaultSource('team')).toBe(
      t('teams.settings.memberDefaults.teamDefault'),
    );
    expect(
      describeInheritedDefaultSource('project', { projectName: 'acme/web' }),
    ).toBe('acme/web');
    expect(describeInheritedDefaultSource('project')).toBe(
      t('teams.settings.memberDefaults.projectDefault'),
    );
  });
});
