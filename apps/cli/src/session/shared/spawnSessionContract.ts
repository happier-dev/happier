import { z } from 'zod';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { SessionIdSchema, TurnIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { SessionOrganizationPlacementV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionCreationTerminalSpawnErrorDetailSchema, SpawnSessionErrorCodeSchema, isSessionCreationTerminalSpawnErrorDetail } from '@happier-dev/protocol/spawnSession';
import { SessionTurnProviderCheckpointV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import type { AcpConfigOptionOverridesV1, AgentExecutionTargetV1, AgentSessionStartupInstructionsV1, BackendTargetRefV2, CallerInputConstraintsV1, MachinePoolSelectionOriginV1, ConnectedServiceMaterializationIdentityV1, RuntimeDescriptorV1, SessionAttachMetadataIdentityPolicy, SessionMcpSelectionV1, SessionInitialAccessDraftV1, SessionReportsToV1, SessionRolesV1, SessionInitialGoalRequestV1, SessionCreateOriginFieldsV1, SessionModelSelectionV1, SessionProviderBindingMetadataV1, SessionProviderBindingSecurityChangeConfirmationV1, SecretReferenceOverlayV1, SpawnSessionExecutionAuthorization, SpawnSessionErrorCode, SpawnSessionErrorDetail } from '@happier-dev/protocol';

import type { PermissionMode, SessionCreationOutcome } from '@/api/types';
import type {
  HostPrivatePersistedTakeoverAdmission,
} from '@/daemon/spawn/persistedTakeoverAdmission';
import type { TerminalSpawnOptions } from '@/terminal/runtime/terminalConfig';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

export { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
export type { SpawnSessionErrorCode, SpawnSessionErrorDetail } from '@happier-dev/protocol';

export const AGENT_SESSION_CONTINUATION_UNREACHABLE_ERROR_NAME =
  'AgentSessionContinuationUnreachableError';

export function isAgentSessionContinuationUnreachableError(error: unknown): error is Error {
  return error instanceof Error
    && error.name === AGENT_SESSION_CONTINUATION_UNREACHABLE_ERROR_NAME;
}

export const SESSION_RUNNER_EXIT_CODES = Object.freeze({
  CONTINUATION_UNREACHABLE: 78,
});

const NativeForkProviderSessionIdSchema = z.string().min(1).max(2_000).refine(
  (value) => value === value.trim(),
  'Provider session id must not contain leading or trailing whitespace',
);
const NativeForkCwdSchema = z.string().min(1).max(10_000).refine(
  (value) => value.trim().length > 0,
  'Native fork cwd must not be blank',
);

export const NativeForkSourceSchema = z.object({
  sessionId: asHostProtocolZod(SessionIdSchema),
  providerSessionId: NativeForkProviderSessionIdSchema,
  cwd: NativeForkCwdSchema,
  target: z.object({
    turnId: TurnIdSchema,
    providerCheckpoint: SessionTurnProviderCheckpointV1Schema,
  }).strict().readonly().optional(),
}).strict().readonly();
export type NativeForkSource = z.infer<typeof NativeForkSourceSchema>;

const NATIVE_FORK_SOURCE_V1_TRANSPORT_PREFIX = 'nfs1:';
const NATIVE_FORK_SOURCE_V1_TRANSPORT_MAX_LENGTH = 24_000;
const nativeForkSourceTextEncoder = new TextEncoder();
const nativeForkSourceTextDecoder = new TextDecoder('utf-8', { fatal: true });

/** Secret-free, canonical argv transport between the daemon and its session runner. */
export function serializeNativeForkSourceV1(source: NativeForkSource): string {
  const parsed = NativeForkSourceSchema.parse(source);
  const encoded = `${NATIVE_FORK_SOURCE_V1_TRANSPORT_PREFIX}${encodeBase64(
    nativeForkSourceTextEncoder.encode(JSON.stringify(parsed)),
    'base64url',
  ).replace(/=+$/u, '')}`;
  if (encoded.length > NATIVE_FORK_SOURCE_V1_TRANSPORT_MAX_LENGTH) {
    throw new Error('Native fork source transport exceeds its maximum length');
  }
  return encoded;
}

export function deserializeNativeForkSourceV1(value: string): NativeForkSource {
  if (
    value.length > NATIVE_FORK_SOURCE_V1_TRANSPORT_MAX_LENGTH
    || !/^nfs1:[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error('Invalid native fork source transport');
  }
  try {
    const parsed = NativeForkSourceSchema.parse(JSON.parse(nativeForkSourceTextDecoder.decode(decodeBase64(
      value.slice(NATIVE_FORK_SOURCE_V1_TRANSPORT_PREFIX.length),
      'base64url',
    ))) as unknown);
    if (serializeNativeForkSourceV1(parsed) !== value) {
      throw new Error('Invalid native fork source transport');
    }
    return parsed;
  } catch {
    throw new Error('Invalid native fork source transport');
  }
}

/**
 * Canonical daemon session-spawn contract shared by API, daemon, and session owners.
 *
 * Keep this module free of RPC registration/runtime imports so lower-level session code never
 * depends on the high-level handler graph merely to describe a spawn request or response.
 */
export interface SpawnSessionOptions extends SessionCreateOriginFieldsV1 {
  machineId?: string;
  directory: string;
  /** Daemon-owned directory routing fact; filesystem authority comes from the allocation record. */
  directoryKind?: 'path' | 'managed';
  /** Trusted creator evidence for a fresh replay row committed before runner launch. */
  freshSessionCreation?: boolean;
  /** Host-private fork seed; the daemon must prove source allocation ownership before reading. */
  managedDirectorySeed?: Readonly<{
    sourceSessionId: string;
    sourceSessionCreationTag?: string;
    sourcePath: string;
  }>;
  /**
   * Daemon-only spawn idempotency salt.
   *
   * When set, the daemon treats the spawn request as unique for the purposes of spawn request
   * coalescing (prevents returning a recent success session id for rapid consecutive spawns).
   *
   * It remains in-memory only. Fresh runners may receive it through the protected
   * `HAPPIER_SESSION_STARTUP_SPAWN_NONCE` environment carrier solely to settle their
   * own terminal startup result; it is not persisted or exposed as a general child control.
   */
  spawnNonce?: string;
  /**
   * Opaque host-derived create-or-rejoin identity for a canonical Session
   * spawn. It is distinct from the daemon-local spawn nonce and is carried
   * only through daemon-to-runner transport.
  */
  sessionCreationTag?: import('@happier-dev/protocol').SessionCreationTagV1;
  /** Full immutable create-or-rejoin recipe carried with the admitted tag. */
  sessionCreationCorrespondence?: import('@happier-dev/protocol').SessionCreationCorrespondenceV1;
  /** Informational creation origin; never an execution target or runtime authority. */
  placementOrigin?: MachinePoolSelectionOriginV1;
  /** Mutable presentation state committed inside the fresh Session create transaction. */
  initialTitle?: string;
  initialAccess?: SessionInitialAccessDraftV1;
  /** Canonical host-sealed trigger intents committed with fresh Session birth. */
  initialTriggers?: readonly import('@happier-dev/protocol').SessionInitialTriggerAdmissionV1[];
  reportsTo?: SessionReportsToV1;
  /** Host-resolved role selection and complete lead snapshot, seeded in fresh owner metadata only. */
  initialSessionRolesV1?: SessionRolesV1;
  primaryTeamId?: string | null;
  teamCredentialBindings?: import('@happier-dev/protocol/teams').SessionTeamCredentialBindingIntentListV1;
  /** Ephemeral producer custody promoted by the child after the real session exists. */
  pendingFirstInput?: {
    text: string;
    localId: string;
    meta?: Record<string, unknown>;
    inputAdmission?: Readonly<{
      provenance: import('@happier-dev/protocol').SessionMessageProvenance;
      request: import('@happier-dev/protocol').SessionInputRequest;
    }>;
  };
  /**
   * Daemon-only, one-shot admission correlation for an explicit persisted takeover.
   *
   * This is handed to the spawned host process and omitted from durable respawn state.
   */
  persistedTakeoverAdmission?: HostPrivatePersistedTakeoverAdmission;
  sessionId?: string;
  /** Resume an existing provider session by its provider-owned id. */
  resume?: string;
  /** Secret-free source consumed once by the child native Agent session opener. */
  nativeForkSource?: NativeForkSource;
  /**
   * Trusted host-authored, non-transcript startup context. Raw text remains
   * ephemeral and is never included in persisted respawn/session metadata.
   */
  agentSessionStartupInstructionsV1?: AgentSessionStartupInstructionsV1;
  /** Opaque Agent-owned launch/resume facts. Generic host code does not interpret its payload. */
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  /** Existing Happier session id to reconnect to instead of creating a new session. */
  existingSessionId?: string;
  /** Attach cursor used when a wake prompt was committed before the runner resumed. */
  initialTranscriptAfterSeq?: number;
  /** One-shot goal intent delivered to the resumed runtime after it opens. */
  initialGoal?: SessionInitialGoalRequestV1;
  executionAuthorization?: SpawnSessionExecutionAuthorization;
  attachMetadataIdentityPolicy?: SessionAttachMetadataIdentityPolicy;
  permissionMode?: PermissionMode;
  /** Host-only caller authority for this launch; never part of the raw spawn wire or respawn state. */
  creationAuthorization?: Readonly<{ token: string }>;
  callerInputConstraints?: CallerInputConstraintsV1;
  permissionModeUpdatedAt?: number;
  agentModeId?: string;
  agentModeUpdatedAt?: number;
  modelSelection?: SessionModelSelectionV1;
  /** Daemon-owned continuity metadata; transport callers cannot author this value. */
  providerBindingMetadataV1?: SessionProviderBindingMetadataV1;
  providerBindingSecurityChangeConfirmationV1?: SessionProviderBindingSecurityChangeConfirmationV1;
  accountSettingsVersionHint?: number;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  approvedNewDirectoryCreation?: boolean;
  /** Canonical plugin-qualified Agent execution identity. */
  agentTarget?: AgentExecutionTargetV1;
  /** Released backend routing ingress and configured-ACP target only. */
  backendTarget?: BackendTargetRefV2;
  terminal?: TerminalSpawnOptions;
  windowsRemoteSessionLaunchMode?: 'hidden' | 'windows_terminal' | 'console';
  /** Legacy compatibility for the prior visible-console boolean selection. */
  windowsRemoteSessionConsole?: 'hidden' | 'visible';
  windowsTerminalWindowName?: string;
  /**
   * Stable Account Launch Profile identity. The daemon resolves its sparse
   * defaults at admission; explicit sparse fields remain authoritative while
   * profile-owned environment names stay canonical.
   */
  profileId?: string;
  /** Value-free Saved Secret binding overrides for this launch only. */
  secretReferenceOverlay?: SecretReferenceOverlayV1;
  environmentVariables?: Record<string, string>;
  /** Secret-free bindings resolved and materialized by the daemon. */
  connectedServices?: unknown;
  connectedServicesUpdatedAt?: number;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
  mcpSelection?: SessionMcpSelectionV1;
  transcriptStorage?: 'persisted' | 'direct';
}

export type SpawnSessionResult =
  | {
      type: 'success';
      sessionId?: string;
      spawnNonce?: string;
      sessionIdStatus?: 'pending' | 'available';
      /** Exact immediate `POST /v1/sessions` transaction fact, when observed. */
      sessionCreationOutcome?: SessionCreationOutcome;
    }
  | { type: 'requestToApproveDirectoryCreation'; directory: string }
  | {
    type: 'error';
    errorCode: SpawnSessionErrorCode;
    errorMessage: string;
    agentId?: string;
    errorDetail?: SpawnSessionErrorDetail;
  };

export const SessionCreationOutcomeSchema = z.object({
  disposition: z.enum(['created', 'rejoined']),
  organizationPlacement: SessionOrganizationPlacementV1Schema,
}).strict();

/** Local daemon control transport schemas, consumed by the real HTTP routes. */
export const SpawnSessionControlBadRequestSchema = z.object({
  success: z.boolean(),
  error: z.string(),
  errorCode: z.string().optional(),
  agentId: z.string().optional(),
  errorDetail: SessionCreationTerminalSpawnErrorDetailSchema.optional(),
});

export const SpawnSessionControlErrorResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  agentId: z.string().optional(),
  errorDetail: SessionCreationTerminalSpawnErrorDetailSchema.optional(),
});

export const SpawnSessionNonceControlResponseSchema = z.object({
  success: z.literal(true),
  status: z.enum(['success', 'error', 'pending', 'not_found']),
  sessionId: z.string().optional(),
  sessionCreationOutcome: SessionCreationOutcomeSchema.optional(),
  errorCode: SpawnSessionErrorCodeSchema.optional(),
  errorMessage: z.string().optional(),
  agentId: z.string().optional(),
  errorDetail: z.unknown().optional(),
});

export function projectSpawnSessionControlErrorResponse(
  error: Pick<Extract<SpawnSessionResult, { type: 'error' }>, 'errorCode' | 'errorMessage' | 'agentId' | 'errorDetail'>,
) {
  return {
    success: false as const,
    error: error.errorMessage,
    errorCode: error.errorCode,
    ...(error.agentId !== undefined ? { agentId: error.agentId } : {}),
    ...(isSessionCreationTerminalSpawnErrorDetail(error.errorDetail)
      ? { errorDetail: error.errorDetail }
      : {}),
  };
}
