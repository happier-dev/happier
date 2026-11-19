import { PluginError, type DeploymentTargetDatabaseRuntimeV1 } from '@happier-dev/plugin-sdk';
import type { DatabaseDescriptorV1, DatabaseFailureV1 } from '@happier-dev/plugin-sdk/database';
import {
  executePostgresqlOperation, PostgresqlInputError, PostgresqlOperationError, postgresqlFailureCause,
  type PostgresqlNativeResult,
} from '@happier-dev/databases/postgresql';
import { record, request } from './provider.js';
import { openNeonReadOnlyTransport } from './transport.js';

const unsupported = (): DatabaseFailureV1 => ({ ok: false, status: 'unavailable', code: 'database_operation_unavailable',
  reason: 'The selected Neon transport supports read-only operations' });

function descriptor(target: DatabaseDescriptorV1['target'], placement: DatabaseDescriptorV1['placement']): DatabaseDescriptorV1 {
  return { target, placement, label: 'database' in target ? target.database : 'Neon', engine: 'postgresql', origin: { label: 'Neon' },
    capabilities: [
      { operation: 'schemas.list', available: true }, { operation: 'relations.list', available: true },
      { operation: 'relation.structure', available: true }, { operation: 'rows.read', available: true },
      { operation: 'cell.read', available: true }, { operation: 'statement.run', available: true },
      { operation: 'statement.explain', available: true },
      { operation: 'edits.apply', available: true },
      { operation: 'stats.read', available: false, code: 'database_operation_unavailable', reason: 'Statistics require the target statistics adapter' },
    ] };
}

/** Validate the external driver's native frame; PostgreSQL types are decoded only by the shared dialect. */
function nativeResult(value: Record<string, unknown>): PostgresqlNativeResult {
  const invalid = (): never => { throw new PluginError({ code: 'provider_response_invalid' }); };
  const fields = Array.isArray(value.fields) ? value.fields.map(value => {
    const field = record(value);
    if (typeof field.name !== 'string' || typeof field.dataTypeID !== 'number'
      || !Number.isSafeInteger(field.dataTypeID) || field.dataTypeID < 0) return invalid();
    return { name: field.name, dataTypeID: field.dataTypeID };
  }) : invalid();
  const rows = Array.isArray(value.rows) ? value.rows.map(value => {
    if (!Array.isArray(value) || value.length !== fields.length) return invalid();
    return value.map(cell => typeof cell === 'string' || cell === null ? cell : invalid());
  }) : invalid();
  if (typeof value.command !== 'string' || value.rowCount !== null
    && (typeof value.rowCount !== 'number' || !Number.isSafeInteger(value.rowCount) || value.rowCount < 0)
    || value.command === 'SELECT' && value.rowCount !== rows.length) return invalid();
  return { fields, rows, command: value.command, rowCount: value.rowCount };
}

export const neonDatabaseRuntime: DeploymentTargetDatabaseRuntimeV1 = {
  async listTargets({ preparation, target, placement }, context) {
    if (!context.services.http) throw new PluginError({ code: 'client_required' });
    const project = preparation.providerIdentity!.providerResourceId;
    const branch = preparation.providerEnvironment.kind === 'custom'
      ? preparation.providerEnvironment.id : preparation.providerIdentity!.providerEnvironment;
    const response = await request({ signal: context.signal, services: { http: context.services.http } },
      `/projects/${encodeURIComponent(project)}/branches/${encodeURIComponent(branch)}/databases`);
    if (!Array.isArray(response.databases)) throw new PluginError({ code: 'provider_response_invalid' });
    const targets = response.databases.map(value => {
      const database = record(value);
      if (typeof database.name !== 'string' || !database.name || database.branch_id !== branch) {
        throw new PluginError({ code: 'provider_response_invalid' });
      }
      return descriptor({ ...target, database: database.name }, placement);
    });
    return { targets, completeness: { complete: true } };
  },
  async open({ preparation, target, placement, access }, context) {
    const description = descriptor(target, placement);
    if (access === 'write') {
      const readDataRole = context.services.secrets.readDataRole;
      if (!readDataRole) throw new PluginError({ code: 'write_connection_setup_required' });
      const connectionString = await readDataRole({ role: 'write', signal: context.signal });
      if (!context.services.databaseEngines) throw new PluginError({ code: 'plugin_service_unavailable' });
      const connection = await context.services.databaseEngines.open('postgresql', {
        connectionString, access, signal: context.signal });
      return { descriptor: description, connection };
    }
    // Capture the admitted read login while OPEN owns credential custody.
    const selected = await openNeonReadOnlyTransport({ ...preparation, database: target.database }, context);
    return { descriptor: description, connection: {
      engine: 'postgresql',
      async execute(input, signal) {
        const operationSignal = signal ? AbortSignal.any([context.signal, signal]) : context.signal;
        if (operationSignal.aborted) return { ok: false, status: 'cancelled', code: 'database_cancelled' };
        if (input.operation === 'describe') return { ok: true, operation: 'describe', descriptor: description };
        if (input.operation === 'edits.apply' || input.operation === 'stats.read'
          || input.operation === 'statement.run' && input.mode === 'write'
          || input.operation === 'statement.explain' && input.accessMode === 'write') return unsupported();
        try {
          return await executePostgresqlOperation(input, async statement => {
            if (!selected.ok) throw new PostgresqlOperationError(selected);
            const response = await selected.execute({ sql: statement.text,
              parameters: statement.values.map(value => value instanceof Uint8Array
                ? `\\x${Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')}` : value) }, operationSignal);
            if (!response.ok) throw new PostgresqlOperationError(response);
            return nativeResult(response.native);
          });
        } catch (error) {
          if (operationSignal.aborted) return { ok: false, status: 'cancelled', code: 'database_cancelled' };
          if (error instanceof PostgresqlOperationError) return error.failure;
          if (error instanceof PostgresqlInputError) return { ok: false, status: 'failed', code: error.code, reason: error.reason };
          const cause = postgresqlFailureCause(error);
          return { ok: false, status: 'failed', code: cause.source === 'engine' ? 'database_engine_error' : 'database_transport_error', cause };
        }
      },
      async close() {},
    } };
  },
};
