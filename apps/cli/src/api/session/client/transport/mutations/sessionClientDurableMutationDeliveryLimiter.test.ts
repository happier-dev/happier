import { afterEach, expect, it } from 'vitest';

import {
    resetSessionClientDurableMutationDeliverySlotsForTests,
    withSessionClientDurableMutationDeliverySlot,
} from './sessionClientDurableMutationDeliveryLimiter';

const originalConcurrency = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY;

afterEach(() => {
    if (originalConcurrency === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY;
    else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY = originalConcurrency;
    resetSessionClientDurableMutationDeliverySlotsForTests();
});

it('serves a waiting session before the next delivery from an active transcript backlog', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY = '1';
    const delivered: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = withSessionClientDurableMutationDeliverySlot(async () => {
        delivered.push('session-a:first');
        await held;
    });
    await Promise.resolve();
    const peer = withSessionClientDurableMutationDeliverySlot(async () => {
        delivered.push('session-b:first');
    });
    const backlog = first.then(async () => await withSessionClientDurableMutationDeliverySlot(async () => {
        delivered.push('session-a:next');
    }));
    expect(delivered).toEqual(['session-a:first']);
    release();
    await Promise.all([first, peer, backlog]);
    expect(delivered).toEqual(['session-a:first', 'session-b:first', 'session-a:next']);
});
