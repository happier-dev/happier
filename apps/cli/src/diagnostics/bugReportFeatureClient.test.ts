import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchBugReportsFeatureFromServer } from './bugReportFeatureClient';

describe('fetchBugReportsFeatureFromServer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses protocol-aligned defaults when feature request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));

    const feature = await fetchBugReportsFeatureFromServer('https://api.happier.dev');

    expect(feature.enabled).toBe(false);
    expect(feature.uploadTimeoutMs).toBe(120_000);
    expect(feature.contextWindowMs).toBe(30 * 60 * 1_000);
  });

  it('parses bug report feature payload from server response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            features: {
              bugReports: {
                enabled: true,
              },
            },
            capabilities: {
              bugReports: {
                providerUrl: 'https://reports.happier.dev',
                defaultIncludeDiagnostics: false,
                maxArtifactBytes: 2048,
                acceptedArtifactKinds: ['cli', 'daemon'],
                uploadTimeoutMs: 9000,
                contextWindowMs: 45000,
              },
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    );

    const feature = await fetchBugReportsFeatureFromServer('https://api.happier.dev');

    expect(feature.enabled).toBe(true);
    expect(feature.providerUrl).toBe('https://reports.happier.dev');
    expect(feature.defaultIncludeDiagnostics).toBe(false);
    expect(feature.maxArtifactBytes).toBe(2048);
    expect(feature.acceptedArtifactKinds).toEqual(['cli', 'daemon']);
    expect(feature.uploadTimeoutMs).toBe(9000);
    expect(feature.contextWindowMs).toBe(45000);
  });

  it('falls back to safe defaults when bug report payload is malformed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            features: {
              bugReports: {
                enabled: true,
              },
            },
            capabilities: {
              bugReports: {
                providerUrl: 'not-a-url',
                defaultIncludeDiagnostics: false,
              },
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    );

    const feature = await fetchBugReportsFeatureFromServer('https://api.happier.dev');

    expect(feature.enabled).toBe(false);
    expect(feature.providerUrl).toBeNull();
    expect(feature.defaultIncludeDiagnostics).toBe(true);
    expect(feature.contextWindowMs).toBe(30 * 60 * 1_000);
  });

  it('falls back to safe defaults when provider url uses a non-http scheme', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            features: {
              bugReports: {
                enabled: true,
              },
            },
            capabilities: {
              bugReports: {
                providerUrl: 'ftp://reports.happier.dev',
              },
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    );

    const feature = await fetchBugReportsFeatureFromServer('https://api.happier.dev');

    expect(feature.enabled).toBe(false);
    expect(feature.providerUrl).toBeNull();
    expect(feature.defaultIncludeDiagnostics).toBe(true);
  });
});
