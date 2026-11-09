import { describe, expect, it } from 'vitest';
// This pure owner needs only the deferred primitive, not the barrel's fixtures.
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { runAccountSettingsMutation } from './accountSettingsMutationOrder';

describe('Account Settings mutation admission and cancellation', () => {
    it('never runs cancelled queued work or lets its follower overtake a live predecessor', async () => {
        const scope = { serverId: 'mutation-order-home', accountId: 'never-issued' };
        const preparation = createDeferred<string>();
        const started = createDeferred<void>();
        const firstSignal = new AbortController();
        const queuedSignal = new AbortController();
        const seen: string[] = [];
        const first = runAccountSettingsMutation(scope, async () => {
            seen.push('first');
            started.resolve();
            return preparation.promise;
        }, firstSignal.signal);
        await started.promise;
        const queued = runAccountSettingsMutation(scope, async () => {
            seen.push('cancelled');
            return 'cancelled';
        }, queuedSignal.signal);
        const queuedRejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
        const following = runAccountSettingsMutation(scope, async () => {
            seen.push('following');
            return 'saved';
        }, new AbortController().signal);
        try {
            queuedSignal.abort();
            expect(seen).toEqual(['first']);
            preparation.resolve('prepared');
            await expect(first).resolves.toBe('prepared');
            await queuedRejected;
            await expect(following).resolves.toBe('saved');
            expect(seen).toEqual(['first', 'following']);
        } finally { preparation.resolve('cancelled preparation'); }
    });

    it('keeps issued work ordered through its receipt without racing cancellation against settlement', async () => {
        const scope = { serverId: 'mutation-order-home', accountId: 'issued' };
        const acknowledgement = createDeferred<string>();
        const issued = createDeferred<void>();
        const firstSignal = new AbortController();
        const queuedSignal = new AbortController();
        let firstSettled = false;
        const seen: string[] = [];
        const first = runAccountSettingsMutation(scope, async () => {
            seen.push('issued');
            issued.resolve();
            return acknowledgement.promise;
        }, firstSignal.signal).then(receipt => { firstSettled = true; return receipt; });
        await issued.promise;
        const queued = runAccountSettingsMutation(scope, async () => 'cancelled', queuedSignal.signal);
        const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
        const following = runAccountSettingsMutation(scope, async () => {
            seen.push('following');
            return 'saved';
        }, new AbortController().signal);
        try {
            firstSignal.abort();
            queuedSignal.abort();
            expect(firstSettled).toBe(false);
            expect(seen).toEqual(['issued']);
            acknowledgement.resolve('durable receipt');
            await expect(first).resolves.toBe('durable receipt');
            await rejected;
            await expect(following).resolves.toBe('saved');
            expect(seen).toEqual(['issued', 'following']);
        } finally { acknowledgement.resolve('durable receipt'); }
    });
});
