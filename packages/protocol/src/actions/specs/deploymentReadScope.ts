import * as ids from '../../deployments/deploymentActionIdsV1.js';

type DeploymentChildMetadataReadV1 = Readonly<
  | { actionId: typeof ids.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1; operand: 'environment' }
  | { actionId: typeof ids.DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1; operand: 'receipt' }
  | { actionId: typeof ids.DEPLOYMENT_DOMAIN_GET_ACTION_ID_V1; operand: 'domain' }
>;
const environmentMetadataRead = {
  actionId: ids.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, operand: 'environment',
} satisfies DeploymentChildMetadataReadV1;

/** Local Action scope; the server selects only the signed admission's operands. */
export type DeploymentReadScopeV1 = Readonly<{
  target: 'current_health' | 'historical_receipt' | 'active_receipt' | 'restore_receipt';
  requireEnvironmentRevision: boolean;
  childMayMaterializeDomainUse: boolean;
  childReadOnly: boolean;
  childMetadataReads: Readonly<Partial<Record<'dataRole' | 'domain' | 'domainDiscover' | 'domainReview' | 'domainDns', readonly DeploymentChildMetadataReadV1[]>>>;
}>;

export const DEPLOYMENT_DATA_ROLE_CHILD_METADATA_READS_V1 = {
  dataRole: [environmentMetadataRead, { actionId: ids.DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1, operand: 'receipt' }],
} as const satisfies DeploymentReadScopeV1['childMetadataReads'];

const domainMetadataReads = [environmentMetadataRead, {
  actionId: ids.DEPLOYMENT_DOMAIN_GET_ACTION_ID_V1, operand: 'domain',
}] as const satisfies readonly DeploymentChildMetadataReadV1[];

export const DEPLOYMENT_DOMAIN_DISCOVERY_CHILD_METADATA_READS_V1 = {
  domain: domainMetadataReads, domainDiscover: [environmentMetadataRead], domainReview: [environmentMetadataRead],
} as const satisfies DeploymentReadScopeV1['childMetadataReads'];

export const DEPLOYMENT_DOMAIN_DNS_CHILD_METADATA_READS_V1 = {
  domain: domainMetadataReads, domainDns: [environmentMetadataRead],
} as const satisfies DeploymentReadScopeV1['childMetadataReads'];

/** Shared defaults only; each Action declares its scope beside its canonical entry. */
export function createDeploymentReadScopeV1(overrides: Partial<DeploymentReadScopeV1> = {}): DeploymentReadScopeV1 {
  return { target: 'active_receipt', requireEnvironmentRevision: false, childMayMaterializeDomainUse: false,
    childReadOnly: false, childMetadataReads: {}, ...overrides };
}
