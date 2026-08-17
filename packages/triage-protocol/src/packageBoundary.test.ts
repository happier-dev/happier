import { describe, expect, it } from 'vitest';

import * as protocol from './index.js';

describe('Triage protocol public barrel', () => {
    it('projects the explicit V1 contribution contract from the root entry point', () => {
        expect(protocol.TriageSourcesContributionPointV1).toMatchObject({
            maxContributionsPerContributor: 1,
            protocols: [{
                id: 'happier.triage/sources',
                version: 1,
            }],
        });
        expect(protocol.TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1).toBe('sources');
        expect(protocol.TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1).toBe('happier.triage');
    });

    it('exposes no default, current, latest, or legacy alias', () => {
        const aliases = Object.keys(protocol)
            .filter((name) => /(?:Current|Latest|Legacy|Default)$/u.test(name));

        expect(aliases).toEqual([]);
        expect(Object.hasOwn(protocol, 'default')).toBe(false);
    });

    it('publishes each JSON Schema as exactly its composable value projection', () => {
        expect(protocol.TriageSourceDescriptorV1JsonSchema)
            .toBe(protocol.TriageSourceDescriptorV1Schema.jsonSchema);
        expect(protocol.TriageScanInputV1JsonSchema)
            .toBe(protocol.TriageScanInputV1Schema.jsonSchema);
        expect(protocol.TriageScanResultV1JsonSchema)
            .toBe(protocol.TriageScanResultV1Schema.jsonSchema);
        expect(protocol.TriageGetInputV1JsonSchema)
            .toBe(protocol.TriageGetInputV1Schema.jsonSchema);
        expect(protocol.TriageDetailSurfaceInputV1JsonSchema)
            .toBe(protocol.TriageDetailSurfaceInputV1Schema.jsonSchema);
        expect(protocol.TriagePrepareReviewWorkspaceInputV1JsonSchema)
            .toBe(protocol.TriagePrepareReviewWorkspaceInputV1Schema.jsonSchema);
    });

    it('publishes every V1 bound source projections and target limits are derived from', () => {
        // The exact values are owned by `v1/bounds.ts` and proven fit for the
        // Action byte gate by `v1/maximumEncodedResult.test.ts`; restating them
        // here would create a second bounds ledger that drifts. What the public
        // barrel owes its consumers is that each bound is exported and usable.
        const bounds = Object.entries(protocol)
            .filter(([name]) => name.startsWith('MAX_TRIAGE_'));

        expect(bounds.map(([name]) => name).sort()).toEqual([
            'MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1',
            'MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1',
            'MAX_TRIAGE_CONFIGURED_INSTANCE_RECORDS_V1',
            'MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1',
            'MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1',
            'MAX_TRIAGE_INSTANCE_DRAFTS_V1',
            'MAX_TRIAGE_INSTANCE_FAILURES_V1',
            'MAX_TRIAGE_KINDS_V1',
            'MAX_TRIAGE_LINKED_SESSIONS_V1',
            'MAX_TRIAGE_LOCATION_UTF8_BYTES_V1',
            'MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1',
            'MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1',
            'MAX_TRIAGE_ROW_FACTS_V1',
            'MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1',
            'MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1',
            'MAX_TRIAGE_TEXT_UTF8_BYTES_V1',
        ]);
        for (const [name, value] of bounds) {
            expect(value, name).toSatisfy(
                (bound: unknown) => Number.isSafeInteger(bound) && (bound as number) > 0,
            );
        }
        // The scan page count and the display-text bound are one budget: the
        // page multiplies every per-entry display byte on the way to the
        // Action byte gate. `maximumEncodedResult.test.ts` derives that worst
        // case; pinning both values here is what makes a consumer-visible
        // change to either one deliberate.
        expect(protocol.MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1).toBe(64);
        expect(protocol.MAX_TRIAGE_TEXT_UTF8_BYTES_V1).toBe(512);
    });
});
