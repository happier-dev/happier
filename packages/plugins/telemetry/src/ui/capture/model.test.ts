import { describe, expect, it } from 'vitest';
import { projectCaptureEndpoints } from './model.js';

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
});
