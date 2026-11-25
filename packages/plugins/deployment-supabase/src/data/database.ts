import { isPluginError, PluginError, type DeploymentTargetDatabaseRuntimeV1 } from '@happier-dev/plugin-sdk';
import {
    DATABASE_OPERATION_NAMES_V1,
    type DatabaseDescriptorV1,
    type DatabaseManagedDeploymentTargetV1,
    type DatabaseOperationInputV1,
} from '@happier-dev/plugin-sdk/database';
import {
  admitPostgresqlWorkbenchStatement, decodePostgresqlObjectRowsV1, executePostgresqlOperation, fitDatabaseOperationResult, postgresqlParameter,
  PostgresqlInputError, PostgresqlOperationError, postgresqlFailureCause,
} from '@happier-dev/databases/postgresql';
import { readSupabaseDatabaseAddress } from './operations.js';
import { openSupabaseReadOnlyTransport } from './transport.js';

const unavailable = { ok: false, status: 'unavailable', code: 'database_operation_unavailable',
  reason: 'The Supabase restricted endpoint supports catalog browsing and read statements without native PostgreSQL field metadata.' } as const;

function isCatalogRead(operation: DatabaseOperationInputV1['operation']) {
  return operation === 'schemas.list' || operation === 'relations.list';
}

function encodeParameter(parameter: ReturnType<typeof postgresqlParameter>) {
  // PostgreSQL bytea text encoding at the JSON-only HTTP boundary.
  return parameter instanceof Uint8Array
    ? `\\x${Array.from(parameter, byte => byte.toString(16).padStart(2, '0')).join('')}` : parameter;
}

function descriptor(target: DatabaseManagedDeploymentTargetV1, placement: DatabaseDescriptorV1['placement']): DatabaseDescriptorV1 {
  return { target, label: target.database, engine: 'postgresql', origin: { label: 'Supabase' }, placement,
    capabilities: DATABASE_OPERATION_NAMES_V1.map(operation => isCatalogRead(operation)
      || operation === 'describe' || operation === 'statement.run' || operation === 'edits.apply'
      ? { operation, available: true }
      : { operation, available: false, code: unavailable.code, reason: unavailable.reason }) };
}

export const supabaseDatabaseRuntime: DeploymentTargetDatabaseRuntimeV1 = {
  readFallbackWithoutDataRole: true,
  async readRoleEndpoint({ preparation, target }, context) {
    const { host, port } = await readSupabaseDatabaseAddress(preparation, context);
    let url: URL;
    try { url = new URL(`postgresql://${host}:${port}`); }
    catch { throw new PluginError({ code: 'provider_response_invalid' }); }
    if (url.hostname !== host.toLowerCase() || url.port !== String(port) || url.username || url.password
      || url.pathname || url.search || url.hash) throw new PluginError({ code: 'provider_response_invalid' });
    url.pathname = `/${encodeURIComponent(target.database)}`;
    return { connectionString: url.href, trust: 'verified' };
  },
  async listTargets({ preparation, target, placement }, context) {
    const transport = await openSupabaseReadOnlyTransport(preparation, context);
    if (!transport.ok) return { targets: [], completeness: { complete: false, reason: 'transport_unproven' } };
    return { targets: [descriptor({ ...target, database: transport.database }, placement)], completeness: { complete: true } };
  },
  async open({ preparation, target, placement, access }, context) {
    if (access === 'write') throw new PluginError({ code: 'write_connection_setup_required' });
    const transport = await openSupabaseReadOnlyTransport({ ...preparation, database: target.database }, context);
    if (!transport.ok) throw new PluginError({ code: transport.reason });
    const selected = descriptor(target, placement);
    return { descriptor: selected, connection: {
      engine: 'postgresql',
      async execute(input, signal) {
        const operationSignal = signal ? AbortSignal.any([context.signal, signal]) : context.signal;
        if (operationSignal.aborted) return { ok: false, status: 'cancelled', code: 'database_cancelled' };
        if (input.operation === 'describe') return { ok: true, operation: 'describe', descriptor: selected };
        const catalog = isCatalogRead(input.operation);
        try {
          if (catalog) return await executePostgresqlOperation(input, async statement => {
            const fields = statement.resultFields;
            if (!fields) throw new PluginError({ code: unavailable.code });
            const records = await transport.execute({ sql: statement.text, parameters: statement.values.map(encodeParameter) }, operationSignal);
            // Catalog SQL selects names and lossless text. Object key order is a provider detail.
            const rows = records.map(record => fields.map(({ name }) => {
              const cell = record[name];
              if (typeof cell === 'string' || cell === null) return cell;
              throw new PluginError({ code: 'provider_response_invalid' });
            }));
            return { fields, rows, command: 'SELECT', rowCount: rows.length };
          });
          if (input.operation !== 'statement.run' || input.mode !== 'read') return unavailable;
          const sql = admitPostgresqlWorkbenchStatement(input.statement.sql);
          const parameters = input.statement.parameters.map(value => encodeParameter(postgresqlParameter(value)));
          const rows = await transport.execute({ sql, parameters }, operationSignal);
          return fitDatabaseOperationResult(input, { ok: true, operation: 'statement.run', results: [decodePostgresqlObjectRowsV1(rows)] });
        } catch (error) {
          if (operationSignal.aborted) return { ok: false, status: 'cancelled', code: 'database_cancelled' };
          if (error instanceof PostgresqlOperationError) return error.failure;
          if (error instanceof PostgresqlInputError) return { ok: false, status: 'failed', code: error.code, reason: error.reason };
          const cause = postgresqlFailureCause(error);
          if (catalog && isPluginError(error)) return { ok: false, status: 'failed', code: error.code, cause };
          return { ok: false, status: 'failed', code: cause.source === 'engine' ? 'database_engine_error' : 'database_transport_error', cause };
        }
      },
      async close() {},
    } };
  },
};
