import { describe, expect, it } from 'vitest';

import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
} from './bounds.js';
import {
    TriageSourcesContributionPointV1,
    TriageSourcesContributionProtocolV1,
} from './contribution.js';
import { TriageDetailSurfaceInputV1Schema } from './detail.js';
import { TriageListInstancesInputV1Schema } from './instances.js';

describe('Triage sources contribution protocol', () => {
    it('declares required reads plus optional prepare and final verification roles', () => {
        const operations = TriageSourcesContributionProtocolV1.operations;
        expect(Object.keys(operations).sort())
            .toEqual(['get', 'listInstances', 'prepareReviewWorkspace', 'scan', 'verifyReviewWorkspace']);
        for (const role of ['listInstances', 'scan', 'get'] as const) {
            expect(operations[role].declaration.dangerLevel).toBe('safe');
            expect(operations[role].declaration.surfaces).toEqual(['plugin']);
        }
        expect(operations.prepareReviewWorkspace.declaration.dangerLevel).toBe('writesLocal');
        expect(operations.verifyReviewWorkspace.declaration.dangerLevel).toBe('safe');
    });

    it('binds every role to a protocol-defined input rather than a contributor-defined one', () => {
        for (const operation of Object.values(TriageSourcesContributionProtocolV1.operations)) {
            expect(operation.declaration.input.kind).toBe('protocolDefined');
        }
        expect(TriageSourcesContributionProtocolV1.operations.listInstances.declaration.input)
            .toMatchObject({ schema: TriageListInstancesInputV1Schema });
    });

    it('declares the required detail content surface and no other surface role', () => {
        // The published role constant IS the declared role. A mounted target
        // picks its handle out of an admitted snapshot by this name, so a second
        // spelling is a detail region that renders nothing and says nothing.
        expect(Object.keys(TriageSourcesContributionProtocolV1.surfaces))
            .toEqual([TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1]);
    });

    it('publishes the descriptor and detail JSON Schemas from the composable values themselves', () => {
        expect(TriageSourcesContributionProtocolV1.descriptor?.jsonSchema)
            .toBeTypeOf('object');
        expect(TriageDetailSurfaceInputV1Schema.jsonSchema).toBeTypeOf('object');
    });
});

describe('Triage sources contribution point', () => {
    it('admits one V1 contribution per source plugin', () => {
        expect(TriageSourcesContributionPointV1).toMatchObject({
            maxContributionsPerContributor: 1,
            protocols: [{
                id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
                version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
            }],
        });
    });
});
