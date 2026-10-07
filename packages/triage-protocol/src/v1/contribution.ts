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
import { TriagePullRequestStatusResultV1Schema } from './pullRequestStatus.js';
import {
    TriageListInstancesInputV1Schema,
    TriageListInstancesResultV1Schema,
} from './instances.js';
import {
    TriageGetConnectedAccountInputV1Schema,
    TriageGetInputV1Schema,
    TriageGetResultV1Schema,
    TriageScanInputV1Schema,
    TriageScanConnectedAccountInputV1Schema,
    TriageScanResultV1Schema,
} from './operations.js';
import {
    TriagePrepareReviewWorkspaceConnectedAccountInputV1Schema,
    TriagePrepareReviewWorkspaceInputV1Schema,
    TriagePrepareReviewWorkspaceResultV1Schema,
    TriageVerifyReviewWorkspaceInputV1Schema,
    TriageVerifyReviewWorkspaceConnectedAccountInputV1Schema,
    TriageVerifyReviewWorkspaceResultV1Schema,
} from './workspace.js';

/**
 * The V1 source role contract.
 *
 * The provider-read roles, including optional PR status, are `safe`; `prepareReviewWorkspace` is the one
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
            action: { surfaces: ['plugin', 'ui'], dangerLevel: 'safe' },
        },
        scan: {
            required: true,
            input: { kind: 'protocolDefined', schema: TriageScanInputV1Schema },
            resultSchema: TriageScanResultV1Schema,
            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
        },
        get: {
            required: true,
            input: { kind: 'protocolDefined', schema: TriageGetInputV1Schema },
            resultSchema: TriageGetResultV1Schema,
            action: { surfaces: ['plugin', 'ui'], dangerLevel: 'safe' },
        },
        readPullRequestStatus: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageGetInputV1Schema },
            resultSchema: TriagePullRequestStatusResultV1Schema,
            action: { surfaces: ['plugin', 'ui'], dangerLevel: 'safe' },
        },
        prepareReviewWorkspace: {
            required: false,
            input: {
                kind: 'protocolDefined',
                schema: TriagePrepareReviewWorkspaceInputV1Schema,
            },
            resultSchema: TriagePrepareReviewWorkspaceResultV1Schema,
            action: { surfaces: ['plugin'], dangerLevel: 'writesLocal' },
        },
        verifyReviewWorkspace: {
            required: false,
            input: {
                kind: 'protocolDefined',
                schema: TriageVerifyReviewWorkspaceInputV1Schema,
            },
            resultSchema: TriageVerifyReviewWorkspaceResultV1Schema,
            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
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

/** Exact V1 Action inputs for sources that support connected Accounts only. */
export const TriageSourceConnectedAccountInputsV1 = {
    listInstances: TriageListInstancesInputV1Schema,
    scan: TriageScanConnectedAccountInputV1Schema,
    get: TriageGetConnectedAccountInputV1Schema,
    readPullRequestStatus: TriageGetConnectedAccountInputV1Schema,
    prepareReviewWorkspace: TriagePrepareReviewWorkspaceConnectedAccountInputV1Schema,
    verifyReviewWorkspace: TriageVerifyReviewWorkspaceConnectedAccountInputV1Schema,
} as const satisfies Record<keyof typeof TriageSourcesContributionProtocolV1.operations, unknown>;

/** The target-owned `sources` point admits one V1 contribution per source plugin. */
export const TriageSourcesContributionPointV1 = defineContributionPoint(
    [TriageSourcesContributionProtocolV1],
    { maxContributionsPerContributor: 1 },
);
