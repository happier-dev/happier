import { describe, expect, it } from 'vitest';

import { rememberBrowserRecentTarget, type BrowserRecentTarget } from './recents';
import { buildBrowserLaunchpadRows } from './suggestions';

describe('browser recent targets', () => {
    it('keeps opened targets available to the launchpad and moves a reopened target to the front', () => {
        let recents: readonly BrowserRecentTarget[] = [];
        for (let index = 0; index < 13; index++) {
            recents = rememberBrowserRecentTarget(recents, {
                target: { kind: 'externalUrl', targetId: `target_${index}`, url: `https://example.com/${index}` },
                openedAt: index,
            });
        }
        const reopened: BrowserRecentTarget = {
            target: { kind: 'externalUrl', targetId: 'target_0', url: 'https://example.com/updated' },
            openedAt: 20,
        };
        recents = rememberBrowserRecentTarget(recents, reopened);
        expect(recents).toHaveLength(13);
        expect(recents[0]).toBe(reopened);
        expect(buildBrowserLaunchpadRows({ recents }).filter(row => row.section === 'recent')).toHaveLength(13);
    });
});
