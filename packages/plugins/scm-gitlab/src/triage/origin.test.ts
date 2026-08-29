import { describe, expect, it } from 'vitest';

import {
  admitGitlabV1Deployment,
  encodeGitlabConfiguredOriginScope,
  normalizeGitlabConfiguredBaseUrl,
} from './origin.js';

describe('normalizeGitlabConfiguredBaseUrl', () => {
  it('drops the default port, keeps a non-default one, and preserves path-prefix case', () => {
    expect(normalizeGitlabConfiguredBaseUrl('https://GitLab.com')).toMatchObject({
      origin: 'https://gitlab.com',
      forgeHostId: 'gitlab.com',
      pathPrefix: '',
      normalized: 'https://gitlab.com',
    });
    expect(normalizeGitlabConfiguredBaseUrl('https://forge.example:443')).toMatchObject({
      forgeHostId: 'forge.example',
      normalized: 'https://forge.example',
    });
    expect(normalizeGitlabConfiguredBaseUrl('https://forge.example:8443')).toMatchObject({
      forgeHostId: 'forge.example:8443',
      normalized: 'https://forge.example:8443',
    });
    // A deployment behind a path prefix is a real configuration; only scheme and
    // host are case-insensitive, so the prefix must survive verbatim.
    expect(normalizeGitlabConfiguredBaseUrl('https://Forge.Example/Corp/GitLab/')).toMatchObject({
      forgeHostId: 'forge.example',
      pathPrefix: '/Corp/GitLab',
      normalized: 'https://forge.example/Corp/GitLab',
    });
  });

  it('returns null rather than guessing for userinfo, an empty host, or an out-of-range port', () => {
    expect(normalizeGitlabConfiguredBaseUrl('https://user:secret@forge.example')).toBeNull();
    expect(normalizeGitlabConfiguredBaseUrl('https://token@forge.example')).toBeNull();
    expect(normalizeGitlabConfiguredBaseUrl('not-a-url')).toBeNull();
    expect(normalizeGitlabConfiguredBaseUrl('https://forge.example:99999')).toBeNull();
  });
});

describe('admitGitlabV1Deployment', () => {
  it('admits the exact configured HTTPS GitLab base, including a self-managed path prefix', () => {
    expect(admitGitlabV1Deployment('https://gitlab.com')).toMatchObject({
      kind: 'admitted',
      origin: { normalized: 'https://gitlab.com' },
    });
    expect(admitGitlabV1Deployment('https://Forge.Example/Corp/GitLab/')).toMatchObject({
      kind: 'admitted',
      origin: {
        origin: 'https://forge.example',
        pathPrefix: '/Corp/GitLab',
        normalized: 'https://forge.example/Corp/GitLab',
      },
    });
  });

  it('rejects non-HTTPS and non-base URL shapes instead of weakening configured authority', () => {
    for (const rejected of [
      'http://gitlab.com',
      'https://user@gitlab.com',
      'https://gitlab.example.com/path?token=secret',
      'https://gitlab.example.com/path#fragment',
    ]) {
      const result = admitGitlabV1Deployment(rejected);
      expect(result, rejected).toMatchObject({
        kind: 'rejected',
        failure: { class: 'unsupportedContract', code: 'configured-base-unusable' },
      });
    }
  });
});

describe('encodeGitlabConfiguredOriginScope', () => {
  it('encodes the normalized origin as unpadded base64url', () => {
    const origin = normalizeGitlabConfiguredBaseUrl('https://gitlab.com');
    if (!origin) throw new Error('expected a normalized origin');
    const encoded = encodeGitlabConfiguredOriginScope(origin);
    expect(encoded).toBe('aHR0cHM6Ly9naXRsYWIuY29t');
    expect(encoded).not.toMatch(/[+/=]/u);
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).toBe('https://gitlab.com');
  });
});
