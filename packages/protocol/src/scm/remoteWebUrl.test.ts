import { describe, expect, it } from 'vitest';

import { resolveScmRemoteWebLink } from './remoteWebUrl.js';

describe('resolveScmRemoteWebLink', () => {
  it('reads the browsable page and the owner/name from the forms git prints for a remote', () => {
    for (const remote of [
      'https://github.com/happier-dev/happier.git',
      'https://github.com/happier-dev/happier',
      'git@github.com:happier-dev/happier.git',
      'ssh://git@github.com/happier-dev/happier.git',
      'ssh://git@github.com:22/happier-dev/happier',
      'https://token@github.com/happier-dev/happier.git',
    ]) {
      expect(resolveScmRemoteWebLink(remote)).toEqual({
        url: 'https://github.com/happier-dev/happier',
        path: 'happier-dev/happier',
      });
    }
    expect(
      resolveScmRemoteWebLink('git@gitlab.com:group/sub/project.git'),
    ).toEqual({
      url: 'https://gitlab.com/group/sub/project',
      path: 'group/sub/project',
    });
  });

  it('never offers a link it cannot browse: local paths, file URLs and bare names have none', () => {
    for (const remote of [
      '/srv/git/happier.git',
      'file:///srv/git/happier.git',
      '../happier',
      'origin',
      '',
      'git@github.com:',
    ]) {
      expect(resolveScmRemoteWebLink(remote)).toBeNull();
    }
  });
});
