import {
    PluginAccountCollectionContributionV1Schema,
    normalizePluginAccountCollectionContractV1,
    validatePluginCollectionUiQueryParametersV1,
} from '@happier-dev/protocol';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { CORPUS_SESSION_LINKS_COLLECTION } from '../../corpus/collections/definitions.js';
import {
    CORPUS_SESSION_LINKS_FIELD,
    CORPUS_SESSION_LINKS_INDEX_ID,
} from '../../corpus/collections/ids.js';
import {
    MAX_TRIAGE_SESSION_LINKED_ENTRY_ROWS_V1,
    TRIAGE_SESSION_LINKED_ENTRIES_UI_QUERY_ID_V1,
    triageSessionLinkedEntriesParameters,
} from './linkedEntriesQuery.js';

/**
 * The cockpit's half of the `session-links` UI-query contract.
 *
 * `PluginUiDataClient.openCollectionQuery` refuses any query id the admitted
 * contract does not declare exactly once, and the pager then admits the
 * parameters through the canonical validator asserted here. A surface that
 * merely returns rows in a test harness proves neither, which is why this reads
 * the declaration through the same normalizer the host admits it with.
 */

const CONTRACT = normalizePluginAccountCollectionContractV1({
    pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    contribution: PluginAccountCollectionContributionV1Schema.parse(CORPUS_SESSION_LINKS_COLLECTION),
});

describe('the Session cockpit linked-entries query', () => {
    it('is declared exactly once by the admitted session-links contract', () => {
        // Exactly one: the Data client refuses zero and refuses two alike.
        const declared = CONTRACT.uiQueries.filter(
            (query) => query.id === TRIAGE_SESSION_LINKED_ENTRIES_UI_QUERY_ID_V1,
        );

        expect(declared).toHaveLength(1);
        expect(declared[0]).toMatchObject({
            indexId: CORPUS_SESSION_LINKS_INDEX_ID.bySession,
            pageSize: MAX_TRIAGE_SESSION_LINKED_ENTRY_ROWS_V1,
        });
    });

    it('admits the exact parameters one mounted Session sends', () => {
        const descriptor = CONTRACT.uiQueries.find(
            (query) => query.id === TRIAGE_SESSION_LINKED_ENTRIES_UI_QUERY_ID_V1,
        );
        if (descriptor === undefined) throw new Error('the linked-entries query is not declared');

        expect(() => validatePluginCollectionUiQueryParametersV1(
            descriptor,
            triageSessionLinkedEntriesParameters('session-a'),
        )).not.toThrow();
        // A query whose prefix ignored the Session would return every link on
        // the Account, so the parameter has to be the one the index leads with.
        expect(descriptor.prefix).toEqual([
            { kind: 'parameter', parameterId: CORPUS_SESSION_LINKS_FIELD.sessionId },
        ]);
    });

    it('projects the ordering fact the cockpit rows are placed by', () => {
        const descriptor = CONTRACT.uiQueries.find(
            (query) => query.id === TRIAGE_SESSION_LINKED_ENTRIES_UI_QUERY_ID_V1,
        );
        if (descriptor === undefined) throw new Error('the linked-entries query is not declared');

        // `linkedEntryRows` orders on this projected field. An unprojected one
        // would collapse every row to the same position without failing loudly.
        expect(descriptor.projectedFields.map((field) => field.field))
            .toContain(CORPUS_SESSION_LINKS_FIELD.linkedAtMs);
    });
});
