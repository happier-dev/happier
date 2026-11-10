import { DeploymentDataQueryUnavailableV1ProtocolSchema, DeploymentTargetDataQueryInputV1ProtocolSchema } from '@happier-dev/deployment-protocol';
import { accountExecution } from './actions.js';

/** Neon management API v2 has no SQL execution endpoint. The documented
 * serverless readOnly transaction needs a database credential/transport:
 * https://neon.com/docs/serverless/serverless-driver
 * Do not fetch a writable connection or treat a read replica as authorization. */
export const queryAction = {
  title: 'Read-only Neon SQL availability', execution: accountExecution, surfaces: ['cli', 'plugin', 'agent', 'ui'], placementBindings: [],
  inputSchema: DeploymentTargetDataQueryInputV1ProtocolSchema.jsonSchema, resultSchema: DeploymentDataQueryUnavailableV1ProtocolSchema.jsonSchema,
  inputHints: { fields: [{ path: 'sql', title: 'SQL', widget: 'textarea',
    description: 'Read-only SQL requires a database credential and transport that the Neon management account does not provide.' }] },
  readOnly: true, dangerLevel: 'safe', hostAccess: ['deploy-manage'],
  connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy-manage' }],
  run: async () => ({ ok: false, error: 'unsupported_action', diagnostic: { code: 'neon_read_only_database_credential_required' } } as const),
} as const;
