import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';

describe('app shell Action identity', () => {
  it('makes existing Inbox acknowledgement and draft deletion discoverable by exact Action identity', () => {
    expect(ActionIdSchema.safeParse('inbox.mark_all_read').success).toBe(true);
    expect(ActionIdSchema.safeParse('session.draft.delete').success).toBe(true);
  });

  it('resolves the declared Inbox notice dismissal to its canonical callable contract', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const spec = getActionSpec('inbox.notice.dismiss');
    expect(spec.inputSchema.parse({ artifactId: 'notice' })).toEqual({ artifactId: 'notice' });
    expect(spec.outputSchema.parse({ artifactId: 'notice', status: 'dismissed' }))
      .toEqual({ artifactId: 'notice', status: 'dismissed' });
  });
});
