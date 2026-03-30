import { describe, expect, it } from 'vitest';

import { createDaemonServiceStartHandler, createDaemonServiceStatusHandler } from './daemonService.js';

async function collectResult(
  handler: (params: unknown, context: Readonly<{ signal: AbortSignal }>) => AsyncGenerator<unknown, unknown, void>,
  params: unknown,
) {
  const iterator = handler(params, { signal: new AbortController().signal });
  const events: unknown[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

describe('daemonService system task handlers', () => {
  it('rejects invalid daemon service params for the status task', async () => {
    const handler = createDaemonServiceStatusHandler();

    await expect(collectResult(handler, null)).rejects.toMatchObject({
      code: 'invalid_params',
    });
  });

  it('rejects daemon service start params that target a non-local machine', async () => {
    const handler = createDaemonServiceStartHandler();

    await expect(collectResult(handler, {
      target: { kind: 'remote' },
      surface: 'desktop.ui',
      mode: 'user',
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });
  });
});
