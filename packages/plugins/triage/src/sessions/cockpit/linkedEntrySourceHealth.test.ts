import { describe, expect, it } from 'vitest';

import { testkitEntryRef, TESTKIT_SOURCE_INSTANCE_ID } from '../../corpus/testkit/observations.test-support.js';
import type { TriageSourceSessionLinksLaneV1 } from '../../actions/sessionLinksProtocol.js';
import { projectTriageUnavailableLinkSources } from './linkedEntrySourceHealth.js';

const source = testkitEntryRef().source;
const lane = (displayLabel: string, health: TriageSourceSessionLinksLaneV1['health'], kindIds?: string[]): TriageSourceSessionLinksLaneV1 => ({
    source, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, displayLabel, health, ...(kindIds === undefined ? {} : { kindIds }),
});

describe('the unavailable link sources a Session names', () => {
    it('names only sources that could not be read, once each, and keeps complete coverage out', () => {
        const sources = projectTriageUnavailableLinkSources([
            lane('Example forge', { kind: 'complete' }, ['issue']),
            lane('Example forge', { kind: 'failed', failure: { class: 'transient', code: 'offline' } }, ['pull-request']),
            lane('Example forge', { kind: 'failed', failure: { class: 'transient', code: 'offline' } }, ['issue']),
            lane('Other forge', { kind: 'complete' }, ['issue']),
        ]);
        expect(sources.map(entry => entry.label)).toEqual(['Example forge']);
    });

    it('gives each typed cause its own human reason and never a raw code', () => {
        const reasons = (health: TriageSourceSessionLinksLaneV1['health']) => projectTriageUnavailableLinkSources([lane('acme/ledger', health)])[0]!.reason;
        const notAdmitted = reasons({ kind: 'failed', failure: { class: 'unsupportedContract', code: 'sessionLinksSourceNotAdmitted' } });
        const noLinks = reasons({ kind: 'failed', failure: { class: 'unsupportedContract', code: 'sessionLinksKindUnsupported' } });
        const rateLimit = reasons({ kind: 'failed', failure: { class: 'rateLimit', code: 'secondary_limit' } });
        const unreached = reasons({ kind: 'unavailable' });
        expect(new Set([notAdmitted.key, noLinks.key, rateLimit.key]).size).toBe(3);
        expect(unreached).toEqual(notAdmitted);
        for (const reason of [notAdmitted, noLinks, rateLimit, unreached]) {
            expect(reason.fallback).not.toMatch(/sessionLinks|secondary_limit|offline|_/);
        }
    });

    it('does not describe an unknown cause as a named source when no lane says which', () => {
        expect(projectTriageUnavailableLinkSources(undefined)).toEqual([]);
        expect(projectTriageUnavailableLinkSources([])).toEqual([]);
    });
});
