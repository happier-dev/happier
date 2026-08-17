import { describe, expect, it } from 'vitest';

import issueActivityPage from '../../api/__fixtures__/issueActivityPage.json' with { type: 'json' };
import {
    parsePosthogIssueActivityEnvelope,
    type PosthogRawActivityRecord,
} from '../../api/types/activity.js';
import {
    POSTHOG_ACTIVITY_BOUNDS_V1,
    POSTHOG_ISSUE_ACTIVITY_MAX_LIMIT,
    projectPosthogActivityRecords,
} from './activityProjection.js';

function projectFixture() {
    const envelope = parsePosthogIssueActivityEnvelope(issueActivityPage);
    if (envelope === null) {
        throw new Error('recorded activity fixture must satisfy the strict envelope');
    }
    return projectPosthogActivityRecords(envelope.rawRecords, POSTHOG_ACTIVITY_BOUNDS_V1);
}

/** Every string anywhere inside a projected value, for leak detection. */
function collectStrings(value: unknown, into: string[] = []): string[] {
    if (typeof value === 'string') {
        into.push(value);
    } else if (Array.isArray(value)) {
        for (const item of value) collectStrings(item, into);
    } else if (typeof value === 'object' && value !== null) {
        for (const [key, item] of Object.entries(value)) {
            into.push(key);
            collectStrings(item, into);
        }
    }
    return into;
}

describe('projectPosthogActivityRecords', () => {
    it('keeps only the allowlisted activity fields a reader needs', () => {
        const projected = projectFixture();

        expect(projected).toEqual([
            {
                id: '01994b1e-0000-4000-8000-0000000000a1',
                activity: 'updated',
                scope: 'ErrorTrackingIssue',
                atMs: Date.parse('2026-08-14T09:12:44.512000Z'),
                actor: 'Dana Okafor',
                isSystem: false,
                changedFields: ['status', 'assignee'],
            },
            {
                id: '01994b1e-0000-4000-8000-0000000000a2',
                activity: 'created',
                scope: 'ErrorTrackingIssue',
                atMs: Date.parse('2026-08-12T04:02:01.000000Z'),
                isSystem: true,
                changedFields: [],
            },
        ]);
    });

    it('drops every provider value outside the allowlist', () => {
        const strings = collectStrings(projectFixture());

        for (const leaked of strings) {
            expect(leaked).not.toContain('SENTINEL');
        }
        // The changed values themselves are customer content and are never projected:
        // a reader is told which field changed, not what it changed to.
        expect(strings).not.toContain('resolved');
        expect(strings).not.toContain('distinct_id');
        expect(strings).not.toContain('dana@example.invalid');
    });

    it('falls back to the account address only when the actor has no name', () => {
        const raw: PosthogRawActivityRecord = {
            id: 'r1',
            activity: 'updated',
            isSystem: false,
            rawUser: { email: 'nameless@example.invalid' },
            rawDetail: null,
        };

        const [projected] = projectPosthogActivityRecords([raw], POSTHOG_ACTIVITY_BOUNDS_V1);

        expect(projected?.actor).toBe('nameless@example.invalid');
    });

    it('bounds a pathological record and says so rather than dropping it', () => {
        const raw: PosthogRawActivityRecord = {
            id: 'x'.repeat(4_096),
            activity: 'a'.repeat(4_096),
            scope: 's'.repeat(4_096),
            isSystem: false,
            rawUser: { first_name: 'n'.repeat(4_096) },
            rawDetail: {
                changes: Array.from({ length: 64 }, () => ({ field: 'f'.repeat(4_096) })),
            },
        };

        const [projected] = projectPosthogActivityRecords([raw], POSTHOG_ACTIVITY_BOUNDS_V1);

        expect(projected?.truncated).toBe(true);
        expect(projected?.changedFields.length)
            .toBe(POSTHOG_ACTIVITY_BOUNDS_V1.maxChangedFieldsPerRecord);
        expect(new TextEncoder().encode(projected?.activity ?? '').length)
            .toBeLessThanOrEqual(POSTHOG_ACTIVITY_BOUNDS_V1.activityUtf8Bytes);
        expect(new TextEncoder().encode(projected?.actor ?? '').length)
            .toBeLessThanOrEqual(POSTHOG_ACTIVITY_BOUNDS_V1.actorUtf8Bytes);
    });

    it('projects provider text through the published single-line rule', () => {
        const raw: PosthogRawActivityRecord = {
            id: 'r1',
            activity: 'updated',
            isSystem: false,
            rawUser: { first_name: 'Dana\nO\u0000kafor', last_name: '' },
            rawDetail: { changes: [{ field: 'sta\r\ntus' }] },
        };

        const [projected] = projectPosthogActivityRecords([raw], POSTHOG_ACTIVITY_BOUNDS_V1);

        // A control run is collapsed by the contract's own owner, not by a rule this
        // source restates: a name or field carrying one stays readable on one line.
        expect(projected?.actor).toBe('Dana O kafor');
        expect(projected?.changedFields).toEqual(['sta tus']);
        // Collapsing is not truncation: no content was lost.
        expect(projected?.truncated).toBeUndefined();
    });

    it('keeps a whole saturated activity page inside the Action byte gate', () => {
        const saturated: readonly PosthogRawActivityRecord[] = Array.from(
            { length: POSTHOG_ISSUE_ACTIVITY_MAX_LIMIT },
            (_unused, index) => ({
                id: `${String(index)}${'i'.repeat(4_096)}`,
                activity: 'a'.repeat(4_096),
                scope: 's'.repeat(4_096),
                createdAtMs: 1_760_000_000_000,
                isSystem: false,
                rawUser: { first_name: 'n'.repeat(4_096), last_name: 'l'.repeat(4_096) },
                rawDetail: {
                    changes: Array.from({ length: 64 }, () => ({ field: 'f'.repeat(4_096) })),
                },
            }),
        );

        const projected = projectPosthogActivityRecords(saturated, POSTHOG_ACTIVITY_BOUNDS_V1);
        const bytes = new TextEncoder().encode(JSON.stringify(projected)).length;

        // The strict Action aggregate rejects a result over 1 MiB, and a rejected page
        // shows a reader nothing at all.
        expect(bytes).toBeLessThan(1_024 * 1_024);
    });
});
