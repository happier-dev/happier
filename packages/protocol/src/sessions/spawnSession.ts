import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { z as zMini } from 'zod/mini';
import { SessionAuthoringTerminalV1Schema } from './authoring/creationFieldsV1.js';
import { OperationUpdateRequiredV1Schema } from '../compat/operationUpdateRequiredV1.js';
import { SessionAccessErrorCodeV1Schema } from './access/sessionAccessOperationsV1.js';

import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  isConnectedServiceUxDiagnosticV1,
  normalizeConnectedServiceUxDiagnosticV1,
  type ConnectedServiceUxDiagnosticV1,
} from '../connect/connectedServiceUxDiagnostics.js';
import { ProviderErrorV1Schema, type ProviderErrorV1 } from '../providers/errors.js';
import { SpawnFailureV1Schema } from '../machines/processes/spawnFailureV1.js';
export { SessionSpawnLaunchErrorV1Schema, type SessionSpawnLaunchErrorV1 } from './creation/sessionSpawnLaunchErrorV1.js';
import { SessionSpawnLaunchErrorV1Schema, type SessionSpawnLaunchErrorV1 } from './creation/sessionSpawnLaunchErrorV1.js';

// Process launch accepts the existing daemon modes, not integrated UI authoring.
export const SpawnSessionTerminalSchema = lazyZodSchema(() => {
  const { mode, tmux, herdr } = SessionAuthoringTerminalV1Schema.shape;
  return z.object({
    mode: z.optional(z.enum(mode._zod.def.innerType.options.filter(value => value !== 'integrated'))),
    tmux: z.optional(z.object(tmux._zod.def.innerType.shape)),
    herdr: z.optional(z.object(herdr._zod.def.innerType.shape)),
  });
});

/** Fresh execution authority is bound to the exact opaque user-message local id. */
export const SpawnSessionExecutionAuthorizationSchema = lazyZodSchema(() => z.strictObject({
  provenance: z.literal('user_request'),
  requestId: z.string().check(z.refine((value) => value.trim().length > 0, {
    message: 'Execution authorization request id must not be blank',
  })),
  requestedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
}));
export type SpawnSessionExecutionAuthorization = z.infer<typeof SpawnSessionExecutionAuthorizationSchema>;

export const SPAWN_SESSION_ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_ENVIRONMENT_VARIABLES: 'INVALID_ENVIRONMENT_VARIABLES',
  AUTH_ENV_UNEXPANDED: 'AUTH_ENV_UNEXPANDED',
  RESUME_NOT_SUPPORTED: 'RESUME_NOT_SUPPORTED',
  RESUME_MISSING_ENCRYPTION_KEY: 'RESUME_MISSING_ENCRYPTION_KEY',
  RESUME_UNSUPPORTED_ENCRYPTION_VARIANT: 'RESUME_UNSUPPORTED_ENCRYPTION_VARIANT',
  DIRECTORY_CREATE_FAILED: 'DIRECTORY_CREATE_FAILED',
  SESSION_DIRECTORY_MISSING: 'SESSION_DIRECTORY_MISSING',
  SPAWN_VALIDATION_FAILED: 'SPAWN_VALIDATION_FAILED',
  AGENT_CLI_MISSING: 'agent_cli_missing',
  AGENT_SIGNED_OUT: 'agent_signed_out',
  BACKEND_DISABLED: 'backend_disabled',
  SPAWN_NO_PID: 'SPAWN_NO_PID',
  CHILD_EXITED_BEFORE_WEBHOOK: 'CHILD_EXITED_BEFORE_WEBHOOK',
  SESSION_WEBHOOK_TIMEOUT: 'SESSION_WEBHOOK_TIMEOUT',
  SPAWN_FAILED: 'SPAWN_FAILED',
  ACCOUNT_SCOPE_CHANGED: 'ACCOUNT_SCOPE_CHANGED',
  DAEMON_RPC_UNAVAILABLE: 'DAEMON_RPC_UNAVAILABLE',
  DAEMON_DRAINING: 'daemon_draining',
  DAEMON_SHUTTING_DOWN: 'daemon_shutting_down',
  SESSION_INITIAL_ACCESS_NOT_AUTHENTICATED: 'not_authenticated',
  SESSION_INITIAL_ACCESS_RECIPIENT_KEY_UNAVAILABLE: 'recipient_key_unavailable',
  SESSION_INITIAL_ACCESS_INVALID_RECIPIENT_ENVELOPE: 'session_access_invalid_recipient_envelope',
  SESSION_INITIAL_ACCESS_REQUEST_FAILED: 'session_access_request_failed',
  SESSION_INITIAL_ACCESS_SUBJECT_NOT_FOUND: 'session_access_subject_not_found',
  SESSION_INITIAL_ACCESS_DATA_KEY_UNAVAILABLE: 'session_data_key_unavailable',
  UNEXPECTED: 'UNEXPECTED',
} as const;

export const SpawnSessionErrorCodeSchema = lazyZodSchema(() => z.enum([
  SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
  SPAWN_SESSION_ERROR_CODES.INVALID_ENVIRONMENT_VARIABLES,
  SPAWN_SESSION_ERROR_CODES.AUTH_ENV_UNEXPANDED,
  SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
  SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
  SPAWN_SESSION_ERROR_CODES.RESUME_UNSUPPORTED_ENCRYPTION_VARIANT,
  SPAWN_SESSION_ERROR_CODES.DIRECTORY_CREATE_FAILED,
  SPAWN_SESSION_ERROR_CODES.SESSION_DIRECTORY_MISSING,
  SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
  SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING,
  SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT,
  SPAWN_SESSION_ERROR_CODES.BACKEND_DISABLED,
  SPAWN_SESSION_ERROR_CODES.SPAWN_NO_PID,
  SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
  SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
  SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
  SPAWN_SESSION_ERROR_CODES.ACCOUNT_SCOPE_CHANGED,
  SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
  SPAWN_SESSION_ERROR_CODES.DAEMON_DRAINING,
  SPAWN_SESSION_ERROR_CODES.DAEMON_SHUTTING_DOWN,
  SPAWN_SESSION_ERROR_CODES.SESSION_INITIAL_ACCESS_NOT_AUTHENTICATED,
  SPAWN_SESSION_ERROR_CODES.SESSION_INITIAL_ACCESS_RECIPIENT_KEY_UNAVAILABLE,
  SPAWN_SESSION_ERROR_CODES.SESSION_INITIAL_ACCESS_INVALID_RECIPIENT_ENVELOPE,
  SPAWN_SESSION_ERROR_CODES.SESSION_INITIAL_ACCESS_REQUEST_FAILED,
  SPAWN_SESSION_ERROR_CODES.SESSION_INITIAL_ACCESS_SUBJECT_NOT_FOUND,
  SPAWN_SESSION_ERROR_CODES.SESSION_INITIAL_ACCESS_DATA_KEY_UNAVAILABLE,
  SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
]));

export type SpawnSessionErrorCode = (typeof SPAWN_SESSION_ERROR_CODES)[keyof typeof SPAWN_SESSION_ERROR_CODES];

/**
 * Structured, machine-recognizable detail attached to a spawn error so clients can react
 * programmatically instead of parsing the human-readable `errorMessage`.
 *
 * This closed union is optional on the spawn error result. Consumers of only
 * `errorCode`/`errorMessage` retain the failure. A current 0.3 `launch_retired`
 * detail additionally supplies exact custody evidence, not presentation text.
 */
export const SPAWN_SESSION_ERROR_DETAIL_KINDS = {
  LAUNCH_ERROR: 'launch_error',
  LAUNCH_RETIRED: 'launch_retired',
  /** Fresh requester Home evidence was unavailable before the runner launched. */
  REQUESTER_HOME_UNAVAILABLE: 'requester_home_unavailable',
  SPAWN_FAILURE: 'spawn_failure',
  TERMINAL_HOST_UNAVAILABLE: 'terminal_host_unavailable',
  /**
   * A connected-service auth switch/resume fail-closed because the resumed session could not be
   * proven reachable in the materialized target before the vendor launched (K1 §2 gate). Surfaced
   * under `SPAWN_VALIDATION_FAILED` (the enum value is unchanged for back-compat); this detail
   * carries the structured continuity reason so the client can show the "switch unavailable"
   * explanation and offer "start fresh under the new account".
   */
  CONNECTED_SERVICE_RESUME_UNREACHABLE: 'connected_service_resume_unreachable',
  /**
   * A connected-service spawn failure whose useful, protocol-owned UI detail is the diagnostic
   * itself. This covers fail-closed errors that are not resume-reachability probes, such as missing
   * materialization identity during existing-session attach.
   */
  CONNECTED_SERVICE_UX_DIAGNOSTIC: 'connected_service_ux_diagnostic',
  /** A strict provider-domain refusal preserved for UI/CLI recovery without parsing message prose. */
  PROVIDER_ERROR: 'provider_error',
  /**
   * The exact `POST /v1/sessions` organization-placement rejection. This is
   * deliberately narrower than the public Action error taxonomy: transport
   * failures and unavailable organization state must not be reclassified as
   * this server-originated refusal.
   */
  SESSION_CREATION_ORGANIZATION_INVALID: 'session_creation_organization_invalid',
  /**
   * The existing Session has the same create-or-rejoin tag but a different
   * immutable creation recipe. This is distinct from mutable organization
   * placement and must terminate the losing creation attempt.
   */
  SESSION_CREATION_CORRESPONDENCE_CONFLICT: 'session_creation_correspondence_conflict',
  /**
   * The Home's typed no-effect refusal of access-bearing creation (for example
   * Session sharing off). It carries the protocol-owned Session-access code only.
   */
  SESSION_CREATION_ACCESS_REFUSED: 'session_creation_access_refused',
  SESSION_CREATION_INITIAL_TRIGGER_REFUSED: 'session_creation_initial_trigger_refused',
  /** A strict no-effect initial-access refusal requiring a newer server or daemon. */
  SESSION_INITIAL_ACCESS_UPDATE_REQUIRED: 'update_required',
} as const;

export type SpawnSessionErrorDetailKind =
  (typeof SPAWN_SESSION_ERROR_DETAIL_KINDS)[keyof typeof SPAWN_SESSION_ERROR_DETAIL_KINDS];

/**
 * The continuity failure code mirrored from the CLI switch-FSM / spawn re-verify taxonomy
 * (`ConnectedServiceSpawnResumeUnreachableError.errorCode`). It is the only code the spawn-path
 * reachability gate emits, so it is modeled as a literal rather than the broader connect-error enum.
 */
export type ConnectedServiceResumeUnreachableContinuityCode = 'provider_session_state_unavailable_for_resume';

export type ConnectedServiceResumeUnreachableSpawnErrorDetail = Readonly<{
  kind: typeof SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE;
  /** Mirrors `ConnectedServiceSpawnResumeUnreachableError.errorCode`. */
  continuityErrorCode: ConnectedServiceResumeUnreachableContinuityCode;
  /** Mirrors `ConnectedServiceSpawnResumeUnreachableError.failurePhase` (the switch-FSM phase). */
  failurePhase: 'continuity';
  /** The catalog agent id of the backend whose resume was unreachable (e.g. `pi`, `codex`). */
  agentId: string;
  /** A UI-safe machine-readable reason from the reachability probe. */
  reason: string;
  /** UI-safe diagnostic payload. Daemon-local paths/provider resume ids must not be included here. */
  uxDiagnostic: ConnectedServiceUxDiagnosticV1;
}>;

export type ConnectedServiceUxDiagnosticSpawnErrorDetail = Readonly<{
  kind: typeof SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_UX_DIAGNOSTIC;
  uxDiagnostic: ConnectedServiceUxDiagnosticV1;
}>;

export type ProviderSpawnErrorDetail = Readonly<{
  kind: typeof SPAWN_SESSION_ERROR_DETAIL_KINDS.PROVIDER_ERROR;
  providerError: ProviderErrorV1;
}>;

/**
 * Safe terminal result emitted only when the server rejected the requested
 * creation-time organization placement with its explicit stable error code.
 */
export const SessionCreationOrganizationInvalidSpawnErrorDetailSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal(SPAWN_SESSION_ERROR_DETAIL_KINDS.SESSION_CREATION_ORGANIZATION_INVALID),
  code: z.literal('organization_invalid'),
}));
export type SessionCreationOrganizationInvalidSpawnErrorDetail = z.infer<
  typeof SessionCreationOrganizationInvalidSpawnErrorDetailSchema
>;

/**
 * Safe terminal result emitted when an existing Session's immutable
 * create-or-rejoin correspondence differs from the admitted request.
 */
export const SessionCreationCorrespondenceConflictSpawnErrorDetailSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal(SPAWN_SESSION_ERROR_DETAIL_KINDS.SESSION_CREATION_CORRESPONDENCE_CONFLICT),
  code: z.literal('creation_conflict'),
}));
export type SessionCreationCorrespondenceConflictSpawnErrorDetail = z.infer<
  typeof SessionCreationCorrespondenceConflictSpawnErrorDetailSchema
>;

/**
 * Safe terminal result emitted when the Home's atomic create refused the
 * requested initial access with a protocol-owned Session-access code.
 */
export const SessionCreationAccessRefusedSpawnErrorDetailSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal(SPAWN_SESSION_ERROR_DETAIL_KINDS.SESSION_CREATION_ACCESS_REFUSED),
  code: SessionAccessErrorCodeV1Schema,
}));
export type SessionCreationAccessRefusedSpawnErrorDetail = z.infer<
  typeof SessionCreationAccessRefusedSpawnErrorDetailSchema
>;

/** Exact no-effect creation refusals carried to a daemon spawn waiter. */
export const SessionCreationTerminalSpawnErrorDetailSchema = lazyZodSchema(() => z.union([
  SessionCreationOrganizationInvalidSpawnErrorDetailSchema,
  SessionCreationCorrespondenceConflictSpawnErrorDetailSchema,
  SessionCreationAccessRefusedSpawnErrorDetailSchema,
  z.strictObject({
    kind: z.literal(SPAWN_SESSION_ERROR_DETAIL_KINDS.SESSION_CREATION_INITIAL_TRIGGER_REFUSED),
    code: z.enum(['invalid_input', 'target_unavailable', 'feature_disabled']),
  }),
  zMini.extend(OperationUpdateRequiredV1Schema, {
    operation: z.literal('session.spawn_new'),
    component: z.enum(['server', 'daemon']),
    reason: z.literal('session_initial_access_update_required'),
  }),
]));
export type SessionCreationTerminalSpawnErrorDetail = z.infer<
  typeof SessionCreationTerminalSpawnErrorDetailSchema
>;

export const TerminalHostUnavailableSpawnErrorDetailSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal(SPAWN_SESSION_ERROR_DETAIL_KINDS.TERMINAL_HOST_UNAVAILABLE),
  host: z.enum(['herdr', 'zellij']),
  reason: z.enum(['installation_unavailable', 'server_version_unsupported']),
}));
export type TerminalHostUnavailableSpawnErrorDetail = z.infer<typeof TerminalHostUnavailableSpawnErrorDetailSchema>;

/** Optional presentation diagnostic; the existing spawn outcome and error code remain authoritative. */
export const SpawnFailureSpawnErrorDetailSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SpawnFailureV1Schema, {
  kind: z.literal(SPAWN_SESSION_ERROR_DETAIL_KINDS.SPAWN_FAILURE),
})));
export type SpawnFailureSpawnErrorDetail = z.infer<typeof SpawnFailureSpawnErrorDetailSchema>;

/** Exact daemon proof: startup failed before input, and its wrapper/runner custody was retired. */
export const SessionLaunchRetiredV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('launch_retired'),
  spawnNonce: z.string().check(z.minLength(1)),
  wrapperPid: z.number().check(z.int(), z.positive(), z.int()),
}));
export type SessionLaunchRetiredV1 = z.infer<typeof SessionLaunchRetiredV1Schema>;

/** Content-free transient cause; neither revocation nor a missing daemon capability. */
const RequesterHomeUnavailableSpawnErrorDetailSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal(SPAWN_SESSION_ERROR_DETAIL_KINDS.REQUESTER_HOME_UNAVAILABLE),
}));
type RequesterHomeUnavailableSpawnErrorDetail = z.infer<typeof RequesterHomeUnavailableSpawnErrorDetailSchema>;

export type SpawnSessionErrorDetail =
  | SessionSpawnLaunchErrorV1
  | SessionLaunchRetiredV1
  | RequesterHomeUnavailableSpawnErrorDetail
  | SpawnFailureSpawnErrorDetail
  | TerminalHostUnavailableSpawnErrorDetail
  | ConnectedServiceResumeUnreachableSpawnErrorDetail
  | ConnectedServiceUxDiagnosticSpawnErrorDetail
  | ProviderSpawnErrorDetail
  | SessionCreationTerminalSpawnErrorDetail;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return isNonEmptyString(value) ? value.trim() : null;
}

function isDiagnosticScalar(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}

const DAEMON_LOCAL_SPAWN_DETAIL_KEYS = new Set([
  'candidatePersistedSessionFile',
  'cwd',
  'persistedSessionFile',
  'providerResumeId',
  'resolvedPath',
  'sessionFile',
  'targetMaterializedRoot',
  'vendorResumeId',
]);

function hasDaemonLocalSpawnDetailKey(detail: Record<string, unknown>): boolean {
  for (const key of DAEMON_LOCAL_SPAWN_DETAIL_KEYS) {
    if (hasOwn(detail, key)) return true;
  }
  return false;
}

const DAEMON_LOCAL_DIAGNOSTIC_KEY_PATTERN =
  /(?:^cwd$|path|file|root|dir|directory|home|materialized|persisted|vendor[_-]?resume[_-]?id|provider[_-]?resume[_-]?id|resume[_-]?id)/i;

function looksLikeLocalFilesystemPath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('/')
    || trimmed.startsWith('~/')
    || trimmed.startsWith('~\\')
    || /^[A-Za-z]:[\\/]/.test(trimmed)
    || trimmed.startsWith('\\\\');
}

function sanitizeUxDiagnosticDiagnostics(
  diagnostics: ConnectedServiceUxDiagnosticV1['diagnostics'],
  fallbackReason: string | null,
): ConnectedServiceUxDiagnosticV1['diagnostics'] | undefined {
  const sanitized: Record<string, string | number | boolean | null> = {};
  if (diagnostics) {
    for (const [key, value] of Object.entries(diagnostics)) {
      if (!isDiagnosticScalar(value)) continue;
      if (DAEMON_LOCAL_SPAWN_DETAIL_KEYS.has(key) || DAEMON_LOCAL_DIAGNOSTIC_KEY_PATTERN.test(key)) continue;
      if (typeof value === 'string' && looksLikeLocalFilesystemPath(value)) continue;
      sanitized[key] = value;
    }
  }

  if (fallbackReason && !('reason' in sanitized)) {
    sanitized.reason = fallbackReason;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function hasUnsafeUxDiagnosticDiagnostics(diagnostics: ConnectedServiceUxDiagnosticV1['diagnostics']): boolean {
  if (!diagnostics) return false;
  for (const [key, value] of Object.entries(diagnostics)) {
    if (DAEMON_LOCAL_SPAWN_DETAIL_KEYS.has(key) || DAEMON_LOCAL_DIAGNOSTIC_KEY_PATTERN.test(key)) {
      return true;
    }
    if (typeof value === 'string' && looksLikeLocalFilesystemPath(value)) {
      return true;
    }
  }
  return false;
}

function isPublicSafeUxDiagnostic(value: unknown): value is ConnectedServiceUxDiagnosticV1 {
  return isConnectedServiceUxDiagnosticV1(value)
    && !hasUnsafeUxDiagnosticDiagnostics(value.diagnostics);
}

function createLegacyResumeUnreachableUxDiagnostic(params: Readonly<{
  agentId: string;
  reason: string;
}>): ConnectedServiceUxDiagnosticV1 {
  return {
    code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume,
    failurePhase: 'continuity',
    source: 'spawn_resume',
    agentId: params.agentId,
    retryable: false,
    suggestedActions: [
      CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.startFreshUnderSelectedAccount,
      CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.resumeCurrentAccount,
    ],
    diagnostics: {
      reason: params.reason,
    },
  };
}

function sanitizeUxDiagnostic(
  value: unknown,
  fallbackReason: string | null,
): ConnectedServiceUxDiagnosticV1 | null {
  const parsed = normalizeConnectedServiceUxDiagnosticV1(value);
  if (!parsed) return null;
  const diagnostics = sanitizeUxDiagnosticDiagnostics(parsed.diagnostics, fallbackReason);
  const candidate: ConnectedServiceUxDiagnosticV1 = {
    ...parsed,
    ...(diagnostics ? { diagnostics } : {}),
  };
  if (!diagnostics && 'diagnostics' in candidate) {
    delete candidate.diagnostics;
  }
  return isConnectedServiceUxDiagnosticV1(candidate) ? candidate : null;
}

function normalizeConnectedServiceResumeUnreachableDetail(
  detail: Record<string, unknown>,
): ConnectedServiceResumeUnreachableSpawnErrorDetail | undefined {
  if (detail.kind !== SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE) {
    return undefined;
  }
  if (detail.continuityErrorCode !== 'provider_session_state_unavailable_for_resume') {
    return undefined;
  }
  if (detail.failurePhase !== 'continuity') {
    return undefined;
  }
  const agentId = readNonEmptyString(detail, 'agentId');
  const reason = readNonEmptyString(detail, 'reason');
  if (!agentId || !reason) {
    return undefined;
  }
  const uxDiagnostic = sanitizeUxDiagnostic(
    hasOwn(detail, 'uxDiagnostic')
      ? detail.uxDiagnostic
      : createLegacyResumeUnreachableUxDiagnostic({ agentId, reason }),
    reason,
  );
  if (!uxDiagnostic) {
    return undefined;
  }
  return {
    kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
    continuityErrorCode: 'provider_session_state_unavailable_for_resume',
    failurePhase: 'continuity',
    agentId,
    reason,
    uxDiagnostic,
  };
}

function normalizeConnectedServiceUxDiagnosticDetail(
  detail: Record<string, unknown>,
): ConnectedServiceUxDiagnosticSpawnErrorDetail | undefined {
  if (detail.kind !== SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_UX_DIAGNOSTIC) {
    return undefined;
  }
  const uxDiagnostic = sanitizeUxDiagnostic(detail.uxDiagnostic, null);
  if (!uxDiagnostic) {
    return undefined;
  }
  return {
    kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_UX_DIAGNOSTIC,
    uxDiagnostic,
  };
}

function normalizeProviderSpawnErrorDetail(
  detail: Record<string, unknown>,
): ProviderSpawnErrorDetail | undefined {
  if (detail.kind !== SPAWN_SESSION_ERROR_DETAIL_KINDS.PROVIDER_ERROR) return undefined;
  if (Object.keys(detail).length !== 2 || !hasOwn(detail, 'providerError')) return undefined;
  const providerError = ProviderErrorV1Schema.safeParse(detail.providerError);
  if (!providerError.success) return undefined;
  return { kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.PROVIDER_ERROR, providerError: providerError.data };
}

function normalizeSessionCreationOrganizationInvalidSpawnErrorDetail(
  detail: Record<string, unknown>,
): SessionCreationOrganizationInvalidSpawnErrorDetail | undefined {
  const parsed = SessionCreationOrganizationInvalidSpawnErrorDetailSchema.safeParse(detail);
  return parsed.success ? parsed.data : undefined;
}

function normalizeSessionCreationCorrespondenceConflictSpawnErrorDetail(
  detail: Record<string, unknown>,
): SessionCreationCorrespondenceConflictSpawnErrorDetail | undefined {
  const parsed = SessionCreationCorrespondenceConflictSpawnErrorDetailSchema.safeParse(detail);
  return parsed.success ? parsed.data : undefined;
}

export function isConnectedServiceResumeUnreachableSpawnErrorDetail(
  value: unknown,
): value is ConnectedServiceResumeUnreachableSpawnErrorDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const detail = value as Record<string, unknown>;
  return detail.kind === SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE
    && detail.continuityErrorCode === 'provider_session_state_unavailable_for_resume'
    && detail.failurePhase === 'continuity'
    && isNonEmptyString(detail.agentId)
    && isNonEmptyString(detail.reason)
    && !hasDaemonLocalSpawnDetailKey(detail)
    && isPublicSafeUxDiagnostic(detail.uxDiagnostic);
}

export function isConnectedServiceUxDiagnosticSpawnErrorDetail(
  value: unknown,
): value is ConnectedServiceUxDiagnosticSpawnErrorDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const detail = value as Record<string, unknown>;
  return detail.kind === SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_UX_DIAGNOSTIC
    && !hasDaemonLocalSpawnDetailKey(detail)
    && isPublicSafeUxDiagnostic(detail.uxDiagnostic);
}

export function isSessionCreationOrganizationInvalidSpawnErrorDetail(
  value: unknown,
): value is SessionCreationOrganizationInvalidSpawnErrorDetail {
  return normalizeSessionCreationOrganizationInvalidSpawnErrorDetail(
    asRecord(value) ?? {},
  ) !== undefined;
}

export function isSessionCreationCorrespondenceConflictSpawnErrorDetail(
  value: unknown,
): value is SessionCreationCorrespondenceConflictSpawnErrorDetail {
  return normalizeSessionCreationCorrespondenceConflictSpawnErrorDetail(
    asRecord(value) ?? {},
  ) !== undefined;
}

export function isSessionCreationTerminalSpawnErrorDetail(
  value: unknown,
): value is SessionCreationTerminalSpawnErrorDetail {
  return SessionCreationTerminalSpawnErrorDetailSchema.safeParse(value).success;
}

export function isSpawnSessionErrorDetail(value: unknown): value is SpawnSessionErrorDetail {
  return SessionSpawnLaunchErrorV1Schema.safeParse(value).success
    || SessionLaunchRetiredV1Schema.safeParse(value).success
    || RequesterHomeUnavailableSpawnErrorDetailSchema.safeParse(value).success
    || SpawnFailureSpawnErrorDetailSchema.safeParse(value).success
    || TerminalHostUnavailableSpawnErrorDetailSchema.safeParse(value).success
    || isConnectedServiceResumeUnreachableSpawnErrorDetail(value)
    || isConnectedServiceUxDiagnosticSpawnErrorDetail(value)
    || normalizeProviderSpawnErrorDetail(asRecord(value) ?? {}) !== undefined
    || isSessionCreationTerminalSpawnErrorDetail(value);
}

export function normalizeSpawnSessionErrorDetail(value: unknown): SpawnSessionErrorDetail | undefined {
  const detail = asRecord(value);
  if (!detail) return undefined;
  return SessionSpawnLaunchErrorV1Schema.safeParse(detail).data
    ?? SessionLaunchRetiredV1Schema.safeParse(detail).data
    ?? RequesterHomeUnavailableSpawnErrorDetailSchema.safeParse(detail).data
    ?? SpawnFailureSpawnErrorDetailSchema.safeParse(detail).data
    ?? TerminalHostUnavailableSpawnErrorDetailSchema.safeParse(detail).data
    ?? normalizeConnectedServiceResumeUnreachableDetail(detail)
    ?? normalizeConnectedServiceUxDiagnosticDetail(detail)
    ?? normalizeProviderSpawnErrorDetail(detail)
    ?? SessionCreationTerminalSpawnErrorDetailSchema.safeParse(detail).data;
}

export type SpawnSessionResult =
  | {
      type: 'success';
      sessionId?: string;
      /** Remote predecessor accept-then-async recovery correlation. */
      spawnNonce?: string;
      sessionIdStatus?: 'pending' | 'available';
    }
  | { type: 'requestToApproveDirectoryCreation'; directory: string }
  | { type: 'error'; errorCode: SpawnSessionErrorCode; errorMessage: string; agentId?: string; errorDetail?: SpawnSessionErrorDetail };
