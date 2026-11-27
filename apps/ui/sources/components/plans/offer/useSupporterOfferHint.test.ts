import { afterEach, describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { SUPPORTERS_WALL_URL } from '@/sync/api/supporters/fetchSupportersWall';
import { resetRuntimeFetch, setRuntimeFetch } from '@/sync/http/client';

import { useSupporterOfferHint } from './useSupporterOfferHint';

describe('useSupporterOfferHint', () => {
    afterEach(resetRuntimeFetch);

    it('reports the published total even when the listing omits supporters', async () => {
        const paths: string[] = [];
        setRuntimeFetch(async (input, init) => {
            paths.push(String(input));
            expect(new Headers(init?.headers).has('Authorization')).toBe(false);
            return Response.json({ schemaVersion: 1, generatedAt: '2026-11-27', total: 12, entries: [] });
        });
        const hint = await renderHook(useSupporterOfferHint);

        expect(paths).toEqual([SUPPORTERS_WALL_URL]);
        expect(hint.getCurrent()).toEqual({ total: 12 });
    });

    it.each([404, 503])('leaves the count unknown when the wall answers %s', async (status) => {
        setRuntimeFetch(async () => new Response('{}', { status }));
        const hint = await renderHook(useSupporterOfferHint);

        expect(hint.getCurrent()).toBeNull();
    });
});
