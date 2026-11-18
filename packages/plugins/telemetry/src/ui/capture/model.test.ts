import { describe, expect, it } from 'vitest';
import { captureSeverityTone, captureStepKind, projectCaptureEndpoints } from './model.js';

const route = (path: string, requestCount: number, errorCount: number, totalDurationMs: number, databaseTimeMs: number) => ({
  serviceName: 'web', method: 'GET', route: path, requestCount, errorCount,
  errorRate: requestCount > 0 ? errorCount / requestCount : null, totalDurationMs, databaseTimeMs,
});

describe('capture endpoint rows', () => {
  it('leads with failing routes and never states an error rate for a route with no requests', () => {
    const views = projectCaptureEndpoints([
      route('/', 210, 0, 6510, 0),
      route('/api/invoices', 38, 9, 836, 200),
      route('/idle', 0, 0, 0, 0),
    ]);
    expect(views[0]).toMatchObject({ endpoint: { route: '/api/invoices' } });
    expect(views[0]!.errorRate).toBeCloseTo(9 / 38);
    expect(views.find((view) => view.endpoint.route === '/idle')).toMatchObject({ errorRate: null, meanMs: null, databaseShare: null });
  });

  // DESIGN-1118-B M2: an error line reads as one; warn is amber; everything else stays quiet.
  it('tones a log level by its severity', () => {
    expect([17, 21, 13, 9, 1, null].map(captureSeverityTone)).toEqual(['danger', 'danger', 'warning', 'secondary', 'secondary', 'secondary']);
  });

  // DESIGN-1118-B S1: a slow step says what kind of work it was.
  it('names a step by what it was: a query, an external call, or work in the app', () => {
    expect(captureStepKind({ kind: 'query', spanKind: null })).toBe('query');
    expect(captureStepKind({ kind: 'span', spanKind: 3 })).toBe('external');
    expect(captureStepKind({ kind: 'span', spanKind: 1 })).toBe('app');
    expect(captureStepKind({ kind: 'span', spanKind: null })).toBe('app');
  });
});
