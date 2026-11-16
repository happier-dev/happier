import { isPluginError, PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { isExternalActionResultWithinResponseEnvelopeLimitV1 } from '@happier-dev/plugin-sdk/actions';
import { defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { DeploymentDataQuerySuccessV1ProtocolSchema, DeploymentDataQueryUnavailableV1ProtocolSchema, DeploymentTargetDataQueryInputV1ProtocolSchema,
  type DeploymentDataQuerySuccessV1, type DeploymentDataQueryUnavailableV1, type DeploymentTargetDataQueryInputV1 } from '@happier-dev/deployment-protocol';
import { accountExecution } from './actions.js';
import { openSupabaseReadOnlyTransport } from './transport.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(): never { throw new PluginError({ code: 'provider_response_invalid' }); }
const incomplete = (): DeploymentDataQuerySuccessV1 => ({ ok: true, columns: [], rows: [], complete: false,
  diagnostic: { code: 'action_result_size_limit' } });
function cell(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalid();
  if (record(value) || Array.isArray(value)) return JSON.stringify(value);
  return invalid();
}

async function query(input: DeploymentTargetDataQueryInputV1, context: PluginAccountActionContext): Promise<DeploymentDataQuerySuccessV1 | DeploymentDataQueryUnavailableV1> {
  // The public API binds positional parameters. Values never become SQL text.
  const keys = Object.keys(input.params).sort((a, b) => Number(a) - Number(b));
  if (keys.some((key, index) => key !== String(index + 1))) throw new PluginError({ code: 'query_parameters_invalid' });
  const transport = await openSupabaseReadOnlyTransport(input, context);
  if (!transport.ok) return transport;
  let response;
  try {
    response = await transport.execute({ sql: input.sql, parameters: keys.map(key => input.params[key]!) });
  } catch (error) {
    if (isPluginError(error) && error.code === 'plugin_fetch_response_too_large') return incomplete();
    throw error;
  }
  const columns = Object.keys(response[0] ?? {}).map(name => ({ name }));
  const rows = response.map(row => {
    if (Object.keys(row).length !== columns.length || columns.some(column => !Object.hasOwn(row, column.name))) return invalid();
    return columns.map(column => cell(row[column.name]));
  });
  // The provider's public response contract has no completeness/truncation
  // marker or field metadata for empty results. Preserve that uncertainty.
  const output: DeploymentDataQuerySuccessV1 = { ok: true, columns, rows, complete: false, diagnostic: { code: 'provider_completeness_unknown' } };
  return isExternalActionResultWithinResponseEnvelopeLimitV1(output) ? output : incomplete();
}

export const queryAction = {
  title: 'Run read-only Supabase SQL', execution: accountExecution, surfaces: ['cli', 'plugin', 'agent', 'ui'], placementBindings: [],
  inputSchema: DeploymentTargetDataQueryInputV1ProtocolSchema.jsonSchema,
  resultSchema: defineProtocolUnion([DeploymentDataQuerySuccessV1ProtocolSchema, DeploymentDataQueryUnavailableV1ProtocolSchema]).jsonSchema,
  inputHints: { fields: [{ path: 'database', title: 'Database name', widget: 'text', required: true,
    description: 'Use the database served by the selected branch’s read-only endpoint.' }, { path: 'sql', title: 'SQL', widget: 'textarea',
    description: 'Use PostgreSQL $1, $2 placeholders with parameter JSON keys "1", "2" in order. Schema-qualify table names.' }] },
  readOnly: true, dangerLevel: 'safe', hostAccess: ['supabase-api', 'deploy-manage'],
  connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy-manage' }],
  // The account Action owner admits the declared input schema before invocation.
  run: (input: JsonValue, context: PluginAccountActionContext) => query(input as DeploymentTargetDataQueryInputV1, context),
} as const;
