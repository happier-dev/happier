import { withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { PluginError, isPluginError, type DeploymentTargetPreparationBaseV1, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { postgresqlReadOnlyRoleGuardSql, type DeploymentDataQueryUnavailableV1 } from '@happier-dev/deployment-protocol';
import { request, record } from './provider.js';

const invalid = (): never => { throw new PluginError({ code: 'provider_response_invalid' }); };
function records(value: unknown) { return Array.isArray(value) ? value.map(record) : invalid(); }

/** Selected provider transport only; SQL compilation and result semantics belong to the shared dialect. */
export async function openNeonReadOnlyTransport(input: DeploymentTargetPreparationBaseV1 & Readonly<{ database: string }>,
  context: PluginAccountActionContext): Promise<Readonly<{ ok: true;
    execute(statement: Readonly<{ sql: string; parameters: readonly JsonValue[] }>, signal?: AbortSignal):
      Promise<Readonly<{ ok: true; native: Record<string, unknown> }> | DeploymentDataQueryUnavailableV1>;
  }> | DeploymentDataQueryUnavailableV1> {
  const http = context.services.http;
  if (!http) return withActionFailureDiagnostic<DeploymentDataQueryUnavailableV1>({ ok: false, error: 'deployment_unavailable', diagnostic: { code: 'client_required' } }, { phase: 'deployment.neon.client', causeKind: 'client_required' });
  let password: string;
  try {
    if (!context.services.secrets?.readDataRole) throw new PluginError({ code: 'secret_missing' });
    password = await context.services.secrets.readDataRole({ signal: context.signal });
  } catch (error) {
    context.signal.throwIfAborted();
    if (isPluginError(error) && error.code === 'secret_missing') return withActionFailureDiagnostic<DeploymentDataQueryUnavailableV1>({ ok: false, error: 'deployment_unavailable',
      diagnostic: { code: 'secret_missing' } }, { phase: 'deployment.neon.read_role', causeKind: 'binding_missing', error });
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
  if (selected.length !== 1) return withActionFailureDiagnostic<DeploymentDataQueryUnavailableV1>({ ok: false, error: 'deployment_unavailable', diagnostic: { code: 'neon_endpoint_unavailable' } }, { phase: 'deployment.neon.endpoint', causeKind: 'not_found' });
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
  return { ok: true, execute: async (statement, signal) => {
    const operationSignal = signal ?? context.signal;
    operationSignal.throwIfAborted();
    const body = new TextEncoder().encode(JSON.stringify({ queries: [
      { query: postgresqlReadOnlyRoleGuardSql, params: [] }, { query: statement.sql, params: statement.parameters },
    ] }));
    let response;
    try {
      response = await http.request({ url: destination.href, method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': connection.href,
          'Neon-Raw-Text-Output': 'true', 'Neon-Array-Mode': 'true', 'Neon-Batch-Read-Only': 'true' }, body }, { signal: operationSignal });
    } catch (error) {
      operationSignal.throwIfAborted();
      if (isPluginError(error) && error.code === 'plugin_fetch_response_too_large') throw error;
      // Network/provider errors can include the private connection header.
      throw new PluginError({ code: 'query_failed' });
    }
    operationSignal.throwIfAborted();
    if (response.finalUrl !== destination.href) throw new PluginError({ code: 'query_failed' });
    if (response.status < 200 || response.status >= 300) {
      let refusal: unknown;
      try { refusal = JSON.parse(new TextDecoder().decode(response.body)); } catch { /* Provider details remain private. */ }
      if (refusal && typeof refusal === 'object' && 'code' in refusal
        && (refusal.code === '28P01' || refusal.code === '28000'
          || refusal.code === '42501' && 'message' in refusal && refusal.message === 'happier_read_role_unavailable')) {
        return withActionFailureDiagnostic<DeploymentDataQueryUnavailableV1>({ ok: false, error: 'deployment_unavailable', diagnostic: { code: 'read_role_unavailable' } }, { phase: 'deployment.neon.query', causeKind: 'access_denied' });
      }
      if (refusal && typeof refusal === 'object' && 'code' in refusal && typeof refusal.code === 'string'
        && /^[0-9A-Z]{5}$/.test(refusal.code)) {
        // Native SQLSTATE is public; provider messages may contain private SQL or credentials.
        throw Object.assign(new Error('The selected Neon database rejected the statement'), { code: refusal.code });
      }
      throw new PluginError({ code: 'query_failed' });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(response.body)); } catch { return invalid(); }
    const results = records(record(parsed).results);
    if (results.length !== 2 || results[0]!.command !== 'DO') return invalid();
    const result = results[1]!;
    return { ok: true, native: result };
  } };
}
