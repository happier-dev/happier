/** Grant authority vocabularies; grant evaluation stays with apiTokenGrant. */
export const API_TOKEN_ENVIRONMENT_ACTION_IDS_V1 = ['deployments.deploy', 'action.operations.get'] as const;
export const API_TOKEN_DISCOVERY_ACTION_IDS_V1 = ['action.spec.search', 'action.spec.get', 'action.options.resolve'] as const;
export const API_TOKEN_APPROVAL_OBSERVATION_ACTION_IDS_V1 = ['approval.request.list', 'approval.request.get'] as const;
