import { PluginError, isPluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { isExternalActionResultWithinResponseEnvelopeLimitV1 } from '@happier-dev/plugin-sdk/actions';
import { defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { DeploymentDataQueryUnavailableV1ProtocolSchema, DeploymentDataQuerySuccessV1ProtocolSchema,
  DeploymentTargetDataQueryInputV1ProtocolSchema, postgresqlReadOnlyRoleGuardSql,
  type DeploymentDataQuerySuccessV1, type DeploymentDataQueryUnavailableV1, type DeploymentTargetDataQueryInputV1 } from '@happier-dev/deployment-protocol';
import { accountExecution } from './actions.js';
import { request, record } from './provider.js';

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
  const http = context.services.http;
  if (!http) return { ok: false, error: 'deployment_unavailable', diagnostic: { code: 'client_required' } };
  let password: string;
  try {
    if (!context.services.secrets?.readDataRole) throw new PluginError({ code: 'secret_missing' });
    password = await context.services.secrets.readDataRole({ signal: context.signal });
  } catch (error) {
    context.signal.throwIfAborted();
    if (isPluginError(error) && error.code === 'secret_missing') return { ok: false, error: 'deployment_unavailable',
      diagnostic: { code: 'secret_missing' } };
    throw error;
  }
  const project = input.providerIdentity!.providerResourceId;
  const branch = input.providerEnvironment.kind === 'custom' ? input.providerEnvironment.id : input.providerIdentity!.providerEnvironment;
  const path = `/projects/${encodeURIComponent(project)}/branches/${encodeURIComponent(branch)}`;
  const providerContext = { signal: context.signal, services: { http } };
  const [endpoints, databases] = await Promise.all([
    request(providerContext, `${path}/endpoints`), request(providerContext, `${path}/databases`),
  ]);
  if (!records(databases.databases).some(database => database.name === input.database && database.branch_id === branch)) return invalid();
  const selected = records(endpoints.endpoints).filter(endpoint => endpoint.type === 'read_write');
  if (selected.length !== 1) return { ok: false, error: 'deployment_unavailable', diagnostic: { code: 'neon_endpoint_unavailable' } };
  const endpoint = selected[0]!;
  if (endpoint.branch_id !== branch || endpoint.project_id !== project || typeof endpoint.host !== 'string'
    || endpoint.disabled === true) return invalid();
  const connection = new URL(`postgresql://${endpoint.host}`);
  if (connection.hostname !== endpoint.host || connection.port || connection.username || connection.password
    || !connection.hostname.endsWith('.neon.tech')) return invalid();
  // Official driver shims/net fetchEndpoint selects the regional API host;
  // the connection header retains the exact provider-returned compute host.
  const destination = new URL(`https://${endpoint.host.replace(/^[^.]+\./, 'api.')}/sql`);
  connection.username = 'happier_ro';
  connection.password = password;
  connection.pathname = `/${encodeURIComponent(input.database)}`;
  connection.searchParams.set('sslmode', 'require');
  const body = new TextEncoder().encode(JSON.stringify({ queries: [
    { query: postgresqlReadOnlyRoleGuardSql, params: [] }, { query: input.sql, params: keys.map(key => input.params[key]) },
  ] }));
  let response;
  try {
    response = await http.request({ url: destination.href, method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': connection.href,
        'Neon-Raw-Text-Output': 'true', 'Neon-Array-Mode': 'true', 'Neon-Batch-Read-Only': 'true' }, body }, { signal: context.signal });
  } catch (error) {
    context.signal.throwIfAborted();
    if (isPluginError(error) && error.code === 'plugin_fetch_response_too_large') return incomplete();
    // Network/provider errors can include the private connection header.
    throw new PluginError({ code: 'query_failed' });
  }
  context.signal.throwIfAborted();
  if (response.finalUrl !== destination.href) throw new PluginError({ code: 'query_failed' });
  if (response.status < 200 || response.status >= 300) {
    let refusal: unknown;
    try { refusal = JSON.parse(new TextDecoder().decode(response.body)); } catch { /* Provider details remain private. */ }
    if (refusal && typeof refusal === 'object' && 'code' in refusal
      && (refusal.code === '28P01' || refusal.code === '28000'
        || refusal.code === '42501' && 'message' in refusal && refusal.message === 'happier_read_role_unavailable')) {
      return { ok: false, error: 'deployment_unavailable', diagnostic: { code: 'read_role_unavailable' } };
    }
    throw new PluginError({ code: 'query_failed' });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(response.body)); } catch { return invalid(); }
  const results = records(record(parsed).results);
  if (results.length !== 2 || results[0]!.command !== 'DO') return invalid();
  const result = results[1]!;
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
