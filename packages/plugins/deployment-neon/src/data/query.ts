import { PluginError, isPluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { isExternalActionResultWithinResponseEnvelopeLimitV1 } from '@happier-dev/plugin-sdk/actions';
import { defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { DeploymentDataQueryUnavailableV1ProtocolSchema, DeploymentDataQuerySuccessV1ProtocolSchema,
  DeploymentTargetDataQueryInputV1ProtocolSchema,
  type DeploymentDataQuerySuccessV1, type DeploymentDataQueryUnavailableV1, type DeploymentTargetDataQueryInputV1 } from '@happier-dev/deployment-protocol';
import { accountExecution } from './actions.js';
import { record } from './provider.js';
import { openNeonReadOnlyTransport } from './transport.js';

const invalid = (): never => { throw new PluginError({ code: 'provider_response_invalid' }); };
function records(value: unknown) { return Array.isArray(value) ? value.map(record) : invalid(); }
const incomplete = (): DeploymentDataQuerySuccessV1 => ({ ok: true, columns: [], rows: [], complete: false,
  diagnostic: { code: 'action_result_size_limit' } });

/** The provider HTTP contract is the official serverless driver batch transport:
 * https://github.com/neondatabase/serverless/blob/main/src/http/index.ts
 * characterized 2026-11-12. Read-only transactions reinforce DB grants; neither
 * the management key nor a replica supplies the query's login authority. */
async function query(input: DeploymentTargetDataQueryInputV1, context: PluginAccountActionContext):
  Promise<DeploymentDataQuerySuccessV1 | DeploymentDataQueryUnavailableV1> {
  const keys = Object.keys(input.params).sort((a, b) => Number(a) - Number(b));
  if (keys.some((key, index) => key !== String(index + 1))) throw new PluginError({ code: 'query_parameters_invalid' });
  const transport = await openNeonReadOnlyTransport(input, context);
  if (!transport.ok) return transport;
  let transported;
  try {
    transported = await transport.execute({ sql: input.sql, parameters: keys.map(key => input.params[key]!) });
  } catch (error) {
    if (isPluginError(error) && error.code === 'plugin_fetch_response_too_large') return incomplete();
    throw error;
  }
  if (!transported.ok) return transported;
  const result = transported.native;
  const columns = records(result.fields).map(field => typeof field.name === 'string' ? { name: field.name } : invalid());
  if (!Array.isArray(result.rows)) return invalid();
  const rows = result.rows.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== columns.length) return invalid();
    return row.map((cell: unknown) => cell === null || typeof cell === 'string' ? cell : invalid());
  });
  if (result.rowCount !== null && result.rowCount !== rows.length) return invalid();
  const output: DeploymentDataQuerySuccessV1 = { ok: true, columns, rows, complete: true };
  return isExternalActionResultWithinResponseEnvelopeLimitV1(output) ? output : incomplete();
}

export const queryAction = {
  title: 'Run read-only Neon SQL', execution: accountExecution, surfaces: ['cli', 'plugin', 'agent', 'ui'], placementBindings: [],
  inputSchema: DeploymentTargetDataQueryInputV1ProtocolSchema.jsonSchema,
  resultSchema: defineProtocolUnion([DeploymentDataQuerySuccessV1ProtocolSchema, DeploymentDataQueryUnavailableV1ProtocolSchema]).jsonSchema,
  inputHints: { fields: [{ path: 'database', title: 'Database name', widget: 'text', required: true },
    { path: 'sql', title: 'SQL', widget: 'textarea',
      description: 'Use PostgreSQL $1, $2 placeholders with parameter JSON keys "1", "2" in order. Schema-qualify table names.' }] },
  readOnly: true, dangerLevel: 'safe', hostAccess: ['neon-api', 'neon-sql', 'deploy-manage'],
  connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy-manage' }],
  run: (input: JsonValue, context: PluginAccountActionContext) => query(input as DeploymentTargetDataQueryInputV1, context),
} as const;
