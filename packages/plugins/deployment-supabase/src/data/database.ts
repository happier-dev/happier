import { PluginError, type DeploymentTargetDatabaseRuntimeV1 } from '@happier-dev/plugin-sdk';
import { DatabaseOperationNameV1Schema, type DatabaseDescriptorV1, type DatabaseManagedDeploymentTargetV1 } from '@happier-dev/database-protocol';
import { fitDatabaseOperationResult } from '@happier-dev/databases';
import {
  admitPostgresqlWorkbenchStatement, decodePostgresqlObjectRowsV1, postgresqlParameter,
  PostgresqlInputError, PostgresqlOperationError, postgresqlFailureCause,
} from '@happier-dev/databases/postgresql';
import { openSupabaseReadOnlyTransport } from './transport.js';

const unavailable = { ok: false, status: 'unavailable', code: 'database_operation_unavailable',
  reason: 'The Supabase restricted endpoint supports read statements without native PostgreSQL field metadata.' } as const;

function descriptor(target: DatabaseManagedDeploymentTargetV1, placement: DatabaseDescriptorV1['placement']): DatabaseDescriptorV1 {
  return { target, label: target.database, engine: 'postgresql', origin: { label: 'Supabase' }, placement,
    capabilities: DatabaseOperationNameV1Schema.options.map(operation => operation === 'describe' || operation === 'statement.run'
      ? { operation, available: true }
      : { operation, available: false, code: unavailable.code, reason: unavailable.reason }) };
}

/** The existing data target owns the selected provider transport; the host owns access admission. */
export const supabaseDatabaseRuntime: DeploymentTargetDatabaseRuntimeV1 = {
  async listTargets({ preparation, target, placement }, context) {
    const transport = await openSupabaseReadOnlyTransport(preparation, context);
    if (!transport.ok) return { targets: [], completeness: { complete: false, reason: 'transport_unproven' } };
    return { targets: [descriptor({ ...target, database: transport.database }, placement)], completeness: { complete: true } };
  },
  async open({ preparation, target, placement }, context) {
    const transport = await openSupabaseReadOnlyTransport({ ...preparation, database: target.database }, context);
    if (!transport.ok) throw new PluginError({ code: transport.diagnostic?.code ?? 'database_operation_unavailable' });
    const selected = descriptor(target, placement);
    return { descriptor: selected, connection: {
      engine: 'postgresql',
      async execute(input, signal) {
        const operationSignal = signal ? AbortSignal.any([context.signal, signal]) : context.signal;
        if (operationSignal.aborted) return { ok: false, status: 'cancelled', code: 'database_cancelled' };
        if (input.operation === 'describe') return { ok: true, operation: 'describe', descriptor: selected };
        if (input.operation !== 'statement.run' || input.mode !== 'read') return unavailable;
        try {
          const sql = admitPostgresqlWorkbenchStatement(input.statement.sql);
          const parameters = input.statement.parameters.map(value => {
            const parameter = postgresqlParameter(value);
            // PostgreSQL bytea text encoding at the JSON-only HTTP boundary.
            return parameter instanceof Uint8Array
              ? `\\x${Array.from(parameter, byte => byte.toString(16).padStart(2, '0')).join('')}` : parameter;
          });
          const rows = await transport.execute({ sql, parameters }, operationSignal);
          return fitDatabaseOperationResult(input, { ok: true, operation: 'statement.run', results: [decodePostgresqlObjectRowsV1(rows)] });
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
