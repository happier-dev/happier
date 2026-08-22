import { afterEach, describe, expect, it } from 'vitest';

import { buildTriagePickerView } from '../composer/pickerModel.js';
import { projectTriagePickerCorpusFacts } from '../composer/pickerFacts.js';
import type { ProjectedObservationV1 } from '../corpus/fold/projectedObservation.js';
import type { CorpusQualifiedObservationV1 } from '../corpus/fold/qualify.js';
import {
    TRIAGE_TESTKIT_SOURCE,
    testkitEntryRef,
    testkitLocator,
    testkitPresentOutcome,
    testkitSnapshot,
    testkitViewer,
} from '../corpus/testkit/observations.test-support.js';
import {
    foldTriageSearchValue,
    parseTriageSearchQuery,
    projectTriageEntrySearchText,
    triageEntryMatchesSearch,
} from './entrySearch.js';
import {
    TRIAGE_LIST_DEFAULT_LENS_V1,
    foldTriageListWindow,
    type TriageListLensV1,
    type TriageListWindowV1,
} from './listWindow.js';
import type { TriageListWindowSnapshotV1 } from './listWindowStore.js';

/**
 * One search rule, proven at the rule and at both surfaces that consume it.
 *
 * The shell list and the Composer picker read the same projected rows, so a
 * query that finds an entry in one must find it in the other. This file is the
 * cross-surface falsifier for that, because the two divergences it covers were
 * both invisible from inside either surface's own tests: the picker's folding
 * depended on the device's locale, and its haystack was two of the four
 * searchable fields.
 */

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

/**
 * A Turkish device, exactly.
 *
 * The ambient locale is an environment adapter and therefore a genuine system
 * boundary: production calls `toLocaleLowerCase()` with no argument, so nothing
 * inside the process can observe the dependency without standing in for that
 * boundary. Replacing the built-in with its explicit `tr` behaviour is the only
 * discriminating test available — an `en-US` test process folds `I` to `i` under
 * either implementation, which is precisely why the second copy of this rule
 * survived a green suite.
 */
const nativeToLocaleLowerCase = String.prototype.toLocaleLowerCase;

function useTurkishDevice(): void {
    // eslint-disable-next-line no-extend-native
    String.prototype.toLocaleLowerCase = function turkish(this: string): string {
        return nativeToLocaleLowerCase.call(this, 'tr');
    };
}

afterEach(() => {
    String.prototype.toLocaleLowerCase = nativeToLocaleLowerCase;
});

type ObservedText = Readonly<{
    title: string;
    summary?: string;
    scopeLabel?: string;
    displayPath?: string;
}>;

function observation(input: ObservedText): ProjectedObservationV1 {
    return {
        sourceInstanceId: INSTANCE_ID,
        observedAtMs: 1_000,
        outcome: testkitPresentOutcome({
            locator: testkitLocator({
                ...(input.displayPath === undefined ? {} : { displayPath: input.displayPath }),
            }),
            snapshot: testkitSnapshot({
                title: input.title,
                ...(input.summary === undefined ? {} : { summary: input.summary }),
                ...(input.scopeLabel === undefined ? {} : { scopeLabel: input.scopeLabel }),
            }),
            viewer: testkitViewer(),
        }),
    };
}

function present(input: ObservedText & Readonly<{ entryId: string }>): CorpusQualifiedObservationV1 {
    return { entryRef: testkitEntryRef({ entryId: input.entryId }), ...observation(input) };
}

function fold(
    observations: readonly CorpusQualifiedObservationV1[],
    lens: Partial<TriageListLensV1> = {},
): TriageListWindowV1 {
    return foldTriageListWindow({
        observations,
        lanes: [{
            sourceInstanceId: INSTANCE_ID,
            source: TRIAGE_TESTKIT_SOURCE,
            health: { kind: 'walkFinished' },
            exhausted: true,
        }],
        configuredSourcesStatus: 'complete',
        activeSourceInstanceIds: [INSTANCE_ID],
        lens: { ...TRIAGE_LIST_DEFAULT_LENS_V1, ...lens },
        assembledAtMs: 5_000,
    });
}

/** The picker reads the same rows through the same mounted snapshot. */
function pickerTitles(
    observations: readonly CorpusQualifiedObservationV1[],
    query: string,
): readonly string[] {
    const snapshot: TriageListWindowSnapshotV1 = {
        window: fold(observations),
        freshness: 'fresh',
        pending: 'idle',
        configuredSources: [{ sourceInstanceId: INSTANCE_ID, source: TRIAGE_TESTKIT_SOURCE, available: true }],
    };
    const view = buildTriagePickerView({
        facts: projectTriagePickerCorpusFacts({ snapshot, nowMs: 6_000 }),
        query,
        attached: [],
    });
    return view.rows.map((row) => row.title);
}

describe('the one entry search rule', () => {
    it('folds case without reading the device locale', () => {
        useTurkishDevice();
        expect(foldTriageSearchValue('ISSUE')).toBe('issue');
        expect(parseTriageSearchQuery('Issue')).toEqual(['issue']);
    });

    it('requires every term but lets them come from different fields', () => {
        const text = projectTriageEntrySearchText([observation({
            title: 'Fix the parser crash',
            scopeLabel: 'acme/web',
        })]);

        expect(triageEntryMatchesSearch(text, parseTriageSearchQuery('acme parser'))).toBe(true);
        expect(triageEntryMatchesSearch(text, parseTriageSearchQuery('acme absent'))).toBe(false);
        // No query matches everything: an empty search is not an empty result.
        expect(triageEntryMatchesSearch(text, parseTriageSearchQuery('  '))).toBe(true);
    });

    it('searches the summary and the display path an entry was observed with', () => {
        const text = projectTriageEntrySearchText([observation({
            title: 'Add retry budget',
            summary: 'The upstream returns 429.',
            displayPath: 'acme/api #42',
        })]);

        expect(triageEntryMatchesSearch(text, parseTriageSearchQuery('upstream'))).toBe(true);
        expect(triageEntryMatchesSearch(text, parseTriageSearchQuery('#42'))).toBe(true);
    });
});

describe('the list and the picker answer one query the same way', () => {
    const ROWS = [
        present({ entryId: '42', title: 'ISSUE in the parser', scopeLabel: 'acme/web' }),
        present({
            entryId: '7',
            title: 'Add retry budget',
            summary: 'The upstream returns 429 under load.',
            scopeLabel: 'acme/api',
            displayPath: 'acme/api #7',
        }),
    ];

    it('finds the same entry on a Turkish device', () => {
        // The exact defect: `toLocaleLowerCase` maps `I` to `ı` on a Turkish
        // device, so a search for `issue` misses every entry titled `ISSUE`.
        // The reader is told the entry does not exist while the list beside the
        // composer is showing it.
        useTurkishDevice();

        expect(fold(ROWS, { query: 'issue' }).rows).toHaveLength(1);
        expect(pickerTitles(ROWS, 'issue')).toEqual(['ISSUE in the parser']);
    });

    it('finds the same entry by a summary or a path neither surface displays', () => {
        expect(fold(ROWS, { query: 'upstream' }).rows).toHaveLength(1);
        expect(pickerTitles(ROWS, 'upstream')).toEqual(['Add retry budget']);
        expect(pickerTitles(ROWS, 'acme/api #7')).toEqual(['Add retry budget']);
    });

    it('combines terms from two fields identically', () => {
        expect(fold(ROWS, { query: 'acme retry' }).rows).toHaveLength(1);
        expect(pickerTitles(ROWS, 'acme retry')).toEqual(['Add retry budget']);
    });
});
