import { z } from 'zod/mini';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_MATERIALIZATION_ID_MAX_LENGTH } from '@happier-dev/protocol/connect/connected-account-request-auth';
import { QualifiedConnectedAccountMaterialError } from '@/daemon/connectedServices/qualifiedConnectedAccountMaterialError';

// Opaque host-native purpose address, not an executable plugin declaration,
// source-custody identity, or HostAccess grant. The purpose owner admits its host
// target only under an authenticated issuer's mcp_request_auth subject.
export const MCP_REQUEST_AUTH_PURPOSE = Object.freeze({
  consumer: Object.freeze({ pluginId: 'happier.mcp', localId: 'remote-bridge' }),
  purpose: 'mcp-server',
});

const MaterializationId = z.string().check(z.trim(), z.minLength(1), z.maxLength(CONNECTED_ACCOUNT_REQUEST_AUTH_MATERIALIZATION_ID_MAX_LENGTH));
export const McpRequestAuthOpenV1Schema = z.strictObject({
  kind: z.literal('mcp.request_auth.open'),
  requestId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  serverId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  resource: z.string().check(z.url()),
  materializationId: MaterializationId,
  executionRun: z.optional(z.strictObject({ runId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)), occurrenceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)) })),
});
export const McpRequestAuthCloseV1Schema = z.strictObject({
  kind: z.literal('mcp.request_auth.close'), requestId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)), materializationId: MaterializationId,
});
export const McpRequestAuthResultV1Schema = z.strictObject({
  kind: z.literal('mcp.request_auth'), capabilityFile: z.string().check(z.minLength(1)), resource: z.string().check(z.url()),
});
export const McpRequestAuthClosedV1Schema = z.strictObject({ kind: z.literal('mcp.request_auth.closed') });
export type McpRequestAuthCapability = Omit<z.infer<typeof McpRequestAuthResultV1Schema>, 'kind'>;
const McpRequestAuthFailureCodeSchema = z.enum(['mcp_request_auth_not_active', 'mcp_request_auth_unavailable',
  'mcp_catalog_unavailable', 'mcp_resource_mismatch', 'mcp_sign_in_required']);
export type McpRequestAuthFailureCode = z.infer<typeof McpRequestAuthFailureCodeSchema>;

/** Private refusal codes may cross diagnostics; arbitrary exception text may not. */
export function readMcpRequestAuthFailureCode(error: unknown): McpRequestAuthFailureCode {
  if (error instanceof QualifiedConnectedAccountMaterialError && error.code === 'credential_snapshot_unavailable') {
    return 'mcp_sign_in_required';
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const parsed = McpRequestAuthFailureCodeSchema.safeParse(code ?? (error instanceof Error ? error.message : undefined));
  return parsed.success ? parsed.data : 'mcp_request_auth_unavailable';
}

const McpRequestAuthDiagnosticCodeSchema = z.union([McpRequestAuthFailureCodeSchema, z.enum([
  'native_agent_privileged_effect_authority_unavailable', 'native_agent_privileged_effect_outcome_unknown',
  'runner_agent_runtime_daemon_service_authority_transition',
  'execution_run_contribution_snapshot_unavailable',
  'agent_runtime_daemon_service_forbidden', 'agent_runtime_daemon_service_unavailable',
  'agent_runtime_daemon_service_admission_custody_unavailable', 'agent_runtime_daemon_service_admission_invalid',
  'agent_runtime_daemon_service_generation_not_current', 'daemon_shutting_down', 'daemon_draining',
  'requester_session_not_current', 'requester_session_custody_mismatch',
  'requester_account_context_unavailable', 'project_requester_home_unavailable',
  'AbortError', 'TimeoutError', 'TypeError', 'RangeError', 'SyntaxError',
])]);

/** File-log evidence only. Never widen the refusal disclosed in a Session notice. */
export function readMcpRequestAuthDiagnosticCode(error: unknown): z.infer<typeof McpRequestAuthDiagnosticCodeSchema> {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const parsed = McpRequestAuthDiagnosticCodeSchema.safeParse(code ?? (error instanceof Error ? error.message : undefined));
  if (parsed.success) return parsed.data;
  const name = McpRequestAuthDiagnosticCodeSchema.safeParse(error instanceof Error ? error.name : undefined);
  return name.success ? name.data : 'mcp_request_auth_unavailable';
}

const McpRequestAuthDispatchCauseSchema = z.strictObject({ code: McpRequestAuthDiagnosticCodeSchema, stage: z.literal('dispatch') });

export function readMcpRequestAuthDispatchCause(value: unknown): z.infer<typeof McpRequestAuthDispatchCauseSchema> | undefined {
  const parsed = McpRequestAuthDispatchCauseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function readMcpRequestAuthFailureDiagnostic(error: unknown): Readonly<{
  failureCode: ReturnType<typeof readMcpRequestAuthDiagnosticCode>;
  failureCheckpoint: 'request_auth_open' | 'daemon_service_dispatch';
}> {
  const cause = readMcpRequestAuthDispatchCause(error instanceof Error ? error.cause : undefined);
  return cause
    ? { failureCode: cause.code, failureCheckpoint: 'daemon_service_dispatch' }
    : { failureCode: readMcpRequestAuthDiagnosticCode(error), failureCheckpoint: 'request_auth_open' };
}

export type McpRequestAuthPort = Readonly<{
  open(input: Omit<z.infer<typeof McpRequestAuthOpenV1Schema>, 'kind' | 'requestId'>): Promise<McpRequestAuthCapability>;
  close(input: Omit<z.infer<typeof McpRequestAuthCloseV1Schema>, 'kind' | 'requestId'>): Promise<void>;
}>;
