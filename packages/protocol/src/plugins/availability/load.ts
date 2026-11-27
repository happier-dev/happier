import { z } from '../../zodRuntimePolicy.js';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginManifestV2LoadSchema } from '../manifest/load.js';
import { PluginUiArtifactDigestV1Schema, type PluginUiArtifactDigestV1 } from '../ui/artifactIntegrity.js';
import {
  PluginMachineMaterializationSnapshotV1Schema,
  PluginMachineMaterializationV1Schema,
  PluginMachineUiArtifactV1Schema,
  PluginReleaseFactsV1Schema,
  type PluginMachineUiArtifactV1,
  type PluginReleaseFactsV1,
  type PluginMachineMaterializationV1,
  type PluginMachineMaterializationSnapshotV1,
} from './v1.js';

function replaceReadFields<T>(schema: z.ZodMiniType<T>, fields: Readonly<Record<string, z.core.$ZodType>>): z.ZodMiniType<T> {
  const definition = (schema as unknown as z.core.$ZodTypes)._zod.def;
  if (definition.type !== 'object') throw new TypeError('Availability read projection requires an object schema.');
  const readDefinition = { ...definition, shape: { ...definition.shape, ...fields } };
  return z.core.clone(schema, readDefinition);
}

/** Read-only variants preserve the canonical output; new publication stays strict. */
export const PluginReleaseFactsV1LoadSchema: z.ZodMiniType<PluginReleaseFactsV1> = lazyZodSchema(() => (
  replaceReadFields(PluginReleaseFactsV1Schema, {
    normalizedManifest: PluginManifestV2LoadSchema,
  })
));

export const PluginMachineMaterializationV1LoadSchema: z.ZodMiniType<PluginMachineMaterializationV1> = lazyZodSchema(() => (
  replaceReadFields(PluginMachineMaterializationV1Schema, {
    declaredManifest: z.optional(PluginManifestV2LoadSchema),
  })
));

export const PluginMachineMaterializationSnapshotV1LoadSchema: z.ZodMiniType<PluginMachineMaterializationSnapshotV1> = lazyZodSchema(() => (
  replaceReadFields(PluginMachineMaterializationSnapshotV1Schema, {
    materializations: z.readonly(z.array(PluginMachineMaterializationV1LoadSchema)),
  })
));

/**
 * Admitted Machine UI-artifact lists of a decoded `materializations.read`: each
 * distinct list is validated once, frozen and shared by every row naming it.
 */
const admittedUiArtifactSets = new WeakSet<object>();

const PluginMachineUiArtifactSetV1Schema = lazyZodSchema(() => z.readonly(z.array(PluginMachineUiArtifactV1Schema)));

function admitUiArtifactSet(list: readonly PluginMachineUiArtifactV1[]): readonly PluginMachineUiArtifactV1[] {
  const admitted = Object.freeze(list.map(artifact => Object.freeze({ ...artifact })));
  admittedUiArtifactSets.add(admitted);
  return admitted;
}

/** True for a list this decoder admitted: immutable and safe to share without copying. */
export function isAdmittedPluginMachineUiArtifactSetV1(value: unknown): value is readonly PluginMachineUiArtifactV1[] {
  return typeof value === 'object' && value !== null && admittedUiArtifactSets.has(value);
}

const PluginMachineMaterializationV1ReadSchema: z.ZodMiniType<PluginMachineMaterializationV1> = lazyZodSchema(() => (
  replaceReadFields(PluginMachineMaterializationV1LoadSchema, {
    uiArtifacts: z.custom<readonly PluginMachineUiArtifactV1[]>(isAdmittedPluginMachineUiArtifactSetV1),
    uiArtifactSetDigest: z.optional(PluginUiArtifactDigestV1Schema),
  }).check(z.refine(value => value.uiArtifactSetDigest === undefined
    || (value.sourceClass === 'bundledFirstParty' && !value.portableRelease && value.uiArtifacts.length === 0),
  { path: ['uiArtifactSetDigest'], message: 'Only a bundled non-portable census row can defer its slots.' }))
));

/** Decoded snapshot rows reference admitted lists; no per-row list copy or re-validation. */
export const PluginMachineMaterializationSnapshotV1ReadSchema: z.ZodMiniType<PluginMachineMaterializationSnapshotV1> = lazyZodSchema(() => (
  replaceReadFields(PluginMachineMaterializationSnapshotV1Schema, {
    materializations: z.readonly(z.array(PluginMachineMaterializationV1ReadSchema)),
  })
));

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const PLUGIN_AVAILABILITY_COMPACT_CENSUS_MEDIA_TYPE = 'application/vnd.happier.plugin-availability-census-v1+json';

/** Set identity is independent of report ordering and JSON object field order. */
export function digestPluginMachineUiArtifactSetV1(artifacts: readonly PluginMachineUiArtifactV1[]): PluginUiArtifactDigestV1 {
  const slots = artifacts.map(slot => JSON.stringify([
    slot.contributionId, slot.artifactId, slot.tier, slot.platform, slot.artifactDigest, slot.hostUiApiRange,
  ])).sort();
  return `sha256:${bytesToHex(sha256(utf8ToBytes(JSON.stringify(slots))))}`;
}

/** Transport envelope: `uiArtifactSets` is admitted here; rows are admitted by the decoded schema. */
export const PluginAccountAvailabilityMaterializationsReadWireEnvelopeV1Schema = lazyZodSchema(() => z.looseObject({
  snapshots: z.readonly(z.array(z.unknown())),
  uiArtifactSets: z.optional(z.readonly(z.array(z.union([PluginMachineUiArtifactSetV1Schema, PluginUiArtifactDigestV1Schema])))),
}));

/**
 * Expands indexed rows with their shared artifact list and snapshot identity.
 * Explicit identities on older rows still pass through the snapshot check.
 * Inline lists are admitted on their own, and invalid indices fail admission.
 */
export function expandPluginMachineUiArtifactSetsV1(
  wire: Readonly<{ snapshots: readonly unknown[]; uiArtifactSets?: readonly (readonly PluginMachineUiArtifactV1[] | PluginUiArtifactDigestV1)[] }>,
): Record<string, unknown> {
  const sets = (wire.uiArtifactSets ?? []).map(set => typeof set === 'string' ? set : admitUiArtifactSet(set));
  const emptySlots = admitUiArtifactSet([]);
  const { uiArtifactSets: _sets, ...fields } = wire;
  return { ...fields, snapshots: wire.snapshots.map(snapshot => !isRecord(snapshot) || !Array.isArray(snapshot.materializations) ? snapshot : {
    ...snapshot,
    materializations: snapshot.materializations.map((row: unknown) => {
      if (!isRecord(row)) return row;
      if ('uiArtifactSet' in row) {
        const { uiArtifactSet, ...materialization } = row;
        const set = typeof uiArtifactSet === 'number' ? sets[uiArtifactSet] : undefined;
        return set ? {
          serverIdentityId: snapshot.serverIdentityId,
          machineId: snapshot.machineId,
          ...materialization,
          ...(typeof set === 'string'
            ? { uiArtifacts: emptySlots, uiArtifactSetDigest: set }
            : { uiArtifacts: set }),
        } : row;
      }
      const inline = PluginMachineUiArtifactSetV1Schema.safeParse(row.uiArtifacts);
      return inline.success ? { ...row, uiArtifacts: admitUiArtifactSet(inline.data) } : row;
    }),
  }) };
}

/** Server transport encoding: Machine identity once per snapshot, each artifact list once per response. */
export function encodePluginAccountAvailabilityMaterializationsReadV1<T extends Readonly<{
  snapshots: readonly Readonly<{ materializations: readonly Readonly<{
    serverIdentityId?: string;
    machineId?: string;
    sourceClass?: PluginMachineMaterializationV1['sourceClass'];
    portableRelease?: boolean;
    uiArtifacts: readonly PluginMachineUiArtifactV1[];
  }>[] }>[];
}>>(response: T, options?: Readonly<{ compactCensus: boolean }>): Record<string, unknown> {
  const uiArtifactSets: (readonly PluginMachineUiArtifactV1[] | PluginUiArtifactDigestV1)[] = [];
  const indexByContent = new Map<string, number>();
  const snapshots = response.snapshots.map(snapshot => ({ ...snapshot, materializations: snapshot.materializations.map(row => {
    const { serverIdentityId: _serverIdentityId, machineId: _machineId, uiArtifacts, ...materialization } = row;
    const defer = options?.compactCensus === true && row.sourceClass === 'bundledFirstParty'
      && row.portableRelease === false && uiArtifacts.length > 0;
    const key = `${defer ? 'digest' : 'slots'}:${JSON.stringify(uiArtifacts)}`;
    let uiArtifactSet = indexByContent.get(key);
    if (uiArtifactSet === undefined) {
      uiArtifactSet = uiArtifactSets.length;
      uiArtifactSets.push(defer ? digestPluginMachineUiArtifactSetV1(uiArtifacts) : uiArtifacts);
      indexByContent.set(key, uiArtifactSet);
    }
    return { ...materialization, uiArtifactSet };
  }) }));
  return { ...response, snapshots, uiArtifactSets };
}
