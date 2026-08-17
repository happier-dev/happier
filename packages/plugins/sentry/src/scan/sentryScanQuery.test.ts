import { describe, expect, it } from 'vitest';

import { buildSentryScanIssuesUrl } from './sentryScanQuery.js';

const INSTANCE = Object.freeze({
  deploymentOrigin: 'https://us.sentry.io',
  organizationId: '7701',
});

function parametersOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('buildSentryScanIssuesUrl', () => {
  it('sends an explicit empty query, statsPeriod, project and sort on a full pass', () => {
    const url = buildSentryScanIssuesUrl({ instance: INSTANCE, nativeLimit: 64 });
    const parameters = parametersOf(url);

    expect(new URL(url).origin).toBe('https://us.sentry.io');
    expect(new URL(url).pathname).toBe('/api/0/organizations/7701/issues/');
    // The default is `is:unresolved`, which silently hides every resolved issue.
    expect(parameters.has('query')).toBe(true);
    expect(parameters.get('query')).toBe('');
    // With no window parameter the search covers the last 90 days by default;
    // the ceiling is declared rather than inherited.
    expect(parameters.get('statsPeriod')).toBe('90d');
    expect(parameters.get('project')).toBe('-1');
    expect(parameters.get('sort')).toBe('date');
    expect(parameters.get('limit')).toBe('64');
    expect(parameters.getAll('collapse')).toEqual(['stats', 'filtered']);
  });

  it('never sends per_page, shortIdLookup, environment or llmFormat', () => {
    const parameters = parametersOf(buildSentryScanIssuesUrl({
      instance: INSTANCE,
      nativeLimit: 64,
      cursor: '1754000000000:0:0',
    }));

    expect(parameters.has('per_page')).toBe(false);
    expect(parameters.has('shortIdLookup')).toBe(false);
    expect(parameters.has('environment')).toBe(false);
    expect(parameters.has('llmFormat')).toBe(false);
  });

  it('never collapses lifetime, which is the only all-time count source', () => {
    const collapse = parametersOf(buildSentryScanIssuesUrl({ instance: INSTANCE, nativeLimit: 64 }))
      .getAll('collapse');

    expect(collapse).not.toContain('lifetime');
    expect(collapse).not.toContain('base');
    expect(collapse).not.toContain('unhandled');
  });

  it('appends the continuation cursor verbatim without changing the frozen geometry', () => {
    const parameters = parametersOf(buildSentryScanIssuesUrl({
      instance: INSTANCE,
      nativeLimit: 37,
      cursor: '1754000000000:0:0',
    }));

    expect(parameters.get('cursor')).toBe('1754000000000:0:0');
    expect(parameters.get('limit')).toBe('37');
  });

  it('refuses a native limit outside the documented provider bound', () => {
    expect(() => buildSentryScanIssuesUrl({ instance: INSTANCE, nativeLimit: 0 })).toThrow();
    expect(() => buildSentryScanIssuesUrl({ instance: INSTANCE, nativeLimit: 101 })).toThrow();
    expect(() => buildSentryScanIssuesUrl({ instance: INSTANCE, nativeLimit: 12.5 })).toThrow();
  });

  it('refuses to route from an unnormalized origin or a non-numeric organization id', () => {
    expect(() => buildSentryScanIssuesUrl({
      instance: { deploymentOrigin: 'https://us.sentry.io/', organizationId: '7701' },
      nativeLimit: 64,
    })).toThrow();
    expect(() => buildSentryScanIssuesUrl({
      instance: { deploymentOrigin: 'https://us.sentry.io', organizationId: 'example-org' },
      nativeLimit: 64,
    })).toThrow();
  });
});
