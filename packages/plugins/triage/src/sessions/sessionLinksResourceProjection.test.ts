import { describe, expect, it } from 'vitest';
import type { ResourceContent } from '@happier-dev/plugin-sdk/ui';
import { MAX_TRIAGE_TEXT_UTF8_BYTES_V1 } from '@happier-dev/triage-protocol/v1';

import { testkitEntryRef, TESTKIT_SOURCE_INSTANCE_ID, TRIAGE_TESTKIT_SOURCE } from '../corpus/testkit/observations.test-support.js';
import { TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1 } from './sessionLinksResourceProjection.js';

function content(value: unknown): ResourceContent {
    return { contentType: 'application/json', digest: 'test-digest', bytes: new TextEncoder().encode(JSON.stringify(value)) };
}

describe('the shared typed Session relation projection', () => {
    it('publishes admitted source setup changes without replacing unchanged links or inventing a retired offer', () => {
        const offer = { destination: { pluginId: 'example.source', localId: 'source-settings' },
            displayName: 'Example', kindNames: ['Pull requests'] };
        const first = { kind: 'complete', links: [], lanes: [], configureSources: [offer] };
        const baseline = TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content(first), undefined);
        expect(baseline).toMatchObject({ configureSources: [offer] });
        expect(TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content(first), baseline)).toBe(baseline);
        const replacement = { ...offer, destination: { ...offer.destination, localId: 'replacement-settings' } };
        const changed = TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content({ ...first, configureSources: [replacement] }), baseline);
        expect(changed).not.toBe(baseline);
        expect(changed).toMatchObject({ configureSources: [replacement] });
        expect(changed.links).toBe(baseline.links);
        expect(changed.lanes).toBe(baseline.lanes);
        const retired = TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content({ kind: 'complete', links: [], lanes: [] }), changed);
        expect(retired).not.toBe(changed);
        expect(retired).not.toHaveProperty('configureSources');
    });

    it('retains only failed source/instance/kind slices, then accepts complete removal and scope retirement', () => {
        const instanceA = TESTKIT_SOURCE_INSTANCE_ID;
        const instanceB = '22222222-2222-4222-8222-222222222222';
        const lane = (sourceInstanceId: string, kindIds = ['issue']) => ({ source: TRIAGE_TESTKIT_SOURCE,
            sourceInstanceId, displayLabel: sourceInstanceId, kindIds, health: { kind: 'complete' } });
        const link = (sourceInstanceId: string, entryId: string, kindId = 'issue') => ({
            entryRef: testkitEntryRef({ kindId, entryId }), sourceInstanceId, sessionId: 'session-a', linkedAtMs: 1, displayPath: entryId,
        });
        const first = { kind: 'complete', links: [link(instanceA, '1'), link(instanceB, '2'), link(instanceB, '3', 'pull-request')],
            lanes: [lane(instanceA), lane(instanceB), lane(instanceB, ['pull-request'])] };
        const baseline = TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content(first), undefined);
        const partial = TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content({ kind: 'partial', links: [first.links[0]],
            lanes: [lane(instanceA), { ...lane(instanceB), health: { kind: 'unavailable' } }, lane(instanceB, ['pull-request'])],
        }), baseline);
        expect(partial.kind).toBe('partial');
        expect(partial.links).toEqual(first.links.slice(0, 2));
        expect(partial.links[1]).toBe(baseline.links[1]);
        const allFailed = TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content({ kind: 'failed', links: [],
            lanes: first.lanes.map(row => ({ ...row, health: { kind: 'unavailable' } })),
        }), partial);
        expect(allFailed.links).toEqual(partial.links);
        expect(allFailed.kind).toBe('failed');
        expect(TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content({ kind: 'complete', links: [first.links[0]], lanes: first.lanes }), partial).links)
            .toEqual([first.links[0]]);
        expect(TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content({ kind: 'partial', links: [],
            lanes: [{ ...lane(instanceA), health: { kind: 'unavailable' } }],
        }), partial).links).toEqual([first.links[0]]);
        // Account, Session and executable custody retirement supply no old Resource baseline.
        expect(TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content({ kind: 'failed', links: [], lanes: allFailed.lanes }), undefined).links).toEqual([]);
    });

    it('keeps legacy unknown coverage without duplicating a newly unqualified relationship', () => {
        const link = { entryRef: testkitEntryRef({ kindId: 'issue' }), sessionId: 'session-a', linkedAtMs: 1, displayPath: 'Issue',
            sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID };
        const baseline = TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content({ kind: 'partial', links: [link] }), undefined);
        expect(TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content({ kind: 'failed', links: [] }), baseline).links).toEqual([link]);
        const { sourceInstanceId: _instance, ...unqualified } = link;
        expect(TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content({ kind: 'partial', links: [unqualified] }), baseline).links).toEqual([unqualified]);
    });

    it('preserves long retained displays, unchanged relation leaves and the complete baseline', () => {
        const first = { kind: 'complete', links: [
            { entryRef: testkitEntryRef({ kindId: 'issue', entryId: '1' }), sessionId: 'session-a', linkedAtMs: 1,
                displayPath: 'x'.repeat(MAX_TRIAGE_TEXT_UTF8_BYTES_V1 + 1) },
            { entryRef: testkitEntryRef({ kindId: 'issue', entryId: '2' }), sessionId: 'session-a', linkedAtMs: 2, displayPath: 'Second' },
        ], lanes: [{ source: TRIAGE_TESTKIT_SOURCE, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
            displayLabel: 'Example source', kindIds: ['issue'], health: { kind: 'complete' } }] };
        const baseline = TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content(first), undefined);
        expect(TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content(first), baseline)).toBe(baseline);
        const changed = TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content({ ...first,
            links: [first.links[0], { ...first.links[1], displayPath: 'Updated' }],
        }), baseline);
        expect(changed).not.toBe(baseline);
        expect(changed.links[0]).toBe(baseline.links[0]);
        expect(changed.links[1]).not.toBe(baseline.links[1]);
        expect(changed.lanes).toBe(baseline.lanes);
    });

    it('does not turn legacy unknown coverage or malformed bytes into complete absence', () => {
        const unknown = TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content({ kind: 'complete', links: [] }), undefined);
        expect(unknown.kind).toBe('failed');
        expect(() => TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content({ kind: 'complete', links: 'invalid' }), unknown)).toThrow();
    });

    it('retains the current producer’s explicit complete empty coverage', () => {
        const result = TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content({ kind: 'complete', links: [], lanes: [] }), undefined);
        expect(result).toEqual({ kind: 'complete', links: [], lanes: [] });
        expect(TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1.decode(content({ kind: 'complete', links: [], lanes: [] }), result)).toBe(result);
    });
});
