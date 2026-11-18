import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor';

describe('Review metadata read Actions', () => {
  it('returns exactly one demanded page without following continuation', async () => {
    const requests: unknown[] = [];
    const page = { items: [], cursor: 'next-page' };
    const executor = createActionExecutor({
      homeDomainAction: async request => { requests.push({ actionId: request.actionId, input: request.input }); return page; },
    });
    const result = await executor.execute('reviews.list', { limit: 2, needsDecision: true }, { surface: 'ui' });
    expect(result).toEqual({ ok: true, result: page });
    expect(requests).toEqual([{ actionId: 'reviews.list', input: { limit: 2, needsDecision: true } }]);
  });

  it('returns authorized history through the same read transport and preserves typed failures', async () => {
    const executor = createActionExecutor({
      homeDomainAction: async () => ({ ok: false, errorCode: 'review_comment_permission_denied', error: 'review_comment_permission_denied' }),
    });
    expect(await executor.execute('review.history.list', { workflowId: 'workflow', reviewId: 'review' }, { surface: 'ui' }))
      .toEqual({ ok: false, errorCode: 'review_comment_permission_denied', error: 'review_comment_permission_denied' });
  });
});
