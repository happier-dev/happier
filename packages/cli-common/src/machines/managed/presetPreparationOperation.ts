import type { ManagedMachinePresetV1, PresetMutationResultV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { ManagedMachinePresetPreparedV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationV1';
import { openManagedMachinePresetContentV1, replaceManagedMachinePresetPreparationV1,
  type ManagedMachinePresetContentV1, type ManagedMachinePresetPreparedWriteV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { MachineProvisionerPreparationBuildInputV1, MachineProvisionerPreparationBuildResultV1,
  MachineProvisionerPreparationInspectInputV1, MachineProvisionerPreparationInspectResultV1,
  MachineProvisionerPreparationDestroyInputV1, MachineProvisionerPreparationDestroyResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisionerPreparationSchemas';
import { createManagedMachinePresetPreparationBindingV1 } from './presetPreparation.js';
import { createManagedNativeObservationWait } from './nativeObservationWait.js';
import type { ManagedMachinePresetPreparationBuildCompositionV1 } from './presetPreparationBuildInput.js';

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
  // Both existing preset CAS owners increment the revision exactly once. Write
  // that revision into the binding atomically with this state, rather than
  // immediately invalidating the artifact with its own operational update.
  const next = { ...prepared, binding: { ...prepared.binding, presetRevision: current.preset.revision + 1 } };
  const replacement = { presetId: current.preset.id, content: current.preset.content,
    expectedOperationId: incumbent?.operationId ?? null, prepared: next };
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
  return await advanceOperation(input, current);
}

async function advanceOperation(input: OperationInput, current: OpenPreset,
  capturedContent = current.content, signal?: AbortSignal): Promise<OperationResult> {
  const prior = current.content.prepared;
  const incumbent = prior?.operationId === input.operationId ? prior : undefined;
  if (prior && !incumbent && !(prior.status === 'cancelled' && !prior.artifact && !prior.nativeOperationRef)) {
    return { kind: 'conflict', currentRevision: current.preset.revision };
  }
  if (incumbent?.status === 'ready' || incumbent?.status === 'failed' || incumbent?.status === 'cancelled') return result(current, incumbent.status);
  if (incumbent?.status === 'stale') return { kind: 'conflict', currentRevision: current.preset.revision };

  let nativeResult: MachineProvisionerPreparationBuildResultV1 | MachineProvisionerPreparationInspectResultV1;
  if (incumbent) {
    // Dispatch may have happened before the process lost its native response.
    // Recovery needs only the original provider launch, not old CLI archives or
    // setup commands, nor the preset's possibly edited current configuration.
    nativeResult = await input.native.inspect(incumbent.nativeOperationRef
      ? { nativeOperation: incumbent.nativeOperationRef }
      : { operationId: incumbent.operationId, launch: incumbent.binding.configuration.launch.choices }, root(current));
  } else {
    if (capturedContent.preparation?.enabled !== true || !capturedContent.launch || !input.composeBuild) {
      return { kind: 'refused', code: 'invalid_request' };
    }
    const composition = await input.composeBuild(capturedContent);
    if (signal?.aborted && prior?.status === 'cancelled' && !prior.artifact && !prior.nativeOperationRef) {
      return result(current, 'cancelled');
    }
    const building: ManagedMachinePresetPreparedV1 = { operationId: input.operationId, status: 'building',
      cliBinaryPath: composition.input.cli.binaryPath,
      ...(composition.bakedSetup === undefined ? {} : { buildSetup: composition.bakedSetup }),
      binding: createManagedMachinePresetPreparationBindingV1({ content: { ...capturedContent, launch: capturedContent.launch },
        presetRevision: current.preset.revision, cliIdentity: composition.input.cli.identity }) };
    const persisted = await persist(input, current, building, 'pending', input.expectedRevision);
    if (!('prepared' in persisted)) return persisted;
    if (signal?.aborted) return await cancelOperation(input, current);
    nativeResult = await input.native.build({ operationId: input.operationId, input: composition.input }, root(current));
  }
  const prepared = current.content.prepared!;
  const { code: _oldCode, ...withoutCode } = prepared;
  switch (nativeResult.kind) {
    case 'ready': {
      const { buildSetup, bakedSetup: _bakedSetup, ...ready } = withoutCode;
      return await persist(input, current, { ...ready, status: 'ready', artifact: nativeResult.artifact,
        ...(buildSetup === undefined ? {} : { bakedSetup: buildSetup }) }, 'ready');
    }
    case 'pending': return await persist(input, current, { ...withoutCode, status: 'building', nativeOperationRef: nativeResult.nativeOperationRef }, 'pending');
    case 'unknown': return await persist(input, current, { ...prepared, status: 'building', code: nativeResult.code,
      nativeOperationRef: nativeResult.nativeOperationRef }, 'unknown');
    case 'refused': return await persist(input, current, { ...prepared, status: 'failed', code: nativeResult.code }, 'failed');
    case 'failed': return await persist(input, current, { ...prepared, status: 'failed', code: nativeResult.code,
      nativeOperationRef: nativeResult.nativeOperationRef }, 'failed');
    case 'absent': return await persist(input, current, { ...prepared, status: 'failed', code: 'managed_not_found' }, 'failed');
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

async function cancelOperation(input: OperationInput, current: OpenPreset, expectedRevision?: number): Promise<OperationResult> {
  let prepared = current.content.prepared;
  if (!prepared || prepared.operationId !== input.operationId) return { kind: 'conflict', currentRevision: current.preset.revision };
  if (expectedRevision !== undefined && !prepared.artifact && !prepared.nativeOperationRef
    && prepared.status !== 'failed' && prepared.status !== 'cancelled') {
    // Establish this new replacement's original revision before even recovery
    // inspection. Keep building/no-ref distinct from confirmed absence.
    const admitted = await persist(input, current, prepared, 'pending', expectedRevision);
    if (!('prepared' in admitted)) return admitted;
    prepared = admitted.prepared;
    expectedRevision = undefined;
  }
  let owned: ManagedMachinePresetPreparedWriteV1 = prepared;
  if (!prepared.artifact && !prepared.nativeOperationRef) {
    // A definite build refusal creates failed/no-ref: its contract guarantees
    // no native side effect. Ambiguous work remains building/unknown instead.
    if (prepared.status === 'failed') {
      const { code: _code, ...refused } = prepared;
      return await persist(input, current, { ...refused, status: 'cancelled' }, 'cancelled', expectedRevision);
    }
    if (prepared.status === 'cancelled') return result(current, 'cancelled');
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
      const { artifact: _artifact, nativeOperationRef: _nativeOperationRef, code: _code, ...settled } = cancelled.prepared;
      return await persist(input, current, settled, 'cancelled');
    }
    case 'pending': return await persist(input, current, { ...cancelled.prepared, nativeOperationRef: nativeResult.nativeOperationRef }, 'pending');
    case 'unknown': return await persist(input, current, { ...cancelled.prepared, code: nativeResult.code,
      nativeOperationRef: nativeResult.nativeOperationRef }, 'unknown');
    case 'refused': return await persist(input, current, { ...cancelled.prepared, code: nativeResult.code }, 'failed');
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
          : await advanceOperation(request, current, capturedContent, input.signal);
        expectedRevision = undefined;
        if (!cancelling && input.signal?.aborted) { cancelling = true; continue; }
        if (!cancelling && outcome.kind === 'cancelled'
          && (outcome.prepared.artifact || outcome.prepared.nativeOperationRef)) {
          cancelling = true;
          continue;
        }
        if (outcome.kind !== 'pending' && outcome.kind !== 'unknown') return outcome;
        await (cancelling ? cleanupWait : wait)();
      } catch (error) {
        if (!cancelling && input.signal?.aborted) { cancelling = true; continue; }
        throw error;
      }
    }
  };
  if (!incumbent || incumbent.operationId === input.operationId
    || incumbent.status === 'cancelled' && !incumbent.artifact && !incumbent.nativeOperationRef) {
    return await follow(input);
  }
  // Native absence does not establish that the original executor has stopped
  // before create. Its host Action must stop and join before replacement.
  if (incumbent.status === 'building') {
    return { kind: 'conflict', currentRevision: initial.preset.revision };
  }
  const capturedContent = initial.content;
  if (capturedContent.preparation?.enabled !== true || !capturedContent.launch || !input.composeBuild) {
    return { kind: 'refused', code: 'invalid_request' };
  }
  const cleanup = await follow({ ...input, operationId: incumbent.operationId }, true, input.expectedRevision);
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
