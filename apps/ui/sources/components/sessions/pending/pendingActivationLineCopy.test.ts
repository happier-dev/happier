import { describe, expect, it } from 'vitest';

import { pendingActivationLineCopy } from './pendingActivationLineCopy';

describe('pendingActivationLineCopy', () => {
  it.each(['queued_offline', 'held_offline', 'waiting_offline'] as const)(
    'names the offline Machine the message waits for (%s)',
    (kind) => {
      const copy = pendingActivationLineCopy(kind, 'Studio Mac');
      expect(copy.text).toContain('Studio Mac');
      expect(copy.detail).not.toBe(copy.text);
    },
  );

  it('tells a stopped Session apart from an unstopped one while the Machine is offline', () => {
    expect(
      pendingActivationLineCopy('held_offline', 'Studio Mac').text,
    ).not.toBe(pendingActivationLineCopy('queued_offline', 'Studio Mac').text);
  });

  it.each(['queued', 'held', 'waiting', 'failed'] as const)(
    'says no Machine condition once it is reachable (%s)',
    (kind) => {
      expect(pendingActivationLineCopy(kind, 'Studio Mac').text).not.toContain(
        'Studio Mac',
      );
    },
  );
});
