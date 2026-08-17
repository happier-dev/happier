import { describe, expect, it } from 'vitest';

import { POSTHOG_ISSUE_EVENTS_MAX_LIMIT } from '../../api/types/events.js';
import { POSTHOG_SAMPLED_EVENT_BOUNDS_V1 } from '../../ui/detail/issueEventProjection.js';
import {
    PosthogSampledEventsInputV1Schema,
    PosthogSampledEventsResultV1Schema,
    decodePosthogSampledEventsContinuation,
    encodePosthogSampledEventsContinuation,
} from './issueEventsContract.js';

const INSTANCE = Object.freeze({
    v: 1,
    instance: Object.freeze({
        source: Object.freeze({ pluginId: 'happier.posthog', localId: 'posthog-error-tracking' }),
        sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    }),
    binding: Object.freeze({
        purpose: 'posthog-api',
        account: Object.freeze({
            service: Object.freeze({ pluginId: 'happier.posthog', localId: 'posthog-api' }),
            accountId: 'account-1',
        }),
    }),
    localInstanceKey: 'posthog-org:https://eu.posthog.com:00000000-0000-4000-8000-0000000000c1',
    configuration: Object.freeze({ v: 1, token: 'posthog-configuration-token-v1' }),
});

const LOCAL_REF = Object.freeze({
    kindId: 'error-issue',
    collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1',
    entryId: '00000000-0000-4000-8000-000000000001',
});

function input(overrides: Readonly<Record<string, unknown>> = {}): unknown {
    return { v: 1, instance: INSTANCE, localRef: LOCAL_REF, limit: 20, ...overrides };
}

describe('PosthogSampledEventsInputV1Schema', () => {
    it('admits the exact request shape and refuses an unknown field', () => {
        expect(PosthogSampledEventsInputV1Schema.parse(input()).limit).toBe(20);
        expect(PosthogSampledEventsInputV1Schema.safeParse(input({ window: '-10y' })).success)
            .toBe(false);
    });

    it('refuses a page the provider sample ceiling cannot serve', () => {
        expect(PosthogSampledEventsInputV1Schema
            .safeParse(input({ limit: POSTHOG_ISSUE_EVENTS_MAX_LIMIT + 1 })).success).toBe(false);
        expect(PosthogSampledEventsInputV1Schema.safeParse(input({ limit: 0 })).success).toBe(false);
    });

    it('carries a following page only through the source-minted continuation', () => {
        const continuation = encodePosthogSampledEventsContinuation({
            v: 1,
            from: '2026-07-16T00:00:00.000Z',
            to: '2026-08-15T00:00:00.000Z',
            offset: 20,
            limit: 20,
        });
        expect(continuation).not.toBeNull();
        expect(PosthogSampledEventsInputV1Schema
            .safeParse(input({ continuation })).success).toBe(true);
    });
});

describe('PosthogSampledEventsResultV1Schema', () => {
    it('round-trips a sampled page and a typed unavailable arm', () => {
        const sampled = PosthogSampledEventsResultV1Schema.parse({
            kind: 'sampled',
            events: [{
                uuid: '00000000-0000-4000-8000-0000000000f1',
                timestampMs: 1_760_000_000_000,
                sessionId: '00000000-0000-4000-8000-0000000000c1',
                url: 'https://shop.example/checkout/summary',
                exceptions: [{
                    type: 'TypeError',
                    value: 'Cannot read properties of undefined',
                    frames: [{ function: 'renderSummary', source: 'a.tsx', line: 1, column: 2, inApp: true }],
                }],
                truncated: true,
            }],
            omittedRowCount: 1,
        });
        expect(sampled.kind).toBe('sampled');

        const unavailable = PosthogSampledEventsResultV1Schema.parse({
            kind: 'unavailable',
            failure: { class: 'permission', code: 'posthog/permission-denied' },
        });
        expect(unavailable.kind).toBe('unavailable');
    });

    it('publishes exactly the bounds the boundary projector applies', () => {
        const frame = { function: 'f', source: 's', line: 1, column: 2, inApp: false };
        const overFramed = {
            kind: 'sampled',
            events: [{
                uuid: 'e1',
                exceptions: [{
                    frames: Array.from(
                        { length: POSTHOG_SAMPLED_EVENT_BOUNDS_V1.maxFramesPerException + 1 },
                        () => frame,
                    ),
                }],
            }],
            omittedRowCount: 0,
        };
        // A result the projector could never produce is rejected here too, so the two
        // cannot drift into disagreeing about what one published sample may contain.
        expect(PosthogSampledEventsResultV1Schema.safeParse(overFramed).success).toBe(false);

        const overPaged = {
            kind: 'sampled',
            events: Array.from(
                { length: POSTHOG_ISSUE_EVENTS_MAX_LIMIT + 1 },
                (_unused, index) => ({ uuid: `e${String(index)}`, exceptions: [] }),
            ),
            omittedRowCount: 0,
        };
        expect(PosthogSampledEventsResultV1Schema.safeParse(overPaged).success).toBe(false);
    });
});

describe('the sampled-events continuation', () => {
    it('round-trips the frozen window, offset and page size', () => {
        const token = encodePosthogSampledEventsContinuation({
            v: 1,
            from: '2026-07-16T00:00:00.000Z',
            to: null,
            offset: 20,
            limit: 20,
        });
        expect(token).not.toBeNull();
        expect(decodePosthogSampledEventsContinuation(token ?? '')).toEqual({
            v: 1,
            from: '2026-07-16T00:00:00.000Z',
            to: null,
            offset: 20,
            limit: 20,
        });
    });

    it('refuses a token this source did not mint', () => {
        for (const token of [
            'not json',
            JSON.stringify({ v: 2, from: 'a', to: null, offset: 0, limit: 20 }),
            JSON.stringify({ v: 1, from: 'a', to: null, offset: -1, limit: 20 }),
            JSON.stringify({ v: 1, from: 'a', to: null, offset: 0, limit: 0 }),
            JSON.stringify({
                v: 1,
                from: 'a',
                to: null,
                offset: 0,
                limit: POSTHOG_ISSUE_EVENTS_MAX_LIMIT + 1,
            }),
            JSON.stringify({ v: 1, to: null, offset: 0, limit: 20 }),
        ]) {
            expect(decodePosthogSampledEventsContinuation(token)).toBeNull();
        }
    });
});
