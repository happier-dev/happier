import { PluginError, isPluginError, type DeploymentTargetPreparationBaseV1, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { DatabaseFailureV1 } from '@happier-dev/database-protocol';
import { request, resource } from './operations.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(): never { throw new PluginError({ code: 'provider_response_invalid' }); }

/** Selected provider transport only; SQL compilation and result semantics belong to the shared dialect. */
export async function openSupabaseReadOnlyTransport(input: DeploymentTargetPreparationBaseV1 & Readonly<{ database?: string }>,
  context: PluginAccountActionContext): Promise<Readonly<{ ok: true;
    database: string;
    execute(statement: Readonly<{ sql: string; parameters: readonly JsonValue[] }>, signal?: AbortSignal): Promise<Record<string, unknown>[]>;
  }> | Extract<DatabaseFailureV1, { status: 'unavailable' }>> {
  const { branchRef } = resource(input);
  // Official Management API 1.0.0, characterized 2026-11-10:
  // https://supabase.com/docs/reference/api/v1-read-only-query
  // This dedicated endpoint runs as supabase_read_only_user. Never use the
  // writable query endpoint or a client-side SQL parser as authorization.
  const path = `/v1/projects/${encodeURIComponent(branchRef)}/database/query/read-only`;
  // The endpoint has no database selector. Confirm its actual database before
  // caller SQL rather than silently treating a requested name as that default.
  let selected: unknown;
  try {
    selected = await request(context, path, 'POST', { query: 'SELECT current_database() AS database', parameters: [] }, true);
  } catch (error) {
    if (isPluginError(error) && error.code === 'plugin_fetch_response_too_large') return { ok: false, status: 'unavailable', code: 'database_transport_unavailable', reason: 'action_result_size_limit' };
    throw error;
  }
  if (!Array.isArray(selected) || selected.length !== 1 || !record(selected[0]) || typeof selected[0].database !== 'string' || !selected[0].database) return invalid();
  if (input.database !== undefined && selected[0].database !== input.database) return { ok: false, status: 'unavailable', code: 'database_transport_unavailable', reason: 'database_unsupported' };
  return { ok: true, database: selected[0].database, execute: async (statement, signal) => {
    const response: unknown = await request({ services: context.services, signal: signal ?? context.signal }, path, 'POST',
      { query: statement.sql, parameters: statement.parameters }, true);
    if (!Array.isArray(response) || !response.every(record)) return invalid();
    return response;
  } };
}
