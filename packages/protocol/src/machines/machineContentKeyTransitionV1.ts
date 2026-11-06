import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';
import { AccessibleMachineAccessV1Schema } from './machineAccessV1.js';
import { MachineKindFromLegacyProjectionSchema } from './machineKind.js';
import { RunnerMachineContentKeyBindingV1Schema } from '../ephemeralRunner/machineContentKeyBindingSchema.js';
import { MachineOperationProtocolCapabilitiesV1Schema } from './operationProtocolCapabilitiesV1.js';
import { SessionDataKeyEnvelopeBytesV1Schema } from '../sessions/encryption/sessionDataKeyEnvelopes.js';
import type { AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import { encodeBase64 } from '../crypto/base64.js';
import { createMachineDataEncryptionKeyV1, isMachineDataEncryptionKeyTransferableV1, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from './machineStoredContent.js';
import { DevcontainerChildProjectionV1Schema } from './managed/devcontainerV1.js';
import { ManagedMachineRefV1Schema, ManagedMachineRefReadV1Schema } from './managed/managedMachineV1.js';

/** The persisted owner envelope and both revisions form one content identity. */
export const MachineKeyBasisV1Schema = lazyZodSchema(() => z.strictObject({
  dataEncryptionKey: z.nullable(z.string().check(z.minLength(1))),
  metadataVersion: z.number().check(z.int(), z.nonnegative()),
  daemonStateVersion: z.number().check(z.int(), z.nonnegative()),
}));
export const MachineKeyBasisStoredReadV1Schema = createStoredReadSchema(MachineKeyBasisV1Schema);
export type MachineKeyBasisV1 = z.infer<typeof MachineKeyBasisV1Schema>;

export const MachineEncodedWriteBasisV1Schema = lazyZodSchema(() => z.strictObject({
  expectedDataEncryptionKey: z.nullable(z.string().check(z.minLength(1))),
  expectedVersion: z.number().check(z.int(), z.nonnegative()),
}));
export type MachineEncodedWriteBasisV1 = z.infer<typeof MachineEncodedWriteBasisV1Schema>;

export const MachineContentKeyTransitionInputV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)),
  expected: MachineKeyBasisV1Schema,
  next: z.strictObject({
    dataEncryptionKey: z.union([SessionDataKeyEnvelopeBytesV1Schema, z.literal(MACHINE_PLAIN_DATA_KEY_MARKER)]),
    metadata: z.string(),
    daemonState: z.nullable(z.string()),
  }),
}));
export type MachineContentKeyTransitionInputV1 = z.infer<typeof MachineContentKeyTransitionInputV1Schema>;

export const MachineContentKeyTransitionRefusalV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('refused'),
  code: z.enum(['forbidden', 'machine_unavailable', 'machine_storage_mode_mismatch', 'encryption_material_unavailable']),
}));

/** Reuse the consuming API's validated published row rather than a second row model. */
export function createMachineContentKeyTransitionResultV1Schema<T extends z.ZodMiniType>(machineSchema: T) {
  return z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('committed'), machine: machineSchema }),
    z.strictObject({ kind: z.literal('conflict'), current: MachineKeyBasisV1Schema }),
    MachineContentKeyTransitionRefusalV1Schema,
  ]);
}

export type MachineContentKeyTransitionResultV1<PublishedMachineRow> =
  | Readonly<{ kind: 'committed'; machine: PublishedMachineRow }>
  | Readonly<{ kind: 'conflict'; current: MachineKeyBasisV1 }>
  | z.infer<typeof MachineContentKeyTransitionRefusalV1Schema>;

/** Known fields of the incumbent Machine row; stored reads drop additive fields. */
const MachinePublishedRowCanonicalV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)),
  managedMachineRef: defineStoredReadProjection(z.nullable(ManagedMachineRefV1Schema), () => ManagedMachineRefReadV1Schema),
  devcontainerChild: z.optional(z.nullable(DevcontainerChildProjectionV1Schema)),
  metadata: z.nullable(z.string()),
  metadataVersion: z.number().check(z.int(), z.nonnegative()),
  daemonState: z.nullable(z.string()),
  daemonStateVersion: z.number().check(z.int(), z.nonnegative()),
  dataEncryptionKey: z.optional(z.nullable(z.string())),
  keyBasis: z.optional(MachineKeyBasisV1Schema),
  storageMode: z.optional(z.enum(['plain', 'e2ee'])),
  access: z.optional(AccessibleMachineAccessV1Schema),
  recipientWorkPending: z.optional(z.boolean()),
  recipientWorkCursor: z.optional(z.number().check(z.int(), z.nonnegative())),
  kind: z.optional(MachineKindFromLegacyProjectionSchema),
  installationId: z.optional(z.nullable(z.string())),
  installationPublicKey: z.optional(z.nullable(z.string())),
  contentPublicKeyFingerprint: z.optional(z.nullable(z.string())),
  runnerContentKeyBinding: z.optional(z.nullable(RunnerMachineContentKeyBindingV1Schema)),
  operationProtocolCapabilities: z.catch(z.optional(z.nullable(MachineOperationProtocolCapabilitiesV1Schema)), null),
  operationProtocolCapabilitiesRevision: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
  replacedByMachineId: z.optional(z.nullable(z.string())),
  replacedAt: z.optional(z.nullable(z.number())),
  replacementReason: z.optional(z.nullable(z.string())),
  replacementSource: z.optional(z.nullable(z.string())),
  replacementActorUserId: z.optional(z.nullable(z.string())),
  seq: z.optional(z.number().check(z.int(), z.nonnegative())),
  active: z.optional(z.boolean()),
  activeAt: z.optional(z.number()),
  presenceProtocolVersion: z.optional(z.literal(1)),
  revokedAt: z.optional(z.nullable(z.number())),
  createdAt: z.optional(z.number()),
  updatedAt: z.optional(z.number()),
}));
export const MachinePublishedRowV1Schema = createStoredReadSchema(MachinePublishedRowCanonicalV1Schema);
export type MachinePublishedRowV1 = z.infer<typeof MachinePublishedRowV1Schema>;
/** The same row parser with a closed wire envelope and a bounded public declaration. */
export const MachinePublishedRowWireV1Schema: z.ZodMiniType<MachinePublishedRowV1> = MachinePublishedRowCanonicalV1Schema;
export const MachineContentKeyTransitionResultV1Schema = lazyZodSchema(() =>
  createMachineContentKeyTransitionResultV1Schema(MachinePublishedRowV1Schema));

export class MachineContentKeyPreparationErrorV1 extends Error {
  constructor(readonly code: 'machine_unavailable' | 'machine_content_key_outcome_unknown' | z.infer<typeof MachineContentKeyTransitionRefusalV1Schema>['code'], readonly refusal = false) {
    super(code);
    this.name = 'MachineContentKeyPreparationErrorV1';
  }
}

/** C40 owner conversion. Raw content is preserved; this is never a sharing sanitizer. */
export async function prepareMachineContentKeyV1<T extends Readonly<{
  encryptionMode: 'plain' | 'e2ee'; encryptionKey?: Uint8Array;
}>>(params: Readonly<{
  machineId: string;
  custodianAccountId: string;
  /** Persisted Account mode, captured by the authenticated caller. */
  targetMode?: 'plain' | 'e2ee';
  material: AccountScopedCryptoMaterial | null;
  dataKeyPublicKey?: Uint8Array;
  randomBytes: (length: number) => Uint8Array;
  observe: (signal?: AbortSignal) => Promise<MachinePublishedRowV1>;
  transition: (input: MachineContentKeyTransitionInputV1, signal?: AbortSignal) => Promise<MachineContentKeyTransitionResultV1<MachinePublishedRowV1>>;
  open: (row: MachinePublishedRowV1) => T | Promise<T>;
  decodeStored: (opened: T, ciphertext: string) => unknown | Promise<unknown>;
  encodeStored: (key: Uint8Array, value: unknown) => string | Promise<string>;
  isCurrent?: () => boolean | Promise<boolean>;
  signal?: AbortSignal;
}>): Promise<T> {
  const unavailable = () => new MachineContentKeyPreparationErrorV1('machine_unavailable');
  const assertCurrent = async () => { if (await params.isCurrent?.() === false) throw unavailable(); };
  const open = async (row: MachinePublishedRowV1) => {
    await assertCurrent();
    if (row.id !== params.machineId || (row.access && (row.access.custodian.accountId !== params.custodianAccountId || row.access.accessState !== 'ready'))
      || (row.keyBasis && (row.keyBasis.dataEncryptionKey !== (row.dataEncryptionKey ?? null)
        || row.keyBasis.metadataVersion !== row.metadataVersion || row.keyBasis.daemonStateVersion !== row.daemonStateVersion))) throw unavailable();
    const opened = await params.open(row);
    await assertCurrent();
    return opened;
  };
  const observe = async (signal?: AbortSignal) => {
    await assertCurrent();
    const row = MachinePublishedRowV1Schema.parse(await params.observe(signal));
    await assertCurrent();
    return row;
  };
  params.signal?.throwIfAborted();
  const raw = await observe(params.signal);
  const machine = await open(raw);
  if (machine.encryptionMode === 'plain') return machine;
  if (raw.metadata === null) throw unavailable();
  const material = params.material;
  if (!material) throw new MachineContentKeyPreparationErrorV1('encryption_material_unavailable');
  const transferable = (row: MachinePublishedRowV1, opened: T) => isMachineDataEncryptionKeyTransferableV1({
    publishedDataEncryptionKey: row.dataEncryptionKey, openedDataEncryptionKey: opened.encryptionKey ?? null, accountScopedMaterial: material });
  const toPlain = params.targetMode === 'plain';
  if (!toPlain && transferable(raw, machine)) return machine;
  let proposed: ReturnType<typeof createMachineDataEncryptionKeyV1> | null = null;
  if (!toPlain) {
    try {
      proposed = createMachineDataEncryptionKeyV1({ material,
        ...(params.dataKeyPublicKey ? { dataKeyPublicKey: params.dataKeyPublicKey } : {}), randomBytes: params.randomBytes });
    } catch { throw new MachineContentKeyPreparationErrorV1('encryption_material_unavailable'); }
  }
  const metadata = await params.decodeStored(machine, raw.metadata);
  const daemonState = raw.daemonState === null ? null : await params.decodeStored(machine, raw.daemonState);
  if (metadata === null || (raw.daemonState !== null && daemonState === null)) {
    throw new MachineContentKeyPreparationErrorV1('encryption_material_unavailable');
  }
  const encodeNext = (value: unknown) => proposed
    ? params.encodeStored(proposed.encryptionKey, value) : encodePlainMachineStoredContent(value);
  const input = MachineContentKeyTransitionInputV1Schema.parse({ machineId: params.machineId,
    expected: raw.keyBasis ?? { dataEncryptionKey: raw.dataEncryptionKey ?? null, metadataVersion: raw.metadataVersion, daemonStateVersion: raw.daemonStateVersion },
    next: { dataEncryptionKey: proposed ? encodeBase64(proposed.dataEncryptionKey) : MACHINE_PLAIN_DATA_KEY_MARKER, metadata: await encodeNext(metadata),
      daemonState: daemonState === null ? null : await encodeNext(daemonState) } });
  const corresponds = (row: MachinePublishedRowV1) => row.id === params.machineId && row.dataEncryptionKey === input.next.dataEncryptionKey
    && row.metadata === input.next.metadata && row.daemonState === input.next.daemonState
    && row.metadataVersion === input.expected.metadataVersion + 1 && row.daemonStateVersion === input.expected.daemonStateVersion + 1;
  let result: MachineContentKeyTransitionResultV1<MachinePublishedRowV1>;
  params.signal?.throwIfAborted();
  await assertCurrent();
  try {
    result = MachineContentKeyTransitionResultV1Schema.parse(await params.transition(input, params.signal));
    await assertCurrent();
  } catch (error) {
    if (error instanceof MachineContentKeyPreparationErrorV1 && error.code !== 'machine_content_key_outcome_unknown') throw error;
    // Cancellation after transmission does not prove the transition failed. Observe, never replay.
    try { const current = await observe(); if (corresponds(current)) return await open(current); } catch { /* exact outcome still unproven */ }
    throw new MachineContentKeyPreparationErrorV1('machine_content_key_outcome_unknown');
  }
  if (result.kind === 'committed') {
    if (!corresponds(result.machine)) throw new MachineContentKeyPreparationErrorV1('machine_content_key_outcome_unknown');
    return await open(result.machine);
  }
  if (result.kind === 'conflict') {
    const current = await observe(params.signal);
    const winner = await open(current);
    if (winner.encryptionMode !== 'plain' && (toPlain || !transferable(current, winner))) throw unavailable();
    return winner;
  }
  throw new MachineContentKeyPreparationErrorV1(result.code, true);
}
