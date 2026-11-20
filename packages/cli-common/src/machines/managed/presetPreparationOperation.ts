import type { ManagedMachinePresetV1, PresetMutationResultV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { ManagedMachinePresetPreparedV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationV1';
import type { MachineAvailabilityDiagnosticV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { openManagedMachinePresetContentV1, replaceManagedMachinePresetPreparationV1,
  type ManagedMachinePresetContentV1, type ManagedMachinePresetPreparedWriteV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { PREPARATION_ARTIFACT_ABSENT_BUILD_UNCONFIRMED_CODE_V1,
  type MachineProvisionerPreparationBuildInputV1, type MachineProvisionerPreparationBuildResultV1,
  type MachineProvisionerPreparationInspectInputV1, type MachineProvisionerPreparationInspectResultV1,
  type MachineProvisionerPreparationDestroyInputV1, type MachineProvisionerPreparationDestroyResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisionerPreparationSchemas';
import { createManagedMachinePresetPreparationBindingV1, readManagedMachinePresetPreparationV1 } from './presetPreparation.js';
import { createManagedNativeObservationWait } from './nativeObservationWait.js';
import { createPresetPreparationProgress, type ManagedMachinePresetPreparationProgressV1 } from './presetPreparationProgress.js';
import type { ManagedMachinePresetPreparationBuildCompositionV1 } from './presetPreparationBuildInput.js';
import type { PluginActionExecutionV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { ManagedMachineControllerError, ManagedMachineNativeEffectGuardRefusal } from './controllerErrors.js';

export type ManagedMachinePresetPreparationStorageV1 = Readonly<{
  /** Bound to the preset and original admission by the installed custodian. */
  read(): Promise<ManagedMachinePresetV1>;
  compareAndSwap(input: Readonly<{ expectedRevision: number; content: ManagedMachinePresetV1['content'];
    recipients: ManagedMachinePresetV1['recipients'] }>): Promise<PresetMutationResultV1>;
}>;
export type ManagedMachinePresetPreparationNativeV1 = Readonly<{
  /** The host's reviewed-child owner supplies these already-admitted role invocations. */
  build(input: MachineProvisionerPreparationBuildInputV1, root: ManagedMachinePresetPreparationRootV1): Promise<MachineProvisionerPreparationBuildResultV1>;
  inspect(input: MachineProvisionerPreparationInspectInputV1, root: ManagedMachinePresetPreparationRootV1): Promise<MachineProvisionerPreparationInspectResultV1>;
  destroy(input: MachineProvisionerPreparationDestroyInputV1, root: ManagedMachinePresetPreparationRootV1): Promise<MachineProvisionerPreparationDestroyResultV1>;
}>;
/** Facts from the admitted operation and the CAS-returned private row; not an authorization proof. */
export type ManagedMachinePresetPreparationRootV1 = Readonly<{
  presetId: string; presetRevision: number; operationId: string;
  /** Original private selection, including credential references, for the owned native resource. */
  launch: ManagedMachinePresetPreparedV1['binding']['configuration']['launch'];
}>;
export type ManagedMachinePresetPreparationCustodyV1 =
  | Readonly<{ mode: 'plain' }>
  | Readonly<{ mode: 'e2ee'; accountId: string; accountKey: Uint8Array; randomBytes: (length: number) => Uint8Array }>;
export type ManagedMachinePresetPreparationOperationInputV1 = Readonly<{
  operationId: string; expectedRevision: number;
  onProgress?: (progress: ManagedMachinePresetPreparationProgressV1) => void;
  /** Installed host that owns Machine-placement native image effects. */
  machineId?: string;
  credentialConfigurations: ManagedMachinePresetPreparedV1['binding']['credentialConfigurations'];
  /** Current canonical supplier metadata; permits adoption without composing archives. */
  cliIdentity?: string;
  /** Archive removes the incumbent image without composing a replacement. */
  cleanupOnly?: boolean;
  /** Canonical Machine availability established that the original cleanup host is permanently gone. */
  cleanupUnavailable?: Extract<MachineAvailabilityDiagnosticV1, { reason: 'machine_revoked' | 'machine_replaced' }>['reason'];
  /** The incumbent image's destroy placement; a replacement on another host keeps that image and refuses. */
  readDestroyExecution?: ManagedMachinePresetDestroyExecutionReaderV1;
  /** Only a new build needs CLI assets; recovery uses the retained native facts. */
  composeBuild?: (capturedContent: ManagedMachinePresetContentV1) => Promise<ManagedMachinePresetPreparationBuildCompositionV1>;
  custody: ManagedMachinePresetPreparationCustodyV1;
  storage: ManagedMachinePresetPreparationStorageV1;
  native: ManagedMachinePresetPreparationNativeV1;
}>;
export type ManagedMachinePresetPreparationOperationResultV1 =
  | Readonly<{ kind: 'ready' | 'pending' | 'unknown' | 'failed' | 'cancelled'; revision: number; prepared: ManagedMachinePresetPreparedV1 }>
  | Readonly<{ kind: 'conflict'; currentRevision: number;
    /** Provider-owned refs returned after a conflicting write, not durable private state. */
    recovery?: Pick<ManagedMachinePresetPreparedV1, 'operationId' | 'artifact' | 'nativeOperationRef'> }>
  | Readonly<{ kind: 'refused'; code: string;
    /** Known provider-owned refs; their private write did not succeed. */
    recovery?: Pick<ManagedMachinePresetPreparedV1, 'operationId' | 'artifact' | 'nativeOperationRef'> }>;

type OpenPreset = { preset: ManagedMachinePresetV1; content: ManagedMachinePresetContentV1 };
type OperationInput = ManagedMachinePresetPreparationOperationInputV1;
type OperationResult = ManagedMachinePresetPreparationOperationResultV1;
type SettledKind = Extract<OperationResult, { prepared: unknown }>['kind'];

async function readPreset(input: OperationInput): Promise<OpenPreset | Extract<OperationResult, { kind: 'refused' }>> {
  const preset = await input.storage.read();
  if (preset.contentEncryptionMode !== input.custody.mode) return { kind: 'refused', code: 'account_mode_mismatch' };
  const opening = { presetId: preset.id, content: preset.content };
  const content = input.custody.mode === 'plain'
    ? openManagedMachinePresetContentV1({ ...opening, mode: 'plain' })
    : openManagedMachinePresetContentV1({ ...opening, ...input.custody, recipients: preset.recipients });
  return content ? { preset, content } : { kind: 'refused', code: 'credential_unavailable' };
}

/** Same-key private persistence; operational CAS writes consume the row's next revision. */
async function persist(input: OperationInput, current: OpenPreset, prepared: ManagedMachinePresetPreparedWriteV1,
  kind: SettledKind, expectedRevision?: number): Promise<OperationResult> {
  const incumbent = current.content.prepared;
  if (expectedRevision === undefined && incumbent && sameStrictJsonValue(incumbent, prepared, { omitUndefinedObjectMembers: true })) {
    return { kind, revision: current.preset.revision, prepared: incumbent };
  }
  const replacement = { presetId: current.preset.id, content: current.preset.content,
    expectedOperationId: incumbent?.operationId ?? null, prepared };
  const replaced = input.custody.mode === 'plain'
    ? replaceManagedMachinePresetPreparationV1({ ...replacement, mode: 'plain' })
    : replaceManagedMachinePresetPreparationV1({ ...replacement, ...input.custody, recipients: current.preset.recipients });
  if (!replaced) return { kind: 'refused', code: 'invalid_request' };
  const normalized = replaced.prepared;
  const saved = await input.storage.compareAndSwap({ expectedRevision: expectedRevision ?? current.preset.revision,
    content: replaced.content, recipients: current.preset.recipients });
  if (saved.kind !== 'saved' && (normalized.artifact || normalized.nativeOperationRef)) {
    return { ...saved, recovery: { operationId: normalized.operationId,
      ...(normalized.artifact === undefined ? {} : { artifact: normalized.artifact }),
      ...(normalized.nativeOperationRef === undefined ? {} : { nativeOperationRef: normalized.nativeOperationRef }) } };
  }
  if (saved.kind !== 'saved') return saved;
  current.preset = saved.preset;
  current.content = { ...current.content, prepared: normalized };
  return { kind, revision: saved.preset.revision, prepared: normalized };
}

function result(current: OpenPreset, kind: SettledKind): OperationResult {
  return { kind, revision: current.preset.revision, prepared: current.content.prepared! };
}

function nativeFailure(outcome: Pick<ManagedMachinePresetPreparedV1, 'code' | 'nativeCause'>,
  prepared: ManagedMachinePresetPreparedV1) {
  if (outcome.nativeCause !== undefined) return { code: outcome.code, nativeCause: outcome.nativeCause };
  return prepared.nativeCause === undefined ? { code: outcome.code }
    : { code: prepared.code ?? outcome.code, nativeCause: prepared.nativeCause };
}

function root(current: OpenPreset): ManagedMachinePresetPreparationRootV1 {
  return { presetId: current.preset.id, presetRevision: current.preset.revision,
    operationId: current.content.prepared!.operationId,
    launch: current.content.prepared!.binding.configuration.launch };
}

/**
 * Advances one provider result under the incumbent Action operation. Its caller
 * owns active following and cancellation; this owner never starts a poller or
 * re-admits provider work. Reload inspects the retained native identity or the
 * original admitted operation and retained launch; it never issues another build.
 */
export async function advanceManagedMachinePresetPreparationOperationV1(
  input: OperationInput,
): Promise<OperationResult> {
  const current = await readPreset(input);
  if ('kind' in current) return current;
  const progress = createPresetPreparationProgress(input.onProgress);
  try {
    const outcome = await advanceOperation(input, current, current.content, undefined, progress);
    if (outcome.kind !== 'ready' && outcome.kind !== 'pending' && outcome.kind !== 'unknown') {
      progress.finish(outcome.kind === 'cancelled' ? 'cancelled' : 'failed');
    }
    return outcome;
  }
  catch (error) { progress.finish('failed'); throw error; }
}

async function advanceOperation(input: OperationInput, current: OpenPreset,
  capturedContent = current.content, signal?: AbortSignal,
  progress = createPresetPreparationProgress(input.onProgress), builtFromRevision = input.expectedRevision): Promise<OperationResult> {
  const prior = current.content.prepared;
  const incumbent = prior?.operationId === input.operationId ? prior : undefined;
  if (prior && !incumbent && !(prior.status === 'cancelled' && !prior.artifact && !prior.nativeOperationRef)) {
    return { kind: 'conflict', currentRevision: current.preset.revision };
  }
  if (incumbent?.status === 'ready' || incumbent?.status === 'failed' || incumbent?.status === 'cancelled') return result(current, incumbent.status);

  let nativeResult: MachineProvisionerPreparationBuildResultV1 | MachineProvisionerPreparationInspectResultV1;
  if (incumbent) {
    // Dispatch may have happened before the process lost its native response.
    // Recovery needs only the original provider launch, not old CLI archives or
    // setup commands, nor the preset's possibly edited current configuration.
    progress.start('build-image');
    nativeResult = await input.native.inspect(incumbent.nativeOperationRef
      ? { nativeOperation: incumbent.nativeOperationRef }
      : { operationId: incumbent.operationId, launch: incumbent.binding.configuration.launch.choices }, root(current));
  } else {
    if (capturedContent.preparation?.enabled !== true || !capturedContent.launch || !input.composeBuild) {
      return { kind: 'refused', code: 'invalid_request' };
    }
    progress.start('prepare-inputs');
    const composition = await input.composeBuild(capturedContent);
    if (signal?.aborted && prior?.status === 'cancelled' && !prior.artifact && !prior.nativeOperationRef) {
      return result(current, 'cancelled');
    }
    const building: ManagedMachinePresetPreparedV1 = { operationId: input.operationId, status: 'building', builtFromRevision,
      cliBinaryPath: composition.input.cli.binaryPath,
      ...(composition.bakedSetup === undefined ? {} : { buildSetup: composition.bakedSetup }),
      binding: createManagedMachinePresetPreparationBindingV1({ content: { ...capturedContent, launch: capturedContent.launch },
        cliIdentity: composition.input.cli.identity,
        machineId: input.machineId,
        credentialConfigurations: input.credentialConfigurations }) };
    const persisted = await persist(input, current, building, 'pending', input.expectedRevision);
    if (!('prepared' in persisted)) return persisted;
    if (signal?.aborted) return await cancelOperation(input, current);
    progress.start('build-image');
    try {
      nativeResult = await input.native.build({ operationId: input.operationId, input: composition.input }, root(current));
    } catch (error) {
      if (error instanceof ManagedMachineNativeEffectGuardRefusal) {
        // The native handler did not start. Keep that fact in the preset so
        // later Archive never has to infer absence from a lost response.
        const nativeCause = error.details?.kind === 'managedNative' ? error.details.nativeCause : undefined;
        const failed = await persist(input, current, { ...building, status: 'failed', code: error.code,
          ...(nativeCause === undefined ? {} : { nativeCause }) }, 'failed');
        if (!('prepared' in failed)) return failed;
      }
      throw error;
    }
  }
  const prepared = current.content.prepared!;
  const { code: _oldCode, nativeCause: _oldCause, ...withoutCode } = prepared;
  switch (nativeResult.kind) {
    case 'ready': {
      const { buildSetup, bakedSetup: _bakedSetup, artifactSizeBytes: _priorSize, ...ready } = withoutCode;
      progress.start('save-image');
      const saved = await persist(input, current, { ...ready, status: 'ready', builtAt: prepared.builtAt ?? Date.now(), artifact: nativeResult.artifact,
        ...(nativeResult.artifactSizeBytes === undefined ? {} : { artifactSizeBytes: nativeResult.artifactSizeBytes }),
        ...(buildSetup === undefined ? {} : { bakedSetup: buildSetup }) }, 'ready');
      progress.finish(saved.kind === 'ready' ? 'succeeded' : 'failed');
      return saved;
    }
    case 'pending': return await persist(input, current, { ...prepared, status: 'building', nativeOperationRef: nativeResult.nativeOperationRef }, 'pending');
    case 'unknown': return await persist(input, current, { ...prepared, status: 'building', ...nativeFailure(nativeResult, prepared),
      nativeOperationRef: nativeResult.nativeOperationRef }, 'unknown');
    case 'refused': progress.finish('failed'); return await persist(input, current, { ...prepared, status: 'failed', ...nativeFailure(nativeResult, prepared) }, 'failed');
    case 'failed': progress.finish('failed'); return await persist(input, current, { ...prepared, status: 'failed', ...nativeFailure(nativeResult, prepared),
      nativeOperationRef: nativeResult.nativeOperationRef }, 'failed');
    case 'absent': return await persist(input, current, { ...prepared, status: 'failed', ...nativeFailure({ code: 'managed_not_found' }, prepared) }, 'failed');
  }
}

/** Cancelling and preset retirement use the same owned native destroy role. */
export async function cancelManagedMachinePresetPreparationOperationV1(
  input: OperationInput,
): Promise<OperationResult> {
  const current = await readPreset(input);
  if ('kind' in current) return current;
  return await cancelOperation(input, current);
}

/** Definite refusal and settled absence need no provider to clean up. */
export function managedMachinePresetPreparationNeedsNativeCleanupV1(prepared: ManagedMachinePresetPreparedV1): boolean {
  return Boolean(prepared.artifact || prepared.nativeOperationRef)
    || prepared.status !== 'failed' && prepared.status !== 'cancelled';
}

/** Place Archive with its native cleanup, using the Prepare host when the caller cannot execute it. */
export type ManagedMachinePresetDestroyExecutionReaderV1 = (
  launch: ManagedMachinePresetPreparedV1['binding']['configuration']['launch'],
) => Promise<Readonly<{ execution: PluginActionExecutionV2 | undefined; requiresNativeHost?: boolean }>>;

export async function resolveManagedMachinePresetArchiveExecutionTargetV1(input: Readonly<{
  prepared: ManagedMachinePresetPreparedV1 | undefined;
  readDestroyExecution: ManagedMachinePresetDestroyExecutionReaderV1;
  readCleanupUnavailable(machineId: string): Promise<OperationInput['cleanupUnavailable']>;
}>): Promise<Readonly<{ kind: 'machine'; machineId: string }> | null> {
  const prepared = input.prepared;
  if (!prepared || !managedMachinePresetPreparationNeedsNativeCleanupV1(prepared)) return null;
  const { execution, requiresNativeHost } = await input.readDestroyExecution(prepared.binding.configuration.launch);
  const accountTarget = execution?.target === 'account';
  if (accountTarget && !requiresNativeHost) return null;
  const machineId = prepared.binding.machineId;
  if (machineId && !await input.readCleanupUnavailable(machineId)) return { kind: 'machine', machineId };
  if (accountTarget) throw new ManagedMachineControllerError('controller_unavailable');
  // Permanent host loss keeps the existing metadata Archive and cleanup diagnostics.
  return null;
}

async function cancelOperation(input: OperationInput, current: OpenPreset, expectedRevision?: number): Promise<OperationResult> {
  let prepared = current.content.prepared;
  if (!prepared || prepared.operationId !== input.operationId) return { kind: 'conflict', currentRevision: current.preset.revision };
  if (expectedRevision !== undefined && !prepared.artifact && !prepared.nativeOperationRef
    && managedMachinePresetPreparationNeedsNativeCleanupV1(prepared)) {
    // Establish this new replacement's original revision before even recovery
    // inspection. Keep building/no-ref distinct from confirmed absence.
    const admitted = await persist(input, current, prepared, 'pending', expectedRevision);
    if (!('prepared' in admitted)) return admitted;
    prepared = admitted.prepared;
    expectedRevision = undefined;
  }
  if (!managedMachinePresetPreparationNeedsNativeCleanupV1(prepared)) {
    // A definite build refusal creates failed/no-ref: its contract guarantees
    // no native side effect. Ambiguous work remains building/unknown instead.
    if (prepared.status === 'failed') {
      const { code: _code, ...refused } = prepared;
      return await persist(input, current, { ...refused, status: 'cancelled' }, 'cancelled', expectedRevision);
    }
    return result(current, 'cancelled');
  }
  let owned: ManagedMachinePresetPreparedWriteV1 = prepared;
  if (!prepared.artifact && !prepared.nativeOperationRef) {
    const recovered = await input.native.inspect({ operationId: prepared.operationId,
      launch: prepared.binding.configuration.launch.choices }, root(current));
    if (recovered.kind === 'absent') {
      const { code: _code, ...absent } = prepared;
      return await persist(input, current, { ...absent, status: 'cancelled' }, 'cancelled', expectedRevision);
    }
    owned = recovered.kind === 'ready' ? { ...prepared, artifact: recovered.artifact }
      : { ...prepared, nativeOperationRef: recovered.nativeOperationRef };
  }

  // Remove warm eligibility before waiting for native cleanup. Preserve both
  // owned identities until the provider establishes absence.
  const cancelled = await persist(input, current, { ...owned, status: 'cancelled' }, 'pending', expectedRevision);
  if (!('prepared' in cancelled)) return cancelled;
  const references = cancelled.prepared.artifact ? { artifact: cancelled.prepared.artifact,
    ...(cancelled.prepared.nativeOperationRef === undefined ? {} : { nativeOperation: cancelled.prepared.nativeOperationRef }) }
    : { nativeOperation: cancelled.prepared.nativeOperationRef! };
  const nativeResult = await input.native.destroy(references, root(current));
  switch (nativeResult.kind) {
    case 'confirmed': {
      const { artifact: _artifact, artifactSizeBytes: _size, nativeOperationRef: _nativeOperationRef, code: _code, nativeCause: _cause, ...settled } = cancelled.prepared;
      return await persist(input, current, settled, 'cancelled');
    }
    case 'pending': return await persist(input, current, { ...cancelled.prepared, nativeOperationRef: nativeResult.nativeOperationRef }, 'pending');
    case 'unknown': {
      // Archive can hide the preset after observed absence. Keep the reference
      // so Restore and a later cleanup can still account for a late publication.
      const kind = input.cleanupOnly && nativeResult.code === PREPARATION_ARTIFACT_ABSENT_BUILD_UNCONFIRMED_CODE_V1
        ? 'cancelled' : 'unknown';
      return await persist(input, current, { ...cancelled.prepared, ...nativeFailure(nativeResult, cancelled.prepared),
        nativeOperationRef: nativeResult.nativeOperationRef }, kind);
    }
    case 'refused': return await persist(input, current, { ...cancelled.prepared, ...nativeFailure(nativeResult, cancelled.prepared) }, 'failed');
  }
}

/**
 * Keep the incumbent host Action handler and its Stop owner alive through native
 * settlement. The installed native port retains admitted cleanup custody after
 * signal abort; Stop withdraws build eligibility, not the owned destroy role.
 */
export async function settleManagedMachinePresetPreparationOperationV1(
  input: OperationInput & Readonly<{ signal?: AbortSignal }>,
): Promise<OperationResult> {
  const wait = createManagedNativeObservationWait(input.signal);
  const cleanupWait = createManagedNativeObservationWait();
  const initial = await readPreset(input);
  if ('kind' in initial) return initial;
  const incumbent = initial.content.prepared;
  let current = initial;
  const progress = createPresetPreparationProgress(input.onProgress);
  const follow = async (request: OperationInput, cancelling = input.signal?.aborted === true,
    expectedRevision?: number, capturedContent?: ManagedMachinePresetContentV1): Promise<OperationResult> => {
    let first = true;
    for (;;) {
      if (!first) {
        const next = await readPreset(request);
        if ('kind' in next) return next;
        current = next;
      }
      first = false;
      if (input.signal?.aborted) cancelling = true;
      const prepared = current.content.prepared;
      if (cancelling && capturedContent && prepared?.operationId !== request.operationId
        && prepared?.operationId === incumbent?.operationId
        && prepared?.status === 'cancelled' && !prepared.artifact && !prepared.nativeOperationRef) {
        return result(current, 'cancelled');
      }
      try {
        const outcome = cancelling ? await cancelOperation(request, current, expectedRevision)
          : await advanceOperation(request, current, capturedContent, input.signal, progress, input.expectedRevision);
        expectedRevision = undefined;
        if (!cancelling && input.signal?.aborted) { cancelling = true; continue; }
        if (!cancelling && outcome.kind === 'cancelled'
          && (outcome.prepared.artifact || outcome.prepared.nativeOperationRef)) {
          cancelling = true;
          continue;
        }
        if (outcome.kind !== 'pending' && outcome.kind !== 'unknown') {
          if (cancelling || outcome.kind === 'cancelled') progress.finish('cancelled');
          else if (outcome.kind !== 'ready') progress.finish('failed');
          return outcome;
        }
        await (cancelling ? cleanupWait : wait)();
      } catch (error) {
        progress.finish(input.signal?.aborted ? 'cancelled' : 'failed');
        if (!cancelling && input.signal?.aborted) { cancelling = true; continue; }
        if (!cancelling && current.content.prepared?.operationId === request.operationId
          && current.content.prepared.status === 'building') {
          // A thrown native failure can follow allocation before a response
          // supplied its reference. The original admission still owns cleanup.
          try { await follow(request, true); } catch {
            // Retain uncertain ownership and surface the original build failure.
          }
        }
        throw error;
      }
    }
  };
  if (input.cleanupOnly) {
    if (input.expectedRevision !== initial.preset.revision) {
      return { kind: 'conflict', currentRevision: initial.preset.revision };
    }
    if (!incumbent) return { kind: 'refused', code: 'invalid_request' };
    if (input.cleanupUnavailable !== undefined) {
      return await persist(input, current, { ...incumbent, status: 'cancelled', code: 'preparation_cleanup_required' },
        'cancelled', input.expectedRevision);
    }
    return await follow({ ...input, operationId: incumbent.operationId }, true, input.expectedRevision);
  }
  if (!incumbent || incumbent.operationId === input.operationId
    || incumbent.status === 'cancelled' && !incumbent.artifact && !incumbent.nativeOperationRef) {
    return await follow(input);
  }
  if (input.readDestroyExecution && input.machineId) {
    // Another host's native namespace cannot observe this image; its absence there
    // must never clear the only reference. Archive or a Retry on that host cleans it.
    const cleanupHost = await resolveManagedMachinePresetArchiveExecutionTargetV1({ prepared: incumbent,
      readDestroyExecution: input.readDestroyExecution, readCleanupUnavailable: async () => undefined });
    if (cleanupHost && cleanupHost.machineId !== input.machineId) return { kind: 'refused', code: 'preparation_cleanup_required' };
  }
  const capturedContent = initial.content;
  let cleanupRevision = input.expectedRevision;
  if (incumbent.status === 'building') {
    if (input.expectedRevision !== initial.preset.revision) {
      return { kind: 'conflict', currentRevision: initial.preset.revision };
    }
    // A new admitted Retry inspects the original native identity, never builds
    // again while its outcome is unknown (O-MACH 2026-11-16 07:18).
    const recovered = await follow({ ...input, operationId: incumbent.operationId });
    if (recovered.kind !== 'ready' && recovered.kind !== 'failed') return recovered;
    if (recovered.kind === 'ready' && input.cliIdentity !== undefined
      && readManagedMachinePresetPreparationV1({ content: { ...capturedContent, prepared: recovered.prepared },
        cliIdentity: input.cliIdentity,
        canManagePreset: true, // This finite Prepare operation already holds admitted Manage authority.
        credentialConfigurations: input.credentialConfigurations }).kind === 'warm') return recovered;
    const observed = await readPreset(input);
    if ('kind' in observed) return observed;
    if (observed.content.prepared?.operationId !== incumbent.operationId) {
      return { kind: 'conflict', currentRevision: observed.preset.revision };
    }
    current = observed;
    cleanupRevision = observed.preset.revision;
  }
  if (capturedContent.preparation?.enabled !== true || !capturedContent.launch || !input.composeBuild) {
    return { kind: 'refused', code: 'invalid_request' };
  }
  const cleanup = await follow({ ...input, operationId: incumbent.operationId }, true, cleanupRevision);
  if (cleanup.kind !== 'cancelled' || input.signal?.aborted) return cleanup;
  const next = await readPreset(input);
  if ('kind' in next) return next;
  if (next.content.prepared?.operationId !== incumbent.operationId) {
    return { kind: 'conflict', currentRevision: next.preset.revision };
  }
  current = next;
  // The target lives only in this admitted invocation. If it is lost before the
  // new binding is written, the original revision conflicts and Retry admits a
  // new target; cleanup never reconstructs it from today's authored definition.
  return await follow({ ...input, expectedRevision: current.preset.revision }, false, undefined, capturedContent);
}
