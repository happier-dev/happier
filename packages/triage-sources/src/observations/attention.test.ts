import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it, vi } from 'vitest';

import { publishTriageAttentionV1 } from './attention.js';

type Send = PluginInvocationContext['services']['notifications']['send'];
type Notice = Parameters<Send>[0];

describe('Triage attention publication', () => {
  it('uses the SDK notification sink with one stable item id for upsert and resolution', async () => {
    const fixture = createTriageSourceV1Fixture();
    const signal = new AbortController().signal;
    const send = vi.fn<Send>(async (_notice: Notice) => ({ deliveries: [], replayed: false }));
    const context = { signal, services: { notifications: { send } } } as unknown as Pick<PluginInvocationContext, 'signal' | 'services'>;
    const entryRef = fixture.detailInput.observation.entryRef;

    const first = await publishTriageAttentionV1(context, {
      entryRef,
      reason: 'reviewRequested',
      notice: {
        clientRequestId: 'attention-open', categoryId: 'source-attention',
        title: 'Review this pull request', type: 'decision', resolved: false,
        page: { pageId: 'triage', subPath: 'entry/example' },
      },
    });
    const second = await publishTriageAttentionV1(context, {
      entryRef,
      reason: 'reviewRequested',
      notice: {
        clientRequestId: 'attention-resolved', categoryId: 'source-attention',
        title: 'Review this pull request', type: 'decision', resolved: true,
        page: { pageId: 'triage', subPath: 'entry/example' },
      },
    });

    expect(first.itemId).toBe(second.itemId);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ itemId: first.itemId, resolved: false });
    expect(send.mock.calls[1]?.[0]).toMatchObject({ itemId: first.itemId, resolved: true });
    expect(send.mock.calls[0]?.[1]).toEqual({ signal });
  });
});
