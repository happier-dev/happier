import { describe, expect, it } from 'vitest';

import {
    MAX_POSTHOG_ISSUE_ACTIVITY_CONTINUATION_UTF8_BYTES,
    PosthogIssueActivityResultV1Schema,
    decodePosthogIssueActivityContinuation,
    encodePosthogIssueActivityContinuation,
} from './issueActivityContract.js';

describe('PostHog activity continuation', () => {
    it('round-trips a position this source minted', () => {
        const token = encodePosthogIssueActivityContinuation({ v: 1, page: 4, limit: 50 });

        expect(token).not.toBeNull();
        expect(new TextEncoder().encode(token ?? '').length)
            .toBeLessThanOrEqual(MAX_POSTHOG_ISSUE_ACTIVITY_CONTINUATION_UTF8_BYTES);
        expect(decodePosthogIssueActivityContinuation(token ?? ''))
            .toEqual({ v: 1, page: 4, limit: 50 });
    });

    it('rejects a token this source did not mint', () => {
        for (const token of [
            'not json',
            JSON.stringify({ v: 2, page: 2, limit: 50 }),
            JSON.stringify({ v: 1, page: 0, limit: 50 }),
            JSON.stringify({ v: 1, page: 1.5, limit: 50 }),
            JSON.stringify({ v: 1, page: 2 }),
            JSON.stringify({ v: 1, page: 2, limit: 0 }),
            JSON.stringify({ v: 1, page: 2, limit: 10_000 }),
        ]) {
            expect(decodePosthogIssueActivityContinuation(token)).toBeNull();
        }
    });
});

describe('PosthogIssueActivityResultV1Schema', () => {
    it('admits a settled page and a stated unavailability, and nothing else', () => {
        expect(PosthogIssueActivityResultV1Schema.parse({
            kind: 'activity',
            records: [{
                id: 'r1',
                activity: 'updated',
                isSystem: false,
                changedFields: ['status'],
            }],
            omittedRowCount: 1,
            totalCount: 7,
            continuation: JSON.stringify({ v: 1, page: 2, limit: 50 }),
        })).toBeDefined();

        expect(PosthogIssueActivityResultV1Schema.parse({
            kind: 'unavailable',
            failure: { class: 'permission', code: 'posthog/permission-denied' },
        })).toBeDefined();

        // An empty page is a provider statement and must remain expressible: it is not
        // the same thing as a failure, and it is not the same thing as an unbuilt tab.
        expect(PosthogIssueActivityResultV1Schema.parse({
            kind: 'activity',
            records: [],
            omittedRowCount: 0,
        })).toBeDefined();

        expect(() => PosthogIssueActivityResultV1Schema.parse({
            kind: 'activity',
            records: [],
            omittedRowCount: 0,
            // A raw provider bag may never cross this boundary.
            detail: { before: 'active' },
        })).toThrow();
    });
});
