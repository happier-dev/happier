import { describe, expect, it } from 'vitest';

import { createSessionListRenderableSessionFixture } from '@/dev/testkit';

import { createBotsNeedingYouCounter } from './AppRailBots';

describe('rail Bots needs-you count', () => {
    it('walks the rows only when one of its Homes replaced its row map, not on every store notification', () => {
        let rowReads = 0;
        const bot = createSessionListRenderableSessionFixture({ id: 'bot', metadata: { path: '/project', bot: { kind: 'bot' } } });
        const counted = new Proxy(bot, {
            get(target, key, receiver) {
                if (key === 'metadata') rowReads += 1;
                return Reflect.get(target, key, receiver);
            },
        });
        const homeRows = { bot: counted };
        const count = createBotsNeedingYouCounter(['home-a']);

        const first = count({ 'home-a': homeRows, 'home-b': {} });
        const readsAfterFirst = rowReads;
        expect(readsAfterFirst).toBeGreaterThan(0);

        // Another Home changed, or anything else in the store: this Home's map is the same object.
        expect(count({ 'home-a': homeRows, 'home-b': { other: bot } })).toBe(first);
        expect(rowReads).toBe(readsAfterFirst);

        // This Home's rows were replaced: the count is taken again.
        count({ 'home-a': { ...homeRows } });
        expect(rowReads).toBeGreaterThan(readsAfterFirst);
    });
});
