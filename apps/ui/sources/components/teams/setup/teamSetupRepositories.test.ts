import { describe, expect, it } from 'vitest';
import { readScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { teamProjectSourceFixture } from '@/dev/testkit/fixtures/teamFixtures';

import {
  buildTeamSetupRepository,
  matchTeamSetupDiscoveredClones,
} from './teamSetupRepositories';

const web = teamProjectSourceFixture({
  id: 'acme-web',
  name: 'Web',
  nameWithOwner: 'acme/web',
  teamId: 'acme',
});
const api = teamProjectSourceFixture({
  id: 'acme-api',
  name: 'API',
  nameWithOwner: 'acme/api',
  teamId: 'acme',
});
const target = { serverId: 'home', machineId: 'devbox', homeDir: '/home/mara' };

describe('Team setup repositories', () => {
  it('clones a fresh checkout when the member adopted no existing clone', () => {
    const repository = buildTeamSetupRepository(web, target, null);
    expect(repository?.input.materialization).toMatchObject({ kind: 'clone' });
    expect(repository?.input.source).toMatchObject({
      kind: 'source',
      id: 'acme-web',
    });
  });

  it('attaches the adopted clone through the ordinary folder Open instead of cloning', () => {
    const repository = buildTeamSetupRepository(
      web,
      target,
      '/home/mara/code/acme-web',
    );
    expect(repository).toMatchObject({
      id: 'acme-web',
      input: {
        source: { kind: 'folder', path: '/home/mara/code/acme-web' },
        materialization: { kind: 'attach' },
      },
    });
  });

  it('matches discovered clones to Sources by repository identity and leaves unrelated children unmatched', () => {
    const identity = (nameWithOwner: string) =>
      readScmHostingRepositoryIdentity({ kind: 'github', baseUrl: 'https://github.com', nameWithOwner })!;
    const matches = matchTeamSetupDiscoveredClones(
      [web, api],
      [
        {
          rootPath: '/home/mara/code/acme-web',
          repositoryIdentity: identity('acme/web'),
        },
        {
          rootPath: '/home/mara/code/dotfiles',
          repositoryIdentity: identity('mara/dotfiles'),
        },
      ],
    );
    expect([...matches]).toEqual([['acme-web', '/home/mara/code/acme-web']]);
  });
});
