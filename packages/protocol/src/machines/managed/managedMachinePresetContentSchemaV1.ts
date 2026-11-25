import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import type { ProtocolComposableSchema } from '../../plugins/actions/protocolComposableSchema.js';
import {
  MachineProvisionerDestroyResultV1Schema, MachineProvisionerPowerResultV1Schema,
  MachineProvisionerRebuildResultV1Schema, MachineProvisionerResizeResultV1Schema,
} from '../../plugins/contributions/machineProvisioners.js';
import { z } from '../../zodRuntimePolicy.js';
import { SessionProjectFilesV1Schema } from '../machineIsolationV1.js';
import { MachinePoolIdV1Schema } from '../pools/v1.js';
import { MachineSetupSourceFactsMapV1Schema } from '../setup/machineSetupSourceFactsV1.js';
import { DevcontainerEffectReviewV1Schema } from './devcontainerV1.js';
import { ManagedMachineEnrollmentIdentityV1Schema } from './enrollmentIdentityV1.js';
import { MachineSetupV1Schema } from './machineSetupV1.js';
import { createManagedConfigurationFactsV1Schema } from './managedConfigurationV1.js';
import {
  CanonicalCiphertextSchema, ManagedMachinePresetRecipientsV1Schema,
  ManagedMachinePresetStoredContentCarrierV1Schema,
} from './managedMachinePresetContentCarrierV1.js';
import {
  createManagedMachinePresetPreparationExecutionV1Schema,
  ManagedMachinePresetPreparationV1Schema, ManagedMachinePresetPreparedV1Schema,
} from './managedMachinePresetPreparationV1.js';
import { createValidatedLaunchSnapshotV1Schema } from './managedMachineV1.js';
import {
  ManagedPowerIntentV1Schema, AcquireResultV1Schema, ProviderObservationV1Schema, MachineProvisionerSizeV1Schema,
  type AcquireResultV1,
} from './providerFactsV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));

type ManagedPresetLaunchIdentityV1 = Readonly<{
  provider: Readonly<{ pluginId: string; localId: string }>;
  schemaVersion: number;
}>;

function readPresetLaunchSelection(launch: Readonly<{ name: string; choices?: unknown }>) {
  const { choices: _choices, name: _name, ...selection } = launch;
  return selection;
}

function nativeResultMatchesLaunch(
  result: AcquireResultV1,
  launch: ManagedPresetLaunchIdentityV1 | undefined,
): boolean {
  const reference = result.kind === 'bound' ? result.resource
    : result.kind === 'pending' ? result.nativeOperationRef
      : undefined;
  return reference === undefined || launch !== undefined
    && reference.contributionRef.pluginId === launch.provider.pluginId
    && reference.contributionRef.localId === launch.provider.localId
    && reference.schemaVersion === launch.schemaVersion;
}

function providerControlResult<TInput, TOutput>(definition: ProtocolComposableSchema<TInput, TOutput>) {
  const schema = z.custom<TOutput>(value => definition.safeParse(value).success);
  const projection = asProtocolZod(definition);
  // Preserve the received provider value when validating the sealed snapshot.
  // Advertise the same provisioner contract through the existing Zod adapter.
  schema._zod.processJSONSchema = (context, _json, params) => {
    z.core.process(projection, context, params);
    context.seen.get(schema)!.ref = projection;
  };
  return schema;
}

/**
 * Provider-private outcomes from a control operation. Home reports only the
 * outcome kind; the exact result remains with the same admitted preset body.
 */
export const ManagedMachinePresetNativeControlResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('power'),
    intent: ManagedPowerIntentV1Schema,
    result: providerControlResult(MachineProvisionerPowerResultV1Schema),
  }),
  z.strictObject({
    kind: z.literal('resize'),
    result: providerControlResult(MachineProvisionerResizeResultV1Schema),
  }),
  z.strictObject({
    kind: z.literal('delete'),
    result: providerControlResult(MachineProvisionerDestroyResultV1Schema),
  }),
  z.strictObject({
    kind: z.literal('rebuild'),
    result: providerControlResult(MachineProvisionerRebuildResultV1Schema),
  }),
]));
export type ManagedMachinePresetNativeControlResultV1 = Readonly<
  z.infer<typeof ManagedMachinePresetNativeControlResultV1Schema>
>;

function nativeControlResultMatchesLaunch(
  controlResult: ManagedMachinePresetNativeControlResultV1,
  launch: ManagedPresetLaunchIdentityV1 | undefined,
): boolean {
  const reference = controlResult.kind === 'rebuild' && controlResult.result.kind === 'bound'
    ? controlResult.result.resource
    : controlResult.kind === 'delete' && controlResult.result.kind === 'accepted'
      ? controlResult.result.nativeOperationRef
      : undefined;
  return reference === undefined || launch !== undefined
    && reference.contributionRef.pluginId === launch.provider.pluginId
    && reference.contributionRef.localId === launch.provider.localId
    && reference.schemaVersion === launch.schemaVersion;
}

/** Private preset and daemon-captured admission values carried only through the mode-tagged envelope. */
export function createManagedMachinePresetContentV1Schema<Choices extends z.core.$ZodType>(choices: Choices) {
  return z.strictObject({
    v: z.literal(1),
    name: id(),
    launch: z.optional(createValidatedLaunchSnapshotV1Schema(choices)),
    setup: z.optional(MachineSetupV1Schema),
    /** Target-captured Retry facts; never a reusable author declaration. */
    setupSourceFacts: z.optional(MachineSetupSourceFactsMapV1Schema),
    controllerDisplayName: z.optional(id()),
    projectFiles: z.optional(SessionProjectFilesV1Schema),
    /** Opts a newly created isolation guest into the Credential broker role. */
    credentialBroker: z.optional(z.boolean()),
    preparation: z.optional(ManagedMachinePresetPreparationV1Schema),
    /** Provider-owned build/artifact identity; never an author or per-acquire override. */
    prepared: z.optional(ManagedMachinePresetPreparedV1Schema),
    /** Selected physical launch and remaining Setup, private to this admitted Machine. */
    preparationExecution: z.optional(createManagedMachinePresetPreparationExecutionV1Schema(choices)),
    /** Private admission identity; an acquire override, not a reusable author declaration. */
    enrollmentIdentity: z.optional(ManagedMachineEnrollmentIdentityV1Schema),
    /** Author-approved source effects, captured before Save approval; independent of per-instance facts. */
    authorEffectReview: z.optional(DevcontainerEffectReviewV1Schema),
    /** Daemon-captured immutable admission review; author writes are rejected by the fresh-seal owner. */
    reviewedFacts: z.optional(createManagedConfigurationFactsV1Schema(choices)),
    /** Provider payload captured by the keyholding daemon; Home sees only structural lifecycle state. */
    nativeResult: z.optional(AcquireResultV1Schema),
    /** Private provider observation, including price/size/native diagnostics. */
    observation: z.optional(ProviderObservationV1Schema),
    /** Provider-private Power/Resize/Delete/Rebuild outcome captured by the keyholding daemon. */
    nativeControlResult: z.optional(ManagedMachinePresetNativeControlResultV1Schema),
    /** One admitted private resize request; author seals cannot populate it. */
    resize: z.optional(MachineProvisionerSizeV1Schema),
  }).check(z.refine(content => content.launch !== undefined || content.setup !== undefined,
    { message: 'A Preset requires launch or setup content.' }))
    .check(z.refine(content => content.authorEffectReview === undefined || content.launch !== undefined,
      { message: 'Author effect review requires the sealed source launch.' }))
    .check(z.refine(content => {
      if (content.preparationExecution === undefined) return true;
      if (content.launch === undefined || content.reviewedFacts === undefined) return false;
      return sameStrictJsonValue(readPresetLaunchSelection(content.launch),
        readPresetLaunchSelection(content.preparationExecution.launch));
    }, { message: 'Prepared execution requires a review and the authored provider and credential selection.' }))
    .check(z.refine(content => content.reviewedFacts === undefined
      || content.launch !== undefined && sameStrictJsonValue(content.preparationExecution?.launch ?? content.launch, content.reviewedFacts.launch),
    { message: 'Reviewed facts must describe the sealed launch snapshot.' }))
    .check(z.refine(content => content.resize === undefined || content.launch !== undefined,
      { message: 'A private resize request requires the sealed launch snapshot.' }))
    .check(z.refine(content => content.nativeResult === undefined || nativeResultMatchesLaunch(content.nativeResult, content.launch),
      { message: 'Native result must belong to the sealed launch provider.' }))
    .check(z.refine(content => content.nativeControlResult === undefined
      || nativeControlResultMatchesLaunch(content.nativeControlResult, content.launch),
    { message: 'Native control result must belong to the sealed launch provider.' }));
}

export const ManagedMachinePresetContentV1Schema = lazyZodSchema(() =>
  createManagedMachinePresetContentV1Schema(PluginJsonValueV2Schema));
export type ManagedMachinePresetContentV1 = Readonly<z.infer<typeof ManagedMachinePresetContentV1Schema>>;

/** Stored content is always explicitly tagged; no mode is inferred from key presence. */
export function createManagedMachinePresetStoredContentV1Schema<Choices extends z.core.$ZodType>(choices: Choices) {
  return z.discriminatedUnion('t', [
    z.strictObject({ t: z.literal('plain'), v: createManagedMachinePresetContentV1Schema(choices) }),
    z.strictObject({ t: z.literal('encrypted'), c: CanonicalCiphertextSchema }),
  ]);
}

export const ManagedMachinePresetStoredContentV1Schema = lazyZodSchema(() =>
  createManagedMachinePresetStoredContentV1Schema(PluginJsonValueV2Schema));
export type ManagedMachinePresetStoredContentV1 = Readonly<z.infer<typeof ManagedMachinePresetStoredContentV1Schema>>;

/** Opaque content storage shared by Preset and Managed Machine server projections. */
export const ManagedMachinePresetEnvelopeV1Schema = lazyZodSchema(() => z.strictObject({
  content: ManagedMachinePresetStoredContentCarrierV1Schema,
  recipients: ManagedMachinePresetRecipientsV1Schema,
  controllerPoolId: z.optional(MachinePoolIdV1Schema),
}));
export type ManagedMachinePresetEnvelopeV1 = Readonly<z.infer<typeof ManagedMachinePresetEnvelopeV1Schema>>;
