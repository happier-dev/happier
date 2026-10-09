import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { AccessibleMachineAccessV1Schema } from './machineAccessV1.js';
import { MachineKindFromLegacyProjectionSchema } from './machineKind.js';
import { RunnerMachineContentKeyBindingV1Schema } from '../ephemeralRunner/machineContentKeyBindingSchema.js';
import { MachineOperationProtocolCapabilitiesV1Schema } from './operationProtocolCapabilitiesV1.js';
import { SessionDataKeyEnvelopeBytesV1Schema } from '../sessions/encryption/sessionDataKeyEnvelopes.js';
import type { AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import { encodeBase64 } from '../crypto/base64.js';
import { createMachineDataEncryptionKeyV1, isMachineDataEncryptionKeyTransferableV1 } from './machineStoredContent.js';
import { DevcontainerChildProjectionV1Schema } from './managed/devcontainerV1.js';

/** The persisted owner envelope and both revisions form one content identity. */
export const MachineKeyBasisV1Schema = lazyZodSchema(() => z.object({
  dataEncryptionKey: z.string().min(1).nullable(),
  metadataVersion: z.number().int().nonnegative(),
  daemonStateVersion: z.number().int().nonnegative(),
}).strict());
export const MachineKeyBasisStoredReadV1Schema = createStoredReadSchema(MachineKeyBasisV1Schema);
export type MachineKeyBasisV1 = z.infer<typeof MachineKeyBasisV1Schema>;

export const MachineEncodedWriteBasisV1Schema = lazyZodSchema(() => z.object({
  expectedDataEncryptionKey: z.string().min(1).nullable(),
  expectedVersion: z.number().int().nonnegative(),
}).strict());
export type MachineEncodedWriteBasisV1 = z.infer<typeof MachineEncodedWriteBasisV1Schema>;

export const MachineContentKeyTransitionInputV1Schema = lazyZodSchema(() => z.object({
  machineId: z.string().min(1),
  expected: MachineKeyBasisV1Schema,
  next: z.object({
    dataEncryptionKey: SessionDataKeyEnvelopeBytesV1Schema,
    metadata: z.string(),
    daemonState: z.string().nullable(),
  }).strict(),
}).strict());
export type MachineContentKeyTransitionInputV1 = z.infer<typeof MachineContentKeyTransitionInputV1Schema>;

export const MachineContentKeyTransitionRefusalV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('refused'),
  code: z.enum(['forbidden', 'machine_unavailable', 'machine_storage_mode_mismatch', 'encryption_material_unavailable']),
}).strict());

/** Reuse the consuming API's validated published row rather than a second row model. */
export function createMachineContentKeyTransitionResultV1Schema<T extends z.ZodType>(machineSchema: T) {
  return z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('committed'), machine: machineSchema }).strict(),
    z.object({ kind: z.literal('conflict'), current: MachineKeyBasisV1Schema }).strict(),
    MachineContentKeyTransitionRefusalV1Schema,
  ]);
}

export type MachineContentKeyTransitionResultV1<PublishedMachineRow> =
  | Readonly<{ kind: 'committed'; machine: PublishedMachineRow }>
  | Readonly<{ kind: 'conflict'; current: MachineKeyBasisV1 }>
  | z.infer<typeof MachineContentKeyTransitionRefusalV1Schema>;

/** Known fields of the incumbent Machine row; stored reads drop additive fields. */
const MachinePublishedRowCanonicalV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1),
  devcontainerChild: z.optional(z.nullable(DevcontainerChildProjectionV1Schema)),
  metadata: z.string().nullable(),
  metadataVersion: z.number().int().nonnegative(),
  daemonState: z.string().nullable(),
  daemonStateVersion: z.number().int().nonnegative(),
  dataEncryptionKey: z.string().nullable().optional(),
  keyBasis: MachineKeyBasisV1Schema.optional(),
  storageMode: z.enum(['plain', 'e2ee']).optional(),
  access: AccessibleMachineAccessV1Schema.optional(),
  kind: MachineKindFromLegacyProjectionSchema.optional(),
  installationId: z.string().nullable().optional(),
  installationPublicKey: z.string().nullable().optional(),
  contentPublicKeyFingerprint: z.string().nullable().optional(),
  runnerContentKeyBinding: RunnerMachineContentKeyBindingV1Schema.nullable().optional(),
  operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.nullable().optional().catch(null),
  operationProtocolCapabilitiesRevision: z.number().int().nonnegative().nullable().optional(),
  replacedByMachineId: z.string().nullable().optional(),
  replacedAt: z.number().nullable().optional(),
  replacementReason: z.string().nullable().optional(),
  replacementSource: z.string().nullable().optional(),
  replacementActorUserId: z.string().nullable().optional(),
  seq: z.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
  activeAt: z.number().optional(),
  revokedAt: z.number().nullable().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
}).strict());
export const MachinePublishedRowV1Schema = createStoredReadSchema(MachinePublishedRowCanonicalV1Schema);
export type MachinePublishedRowV1 = z.infer<typeof MachinePublishedRowV1Schema>;
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
  if (transferable(raw, machine)) return machine;
  let proposed: ReturnType<typeof createMachineDataEncryptionKeyV1>;
  try {
    proposed = createMachineDataEncryptionKeyV1({ material,
      ...(params.dataKeyPublicKey ? { dataKeyPublicKey: params.dataKeyPublicKey } : {}), randomBytes: params.randomBytes });
  } catch { throw new MachineContentKeyPreparationErrorV1('encryption_material_unavailable'); }
  const metadata = await params.decodeStored(machine, raw.metadata);
  const daemonState = raw.daemonState === null ? null : await params.decodeStored(machine, raw.daemonState);
  const input = MachineContentKeyTransitionInputV1Schema.parse({ machineId: params.machineId,
    expected: raw.keyBasis ?? { dataEncryptionKey: raw.dataEncryptionKey ?? null, metadataVersion: raw.metadataVersion, daemonStateVersion: raw.daemonStateVersion },
    next: { dataEncryptionKey: encodeBase64(proposed.dataEncryptionKey), metadata: await params.encodeStored(proposed.encryptionKey, metadata),
      daemonState: daemonState === null ? null : await params.encodeStored(proposed.encryptionKey, daemonState) } });
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
    if (winner.encryptionMode !== 'plain' && !transferable(current, winner)) throw unavailable();
    return winner;
  }
  throw new MachineContentKeyPreparationErrorV1(result.code, true);
}
