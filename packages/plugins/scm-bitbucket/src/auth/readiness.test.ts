import { describe, expect, it } from 'vitest';

import { resolveBitbucketAuthReadiness } from './readiness.js';

describe('resolveBitbucketAuthReadiness', () => {
  it('reports ready only for Bitbucket Cloud basic-auth materialization with redacted diagnostics', () => {
    expect(resolveBitbucketAuthReadiness({
      descriptorMaterializationKinds: ['scm_hosting_basic_auth'],
      host: 'bitbucket.org',
      username: 'dev@example.com',
      apiTokenAvailable: true,
      apiProbe: 'available',
    })).toEqual({
      state: 'ready',
      diagnostic: 'Bitbucket Cloud API credentials are configured for dev@example.com.',
      remediation: null,
    });
  });

  it('reports bounded readiness failures without exposing token material', () => {
    expect(resolveBitbucketAuthReadiness({
      descriptorMaterializationKinds: [],
      host: 'bitbucket.org',
      username: 'dev@example.com',
      apiTokenAvailable: true,
      apiProbe: 'available',
    }).state).toBe('missing_descriptor');

    expect(resolveBitbucketAuthReadiness({
      descriptorMaterializationKinds: ['scm_hosting_basic_auth'],
      host: 'bitbucket.org',
      username: '',
      apiTokenAvailable: true,
      apiProbe: 'available',
    }).state).toBe('missing_email');

    const missingToken = resolveBitbucketAuthReadiness({
      descriptorMaterializationKinds: ['scm_hosting_basic_auth'],
      host: 'bitbucket.org',
      username: 'dev@example.com',
      apiTokenAvailable: false,
      apiProbe: 'available',
    });
    expect(missingToken.state).toBe('missing_token');
    expect(JSON.stringify(missingToken)).not.toContain('api-token-secret');

    expect(resolveBitbucketAuthReadiness({
      descriptorMaterializationKinds: ['scm_hosting_basic_auth'],
      host: 'bitbucket.internal.test',
      username: 'dev@example.com',
      apiTokenAvailable: true,
      apiProbe: 'available',
    }).state).toBe('invalid_host');

    expect(resolveBitbucketAuthReadiness({
      descriptorMaterializationKinds: ['scm_hosting_basic_auth'],
      host: 'bitbucket.org',
      username: 'dev@example.com',
      apiTokenAvailable: true,
      apiProbe: 'unavailable',
    }).state).toBe('api_probe_unavailable');
  });
});
