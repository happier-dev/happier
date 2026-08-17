import {
    defineContributionPoint,
    defineContributionProtocol,
} from '@happier-dev/plugin-sdk/contributions';

import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
} from './bounds.js';
import { TriageSourceDescriptorV1Schema } from './descriptor.js';
import { TriageDetailSurfaceInputV1Schema } from './detail.js';
import {
    TriageListInstancesInputV1Schema,
    TriageListInstancesResultV1Schema,
} from './instances.js';
import {
    TriageGetInputV1Schema,
    TriageGetResultV1Schema,
    TriageScanInputV1Schema,
    TriageScanResultV1Schema,
} from './operations.js';
import {
    TriagePrepareReviewWorkspaceInputV1Schema,
    TriagePrepareReviewWorkspaceResultV1Schema,
} from './workspace.js';

/**
 * The V1 source role contract.
 *
 * The three provider-read roles are `safe`; `prepareReviewWorkspace` is the one
 * optional source-owned local materialization and is therefore `writesLocal`.
 * There is no generic search, mutation, decorate, credential, or
 * provider-operation role: other source writes remain ordinary named source
 * Actions with their own closed schemas (`CONTRACT.md` §2.5, §5).
 */
export const TriageSourcesContributionProtocolV1 = defineContributionProtocol({
    id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    descriptor: TriageSourceDescriptorV1Schema,
    operations: {
        listInstances: {
            required: true,
            input: { kind: 'protocolDefined', schema: TriageListInstancesInputV1Schema },
            resultSchema: TriageListInstancesResultV1Schema,
            action: { surface: 'plugin', dangerLevel: 'safe' },
        },
        scan: {
            required: true,
            input: { kind: 'protocolDefined', schema: TriageScanInputV1Schema },
            resultSchema: TriageScanResultV1Schema,
            action: { surface: 'plugin', dangerLevel: 'safe' },
        },
        get: {
            required: true,
            input: { kind: 'protocolDefined', schema: TriageGetInputV1Schema },
            resultSchema: TriageGetResultV1Schema,
            action: { surface: 'plugin', dangerLevel: 'safe' },
        },
        prepareReviewWorkspace: {
            required: false,
            input: {
                kind: 'protocolDefined',
                schema: TriagePrepareReviewWorkspaceInputV1Schema,
            },
            resultSchema: TriagePrepareReviewWorkspaceResultV1Schema,
            action: { surface: 'plugin', dangerLevel: 'writesLocal' },
        },
    },
    surfaces: {
        detail: {
            required: true,
            inputSchema: TriageDetailSurfaceInputV1Schema,
            presentation: 'content',
        },
    },
});

/** The target-owned `sources` point admits one V1 contribution per source plugin. */
export const TriageSourcesContributionPointV1 = defineContributionPoint(
    [TriageSourcesContributionProtocolV1],
    { maxContributionsPerContributor: 1 },
);
