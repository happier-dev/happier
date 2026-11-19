import { TriageSourceDescriptorV1Schema, TriageSourcesContributionProtocolV1 } from '@happier-dev/triage-protocol/v1';
import { TRIAGE_DATA_ACTION_EXECUTION_V1 } from '../accountExecution.js';
import { REVIEW_ACCOUNT_DATA_INSTANCE_V1, REVIEW_DRAFT_V1, getReviewV1, readReviewAttentionV1, scanReviewsV1 } from './source.js';

const REVIEW_SOURCE_LIST_INSTANCES_ACTION_ID_V1 = 'internal/reviews/list-instances-v1';
const REVIEW_SOURCE_READ_ATTENTION_ACTION_ID_V1 = 'internal/reviews/read-attention-v1';
const REVIEW_SOURCE_SCAN_ACTION_ID_V1 = 'internal/reviews/scan-v1';
const REVIEW_SOURCE_GET_ACTION_ID_V1 = 'internal/reviews/get-v1';

const protocol = TriageSourcesContributionProtocolV1;
export const REVIEW_DESCRIPTOR_V1 = TriageSourceDescriptorV1Schema.parse({ v: 1, purpose: 'reviews', displayName: 'Reviews',
    accountDataInstance: REVIEW_ACCOUNT_DATA_INSTANCE_V1,
    kinds: [{ id: 'review', workflowSubject: 'issue', displayName: 'Review', pluralDisplayName: 'Reviews' }] });
const read = { surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], placementBindings: [], dangerLevel: 'safe',
    execution: { ...TRIAGE_DATA_ACTION_EXECUTION_V1, invokingUi: true }, readOnly: true } as const;
export const REVIEW_ACTIONS_V1 = {
    [REVIEW_SOURCE_LIST_INSTANCES_ACTION_ID_V1]: { ...read, title: 'Discover Reviews', description: 'Read the built-in Review source.',
        inputSchema: protocol.operations.listInstances.declaration.input.schema, resultSchema: protocol.operations.listInstances.declaration.resultSchema,
        run: async () => ({ kind: 'complete' as const, candidates: [REVIEW_DRAFT_V1], failures: [] }) },
    [REVIEW_SOURCE_READ_ATTENTION_ACTION_ID_V1]: { ...read, title: 'Read Review attention', description: 'Read accessible Review requests and pending decisions in this Account.',
        inputSchema: protocol.operations.readAttention.declaration.input.schema, resultSchema: protocol.operations.readAttention.declaration.resultSchema,
        run: readReviewAttentionV1 },
    [REVIEW_SOURCE_SCAN_ACTION_ID_V1]: { ...read, title: 'Read Reviews', description: 'Read a page of accessible Reviews.',
        inputSchema: protocol.operations.scan.declaration.input.schema, resultSchema: protocol.operations.scan.declaration.resultSchema, run: scanReviewsV1 },
    [REVIEW_SOURCE_GET_ACTION_ID_V1]: { ...read, title: 'Read a Review', description: 'Read one accessible Review.',
        inputSchema: protocol.operations.get.declaration.input.schema, resultSchema: protocol.operations.get.declaration.resultSchema, run: getReviewV1 },
};
export const REVIEW_CONTRIBUTION_V1 = protocol.contribute({ descriptor: REVIEW_DESCRIPTOR_V1, operations: {
    listInstances: protocol.operations.listInstances.bind(REVIEW_SOURCE_LIST_INSTANCES_ACTION_ID_V1),
    scan: protocol.operations.scan.bind(REVIEW_SOURCE_SCAN_ACTION_ID_V1), get: protocol.operations.get.bind(REVIEW_SOURCE_GET_ACTION_ID_V1),
    readAttention: protocol.operations.readAttention.bind(REVIEW_SOURCE_READ_ATTENTION_ACTION_ID_V1),
}, surfaces: { detail: { renderer: 'review-detail' } } });
