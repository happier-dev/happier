import { describe, expect, it } from 'vitest';
import { resolveJoinScreenHomeDisplayName, resolveJoinScreenHomeHosting, resolveTeamJoinLinkTarget } from './joinScreenHome';

describe('resolveJoinScreenHomeDisplayName', () => {
  it('names the Home by the name it published, and by its configured host only while it has none', () => {
    const canonical = { HAPPIER_CANONICAL_SERVER_URL: 'https://home.example.test' };
    expect(resolveJoinScreenHomeDisplayName({ ...canonical, HAPPIER_HOME_DISPLAY_NAME: ' Northwind Studio ' })).toBe('Northwind Studio');
    expect(resolveJoinScreenHomeDisplayName({ ...canonical, HAPPIER_HOME_DISPLAY_NAME: '  ' })).toBe('home.example.test');
    expect(resolveJoinScreenHomeDisplayName(canonical)).toBe('home.example.test');
    expect(resolveJoinScreenHomeDisplayName({})).toBeNull();
  });
});

describe('resolveJoinScreenHomeHosting', () => {
  it('discloses the runtime purpose a joiner has to know, and nothing it cannot substantiate', () => {
    // A Personal Home runs on somebody's own computer and can be offline: that
    // is the one hosting consequence the join screen states. Another published
    // purpose is shared hosting, and a runtime that publishes none says nothing
    // rather than inferring hosting from the URL or the storage mode.
    expect(resolveJoinScreenHomeHosting({ HAPPIER_MANAGED_RELAY_PURPOSE: 'personal-home' })).toBe('personal');
    expect(resolveJoinScreenHomeHosting({ HAPPIER_MANAGED_RELAY_PURPOSE: 'generic' })).toBe('shared');
    expect(resolveJoinScreenHomeHosting({})).toBeNull();
    expect(resolveJoinScreenHomeHosting({ HAPPIER_MANAGED_RELAY_PURPOSE: '  ' })).toBeNull();
  });
});

describe('resolveTeamJoinLinkTarget', () => {
  it('uses the complete published Home descriptor as the explicit carrier', async () => {
    const result = await resolveTeamJoinLinkTarget(
      {
        HAPPIER_WEBAPP_URL: 'https://app.example.test',
      },
      {
        read: async () => null,
        write: async () => ({ status: 'unchanged' as const, continuity: { revision: 1, contentKey: 'v1:n:' + 'a'.repeat(64) } }),
      },
      async () => ({
        v: 1,
        homeServerIdentityId: 'home-identity-1',
        canonicalServerUrl: 'https://home.example.test',
        revision: 1,
        endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
      }),
    );
    expect(result.applicationOrigin).toBe('https://app.example.test');
    expect(result.serverId).toBe('home-identity-1');
    expect(JSON.parse(result.homeTarget!)).toEqual({
        kind: 'descriptor',
        authority: 'trusted_enrollment',
        descriptor: {
          v: 1,
          homeServerIdentityId: 'home-identity-1',
          canonicalServerUrl: 'https://home.example.test',
          revision: 1,
          endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
        },
    });
  });

  it('renders links at the web app the Home reports, its default included, when no address is set', async () => {
    // Reach names the default web app as where this Home's links open; mail must build its links there
    // too rather than calling the same Home linkless.
    const result = await resolveTeamJoinLinkTarget(
      {},
      {
        read: async () => null,
        write: async () => ({ status: 'unchanged' as const, continuity: { revision: 1, contentKey: 'v1:n:' + 'a'.repeat(64) } }),
      },
      async () => ({
        v: 1,
        homeServerIdentityId: 'home-identity-1',
        canonicalServerUrl: 'https://home.example.test',
        revision: 1,
        endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
      }),
    );
    expect(result.applicationOrigin).toBe('https://cloud.happier.dev');
    expect(result.serverId).toBe('home-identity-1');
  });

  it('fails closed when descriptor publication is unavailable', async () => {
    const result = await resolveTeamJoinLinkTarget(
      { HAPPIER_WEBAPP_URL: 'https://app.example.test' },
      { read: async () => null, write: async () => { throw new Error('unavailable'); } },
      async () => { throw new Error('unavailable'); },
    );
    expect(result).toEqual({ applicationOrigin: null, homeTarget: null, serverId: null });
  });
});
