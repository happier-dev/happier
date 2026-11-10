import { describe, expect, it, vi } from 'vitest';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { SessionEvent } from '@happier-dev/plugin-sdk/sessions';
import { createOutwardBindingObservation } from './outwardBindingObservation.js';
import { MemoryCollection } from './testkit/memoryCollection.js';

describe('outward Session activity observation', () => {
  it('wakes only bound consumers for working, completion, failure-idle and stop, without reads per activity', async () => {
    let publish: (event: SessionEvent) => void = () => {};
    const get = vi.fn(async () => ({ watch(listener: typeof publish) {
      publish = listener; return { dispose() {} };
    } }));
    const changed = vi.fn();
    // Sessions and Account Collections are the host boundaries.
    const context = { signal: new AbortController().signal, services: {
      sessions: { get }, storage: { account: { collection: () => new MemoryCollection() } },
    } } as unknown as BackgroundServiceContext;
    const observation = createOutwardBindingObservation(context, changed);
    await observation.observe('session', 'binding', true);
    await observation.observe('session', 'binding-two', true);
    await observation.observe('session', 'unsupported-provider');
    for (const [index, state] of (['active', 'idle', 'active', 'idle', 'stopped'] as const).entries()) {
      publish({ kind: 'activity', sequence: index, activity: { state, observedAtMs: index } });
      for (let repeat = 0; repeat < 1000; repeat++) {
        publish({ kind: 'activity', sequence: index, activity: { state, observedAtMs: index + repeat } });
      }
    }
    expect(changed.mock.calls).toEqual(Array.from({ length: 5 }, () => [['binding', 'binding-two']]));
    expect(get).toHaveBeenCalledTimes(1);
    observation.dispose();
  });
});
