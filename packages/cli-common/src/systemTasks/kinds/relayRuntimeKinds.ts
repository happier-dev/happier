import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { HomeOwnerClaimAccountIdV1Schema } from '@happier-dev/protocol/home/governance/claim';
import { SystemTaskJsonValueSchema } from '@happier-dev/protocol/system/tasks/spec';
import type { HomeConnectionDescriptorV1, SystemTaskJsonValue } from '@happier-dev/protocol';
import { normalizePublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import { SystemTaskExecutionError } from '../runSystemTask.js';
import { type InteractiveSystemTaskKind } from '../interactiveTaskKinds.js';
import {
  assertPersonalHomeEnvironmentKeys,
  createPersonalHomeRuntimeSpec,
  parsePersonalHomeRuntimePurpose,
  type ManagedRelayPurpose,
} from '../../firstPartyRuntime/personalHome/personalHomeRuntimeSpec.js';
import type { PersonalHomeRuntimeLayout } from '../../firstPartyRuntime/personalHome/layout.js';
import type {
  PersonalHomeOperationContext,
  PersonalHomeOperations,
  PersonalHomeEraseConfirmationFacts,
} from '../../firstPartyRuntime/personalHome/operations.js';
import type {
  PersonalHomeRelocationDestinationOwner,
  PersonalHomeRelocationDestinationStageInput,
} from '../../firstPartyRuntime/personalHome/relocationDestination.js';

export interface SystemTaskSshConnectionConfig {
  target: string;
  port?: number;
  auth: 'agent' | 'keyfile' | 'password';
  identityFile?: string;
  password?: string;
  sshConfigFile?: string;
  knownHostsPath?: string;
  trustedHostKey?: string;
}

export interface RelayRuntimeTaskParams {
  target: Readonly<{ kind: 'local' }> | Readonly<{ kind: 'ssh'; ssh: SystemTaskSshConnectionConfig }>;
  channel?: 'stable' | 'preview' | 'dev';
  mode?: 'user' | 'system';
  env?: Record<string, string>;
  selfHostRelayBinaryOverride?: string;
  purpose?: ManagedRelayPurpose;
  expectedPersonalHomeState?: Readonly<{
    installed: boolean;
    canonicalServerUrl: string | null;
    dataPresent: boolean;
  }>;
  /** Internal execution cancellation; never parsed from the public task payload. */
  signal?: AbortSignal;
}

export interface RelayRuntimeStatusSnapshot {
  installed: boolean;
  version: string | null;
  service: Readonly<{
    active: boolean | null;
    enabled: boolean | null;
  }>;
  baseUrl: string;
  healthy?: boolean | null;
  warnings?: readonly string[];
  purpose?: ManagedRelayPurpose;
  canonicalServerUrl?: string;
  layout?: PersonalHomeRuntimeLayout;
  dataPresent?: boolean;
  anonymousSignupEnabled?: boolean | null;
}

type RelayRuntimeStatusResult = Readonly<{
  channel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
  installed: boolean;
  version: string | null;
  relayUrl: string;
  healthy: boolean;
  service: RelayRuntimeStatusSnapshot['service'];
  warnings?: readonly string[];
  purpose?: ManagedRelayPurpose;
  canonicalServerUrl?: string;
  layout?: PersonalHomeRuntimeLayout;
  dataPresent?: boolean;
  anonymousSignupEnabled?: boolean | null;
}>;

export type RelayRuntimeKindDeps = Readonly<{
  readStatus: (params: RelayRuntimeTaskParams) => Promise<RelayRuntimeStatusSnapshot>;
  checkHealth: (params: Readonly<{ baseUrl: string }>) => Promise<boolean>;
  installOrUpdate: (params: RelayRuntimeTaskParams) => Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>>;
  control: (params: RelayRuntimeTaskParams & Readonly<{ action: 'start' | 'stop' | 'restart' | 'uninstall' }>) => Promise<void>;
  reconcilePersonalHomeRestore?: (
    params: RelayRuntimeTaskParams,
    context: Readonly<{ signal?: AbortSignal; progress(stepId: string, message?: string): void }>,
  ) => Promise<void>;
}>;

export type PersonalHomeTaskBaseParams = Readonly<{
  target: Readonly<{ kind: 'local' }>;
  channel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
  purpose: Extract<ManagedRelayPurpose, { kind: 'personal-home' }>;
}>;

export type PersonalHomeRuntimeTarget = Pick<PersonalHomeTaskBaseParams, 'channel' | 'mode'>;

export const PERSONAL_HOME_SYSTEM_TASK_KINDS = Object.freeze({
  inspect: 'relay.runtime.personal_home.inspect.v1',
  backup: 'relay.runtime.personal_home.backup.v1',
  verifyBackup: 'relay.runtime.personal_home.verify_backup.v1',
  restore: 'relay.runtime.personal_home.restore.v1',
  erase: 'relay.runtime.personal_home.erase.v1',
  relocationDestinationStage: 'relay.runtime.personal_home.relocation_destination.stage.v1',
  relocationDestinationStatus: 'relay.runtime.personal_home.relocation_destination.status.v1',
  relocationDestinationCommit: 'relay.runtime.personal_home.relocation_destination.commit.v1',
  relocationDestinationAbort: 'relay.runtime.personal_home.relocation_destination.abort.v1',
  claimOwner: 'relay.runtime.personal_home.claim_owner.v1',
} as const);

/**
 * The Personal Home kinds every local host serves, and the list the daemon advertises. The owner
 * claim is excluded: decision A(a) allows the in-app claim only from the desktop hosting the Home,
 * so only hsetup registers it.
 */
export const PERSONAL_HOME_SYSTEM_TASK_KIND_IDS = Object.freeze(
  Object.values(PERSONAL_HOME_SYSTEM_TASK_KINDS).filter((kind) => kind !== PERSONAL_HOME_SYSTEM_TASK_KINDS.claimOwner),
);

export type PersonalHomeBackupTaskInput = Readonly<{ outputPath?: string }>;
export type PersonalHomeVerifyBackupTaskInput = Readonly<{ archivePath: string }>;
export type PersonalHomeRestoreTaskInput =
  | Readonly<{ action?: 'restore'; archivePath: string; confirmOverwrite?: true; expectedHomeServerIdentityId?: string }>
  | Readonly<{ action: 'recover' }>;
export type PersonalHomeEraseTaskInput = Readonly<Record<never, never>>;
export type PersonalHomeRelocationDestinationStageTaskInput = PersonalHomeRelocationDestinationStageInput;
export type PersonalHomeRelocationDestinationStatusTaskInput = Readonly<{ operationId: string }>;
export type PersonalHomeRelocationDestinationCommitTaskInput = Readonly<{ operationId: string; publishedDescriptor: HomeConnectionDescriptorV1 }>;
export type PersonalHomeRelocationDestinationAbortTaskInput = Readonly<{ operationId: string }>;
export type PersonalHomeClaimOwnerTaskInput = Readonly<{ accountId: string }>;

export type PersonalHomeInspectTaskParams = PersonalHomeTaskBaseParams;
export type PersonalHomeBackupTaskParams = PersonalHomeTaskBaseParams & PersonalHomeBackupTaskInput;
export type PersonalHomeVerifyBackupTaskParams = PersonalHomeTaskBaseParams & PersonalHomeVerifyBackupTaskInput;
export type PersonalHomeRestoreTaskParams = PersonalHomeTaskBaseParams & PersonalHomeRestoreTaskInput;
export type PersonalHomeEraseTaskParams = PersonalHomeTaskBaseParams;
export type PersonalHomeRelocationDestinationStageTaskParams = PersonalHomeTaskBaseParams & PersonalHomeRelocationDestinationStageTaskInput;
export type PersonalHomeRelocationDestinationStatusTaskParams = PersonalHomeTaskBaseParams & PersonalHomeRelocationDestinationStatusTaskInput;
export type PersonalHomeRelocationDestinationCommitTaskParams = PersonalHomeTaskBaseParams & PersonalHomeRelocationDestinationCommitTaskInput;
export type PersonalHomeRelocationDestinationAbortTaskParams = PersonalHomeTaskBaseParams & PersonalHomeRelocationDestinationAbortTaskInput;
export type PersonalHomeClaimOwnerTaskParams = PersonalHomeTaskBaseParams & PersonalHomeClaimOwnerTaskInput;

export type PersonalHomeSystemTaskParamsByKind = Readonly<{
  [PERSONAL_HOME_SYSTEM_TASK_KINDS.inspect]: PersonalHomeInspectTaskParams;
  [PERSONAL_HOME_SYSTEM_TASK_KINDS.backup]: PersonalHomeBackupTaskParams;
  [PERSONAL_HOME_SYSTEM_TASK_KINDS.verifyBackup]: PersonalHomeVerifyBackupTaskParams;
  [PERSONAL_HOME_SYSTEM_TASK_KINDS.restore]: PersonalHomeRestoreTaskParams;
  [PERSONAL_HOME_SYSTEM_TASK_KINDS.erase]: PersonalHomeEraseTaskParams;
  [PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationStage]: PersonalHomeRelocationDestinationStageTaskParams;
  [PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationStatus]: PersonalHomeRelocationDestinationStatusTaskParams;
  [PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationCommit]: PersonalHomeRelocationDestinationCommitTaskParams;
  [PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationAbort]: PersonalHomeRelocationDestinationAbortTaskParams;
  [PERSONAL_HOME_SYSTEM_TASK_KINDS.claimOwner]: PersonalHomeClaimOwnerTaskParams;
}>;

/**
 * The task-facing view of the canonical PersonalHomeOperations instance. It intentionally omits
 * archive, lifecycle, transfer, publication, and filesystem callbacks: production composition
 * supplies those once, while task callers provide only operation facts.
 */
export type PersonalHomeSystemTaskOperations = Readonly<{
  reconcileRestore(context: PersonalHomeTaskOperationContext): Promise<void>;
  inspect(context: PersonalHomeTaskOperationContext): Promise<SystemTaskJsonValue>;
  backup(input: PersonalHomeBackupTaskInput & PersonalHomeTaskOperationContext): Promise<SystemTaskJsonValue>;
  verifyBackup(input: PersonalHomeVerifyBackupTaskInput & PersonalHomeTaskOperationContext): Promise<SystemTaskJsonValue>;
  restore(input: Exclude<PersonalHomeRestoreTaskInput, Readonly<{ action: 'recover' }>> & PersonalHomeTaskOperationContext): Promise<SystemTaskJsonValue>;
  recoverRestore(context: PersonalHomeTaskOperationContext): Promise<SystemTaskJsonValue>;
  erase(context: PersonalHomeTaskOperationContext): Promise<SystemTaskJsonValue>;
  /** Hosting-desktop owner claim; absent where the host composition does not offer it. */
  claimOwner?(input: PersonalHomeClaimOwnerTaskInput & PersonalHomeTaskOperationContext): Promise<SystemTaskJsonValue>;
}>;

export type PersonalHomeTaskOperationContext = Readonly<{
  signal?: AbortSignal;
  progress(stepId: string, message?: string): void;
  requestedPurpose: Extract<ManagedRelayPurpose, { kind: 'personal-home' }>;
  runtimeTarget: PersonalHomeRuntimeTarget;
  confirm?(facts: PersonalHomeEraseConfirmationFacts): Promise<boolean>;
}>;

export type PersonalHomeTaskKindDeps = Readonly<{
  operations?: PersonalHomeSystemTaskOperations;
  loadRelocationDestination?: (target: PersonalHomeRuntimeTarget) => Promise<PersonalHomeRelocationDestinationOwner>;
}>;

const PERSONAL_HOME_DOMAIN_ERROR_CODES: ReadonlySet<string> = new Set([
  'purpose_not_personal_home',
  'identity_unavailable',
  'sqlite_maintenance_required',
  'home_stop_failed',
  'home_restart_failed',
  'relocation_unavailable',
  'invalid_relocation_operation',
  'relocation_operation_conflict',
  'relocation_bundle_mismatch',
  'relocation_destination_not_quarantined',
  'relocation_destination_recovery_required',
  'relocation_destination_not_staged',
  'relocation_destination_already_active',
  'restore_unavailable',
  'destination_not_empty',
  'identity_mismatch',
  'schema_unsupported',
  'insufficient_space',
  'restore_failed',
  'recovery_required',
  'restore_recovery_required',
  'confirmation_required',
  'unsafe_data_root',
  'operation_in_progress',
  'ambiguous_stale_lock',
  'sqlite_snapshot_unstable',
  'sqlite_check_failed',
  'invalid_archive',
  'hash_mismatch',
  'unsupported_archive',
  'personal_home_update_candidate_selection_required',
  'personal_home_update_retry_required',
  'personal_home_artifact_update_required',
  'claim_owner_failed',
]);

function translatePersonalHomeDomainError(error: unknown): never {
  if (error instanceof SystemTaskExecutionError) throw error;
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
    const code = String(error.code);
    const message = typeof error.message === 'string' ? error.message.trim() : '';
    if (code === 'operation_cancelled') {
      throw new SystemTaskExecutionError('cancelled', message || 'Personal Home operation was cancelled.');
    }
    if (PERSONAL_HOME_DOMAIN_ERROR_CODES.has(code)) {
      throw new SystemTaskExecutionError(code, message || 'Personal Home operation failed.');
    }
  }
  throw error;
}

export function createPersonalHomeSystemTaskOperations(params: Readonly<{
  operations: PersonalHomeOperations;
  restoreAvailability?: 'available' | 'unavailable';
}>): PersonalHomeSystemTaskOperations {
  const result = async (value: Promise<unknown>): Promise<SystemTaskJsonValue> => {
    try {
      return SystemTaskJsonValueSchema.parse(await value);
    } catch (error) {
      translatePersonalHomeDomainError(error);
    }
  };
  const ownerContext = (context: PersonalHomeTaskOperationContext): PersonalHomeOperationContext => ({
    ...(context.signal ? { signal: context.signal } : {}),
    progress: context.progress,
    expectedCanonicalServerUrl: context.requestedPurpose.canonicalServerUrl,
  });
  return Object.freeze({
    reconcileRestore: async (context) => {
      try {
        const reconciliation = await params.operations.reconcileRestore(ownerContext(context));
        if (reconciliation.outcome === 'recovery_required') {
          throw new SystemTaskExecutionError(
            'restore_recovery_required',
            reconciliation.error ?? 'Personal Home restore requires recovery before the runtime operation can continue.',
          );
        }
      } catch (error) {
        translatePersonalHomeDomainError(error);
      }
    },
    inspect: async (context) => await result(params.operations.inspect(ownerContext(context))),
    backup: async (input) => await result(params.operations.backup({
        ...(input.outputPath === undefined ? {} : { outputPath: input.outputPath }),
        ...ownerContext(input),
      })),
    verifyBackup: async (input) => await result(params.operations.verifyBackup({ archivePath: input.archivePath, ...ownerContext(input) })),
    restore: async (input) => {
      if (params.restoreAvailability === 'unavailable') {
        throw new SystemTaskExecutionError(
          'unsupported',
          'Personal Home restore is unavailable because this runtime has no authoritative backup schema compatibility frontier.',
        );
      }
      return await result(params.operations.restore({
        archivePath: input.archivePath,
        confirmOverwrite: input.confirmOverwrite === true,
        ...(input.expectedHomeServerIdentityId ? { expectedHomeServerIdentityId: input.expectedHomeServerIdentityId } : {}),
        ...ownerContext(input),
      }));
    },
    recoverRestore: async (context) => await result(params.operations.recoverRestore(ownerContext(context))),
    erase: async (context) => {
      if (!context.confirm) throw new SystemTaskExecutionError('confirmation_required', 'Personal Home erase confirmation is unavailable.');
      return await result(params.operations.erase({ confirm: context.confirm, ...ownerContext(context) }));
    },
    claimOwner: async (input) => await result(params.operations.claimOwner({ accountId: input.accountId, ...ownerContext(input) })),
  });
}

export function createDeferredPersonalHomeSystemTaskOperations(
  load: (target: PersonalHomeRuntimeTarget) => Promise<PersonalHomeSystemTaskOperations>,
): PersonalHomeSystemTaskOperations {
  const pendingByTarget = new Map<string, Promise<PersonalHomeSystemTaskOperations>>();
  const operations = (target: PersonalHomeRuntimeTarget): Promise<PersonalHomeSystemTaskOperations> => {
    const key = `${target.channel}:${target.mode}`;
    const existing = pendingByTarget.get(key);
    if (existing) return existing;
    const pending = load(target).catch((error: unknown) => {
      pendingByTarget.delete(key);
      throw error;
    });
    pendingByTarget.set(key, pending);
    return pending;
  };
  return Object.freeze({
    reconcileRestore: async (context) => await (await operations(context.runtimeTarget)).reconcileRestore(context),
    inspect: async (context) => await (await operations(context.runtimeTarget)).inspect(context),
    backup: async (input) => await (await operations(input.runtimeTarget)).backup(input),
    verifyBackup: async (input) => await (await operations(input.runtimeTarget)).verifyBackup(input),
    restore: async (input) => await (await operations(input.runtimeTarget)).restore(input),
    recoverRestore: async (input) => await (await operations(input.runtimeTarget)).recoverRestore(input),
    erase: async (input) => await (await operations(input.runtimeTarget)).erase(input),
    claimOwner: async (input) => {
      const loaded = await operations(input.runtimeTarget);
      if (!loaded.claimOwner) throw new SystemTaskExecutionError('unsupported', 'Personal Home owner claim is unavailable.');
      return await loaded.claimOwner(input);
    },
  });
}

export function createPersonalHomeRestoreContactReconciler(params: Readonly<{
  readStatus(runtime: RelayRuntimeTaskParams): Promise<RelayRuntimeStatusSnapshot>;
  operations: PersonalHomeSystemTaskOperations;
}>): NonNullable<RelayRuntimeKindDeps['reconcilePersonalHomeRestore']> {
  return async (runtime, context) => {
    if (runtime.target.kind !== 'local') return;
    const snapshot = await params.readStatus(runtime);
    if (snapshot.purpose?.kind !== 'personal-home') return;
    // An absent runtime status may project the caller-requested purpose so install planning can
    // use the Personal Home layout. That projection is not evidence of an existing restore
    // contact. Retained Home data remains authoritative after a safe runtime uninstall.
    if (!snapshot.installed && snapshot.dataPresent !== true) return;
    await params.operations.reconcileRestore({
      ...(context.signal ? { signal: context.signal } : {}),
      progress: context.progress,
      requestedPurpose: snapshot.purpose,
      runtimeTarget: {
        channel: runtime.channel ?? 'stable',
        mode: runtime.mode ?? 'user',
      },
    });
  };
}

async function reconcileRelayRuntimeContact(
  deps: Pick<RelayRuntimeKindDeps, 'reconcilePersonalHomeRestore'>,
  params: RelayRuntimeTaskParams,
  context: Readonly<{ signal?: AbortSignal; emit(event: Readonly<{ type: 'progress'; stepId: string; message?: string }>): void }>,
): Promise<void> {
  await deps.reconcilePersonalHomeRestore?.(params, {
    ...(context.signal ? { signal: context.signal } : {}),
    progress(stepId, message) {
      context.emit({ type: 'progress', stepId, ...(message ? { message } : {}) });
    },
  });
}

const PERSONAL_HOME_BASE_KEYS = ['target', 'channel', 'mode', 'purpose'] as const;

export function createPersonalHomeInspectTaskKind(deps: PersonalHomeTaskKindDeps): InteractiveSystemTaskKind<SystemTaskJsonValue> {
  return createPersonalHomeTaskKind(deps, PERSONAL_HOME_BASE_KEYS, async (operations, _value, context) => await operations.inspect(context));
}

export function createPersonalHomeBackupTaskKind(deps: PersonalHomeTaskKindDeps): InteractiveSystemTaskKind<SystemTaskJsonValue> {
  return createPersonalHomeTaskKind(deps, [...PERSONAL_HOME_BASE_KEYS, 'outputPath'], async (operations, value, context) => {
    return await operations.backup({
      ...(value.outputPath === undefined ? {} : { outputPath: parseNonEmptyString(value.outputPath, 'outputPath') }),
      ...context,
    });
  });
}

export function createPersonalHomeVerifyBackupTaskKind(deps: PersonalHomeTaskKindDeps): InteractiveSystemTaskKind<SystemTaskJsonValue> {
  return createPersonalHomeTaskKind(deps, [...PERSONAL_HOME_BASE_KEYS, 'archivePath'], async (operations, value, context) =>
    await operations.verifyBackup({ archivePath: parseNonEmptyString(value.archivePath, 'archivePath'), ...context }));
}

export function createPersonalHomeRestoreTaskKind(deps: PersonalHomeTaskKindDeps): InteractiveSystemTaskKind<SystemTaskJsonValue> {
  return createPersonalHomeTaskKind(
    deps,
    [...PERSONAL_HOME_BASE_KEYS, 'action', 'archivePath', 'confirmOverwrite', 'expectedHomeServerIdentityId'],
    async (operations, value, context) => {
      if (value.action === 'recover') {
        if (value.archivePath !== undefined || value.confirmOverwrite !== undefined || value.expectedHomeServerIdentityId !== undefined) {
          throw new SystemTaskExecutionError('invalid_params', 'Restore recovery does not accept archive or overwrite fields.');
        }
        return await operations.recoverRestore(context);
      }
      if (value.action !== undefined && value.action !== 'restore') {
        throw new SystemTaskExecutionError('invalid_params', 'Invalid restore action.');
      }
      if (value.confirmOverwrite !== undefined && value.confirmOverwrite !== true) {
        throw new SystemTaskExecutionError('invalid_params', 'Restore overwrite confirmation must be true when provided.');
      }
      return await operations.restore({
        ...(value.action === 'restore' ? { action: 'restore' as const } : {}),
        archivePath: parseNonEmptyString(value.archivePath, 'archivePath'),
        ...(value.confirmOverwrite === true ? { confirmOverwrite: true as const } : {}),
        ...(value.expectedHomeServerIdentityId === undefined
          ? {}
          : { expectedHomeServerIdentityId: parseNonEmptyString(value.expectedHomeServerIdentityId, 'expectedHomeServerIdentityId') }),
        ...context,
      });
    },
  );
}

export function createPersonalHomeEraseTaskKind(deps: PersonalHomeTaskKindDeps): InteractiveSystemTaskKind<SystemTaskJsonValue> {
  return createPersonalHomeTaskKind(deps, PERSONAL_HOME_BASE_KEYS, async (operations, _value, context) =>
    await operations.erase(context));
}

/**
 * Decision A(a): make an explicit Account the owner of the ownerless Personal Home this desktop
 * hosts. The server's zero-owner claim decides; a refusal (`already_owned`, `target_inactive`,
 * `target_not_found`) is returned as the task result, not a task failure.
 */
export function createPersonalHomeClaimOwnerTaskKind(deps: PersonalHomeTaskKindDeps): InteractiveSystemTaskKind<SystemTaskJsonValue> {
  return createPersonalHomeTaskKind(deps, [...PERSONAL_HOME_BASE_KEYS, 'accountId'], async (operations, value, context) => {
    const accountId = HomeOwnerClaimAccountIdV1Schema.safeParse(value.accountId);
    if (!accountId.success) throw new SystemTaskExecutionError('invalid_params', 'Invalid accountId.');
    if (!operations.claimOwner) throw new SystemTaskExecutionError('unsupported', 'Personal Home owner claim is unavailable.');
    return await operations.claimOwner({ accountId: accountId.data, ...context });
  });
}

function createPersonalHomeRelocationDestinationTaskKind(
  deps: PersonalHomeTaskKindDeps,
  allowedKeys: readonly string[],
  invoke: (owner: PersonalHomeRelocationDestinationOwner, value: Record<string, unknown>) => Promise<unknown>,
): InteractiveSystemTaskKind<SystemTaskJsonValue> {
  return {
    async run(ctx) {
      const value = parsePersonalHomeTaskBase(ctx.params, allowedKeys);
      if (ctx.signal?.aborted) throw new SystemTaskExecutionError('cancelled', 'System task execution was cancelled.');
      if (!deps.loadRelocationDestination) {
        throw new SystemTaskExecutionError('unsupported', 'Personal Home relocation destination operations are unavailable.');
      }
      try {
        const owner = await deps.loadRelocationDestination({ channel: value.channel, mode: value.mode });
        return SystemTaskJsonValueSchema.parse(await invoke(owner, value));
      } catch (error) {
        translatePersonalHomeDomainError(error);
      }
    },
  };
}

export function createPersonalHomeRelocationDestinationStageTaskKind(deps: PersonalHomeTaskKindDeps): InteractiveSystemTaskKind<SystemTaskJsonValue> {
  return createPersonalHomeRelocationDestinationTaskKind(
    deps,
    [...PERSONAL_HOME_BASE_KEYS, 'operationId', 'archivePath', 'bundleSha256', 'expectedHomeServerIdentityId', 'expectedCanonicalServerUrl', 'sourceDescriptorRevision'],
    async (owner, value) => await owner.stage({
      operationId: parseNonEmptyString(value.operationId, 'operationId'),
      archivePath: parseNonEmptyString(value.archivePath, 'archivePath'),
      bundleSha256: parseNonEmptyString(value.bundleSha256, 'bundleSha256'),
      expectedHomeServerIdentityId: parseNonEmptyString(value.expectedHomeServerIdentityId, 'expectedHomeServerIdentityId'),
      expectedCanonicalServerUrl: parseNonEmptyString(value.expectedCanonicalServerUrl, 'expectedCanonicalServerUrl'),
      sourceDescriptorRevision: parsePositiveInteger(value.sourceDescriptorRevision, 'sourceDescriptorRevision'),
    }),
  );
}

export function createPersonalHomeRelocationDestinationStatusTaskKind(deps: PersonalHomeTaskKindDeps): InteractiveSystemTaskKind<SystemTaskJsonValue> {
  return createPersonalHomeRelocationDestinationTaskKind(
    deps,
    [...PERSONAL_HOME_BASE_KEYS, 'operationId'],
    async (owner, value) => await owner.status(parseNonEmptyString(value.operationId, 'operationId')),
  );
}

export function createPersonalHomeRelocationDestinationCommitTaskKind(deps: PersonalHomeTaskKindDeps): InteractiveSystemTaskKind<SystemTaskJsonValue> {
  return createPersonalHomeRelocationDestinationTaskKind(
    deps,
    [...PERSONAL_HOME_BASE_KEYS, 'operationId', 'publishedDescriptor'],
    async (owner, value) => {
      const descriptor = HomeConnectionDescriptorV1Schema.safeParse(value.publishedDescriptor);
      if (!descriptor.success) throw new SystemTaskExecutionError('invalid_params', 'Invalid published relocation descriptor.');
      return await owner.commit({
        operationId: parseNonEmptyString(value.operationId, 'operationId'),
        publishedDescriptor: descriptor.data,
      });
    },
  );
}

export function createPersonalHomeRelocationDestinationAbortTaskKind(deps: PersonalHomeTaskKindDeps): InteractiveSystemTaskKind<SystemTaskJsonValue> {
  return createPersonalHomeRelocationDestinationTaskKind(
    deps,
    [...PERSONAL_HOME_BASE_KEYS, 'operationId'],
    async (owner, value) => await owner.abort(parseNonEmptyString(value.operationId, 'operationId')),
  );
}

function createPersonalHomeTaskKind(
  deps: PersonalHomeTaskKindDeps,
  allowedKeys: readonly string[],
  invoke: (
    operations: PersonalHomeSystemTaskOperations,
    value: Record<string, unknown>,
    context: PersonalHomeTaskOperationContext,
  ) => Promise<SystemTaskJsonValue>,
): InteractiveSystemTaskKind<SystemTaskJsonValue> {
  return {
    async run(ctx) {
      const value = parsePersonalHomeTaskBase(ctx.params, allowedKeys);
      if (ctx.signal?.aborted) {
        throw new SystemTaskExecutionError('cancelled', 'System task execution was cancelled.');
      }
      if (!deps.operations) {
        throw new SystemTaskExecutionError('unsupported', 'Personal Home operations are unavailable.');
      }
      return await invoke(deps.operations, value, {
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        progress: (stepId, message) => ctx.emit({
          type: 'progress',
          stepId: `personal_home.${stepId}`,
          ...(message ? { message } : {}),
        }),
        requestedPurpose: value.purpose,
        runtimeTarget: { channel: value.channel, mode: value.mode },
        confirm: async (facts) => {
          const answer = await ctx.prompt({
            kind: 'personal_home.confirm_erase.v1',
            stepId: 'personal_home.confirm_erase',
            message: 'Confirm permanent deletion of these Personal Home paths.',
            data: {
              canonicalServerUrl: facts.canonicalServerUrl,
              homeServerIdentityId: facts.homeServerIdentityId,
              paths: [...facts.paths],
              estimatedBytes: facts.estimatedBytes,
              previewComplete: facts.previewComplete,
              previewReason: facts.previewReason,
            },
          });
          return isExactEraseConfirmation(answer);
        },
      });
    },
  };
}

function isExactEraseConfirmation(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).length === 1
    && value.confirmed === true;
}

function parsePersonalHomeTaskBase(params: unknown, allowedKeys: readonly string[]): Record<string, unknown> & PersonalHomeTaskBaseParams {
  if (!isRecord(params)) {
    throw new SystemTaskExecutionError('invalid_params', 'Personal Home task params must be an object.');
  }
  if (!isRecord(params.target)) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid Personal Home runtime target.');
  }
  if (params.target.kind === 'ssh') {
    throw new SystemTaskExecutionError('unsupported', 'Personal Home data operations do not support SSH targets.');
  }
  assertOnlyKeys(params, allowedKeys);
  assertOnlyKeys(params.target, ['kind']);
  if (params.target.kind !== 'local') {
    throw new SystemTaskExecutionError('invalid_params', 'Personal Home data operations require a local target.');
  }
  const channel = normalizePublicReleaseRingLabel(params.channel);
  if (channel !== 'stable' && channel !== 'preview' && channel !== 'dev') {
    throw new SystemTaskExecutionError('invalid_params', 'Personal Home data operations require an explicit runtime channel.');
  }
  if (params.mode !== 'user' && params.mode !== 'system') {
    throw new SystemTaskExecutionError('invalid_params', 'Personal Home data operations require an explicit runtime mode.');
  }
  let purpose: ReturnType<typeof parsePersonalHomeRuntimePurpose>;
  try {
    purpose = parsePersonalHomeRuntimePurpose(params.purpose);
  } catch {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid Personal Home runtime purpose.');
  }
  return {
    ...params,
    target: { kind: 'local' },
    channel,
    mode: params.mode,
    purpose: { kind: 'personal-home', canonicalServerUrl: purpose.canonicalServerUrl },
  };
}

function assertOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  const unknownKey = Object.keys(value).find((key) => !allowed.has(key));
  if (unknownKey) {
    throw new SystemTaskExecutionError('invalid_params', `Unknown Personal Home task param: ${unknownKey}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseNonEmptyString(value: unknown, field: string): string {
  const parsed = typeof value === 'string' ? value.trim() : '';
  if (!parsed) {
    throw new SystemTaskExecutionError('invalid_params', `Missing ${field}.`);
  }
  return parsed;
}

function parsePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new SystemTaskExecutionError('invalid_params', `Invalid ${field}.`);
  }
  return value;
}

export function createRelayRuntimeStatusTaskKind(deps: Pick<RelayRuntimeKindDeps, 'readStatus' | 'checkHealth' | 'reconcilePersonalHomeRestore'>): InteractiveSystemTaskKind<RelayRuntimeStatusResult> {
  return {
    async run(ctx) {
      const parsed = parseRelayRuntimeTaskParams(ctx.params);

      await reconcileRelayRuntimeContact(deps, parsed, ctx);

      ctx.emit({
        type: 'progress',
        stepId: 'relay.status.inspect',
        message: 'Inspecting relay runtime',
      });

      const snapshot = await deps.readStatus(parsed);

      ctx.emit({
        type: 'progress',
        stepId: 'relay.status.health',
        message: 'Checking relay runtime health',
      });

      return await buildRelayRuntimeStatusResult(snapshot, deps.checkHealth, parsed);
    },
  };
}

export function createRelayRuntimeInstallOrUpdateTaskKind(deps: Pick<RelayRuntimeKindDeps, 'installOrUpdate' | 'reconcilePersonalHomeRestore'>): InteractiveSystemTaskKind<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>> {
  return {
    async run(ctx) {
      const parsed = parseRelayRuntimeTaskParams(ctx.params);

      await reconcileRelayRuntimeContact(deps, parsed, ctx);

      ctx.emit({
        type: 'progress',
        stepId: 'relay.install',
        message: 'Installing relay runtime',
      });

      try {
        return await deps.installOrUpdate(parsed);
      } catch (error) {
        translatePersonalHomeDomainError(error);
      }
    },
  };
}

export function createRelayRuntimeStartTaskKind(deps: Pick<RelayRuntimeKindDeps, 'control' | 'readStatus' | 'checkHealth' | 'reconcilePersonalHomeRestore'>): InteractiveSystemTaskKind<RelayRuntimeStatusResult> {
  return {
    async run(ctx) {
      const parsed = parseRelayRuntimeTaskParams(ctx.params);

      await reconcileRelayRuntimeContact(deps, parsed, ctx);

      ctx.emit({
        type: 'progress',
        stepId: 'relay.start',
        message: 'Starting relay runtime',
      });

      await deps.control({
        ...parsed,
        action: 'start',
      });

      ctx.emit({
        type: 'progress',
        stepId: 'relay.status.inspect',
        message: 'Inspecting relay runtime',
      });

      const snapshot = await deps.readStatus(parsed);

      ctx.emit({
        type: 'progress',
        stepId: 'relay.status.health',
        message: 'Checking relay runtime health',
      });

      return await buildRelayRuntimeStatusResult(snapshot, deps.checkHealth, parsed);
    },
  };
}

export function createRelayRuntimeRestartTaskKind(deps: Pick<RelayRuntimeKindDeps, 'control' | 'readStatus' | 'checkHealth' | 'reconcilePersonalHomeRestore'>): InteractiveSystemTaskKind<RelayRuntimeStatusResult> {
  return {
    async run(ctx) {
      const parsed = parseRelayRuntimeTaskParams(ctx.params);
      await reconcileRelayRuntimeContact(deps, parsed, ctx);
      ctx.emit({ type: 'progress', stepId: 'relay.restart', message: 'Restarting relay runtime' });
      await deps.control({ ...parsed, action: 'restart' });
      const snapshot = await deps.readStatus(parsed);
      ctx.emit({ type: 'progress', stepId: 'relay.status.health', message: 'Checking relay runtime health' });
      return await buildRelayRuntimeStatusResult(snapshot, deps.checkHealth, parsed);
    },
  };
}

export function createRelayRuntimeStopTaskKind(deps: Pick<RelayRuntimeKindDeps, 'control' | 'reconcilePersonalHomeRestore'>): InteractiveSystemTaskKind<Readonly<{ stopped: true }>> {
  return {
    async run(ctx) {
      const parsed = parseRelayRuntimeTaskParams(ctx.params);

      await reconcileRelayRuntimeContact(deps, parsed, ctx);

      ctx.emit({
        type: 'progress',
        stepId: 'relay.stop',
        message: 'Stopping relay runtime',
      });

      await deps.control({
        ...parsed,
        action: 'stop',
      });

      return {
        stopped: true,
      };
    },
  };
}

export function createRelayRuntimeUninstallTaskKind(deps: Pick<RelayRuntimeKindDeps, 'control' | 'reconcilePersonalHomeRestore'>): InteractiveSystemTaskKind<Readonly<{ uninstalled: true }>> {
  return {
    async run(ctx) {
      const parsed = parseRelayRuntimeTaskParams(ctx.params);

      await reconcileRelayRuntimeContact(deps, parsed, ctx);

      ctx.emit({
        type: 'progress',
        stepId: 'relay.uninstall',
        message: 'Uninstalling relay runtime',
      });

      await deps.control({
        ...parsed,
        action: 'uninstall',
      });

      return {
        uninstalled: true,
      };
    },
  };
}

async function buildRelayRuntimeStatusResult(
  snapshot: RelayRuntimeStatusSnapshot,
  checkHealth: (params: Readonly<{ baseUrl: string }>) => Promise<boolean>,
  runtimeTarget: Pick<RelayRuntimeTaskParams, 'channel' | 'mode'>,
): Promise<RelayRuntimeStatusResult> {
  const healthy = typeof snapshot.healthy === 'boolean'
    ? snapshot.healthy
    : await checkHealth({ baseUrl: snapshot.baseUrl });

  return {
    channel: runtimeTarget.channel ?? 'stable',
    mode: runtimeTarget.mode ?? 'user',
    installed: snapshot.installed,
    version: snapshot.version,
    relayUrl: snapshot.baseUrl,
    healthy,
    service: snapshot.service,
    ...(snapshot.warnings && snapshot.warnings.length > 0 ? { warnings: snapshot.warnings } : {}),
    ...(snapshot.purpose ? { purpose: snapshot.purpose } : {}),
    ...(snapshot.canonicalServerUrl ? { canonicalServerUrl: snapshot.canonicalServerUrl } : {}),
    ...(snapshot.layout ? { layout: snapshot.layout } : {}),
    ...(typeof snapshot.dataPresent === 'boolean' ? { dataPresent: snapshot.dataPresent } : {}),
    ...(snapshot.anonymousSignupEnabled !== undefined
      ? { anonymousSignupEnabled: snapshot.anonymousSignupEnabled }
      : {}),
  };
}

export function parseRelayRuntimeTaskParams(params: unknown): RelayRuntimeTaskParams {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid relay runtime params.');
  }
  const value = params as Record<string, unknown>;
  const target = value.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid relay runtime target.');
  }

  const targetRecord = target as Record<string, unknown>;
  const kind = targetRecord.kind === 'ssh' ? 'ssh' : 'local';
  const channel = normalizePublicReleaseRingLabel(value.channel) || 'stable';
  const mode = value.mode === 'system' ? 'system' : 'user';
  const env = typeof value.env === 'object' && value.env && !Array.isArray(value.env)
    ? Object.fromEntries(Object.entries(value.env as Record<string, unknown>).map(([key, innerValue]) => [key, String(innerValue ?? '')]))
    : undefined;
  const selfHostRelayBinaryOverride = typeof value.selfHostRelayBinaryOverride === 'string'
    ? value.selfHostRelayBinaryOverride
    : undefined;
  let purpose: ManagedRelayPurpose | undefined;
  let expectedPersonalHomeState: RelayRuntimeTaskParams['expectedPersonalHomeState'];
  try {
    purpose = value.purpose === undefined
      ? undefined
      : (() => {
          const spec = parsePersonalHomeRuntimePurpose(value.purpose);
          return { kind: 'personal-home' as const, canonicalServerUrl: spec.canonicalServerUrl };
        })();
    if (purpose?.kind === 'personal-home') {
      assertPersonalHomeEnvironmentKeys(env ?? {});
      if (kind === 'ssh') {
        throw new SystemTaskExecutionError(
          'unsupported',
          'Personal Home runtime does not support SSH targets.',
        );
      }
    }
    if (value.expectedPersonalHomeState !== undefined) {
      if (purpose?.kind !== 'personal-home' || kind !== 'local') {
        throw new SystemTaskExecutionError(
          'invalid_params',
          'Personal Home expected state requires a local Personal Home mutation.',
        );
      }
      const expected = value.expectedPersonalHomeState;
      if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
        throw new SystemTaskExecutionError('invalid_params', 'Invalid Personal Home expected state.');
      }
      const record = expected as Record<string, unknown>;
      if (typeof record.installed !== 'boolean' || typeof record.dataPresent !== 'boolean') {
        throw new SystemTaskExecutionError('invalid_params', 'Invalid Personal Home expected state.');
      }
      const canonicalServerUrl = record.canonicalServerUrl === null
        ? null
        : createPersonalHomeRuntimeSpec({ canonicalServerUrl: String(record.canonicalServerUrl ?? '') }).canonicalServerUrl;
      expectedPersonalHomeState = {
        installed: record.installed,
        canonicalServerUrl,
        dataPresent: record.dataPresent,
      };
    }
  } catch (error) {
    if (error instanceof SystemTaskExecutionError) throw error;
    throw new SystemTaskExecutionError(
      'invalid_params',
      error instanceof Error ? error.message : 'Invalid Personal Home runtime parameters.',
    );
  }

  return {
    target: kind === 'local'
      ? { kind: 'local' }
      : {
          kind: 'ssh',
          ssh: parseSystemTaskSshConfig(targetRecord.ssh),
        },
    channel,
    mode,
    ...(env ? { env } : {}),
    ...(selfHostRelayBinaryOverride ? { selfHostRelayBinaryOverride } : {}),
    ...(purpose ? { purpose } : {}),
    ...(expectedPersonalHomeState ? { expectedPersonalHomeState } : {}),
  };
}

export function parseSystemTaskSshConfig(value: unknown): SystemTaskSshConnectionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid ssh config.');
  }
  const record = value as Record<string, unknown>;
  const auth = record.auth === 'keyfile'
    ? 'keyfile'
    : record.auth === 'password'
      ? 'password'
      : 'agent';
  return {
    target: ensureNonEmptyString(record.target, 'ssh.target'),
    ...(typeof record.port === 'number' ? { port: record.port } : {}),
    auth,
    ...(typeof record.identityFile === 'string' ? { identityFile: record.identityFile } : {}),
    ...(typeof record.password === 'string' ? { password: record.password } : {}),
    ...(typeof record.sshConfigFile === 'string' ? { sshConfigFile: record.sshConfigFile } : {}),
    ...(typeof record.knownHostsPath === 'string' ? { knownHostsPath: record.knownHostsPath } : {}),
    ...(typeof record.trustedHostKey === 'string' ? { trustedHostKey: record.trustedHostKey } : {}),
  };
}

function ensureNonEmptyString(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new SystemTaskExecutionError('invalid_params', `Missing ${field}.`);
  }
  return text;
}
