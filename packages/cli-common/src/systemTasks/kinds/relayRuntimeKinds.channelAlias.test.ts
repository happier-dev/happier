import { describe, expect, it } from 'vitest';

import { parseRelayRuntimeTaskParams } from './relayRuntimeKinds.js';

describe('parseRelayRuntimeTaskParams', () => {
  it('normalizes channel publicdev to dev (systemTasks channels are labels)', () => {
    const parsed = parseRelayRuntimeTaskParams({
      target: { kind: 'local' },
      channel: 'publicdev',
    });

    expect(parsed.channel).toBe('dev');
  });
});
