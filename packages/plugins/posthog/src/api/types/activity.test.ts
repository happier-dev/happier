import { describe, expect, it } from 'vitest';

import issueActivityPage from '../__fixtures__/issueActivityPage.json' with { type: 'json' };
import { parsePosthogIssueActivityEnvelope } from './activity.js';

describe('parsePosthogIssueActivityEnvelope', () => {
    it('reads the activity page envelope and keeps unreadable rows countable', () => {
        const envelope = parsePosthogIssueActivityEnvelope(issueActivityPage);

        expect(envelope).not.toBeNull();
        // The third recorded row carries no usable record id, so it cannot be keyed,
        // deduplicated or rendered. It is counted rather than silently dropped: a page
        // that covered three provider rows must not claim it covered two.
        expect(envelope?.rawRecords).toHaveLength(2);
        expect(envelope?.skippedRowCount).toBe(1);
        expect(envelope?.totalCount).toBe(7);
        expect(envelope?.next).toBe(
            'https://eu.posthog.com/api/projects/4821/error_tracking/issues/00000000-0000-4000-8000-000000000001/activity/?limit=50&page=2',
        );
    });

    it('keeps the raw user and detail bags for the boundary projector alone', () => {
        const envelope = parsePosthogIssueActivityEnvelope(issueActivityPage);
        const first = envelope?.rawRecords[0];

        expect(first?.id).toBe('01994b1e-0000-4000-8000-0000000000a1');
        expect(first?.activity).toBe('updated');
        expect(first?.scope).toBe('ErrorTrackingIssue');
        expect(first?.isSystem).toBe(false);
        expect(first?.createdAtMs).toBe(Date.parse('2026-08-14T09:12:44.512000Z'));
        // `user` and `detail` are open provider bags; the envelope hands them on
        // untouched so exactly one module decides what may leave this source.
        expect(first?.rawUser?.['distinct_id']).toBe('SENTINEL_DISTINCT_ID_MUST_NOT_LEAK');
        expect(first?.rawDetail?.['changes']).toBeInstanceOf(Array);
    });

    it('rejects a body that is not the activity page envelope', () => {
        expect(parsePosthogIssueActivityEnvelope({ results: {} })).toBeNull();
        expect(parsePosthogIssueActivityEnvelope({ results: [], total_count: 'many' })).toBeNull();
        expect(parsePosthogIssueActivityEnvelope({ results: [], next: 7 })).toBeNull();
        expect(parsePosthogIssueActivityEnvelope(null)).toBeNull();
    });

    it('accepts a last page that states no next and no total', () => {
        const envelope = parsePosthogIssueActivityEnvelope({ results: [], next: null });

        expect(envelope).not.toBeNull();
        expect(envelope?.next).toBeNull();
        expect(envelope?.totalCount).toBeNull();
        expect(envelope?.rawRecords).toHaveLength(0);
    });
});
