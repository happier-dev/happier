import { describe, expect, it } from 'vitest';

import { runInHostedSessionScope } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { readReplayTextLimitFromEnv } from './readReplayTextLimitFromEnv';

describe('replay text limit environment', () => {
    it('keeps each Session override and a stripped key independent of the host', async () => {
        const key = 'HAPPIER_REPLAY_MAX_TEXT_CHARS';
        const previous = process.env[key];
        process.env[key] = '77';
        try {
            const limits = await Promise.all([undefined, '123', '90000', '0', 'invalid'].map(value =>
                runInHostedSessionScope({ environment: value === undefined ? {} : { [key]: value } }, async () => {
                    await Promise.resolve();
                    return readReplayTextLimitFromEnv();
                })));
            expect(limits).toEqual([null, 123, 50_000, 1, null]);
            expect(readReplayTextLimitFromEnv()).toBe(77);
        } finally {
            if (previous === undefined) delete process.env[key];
            else process.env[key] = previous;
        }
    });
});
