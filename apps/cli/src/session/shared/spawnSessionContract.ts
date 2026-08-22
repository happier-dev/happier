import { z } from 'zod';
import {
  decodeBase64,
  encodeBase64,
  SessionIdSchema,
  SessionTurnProviderCheckpointV1Schema,
  TurnIdSchema,
  type AcpConfigOptionOverridesV1,
  type AgentSessionStartupInstructionsV1,
  type BackendTargetRefV2,
  type CodexBackendMode,
  type ConnectedServiceMaterializationIdentityV1,
  type RuntimeDescriptorV1,
  type SessionAttachMetadataIdentityPolicy,
  type SessionMcpSelectionV1,
  type SessionModelSelectionV1,
  type SessionProviderBindingMetadataV1,
  type SessionProviderBindingSecurityChangeConfirmationV1,
  type SpawnSessionExecutionAuthorization,
  type SpawnSessionErrorCode,
  type SpawnSessionErrorDetail,
} from '@happier-dev/protocol';

import type { PermissionMode, SessionCreationOutcome } from '@/api/types';
import type {
  HostPrivatePersistedTakeoverAdmission,
} from '@/daemon/spawn/persistedTakeoverAdmission';
import type { TerminalSpawnOptions } from '@/terminal/runtime/terminalConfig';

export { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
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
  sessionId: SessionIdSchema,
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
export interface SpawnSessionOptions {
  machineId?: string;
  directory: string;
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
  /** Mutable presentation state committed inside the fresh Session create transaction. */
  initialTitle?: string;
  /** Ephemeral producer custody promoted by the child after the real session exists. */
  pendingFirstInput?: { text: string; localId: string };
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
  /** Legacy ingress compatibility. Prefer the canonical runtime selection fields. */
  experimentalCodexAcp?: boolean;
  /** Provider-declared runtime-mode token interpreted by the owning backend. */
  backendMode?: string;
  codexBackendMode?: CodexBackendMode;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  /** Existing Happier session id to reconnect to instead of creating a new session. */
  existingSessionId?: string;
  /** Attach cursor used when a wake prompt was committed before the runner resumed. */
  initialTranscriptAfterSeq?: number;
  executionAuthorization?: SpawnSessionExecutionAuthorization;
  attachMetadataIdentityPolicy?: SessionAttachMetadataIdentityPolicy;
  permissionMode?: PermissionMode;
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
  backendTarget?: BackendTargetRefV2;
  terminal?: TerminalSpawnOptions;
  windowsRemoteSessionLaunchMode?: 'hidden' | 'windows_terminal' | 'console';
  /** Legacy compatibility for the prior visible-console boolean selection. */
  windowsRemoteSessionConsole?: 'hidden' | 'visible';
  windowsTerminalWindowName?: string;
  /** Session-scoped profile identity only; profile content is projected through the environment. */
  profileId?: string;
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
    errorDetail?: SpawnSessionErrorDetail;
  };
