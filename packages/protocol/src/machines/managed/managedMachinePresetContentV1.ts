import tweetnacl from 'tweetnacl';

import { decodeBase64, encodeBase64, readCanonicalPaddedBase64DecodedLength } from '../../crypto/base64.js';
import { openEncryptedDataKeyEnvelopeV1 } from '../../crypto/encryptedDataKeyEnvelopeV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import {
  prepareSavedSecretResourceRecipientEnvelopesV1,
  sealSavedSecretResourceRecipientEnvelopeV1,
} from '../../account/settings/savedSecretResourceContentV1.js';
import { formatSharedSavedSecretRefV1, parseSavedSecretRefV1 } from '../../account/settings/savedSecretReferenceV1.js';
import {
  SavedSecretResourceEnvelopeCensusRecipientV1Schema,
  SavedSecretResourceRecipientEnvelopeV1Schema,
  type SavedSecretResourceEnvelopeCensusRecipientV1,
} from '../../account/settings/savedSecretCatalogV1.js';
import { createValidatedLaunchSnapshotV1Schema } from './managedMachineV1.js';
import {
  createManagedConfigurationFactsV1Schema,
  ManagedConfigurationFactsV1Schema,
  type ManagedConfigurationFactsV1,
} from './managedConfigurationV1.js';
import { AcquireResultV1Schema, ProviderObservationV1Schema, MachineProvisionerSizeV1Schema,
  type AcquireResultV1, type MachineProvisionerSizeV1, type ProviderObservationV1 } from './providerFactsV1.js';
import { ManagedMachineEnrollmentIdentityV1Schema, type ManagedMachineEnrollmentIdentityV1 } from './enrollmentIdentityV1.js';
import { MachineSetupV1Schema, type MachineSetupV1 } from './machineSetupV1.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { MachineProvisionerDestroyResultV1Schema, MachineProvisionerPowerResultV1Schema,
  MachineProvisionerRebuildResultV1Schema, MachineProvisionerResizeResultV1Schema } from '../../plugins/contributions/machineProvisioners.js';
import { MachinePoolIdV1Schema } from '../pools/v1.js';
import { z } from '../../zodRuntimePolicy.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const PresetIdSchema = id();

type ManagedPresetLaunchIdentityV1 = Readonly<{
  provider: Readonly<{ pluginId: string; localId: string }>;
  schemaVersion: number;
}>;

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

/**
 * Provider-private outcomes from a control operation. Home reports only the
 * outcome kind; the exact result remains with the same admitted preset body.
 */
export const ManagedMachinePresetNativeControlResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('power'),
    intent: z.enum(['start', 'stop', 'suspend', 'resume']),
    result: z.custom<ReturnType<typeof MachineProvisionerPowerResultV1Schema.parse>>(
      value => MachineProvisionerPowerResultV1Schema.safeParse(value).success,
    ),
  }),
  z.strictObject({
    kind: z.literal('resize'),
    result: z.custom<ReturnType<typeof MachineProvisionerResizeResultV1Schema.parse>>(
      value => MachineProvisionerResizeResultV1Schema.safeParse(value).success,
    ),
  }),
  z.strictObject({
    kind: z.literal('delete'),
    result: z.custom<ReturnType<typeof MachineProvisionerDestroyResultV1Schema.parse>>(
      value => MachineProvisionerDestroyResultV1Schema.safeParse(value).success,
    ),
  }),
  z.strictObject({
    kind: z.literal('rebuild'),
    result: z.custom<ReturnType<typeof MachineProvisionerRebuildResultV1Schema.parse>>(
      value => MachineProvisionerRebuildResultV1Schema.safeParse(value).success,
    ),
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
    controllerDisplayName: z.optional(id()),
    /** Private admission identity; an acquire override, not a reusable author declaration. */
    enrollmentIdentity: z.optional(ManagedMachineEnrollmentIdentityV1Schema),
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
    .check(z.refine(content => content.reviewedFacts === undefined
      || content.launch !== undefined && sameStrictJsonValue(content.launch, content.reviewedFacts.launch),
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

/**
 * One promoted personal Saved Secret reference and its exact newly-created
 * shared-resource revision. The promotion owner supplies these mappings;
 * this content owner only rewrites canonical Machine Setup bindings.
 */
export const ManagedMachinePresetSavedSecretReferenceRewriteV1Schema = lazyZodSchema(() => z.strictObject({
  personalSecretId: z.string().check(z.minLength(1)),
  resourceId: z.string().check(z.minLength(1)),
  resourceRevision: z.number().check(z.int(), z.positive()),
}));
export type ManagedMachinePresetSavedSecretReferenceRewriteV1 = Readonly<
  z.infer<typeof ManagedMachinePresetSavedSecretReferenceRewriteV1Schema>
>;

type PreparedManagedMachinePresetSavedSecretReferenceRewriteV1 = Readonly<{
  ref: string;
  revision: number;
}>;

function prepareManagedMachinePresetSavedSecretReferenceRewritesV1(
  rewrites: readonly ManagedMachinePresetSavedSecretReferenceRewriteV1[],
): ReadonlyMap<string, PreparedManagedMachinePresetSavedSecretReferenceRewriteV1> | null {
  const parsed = z.array(ManagedMachinePresetSavedSecretReferenceRewriteV1Schema).safeParse(rewrites);
  if (!parsed.success) return null;
  const sources = new Set<string>();
  const destinations = new Set<string>();
  const prepared = new Map<string, PreparedManagedMachinePresetSavedSecretReferenceRewriteV1>();
  for (const rewrite of parsed.data) {
    let personalSecretId: string;
    let ref: string;
    try {
      const source = parseSavedSecretRefV1(rewrite.personalSecretId);
      if (source.kind !== 'personal') return null;
      personalSecretId = source.personalId;
      ref = formatSharedSavedSecretRefV1(rewrite.resourceId);
    } catch {
      return null;
    }
    if (sources.has(personalSecretId) || destinations.has(rewrite.resourceId)) return null;
    sources.add(personalSecretId);
    destinations.add(rewrite.resourceId);
    prepared.set(personalSecretId, { ref, revision: rewrite.resourceRevision });
  }
  return prepared;
}

/**
 * Rewrites only canonical Machine Setup Saved Secret bindings. It deliberately
 * preserves the rest of the sealed preset body, including daemon-captured
 * admission, provider, and control fields.
 */
export function rewriteManagedMachinePresetSavedSecretReferencesV1(params: Readonly<{
  content: unknown;
  rewrites: readonly ManagedMachinePresetSavedSecretReferenceRewriteV1[];
}>): ManagedMachinePresetContentV1 | null {
  const content = ManagedMachinePresetContentV1Schema.safeParse(params.content);
  const rewrites = prepareManagedMachinePresetSavedSecretReferenceRewritesV1(params.rewrites);
  if (!content.success || rewrites === null) return null;
  const setup = content.data.setup;
  const secretRefs = setup?.secretRefs;
  if (!setup || !secretRefs) return content.data;

  const bindings = { ...secretRefs.bindings };
  let changed = false;
  for (const [name, binding] of Object.entries(secretRefs.bindings)) {
    let source;
    try {
      source = parseSavedSecretRefV1(binding.ref);
    } catch {
      return null;
    }
    if (source.kind !== 'personal') continue;
    const rewrite = rewrites.get(source.personalId);
    if (!rewrite) continue;
    bindings[name] = { ref: rewrite.ref, revision: rewrite.revision };
    changed = true;
  }
  if (!changed) return content.data;
  const next = ManagedMachinePresetContentV1Schema.safeParse({
    ...content.data,
    setup: { ...setup, secretRefs: { ...secretRefs, bindings } },
  });
  return next.success ? next.data : null;
}

function isCanonicalCiphertext(value: string): boolean {
  try {
    const decodedLength = readCanonicalPaddedBase64DecodedLength(value);
    if (decodedLength === null || decodedLength < tweetnacl.secretbox.nonceLength + tweetnacl.secretbox.overheadLength) return false;
    return encodeBase64(decodeBase64(value, 'base64'), 'base64') === value;
  } catch {
    return false;
  }
}

const CanonicalCiphertextSchema = lazyZodSchema(() => z.string().check(
  z.minLength(1),
  z.refine(isCanonicalCiphertext, { message: 'Expected canonical padded Base64 ciphertext' }),
));

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

/**
 * Public/server carrier for private preset content. It checks only the explicit
 * tag and encrypted transport shape; sealing and opening own private-body validation.
 */
const OpaquePrivatePresetContentV1Schema = lazyZodSchema(() => z.unknown().check(
  z.refine(value => value !== undefined, { message: 'Expected private preset content' }),
));
export const ManagedMachinePresetStoredContentCarrierV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: OpaquePrivatePresetContentV1Schema }),
  z.strictObject({ t: z.literal('encrypted'), c: CanonicalCiphertextSchema }),
]));
export type ManagedMachinePresetStoredContentCarrierV1 = Readonly<
  z.infer<typeof ManagedMachinePresetStoredContentCarrierV1Schema>
>;

/** Persisted recipient envelopes are Account-scoped; Machine recipients are not a valid shape. */
export const ManagedMachinePresetRecipientV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: id(),
  envelope: SavedSecretResourceRecipientEnvelopeV1Schema,
}));
export type ManagedMachinePresetRecipientV1 = Readonly<z.infer<typeof ManagedMachinePresetRecipientV1Schema>>;

export const ManagedMachinePresetRecipientsV1Schema = lazyZodSchema(() => z.array(
  ManagedMachinePresetRecipientV1Schema,
).check(z.refine((items) => new Set(items.map(item => item.accountId)).size === items.length,
  { message: 'Duplicate accountId' })));
export type ManagedMachinePresetRecipientsV1 = ReadonlyArray<ManagedMachinePresetRecipientV1>;

/** Opaque content storage shared by Preset and Managed Machine server projections. */
export const ManagedMachinePresetEnvelopeV1Schema = lazyZodSchema(() => z.strictObject({
  content: ManagedMachinePresetStoredContentCarrierV1Schema,
  recipients: ManagedMachinePresetRecipientsV1Schema,
  controllerPoolId: z.optional(MachinePoolIdV1Schema),
}));
export type ManagedMachinePresetEnvelopeV1 = Readonly<z.infer<typeof ManagedMachinePresetEnvelopeV1Schema>>;

/** GET/LIST presentation projection: disclose at most the requesting Account's envelope. */
export const ManagedMachinePresetRecipientProjectionV1Schema = lazyZodSchema(() => z.strictObject({
  content: ManagedMachinePresetStoredContentCarrierV1Schema,
  recipientEnvelope: z.nullable(SavedSecretResourceRecipientEnvelopeV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.content.t === 'plain' && value.recipientEnvelope !== null) {
    context.addIssue({ code: 'custom', message: 'Plain managed preset content cannot carry a reader envelope' });
  }
})));
export type ManagedMachinePresetRecipientProjectionV1 = Readonly<
  z.infer<typeof ManagedMachinePresetRecipientProjectionV1Schema>
>;

/**
 * Optional acquire-time private replacement. Its allowed semantic delta is
 * decided only by the narrow creator/resolver pair; the server stores no raw
 * name or setup separately from this existing mode-tagged carrier.
 */
export const ManagedMachinePresetLaunchNameOverrideV1Schema = lazyZodSchema(() => z.strictObject({
  content: ManagedMachinePresetStoredContentCarrierV1Schema,
}));
export type ManagedMachinePresetLaunchNameOverrideV1 = Readonly<
  z.infer<typeof ManagedMachinePresetLaunchNameOverrideV1Schema>
>;

function hasStoredContentTagForMode(
  content: ManagedMachinePresetStoredContentCarrierV1,
  mode: 'plain' | 'e2ee',
): boolean {
  return mode === 'plain' ? content.t === 'plain' : content.t === 'encrypted';
}

/** Reject an override whose tagged carrier conflicts with the persisted author mode. */
export function readManagedMachinePresetContentOverrideForModeV1(params: Readonly<{
  mode: 'plain' | 'e2ee';
  override: unknown;
}>): ManagedMachinePresetLaunchNameOverrideV1 | null {
  const override = ManagedMachinePresetLaunchNameOverrideV1Schema.safeParse(params.override);
  return override.success && hasStoredContentTagForMode(override.data.content, params.mode) ? override.data : null;
}

/** @deprecated Use readManagedMachinePresetContentOverrideForModeV1 for a mode-bound private override. */
export function readManagedMachinePresetLaunchNameOverrideForModeV1(params: Readonly<{
  mode: 'plain' | 'e2ee';
  override: unknown;
}>): ManagedMachinePresetLaunchNameOverrideV1 | null {
  return readManagedMachinePresetContentOverrideForModeV1(params);
}

export type ManagedMachinePresetContentSealParamsV1 =
  | Readonly<{ presetId: string; mode: 'plain'; content: ManagedMachinePresetContentV1 }>
  | Readonly<{
      presetId: string;
      mode: 'e2ee';
      content: ManagedMachinePresetContentV1;
      /** Server-owned verified owner/member/custodian census; never UI-selected keys. */
      recipientCensus: readonly SavedSecretResourceEnvelopeCensusRecipientV1[];
      randomBytes: (length: number) => Uint8Array;
    }>;

export type ManagedMachinePresetContentSealV1 = Readonly<{
  content: ManagedMachinePresetStoredContentV1;
  recipients: readonly ManagedMachinePresetRecipientV1[];
}>;

const EncryptedPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  presetId: PresetIdSchema,
  mode: z.literal('e2ee'),
  content: ManagedMachinePresetContentV1Schema,
}));

function parsePresetId(value: string): string {
  const parsed = PresetIdSchema.safeParse(value);
  if (!parsed.success) throw new Error('managed_preset_invalid_id');
  return parsed.data;
}

function parseCompletePresetRecipientCensus(
  recipientCensus: readonly SavedSecretResourceEnvelopeCensusRecipientV1[],
  allowPrepared: boolean,
): SavedSecretResourceEnvelopeCensusRecipientV1[] {
  const recipients = z.array(SavedSecretResourceEnvelopeCensusRecipientV1Schema).safeParse(recipientCensus);
  if (!recipients.success || recipients.data.length === 0) {
    throw new Error('managed_preset_recipient_census_incomplete');
  }
  if (new Set(recipients.data.map(recipient => recipient.account.accountId)).size !== recipients.data.length) {
    throw new Error('managed_preset_duplicate_recipient');
  }
  if (recipients.data.some(recipient => recipient.readiness.status !== 'available'
    || (!allowPrepared && recipient.envelopeStatus === 'prepared'))) {
    throw new Error('managed_preset_recipient_census_incomplete');
  }
  return recipients.data;
}

/** A fresh preset ciphertext has a fresh DEK, so every canonical recipient needs a fresh envelope. */
function preparePresetRecipientEnvelopes(
  dataKey: Uint8Array,
  recipientCensus: readonly SavedSecretResourceEnvelopeCensusRecipientV1[],
  randomBytes: (length: number) => Uint8Array,
): ManagedMachinePresetRecipientsV1 {
  const recipients = parseCompletePresetRecipientCensus(recipientCensus, false);

  const prepared = prepareSavedSecretResourceRecipientEnvelopesV1({
    recipients,
    resourceDataKey: dataKey,
    randomBytes,
  });
  if (prepared.length !== recipients.length) {
    throw new Error('managed_preset_recipient_census_incomplete');
  }
  return ManagedMachinePresetRecipientsV1Schema.parse(prepared.map(recipient => ({
    accountId: recipient.recipientAccountId,
    envelope: {
      encryptedDataKey: recipient.encryptedDataKey,
      recipientContentPublicKeyFingerprint: recipient.recipientContentPublicKeyFingerprint,
    },
  })));
}

/** Encrypt a canonical private payload under a caller-selected existing or fresh DEK. */
function sealEncryptedPresetContent(
  presetId: string,
  content: ManagedMachinePresetContentV1,
  dataKey: Uint8Array,
  randomBytes: (length: number) => Uint8Array,
): ManagedMachinePresetStoredContentV1 {
  if (dataKey.length !== tweetnacl.secretbox.keyLength) throw new Error('managed_preset_data_key_unavailable');
  const nonce = new Uint8Array(randomBytes(tweetnacl.secretbox.nonceLength));
  if (nonce.length !== tweetnacl.secretbox.nonceLength) throw new Error('managed_preset_nonce_unavailable');
  const plaintext = new TextEncoder().encode(JSON.stringify({ v: 1, presetId, mode: 'e2ee', content }));
  const boxed = tweetnacl.secretbox(plaintext, nonce, dataKey);
  const combined = new Uint8Array(nonce.length + boxed.length);
  combined.set(nonce);
  combined.set(boxed, nonce.length);
  return ManagedMachinePresetStoredContentV1Schema.parse({ t: 'encrypted', c: encodeBase64(combined) });
}

/** Authenticate an encrypted private payload with a DEK already admitted to this owner. */
function openEncryptedPresetContentWithDataKey(
  params: Readonly<{
    presetId: string;
    content: Readonly<{ t: 'encrypted'; c: string }>;
    dataKey: Uint8Array;
  }>,
  readStoredPayload: boolean,
): ManagedMachinePresetContentV1 | null {
  try {
    if (!(params.dataKey instanceof Uint8Array) || params.dataKey.length !== tweetnacl.secretbox.keyLength) return null;
    const combined = decodeBase64(params.content.c);
    if (combined.length < tweetnacl.secretbox.nonceLength + tweetnacl.secretbox.overheadLength) return null;
    const opened = tweetnacl.secretbox.open(
      combined.subarray(tweetnacl.secretbox.nonceLength),
      combined.subarray(0, tweetnacl.secretbox.nonceLength),
      params.dataKey,
    );
    if (!opened) return null;
    const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(opened));
    const payload = (readStoredPayload ? createStoredReadSchema(EncryptedPayloadV1Schema) : EncryptedPayloadV1Schema)
      .safeParse(decoded);
    return !payload.success || payload.data.presetId !== params.presetId || payload.data.mode !== 'e2ee'
      ? null
      : payload.data.content;
  } catch {
    return null;
  }
}

/** Authenticate one existing private payload and expose its DEK only inside this owner. */
function openEncryptedPresetContent(
  params: Readonly<{
    presetId: string;
    content: Readonly<{ t: 'encrypted'; c: string }>;
    recipients: readonly unknown[];
    accountId: string;
    accountKey: Uint8Array;
  }>,
  readStoredPayload: boolean,
): Readonly<{ dataKey: Uint8Array; content: ManagedMachinePresetContentV1 }> | null {
  if (!(params.accountKey instanceof Uint8Array)) return null;
  const envelopes = ManagedMachinePresetRecipientsV1Schema.safeParse(params.recipients);
  if (!envelopes.success) return null;
  const accountId = id().safeParse(params.accountId);
  if (!accountId.success) return null;
  const envelope = envelopes.data.find(item => item.accountId === accountId.data);
  if (!envelope) return null;
  const dataKey = openEncryptedDataKeyEnvelopeV1({
    envelope: decodeBase64(envelope.envelope.encryptedDataKey),
    recipientSecretKeyOrSeed: params.accountKey,
  });
  if (!dataKey || dataKey.length !== tweetnacl.secretbox.keyLength) return null;
  const content = openEncryptedPresetContentWithDataKey({
    presetId: params.presetId,
    content: params.content,
    dataKey,
  }, readStoredPayload);
  return content === null ? null : { dataKey, content };
}

function replacePresetLaunchName(
  content: ManagedMachinePresetContentV1,
  launchName: string,
  reviewedFacts: ManagedConfigurationFactsV1 | undefined,
  nativeResult: AcquireResultV1 | undefined,
  observation: ProviderObservationV1 | undefined,
  nativeControlResult: ManagedMachinePresetNativeControlResultV1 | undefined,
): ManagedMachinePresetContentV1 | null {
  if (!content.launch) return null;
  if (content.reviewedFacts !== undefined && reviewedFacts !== undefined
    && !sameStrictJsonValue(content.reviewedFacts, reviewedFacts)) return null;
  // A reviewed snapshot is immutable. A daemon may retry it unchanged, but cannot
  // rewrite its selected launch without submitting the matching canonical review.
  if (content.reviewedFacts !== undefined && reviewedFacts === undefined && content.launch.name !== launchName) return null;
  const launch = { ...content.launch, name: launchName };
  const nextReviewedFacts = reviewedFacts ?? content.reviewedFacts;
  const nextNativeResult = nativeResult ?? content.nativeResult;
  const nextObservation = observation ?? content.observation;
  const nextNativeControlResult = nativeControlResult ?? content.nativeControlResult;
  if (nextReviewedFacts !== undefined && !sameStrictJsonValue(nextReviewedFacts.launch, launch)) return null;
  return ManagedMachinePresetContentV1Schema.parse({
    ...content,
    launch,
    ...(nextReviewedFacts === undefined ? {} : { reviewedFacts: nextReviewedFacts }),
    ...(nextNativeResult === undefined ? {} : { nativeResult: nextNativeResult }),
    ...(nextObservation === undefined ? {} : { observation: nextObservation }),
    ...(nextNativeControlResult === undefined ? {} : { nativeControlResult: nextNativeControlResult }),
  });
}

/** A setup override may change setup only; launch, review, and every other private field remain authenticated. */
function replacePresetSetup(
  content: ManagedMachinePresetContentV1,
  setup: MachineSetupV1,
): ManagedMachinePresetContentV1 | null {
  const next = ManagedMachinePresetContentV1Schema.safeParse({ ...content, setup });
  return next.success ? next.data : null;
}

/** An acquire-time identity is private input; no other admitted detail may drift with it. */
function replacePresetEnrollmentIdentity(
  content: ManagedMachinePresetContentV1,
  enrollmentIdentity: ManagedMachineEnrollmentIdentityV1,
): ManagedMachinePresetContentV1 | null {
  const next = ManagedMachinePresetContentV1Schema.safeParse({ ...content, enrollmentIdentity });
  return next.success ? next.data : null;
}

/** A control-time resize is private action input, never a reusable preset declaration. */
function replacePresetResize(
  content: ManagedMachinePresetContentV1,
  size: MachineProvisionerSizeV1,
): ManagedMachinePresetContentV1 | null {
  if (!content.launch) return null;
  const next = ManagedMachinePresetContentV1Schema.safeParse({ ...content, resize: size });
  return next.success ? next.data : null;
}

type ManagedMachinePresetExistingContentReplacementV1 =
  | Readonly<{
      presetId: string;
      mode: 'plain';
      content: unknown;
      replace: (content: ManagedMachinePresetContentV1) => ManagedMachinePresetContentV1 | null;
    }>
  | Readonly<{
      presetId: string;
      mode: 'e2ee';
      content: unknown;
      recipients: readonly unknown[];
      accountId: string;
      accountKey: Uint8Array;
      randomBytes: (length: number) => Uint8Array;
      replace: (content: ManagedMachinePresetContentV1) => ManagedMachinePresetContentV1 | null;
    }>;

/** One internal same-DEK mutation path shared by the bounded private override operations below. */
function replaceManagedMachinePresetExistingContentV1(
  params: ManagedMachinePresetExistingContentReplacementV1,
): ManagedMachinePresetStoredContentV1 | null {
  const presetId = parsePresetId(params.presetId);
  // Use the write schema rather than a stored-reader projection: a private
  // mutation must fail closed for legacy/non-canonical content.
  const stored = ManagedMachinePresetStoredContentV1Schema.safeParse(params.content);
  if (!stored.success) return null;
  if (params.mode === 'plain') {
    if (stored.data.t !== 'plain') return null;
    const content = params.replace(stored.data.v);
    return content === null ? null : sameStrictJsonValue(content, stored.data.v) ? stored.data : { t: 'plain', v: content };
  }

  if (stored.data.t !== 'encrypted') return null;
  const opened = openEncryptedPresetContent({
    presetId,
    content: stored.data,
    recipients: params.recipients,
    accountId: params.accountId,
    accountKey: params.accountKey,
  }, false);
  if (!opened) return null;
  const content = params.replace(opened.content);
  return content === null ? null : sameStrictJsonValue(content, opened.content)
    ? stored.data
    : sealEncryptedPresetContent(presetId, content, opened.dataKey, params.randomBytes);
}

export type ManagedMachinePresetSavedSecretReferenceRewriteCreateParamsV1 =
  | Readonly<{
      presetId: string;
      mode: 'plain';
      projection: unknown;
      rewrites: readonly ManagedMachinePresetSavedSecretReferenceRewriteV1[];
    }>
  | Readonly<{
      presetId: string;
      mode: 'e2ee';
      projection: unknown;
      accountId: string;
      accountKey: Uint8Array;
      rewrites: readonly ManagedMachinePresetSavedSecretReferenceRewriteV1[];
      randomBytes: (length: number) => Uint8Array;
    }>;

/**
 * Re-encrypt a retained snapshot after Saved Secret promotion using its exact
 * recipient projection, authenticated existing DEK, and existing `{content}`
 * carrier. Fresh source-preset writes use the pure rewriter and the normal
 * fresh-DEK sealing owner instead.
 */
export function createManagedMachinePresetSavedSecretReferenceRewriteV1(
  params: ManagedMachinePresetSavedSecretReferenceRewriteCreateParamsV1,
): ManagedMachinePresetLaunchNameOverrideV1 | null {
  try {
    const projection = ManagedMachinePresetRecipientProjectionV1Schema.safeParse(params.projection);
    if (!projection.success || !hasStoredContentTagForMode(projection.data.content, params.mode)) return null;
    const replace = (content: ManagedMachinePresetContentV1) => rewriteManagedMachinePresetSavedSecretReferencesV1({
      content,
      rewrites: params.rewrites,
    });
    if (params.mode === 'plain') {
      const content = replaceManagedMachinePresetExistingContentV1({
        presetId: params.presetId,
        mode: 'plain',
        content: projection.data.content,
        replace,
      });
      return content === null ? null : ManagedMachinePresetLaunchNameOverrideV1Schema.parse({ content });
    }
    if (projection.data.content.t !== 'encrypted' || projection.data.recipientEnvelope === null) return null;
    const content = replaceManagedMachinePresetExistingContentV1({
      presetId: params.presetId,
      mode: 'e2ee',
      content: projection.data.content,
      recipients: [{ accountId: params.accountId, envelope: projection.data.recipientEnvelope }],
      accountId: params.accountId,
      accountKey: params.accountKey,
      randomBytes: params.randomBytes,
      replace,
    });
    return content === null ? null : ManagedMachinePresetLaunchNameOverrideV1Schema.parse({ content });
  } catch {
    return null;
  }
}

/** Remove the recipient audience from a server response without reinterpreting private content. */
export function projectManagedMachinePresetForRecipientV1(params: Readonly<{
  content: unknown;
  recipients: readonly unknown[];
  recipientAccountId: string;
}>): ManagedMachinePresetRecipientProjectionV1 {
  const content = ManagedMachinePresetStoredContentCarrierV1Schema.parse(params.content);
  const recipients = ManagedMachinePresetRecipientsV1Schema.parse(params.recipients);
  const recipientAccountId = id().parse(params.recipientAccountId);
  return ManagedMachinePresetRecipientProjectionV1Schema.parse({
    content,
    recipientEnvelope: content.t === 'encrypted'
      ? recipients.find(recipient => recipient.accountId === recipientAccountId)?.envelope ?? null
      : null,
  });
}

export type ManagedMachinePresetRecipientRewrapParamsV1 = Readonly<{
  recipients: readonly unknown[];
  accountId: string;
  accountKey: Uint8Array;
  /** The server-owned current census decides who remains, joins, or needs rewrapping. */
  recipientCensus: readonly SavedSecretResourceEnvelopeCensusRecipientV1[];
  randomBytes: (length: number) => Uint8Array;
}>;

/**
 * Re-envelop the existing DEK for the current Account census without reading or changing private content.
 * A removed Account cannot initiate it: the server census must still include the keyholder.
 */
export function rewrapManagedMachinePresetRecipientsV1(
  params: ManagedMachinePresetRecipientRewrapParamsV1,
): ManagedMachinePresetRecipientsV1 | null {
  try {
    if (!(params.accountKey instanceof Uint8Array)) return null;
    const accountId = id().safeParse(params.accountId);
    const existing = ManagedMachinePresetRecipientsV1Schema.safeParse(params.recipients);
    if (!accountId.success || !existing.success) return null;
    const recipientCensus = parseCompletePresetRecipientCensus(params.recipientCensus, true);
    if (!recipientCensus.some(recipient => recipient.account.accountId === accountId.data)) return null;

    const currentEnvelope = existing.data.find(recipient => recipient.accountId === accountId.data);
    if (!currentEnvelope) return null;
    const dataKey = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(currentEnvelope.envelope.encryptedDataKey),
      recipientSecretKeyOrSeed: params.accountKey,
    });
    if (!dataKey || dataKey.length !== tweetnacl.secretbox.keyLength) return null;

    const prepared = prepareSavedSecretResourceRecipientEnvelopesV1({
      recipients: recipientCensus,
      resourceDataKey: dataKey,
      randomBytes: params.randomBytes,
    });
    const preparedByAccountId = new Map(prepared.map(recipient => [recipient.recipientAccountId, recipient]));
    const existingByAccountId = new Map(existing.data.map(recipient => [recipient.accountId, recipient]));
    return ManagedMachinePresetRecipientsV1Schema.parse(recipientCensus.map(recipient => {
      const accountId = recipient.account.accountId;
      if (recipient.envelopeStatus === 'prepared') {
        const existingRecipient = existingByAccountId.get(accountId);
        if (!existingRecipient) throw new Error('managed_preset_recipient_census_incomplete');
        return existingRecipient;
      }
      const preparedRecipient = preparedByAccountId.get(accountId);
      if (!preparedRecipient) throw new Error('managed_preset_recipient_census_incomplete');
      return {
        accountId,
        envelope: {
          encryptedDataKey: preparedRecipient.encryptedDataKey,
          recipientContentPublicKeyFingerprint: preparedRecipient.recipientContentPublicKeyFingerprint,
        },
      };
    }));
  } catch {
    return null;
  }
}

/** Seal through the captured Account mode; Plain is intentionally keyless. */
export function sealManagedMachinePresetContentV1(
  params: ManagedMachinePresetContentSealParamsV1,
): ManagedMachinePresetContentSealV1 {
  const presetId = parsePresetId(params.presetId);
  const content = ManagedMachinePresetContentV1Schema.parse(params.content);
  if (content.nativeResult !== undefined) throw new Error('managed_preset_author_native_result_forbidden');
  if (content.observation !== undefined) throw new Error('managed_preset_author_observation_forbidden');
  if (content.nativeControlResult !== undefined) throw new Error('managed_preset_author_native_control_result_forbidden');
  if (content.resize !== undefined) throw new Error('managed_preset_author_resize_forbidden');
  if (content.enrollmentIdentity !== undefined) throw new Error('managed_preset_author_enrollment_identity_forbidden');
  if (content.reviewedFacts !== undefined) throw new Error('managed_preset_author_reviewed_facts_forbidden');
  if (params.mode === 'plain') {
    return { content: { t: 'plain', v: content }, recipients: [] };
  }

  const dataKey = new Uint8Array(params.randomBytes(tweetnacl.secretbox.keyLength));
  if (dataKey.length !== tweetnacl.secretbox.keyLength) throw new Error('managed_preset_data_key_unavailable');

  return {
    content: sealEncryptedPresetContent(presetId, content, dataKey, params.randomBytes),
    recipients: preparePresetRecipientEnvelopes(dataKey, params.recipientCensus, params.randomBytes),
  };
}

/**
 * Account-mode migration reuses the authenticated full preset body, including
 * daemon-captured snapshot fields that fresh author sealing intentionally rejects.
 * It accepts only a source projection and a directly opened source DEK; recipient
 * wrapping remains delegated to the Saved Secret envelope owner.
 */
export type ManagedMachinePresetContentEncryptionModeTransitionParamsV1 =
  | Readonly<{ presetId: string; fromMode: 'plain'; toMode: 'plain'; source: unknown }>
  | Readonly<{
      presetId: string;
      fromMode: 'plain';
      toMode: 'e2ee';
      source: unknown;
      accountId: string;
      targetContentPublicKey: Uint8Array;
      randomBytes: (length: number) => Uint8Array;
    }>
  | Readonly<{
      presetId: string;
      fromMode: 'e2ee';
      toMode: 'plain';
      source: unknown;
      sourceDataKey: Uint8Array;
    }>;

/**
 * Convert one personal preset/snapshot between Account modes. The caller opens
 * its own source recipient envelope before entering this owner; the target is
 * always a fresh DEK and one target owner envelope.
 */
export function transitionManagedMachinePresetContentEncryptionModeV1(
  params: ManagedMachinePresetContentEncryptionModeTransitionParamsV1,
): ManagedMachinePresetContentSealV1 | null {
  try {
    const presetId = parsePresetId(params.presetId);
    const projection = ManagedMachinePresetRecipientProjectionV1Schema.safeParse(params.source);
    if (!projection.success) return null;
    const stored = createStoredReadSchema(ManagedMachinePresetStoredContentV1Schema).safeParse(projection.data.content);
    if (!stored.success) return null;

    const content = params.fromMode === 'plain'
      ? stored.data.t === 'plain' && projection.data.recipientEnvelope === null ? stored.data.v : null
      : stored.data.t === 'encrypted' && projection.data.recipientEnvelope !== null
        ? openEncryptedPresetContentWithDataKey({
            presetId,
            content: stored.data,
            dataKey: params.sourceDataKey,
          }, true)
        : null;
    if (content === null) return null;

    if (params.toMode === 'plain') {
      return { content: { t: 'plain', v: content }, recipients: [] };
    }

    const accountId = id().safeParse(params.accountId);
    if (!accountId.success || !(params.targetContentPublicKey instanceof Uint8Array)) return null;
    const dataKey = new Uint8Array(params.randomBytes(tweetnacl.secretbox.keyLength));
    if (dataKey.length !== tweetnacl.secretbox.keyLength) return null;
    try {
      const envelope = sealSavedSecretResourceRecipientEnvelopeV1({
        resourceDataKey: dataKey,
        recipientContentPublicKey: params.targetContentPublicKey,
        randomBytes: params.randomBytes,
      });
      return {
        content: sealEncryptedPresetContent(presetId, content, dataKey, params.randomBytes),
        recipients: ManagedMachinePresetRecipientsV1Schema.parse([{ accountId: accountId.data, envelope }]),
      };
    } finally {
      dataKey.fill(0);
    }
  } catch {
    return null;
  }
}

/** Daemon-only admitted snapshot overlay; it changes launch name plus captured review/native facts only. */
export type ManagedMachinePresetLaunchNameReplacementParamsV1 =
  | Readonly<{
      presetId: string;
      mode: 'plain';
      content: unknown;
      launchName: string;
      /** Daemon-captured immutable review, never accepted by a fresh author seal. */
      reviewedFacts?: ManagedConfigurationFactsV1;
      /** Provider-private result captured with the admitted snapshot, never accepted by a fresh author seal. */
      nativeResult?: AcquireResultV1;
      /** Private provider observation captured with the admitted snapshot, never accepted by a fresh author seal. */
      observation?: ProviderObservationV1;
      /** Private provider control outcome captured with the admitted snapshot, never accepted by a fresh author seal. */
      nativeControlResult?: ManagedMachinePresetNativeControlResultV1;
    }>
  | Readonly<{
      presetId: string;
      mode: 'e2ee';
      content: unknown;
      recipients: readonly unknown[];
      accountId: string;
      accountKey: Uint8Array;
      launchName: string;
      /** Daemon-captured immutable review, never accepted by a fresh author seal. */
      reviewedFacts?: ManagedConfigurationFactsV1;
      /** Provider-private result captured with the admitted snapshot, never accepted by a fresh author seal. */
      nativeResult?: AcquireResultV1;
      /** Private provider observation captured with the admitted snapshot, never accepted by a fresh author seal. */
      observation?: ProviderObservationV1;
      /** Private provider control outcome captured with the admitted snapshot, never accepted by a fresh author seal. */
      nativeControlResult?: ManagedMachinePresetNativeControlResultV1;
      randomBytes: (length: number) => Uint8Array;
    }>;

/**
 * Change the private launch name and daemon-captured admitted snapshot fields
 * while retaining the authenticated DEK and recipient rows. A retry with an
 * identical snapshot returns the current carrier unchanged.
 */
export function replaceManagedMachinePresetLaunchNameV1(
  params: ManagedMachinePresetLaunchNameReplacementParamsV1,
): ManagedMachinePresetStoredContentV1 | null {
  try {
    const launchName = id().safeParse(params.launchName);
    if (!launchName.success) return null;
    const reviewedFacts = params.reviewedFacts === undefined ? undefined
      : ManagedConfigurationFactsV1Schema.safeParse(params.reviewedFacts);
    if (reviewedFacts !== undefined && !reviewedFacts.success) return null;
    const nativeResult = params.nativeResult === undefined ? undefined : AcquireResultV1Schema.safeParse(params.nativeResult);
    if (nativeResult !== undefined && !nativeResult.success) return null;
    const observation = params.observation === undefined ? undefined : ProviderObservationV1Schema.safeParse(params.observation);
    if (observation !== undefined && !observation.success) return null;
    const nativeControlResult = params.nativeControlResult === undefined ? undefined
      : ManagedMachinePresetNativeControlResultV1Schema.safeParse(params.nativeControlResult);
    if (nativeControlResult !== undefined && !nativeControlResult.success) return null;
    if (params.mode === 'plain') {
      return replaceManagedMachinePresetExistingContentV1({
        presetId: params.presetId,
        mode: 'plain',
        content: params.content,
        replace: content => replacePresetLaunchName(content, launchName.data,
          reviewedFacts === undefined ? undefined : reviewedFacts.data,
          nativeResult === undefined ? undefined : nativeResult.data,
          observation === undefined ? undefined : observation.data,
          nativeControlResult === undefined ? undefined : nativeControlResult.data),
      });
    }
    return replaceManagedMachinePresetExistingContentV1({
      presetId: params.presetId,
      mode: 'e2ee',
      content: params.content,
      recipients: params.recipients,
      accountId: params.accountId,
      accountKey: params.accountKey,
      randomBytes: params.randomBytes,
      replace: content => replacePresetLaunchName(content, launchName.data,
        reviewedFacts === undefined ? undefined : reviewedFacts.data,
        nativeResult === undefined ? undefined : nativeResult.data,
        observation === undefined ? undefined : observation.data,
        nativeControlResult === undefined ? undefined : nativeControlResult.data),
    });
  } catch {
    return null;
  }
}

/** Daemon-only private setup overlay; it cannot replace launch, review, or any other private field. */
export type ManagedMachinePresetSetupReplacementParamsV1 =
  | Readonly<{
      presetId: string;
      mode: 'plain';
      content: unknown;
      setup: MachineSetupV1;
    }>
  | Readonly<{
      presetId: string;
      mode: 'e2ee';
      content: unknown;
      recipients: readonly unknown[];
      accountId: string;
      accountKey: Uint8Array;
      setup: MachineSetupV1;
      randomBytes: (length: number) => Uint8Array;
    }>;

export function replaceManagedMachinePresetSetupV1(
  params: ManagedMachinePresetSetupReplacementParamsV1,
): ManagedMachinePresetStoredContentV1 | null {
  try {
    const setup = MachineSetupV1Schema.safeParse(params.setup);
    if (!setup.success) return null;
    if (params.mode === 'plain') {
      return replaceManagedMachinePresetExistingContentV1({
        presetId: params.presetId,
        mode: 'plain',
        content: params.content,
        replace: content => replacePresetSetup(content, setup.data),
      });
    }
    return replaceManagedMachinePresetExistingContentV1({
      presetId: params.presetId,
      mode: 'e2ee',
      content: params.content,
      recipients: params.recipients,
      accountId: params.accountId,
      accountKey: params.accountKey,
      randomBytes: params.randomBytes,
      replace: content => replacePresetSetup(content, setup.data),
    });
  } catch {
    return null;
  }
}

/** Daemon-only private resize overlay; it cannot replace launch, setup, review, or any other private field. */
export type ManagedMachinePresetResizeReplacementParamsV1 =
  | Readonly<{
      presetId: string;
      mode: 'plain';
      content: unknown;
      size: MachineProvisionerSizeV1;
    }>
  | Readonly<{
      presetId: string;
      mode: 'e2ee';
      content: unknown;
      recipients: readonly unknown[];
      accountId: string;
      accountKey: Uint8Array;
      size: MachineProvisionerSizeV1;
      randomBytes: (length: number) => Uint8Array;
    }>;

export function replaceManagedMachinePresetResizeV1(
  params: ManagedMachinePresetResizeReplacementParamsV1,
): ManagedMachinePresetStoredContentV1 | null {
  try {
    const size = MachineProvisionerSizeV1Schema.safeParse(params.size);
    if (!size.success) return null;
    if (params.mode === 'plain') {
      return replaceManagedMachinePresetExistingContentV1({
        presetId: params.presetId,
        mode: 'plain',
        content: params.content,
        replace: content => replacePresetResize(content, size.data),
      });
    }
    return replaceManagedMachinePresetExistingContentV1({
      presetId: params.presetId,
      mode: 'e2ee',
      content: params.content,
      recipients: params.recipients,
      accountId: params.accountId,
      accountKey: params.accountKey,
      randomBytes: params.randomBytes,
      replace: content => replacePresetResize(content, size.data),
    });
  } catch {
    return null;
  }
}

/** The existing `{content}` carrier can bind both acquire-time private choices together. */
export type ManagedMachinePresetAcquireOverrideCreateParamsV1 =
  | Readonly<{
      presetId: string;
      mode: 'plain';
      projection: unknown;
      launchName?: string;
      enrollmentIdentity?: ManagedMachineEnrollmentIdentityV1;
    }>
  | Readonly<{
      presetId: string;
      mode: 'e2ee';
      projection: unknown;
      accountId: string;
      accountKey: Uint8Array;
      launchName?: string;
      enrollmentIdentity?: ManagedMachineEnrollmentIdentityV1;
      randomBytes: (length: number) => Uint8Array;
    }>;

/**
 * Create the one acquire-time private override from the exact one-recipient
 * projection. It can change only launch.name and/or enrollment identity.
 */
export function createManagedMachinePresetAcquireOverrideV1(
  params: ManagedMachinePresetAcquireOverrideCreateParamsV1,
): ManagedMachinePresetLaunchNameOverrideV1 | null {
  const projection = ManagedMachinePresetRecipientProjectionV1Schema.safeParse(params.projection);
  if (!projection.success || !hasStoredContentTagForMode(projection.data.content, params.mode)) return null;
  let launchName: string | undefined;
  if (params.launchName !== undefined) {
    const parsed = id().safeParse(params.launchName);
    if (!parsed.success) return null;
    launchName = parsed.data;
  }
  let enrollmentIdentity: ManagedMachineEnrollmentIdentityV1 | undefined;
  if (params.enrollmentIdentity !== undefined) {
    const parsed = ManagedMachineEnrollmentIdentityV1Schema.safeParse(params.enrollmentIdentity);
    if (!parsed.success) return null;
    enrollmentIdentity = parsed.data;
  }
  if (launchName === undefined && enrollmentIdentity === undefined) return null;
  const replace = (current: ManagedMachinePresetContentV1) => {
    const named = launchName === undefined ? current
      : replacePresetLaunchName(current, launchName, undefined, undefined, undefined, undefined);
    return named === null ? null : enrollmentIdentity === undefined ? named
      : replacePresetEnrollmentIdentity(named, enrollmentIdentity);
  };
  if (params.mode === 'plain') {
    const content = replaceManagedMachinePresetExistingContentV1({
      presetId: params.presetId,
      mode: 'plain',
      content: projection.data.content,
      replace,
    });
    return content ? ManagedMachinePresetLaunchNameOverrideV1Schema.parse({ content }) : null;
  }
  if (projection.data.content.t !== 'encrypted' || projection.data.recipientEnvelope === null) return null;
  const content = replaceManagedMachinePresetExistingContentV1({
    presetId: params.presetId,
    mode: 'e2ee',
    content: projection.data.content,
    recipients: [{ accountId: params.accountId, envelope: projection.data.recipientEnvelope }],
    accountId: params.accountId,
    accountKey: params.accountKey,
    randomBytes: params.randomBytes,
    replace,
  });
  return content ? ManagedMachinePresetLaunchNameOverrideV1Schema.parse({ content }) : null;
}

/** Backwards-compatible name-only specialization of the canonical acquire owner. */
export type ManagedMachinePresetLaunchNameOverrideCreateParamsV1 =
  | Readonly<{
      presetId: string;
      mode: 'plain';
      projection: unknown;
      launchName: string;
    }>
  | Readonly<{
      presetId: string;
      mode: 'e2ee';
      projection: unknown;
      accountId: string;
      accountKey: Uint8Array;
      launchName: string;
      randomBytes: (length: number) => Uint8Array;
    }>;

export function createManagedMachinePresetLaunchNameOverrideV1(
  params: ManagedMachinePresetLaunchNameOverrideCreateParamsV1,
): ManagedMachinePresetLaunchNameOverrideV1 | null {
  return createManagedMachinePresetAcquireOverrideV1(params);
}

/**
 * Create an optional setup override from the caller's exact one-recipient
 * projection. It does not accept recipients, a census, or raw preset setup.
 */
export type ManagedMachinePresetSetupOverrideCreateParamsV1 =
  | Readonly<{
      presetId: string;
      mode: 'plain';
      projection: unknown;
      setup: MachineSetupV1;
    }>
  | Readonly<{
      presetId: string;
      mode: 'e2ee';
      projection: unknown;
      accountId: string;
      accountKey: Uint8Array;
      setup: MachineSetupV1;
      randomBytes: (length: number) => Uint8Array;
    }>;

export function createManagedMachinePresetSetupOverrideV1(
  params: ManagedMachinePresetSetupOverrideCreateParamsV1,
): ManagedMachinePresetLaunchNameOverrideV1 | null {
  const projection = ManagedMachinePresetRecipientProjectionV1Schema.safeParse(params.projection);
  if (!projection.success || !hasStoredContentTagForMode(projection.data.content, params.mode)) return null;
  if (params.mode === 'plain') {
    const content = replaceManagedMachinePresetSetupV1({
      presetId: params.presetId,
      mode: 'plain',
      content: projection.data.content,
      setup: params.setup,
    });
    return content ? ManagedMachinePresetLaunchNameOverrideV1Schema.parse({ content }) : null;
  }
  if (projection.data.content.t !== 'encrypted' || projection.data.recipientEnvelope === null) return null;
  const content = replaceManagedMachinePresetSetupV1({
    presetId: params.presetId,
    mode: 'e2ee',
    content: projection.data.content,
    recipients: [{ accountId: params.accountId, envelope: projection.data.recipientEnvelope }],
    accountId: params.accountId,
    accountKey: params.accountKey,
    setup: params.setup,
    randomBytes: params.randomBytes,
  });
  return content ? ManagedMachinePresetLaunchNameOverrideV1Schema.parse({ content }) : null;
}

/**
 * Create a private resize override from the caller's exact one-recipient
 * projection. It carries generic dimensions only inside the existing carrier.
 */
export type ManagedMachinePresetResizeOverrideCreateParamsV1 =
  | Readonly<{
      presetId: string;
      mode: 'plain';
      projection: unknown;
      size: MachineProvisionerSizeV1;
    }>
  | Readonly<{
      presetId: string;
      mode: 'e2ee';
      projection: unknown;
      accountId: string;
      accountKey: Uint8Array;
      size: MachineProvisionerSizeV1;
      randomBytes: (length: number) => Uint8Array;
    }>;

export function createManagedMachinePresetResizeOverrideV1(
  params: ManagedMachinePresetResizeOverrideCreateParamsV1,
): ManagedMachinePresetLaunchNameOverrideV1 | null {
  const projection = ManagedMachinePresetRecipientProjectionV1Schema.safeParse(params.projection);
  if (!projection.success || !hasStoredContentTagForMode(projection.data.content, params.mode)) return null;
  if (params.mode === 'plain') {
    const content = replaceManagedMachinePresetResizeV1({
      presetId: params.presetId,
      mode: 'plain',
      content: projection.data.content,
      size: params.size,
    });
    return content ? ManagedMachinePresetLaunchNameOverrideV1Schema.parse({ content }) : null;
  }
  if (projection.data.content.t !== 'encrypted' || projection.data.recipientEnvelope === null) return null;
  const content = replaceManagedMachinePresetResizeV1({
    presetId: params.presetId,
    mode: 'e2ee',
    content: projection.data.content,
    recipients: [{ accountId: params.accountId, envelope: projection.data.recipientEnvelope }],
    accountId: params.accountId,
    accountKey: params.accountKey,
    size: params.size,
    randomBytes: params.randomBytes,
  });
  return content ? ManagedMachinePresetLaunchNameOverrideV1Schema.parse({ content }) : null;
}

/** Backwards-compatible identity-only specialization of the canonical acquire owner. */
export type ManagedMachinePresetEnrollmentIdentityOverrideCreateParamsV1 =
  | Readonly<{
      presetId: string;
      mode: 'plain';
      projection: unknown;
      enrollmentIdentity: ManagedMachineEnrollmentIdentityV1;
    }>
  | Readonly<{
      presetId: string;
      mode: 'e2ee';
      projection: unknown;
      accountId: string;
      accountKey: Uint8Array;
      enrollmentIdentity: ManagedMachineEnrollmentIdentityV1;
      randomBytes: (length: number) => Uint8Array;
    }>;

export function createManagedMachinePresetEnrollmentIdentityOverrideV1(
  params: ManagedMachinePresetEnrollmentIdentityOverrideCreateParamsV1,
): ManagedMachinePresetLaunchNameOverrideV1 | null {
  return createManagedMachinePresetAcquireOverrideV1(params);
}

export type ManagedMachinePresetAcquireOverrideResolutionV1 = Readonly<{
  launchName?: string;
  enrollmentIdentity?: ManagedMachineEnrollmentIdentityV1;
}>;

/**
 * Daemon-only semantic check for the one acquire override. Both contents were
 * opened with the same admitted key; only name and/or enrollment identity may differ.
 */
export function resolveManagedMachinePresetAcquireOverrideV1(params: Readonly<{
  baseContent: unknown;
  overrideContent: unknown;
}>): ManagedMachinePresetAcquireOverrideResolutionV1 | null {
  const base = ManagedMachinePresetContentV1Schema.safeParse(params.baseContent);
  const override = ManagedMachinePresetContentV1Schema.safeParse(params.overrideContent);
  if (!base.success || !override.success) return null;
  const baseLaunch = base.data.launch;
  const overrideLaunch = override.data.launch;
  if ((baseLaunch === undefined) !== (overrideLaunch === undefined)) return null;
  const launchNameChanged = baseLaunch !== undefined && overrideLaunch !== undefined && baseLaunch.name !== overrideLaunch.name;
  const identityChanged = !sameStrictJsonValue(base.data.enrollmentIdentity, override.data.enrollmentIdentity);
  if (identityChanged && override.data.enrollmentIdentity === undefined) return null;
  if (launchNameChanged && (base.data.reviewedFacts !== undefined || override.data.reviewedFacts !== undefined)) return null;
  const expected = {
    ...base.data,
    ...(launchNameChanged ? { launch: { ...baseLaunch!, name: overrideLaunch!.name } } : {}),
    ...(identityChanged ? { enrollmentIdentity: override.data.enrollmentIdentity } : {}),
  };
  if (!sameStrictJsonValue(expected, override.data)) return null;
  if (launchNameChanged || identityChanged) return {
    ...(launchNameChanged ? { launchName: overrideLaunch!.name } : {}),
    ...(identityChanged ? { enrollmentIdentity: override.data.enrollmentIdentity! } : {}),
  };
  // A name-only caller may submit its unchanged base carrier. It is an
  // idempotent no-op, and the existing name helper has always accepted it.
  return baseLaunch !== undefined && base.data.reviewedFacts === undefined ? { launchName: baseLaunch.name } : null;
}

/** Backwards-compatible name-only specialization of the canonical acquire resolver. */
export function resolveManagedMachinePresetLaunchNameOverrideV1(params: Readonly<{
  baseContent: unknown;
  overrideContent: unknown;
}>): string | null {
  const resolved = resolveManagedMachinePresetAcquireOverrideV1(params);
  return resolved?.enrollmentIdentity === undefined ? resolved?.launchName ?? null : null;
}

/**
 * Daemon-only semantic check for an editable setup override. Both contents
 * were opened using the same admitted preset key; only setup may differ.
 */
export function resolveManagedMachinePresetSetupOverrideV1(params: Readonly<{
  baseContent: unknown;
  overrideContent: unknown;
}>): MachineSetupV1 | null {
  const base = ManagedMachinePresetContentV1Schema.safeParse(params.baseContent);
  const override = ManagedMachinePresetContentV1Schema.safeParse(params.overrideContent);
  if (!base.success || !override.success || override.data.setup === undefined) return null;
  const expected = { ...base.data, setup: override.data.setup };
  return sameStrictJsonValue(expected, override.data) ? override.data.setup : null;
}

/**
 * Daemon-only semantic check for an admitted resize. Both contents were opened
 * under the same key; exactly the generic private resize request may differ.
 */
export function resolveManagedMachinePresetResizeOverrideV1(params: Readonly<{
  baseContent: unknown;
  overrideContent: unknown;
}>): MachineProvisionerSizeV1 | null {
  const base = ManagedMachinePresetContentV1Schema.safeParse(params.baseContent);
  const override = ManagedMachinePresetContentV1Schema.safeParse(params.overrideContent);
  if (!base.success || !override.success || override.data.resize === undefined) return null;
  const expected = { ...base.data, resize: override.data.resize };
  return sameStrictJsonValue(expected, override.data) ? override.data.resize : null;
}

/** Backwards-compatible identity-only specialization of the canonical acquire resolver. */
export function resolveManagedMachinePresetEnrollmentIdentityOverrideV1(params: Readonly<{
  baseContent: unknown;
  overrideContent: unknown;
}>): ManagedMachineEnrollmentIdentityV1 | null {
  const resolved = resolveManagedMachinePresetAcquireOverrideV1(params);
  return resolved?.launchName === undefined ? resolved?.enrollmentIdentity ?? null : null;
}

export type ManagedMachinePresetContentOpenParamsV1 =
  | Readonly<{ presetId: string; mode: 'plain'; content: unknown }>
  | Readonly<{
      presetId: string;
      mode: 'e2ee';
      content: unknown;
      recipients: readonly unknown[];
      accountId: string;
      accountKey: Uint8Array;
    }>;

/** Open only the arm selected by the captured Account mode and recipient key. */
export function openManagedMachinePresetContentV1(
  params: ManagedMachinePresetContentOpenParamsV1,
): ManagedMachinePresetContentV1 | null {
  try {
    const presetId = parsePresetId(params.presetId);
    const stored = createStoredReadSchema(ManagedMachinePresetStoredContentV1Schema).safeParse(params.content);
    if (!stored.success) return null;
    if (params.mode === 'plain') return stored.data.t === 'plain' ? stored.data.v : null;
    if (stored.data.t !== 'encrypted' || !(params.accountKey instanceof Uint8Array)) return null;
    return openEncryptedPresetContent({
      presetId,
      content: stored.data,
      recipients: params.recipients,
      accountId: params.accountId,
      accountKey: params.accountKey,
    }, true)?.content ?? null;
  } catch {
    return null;
  }
}

/** Open the server's one-recipient projection without rebuilding recipient policy in a client. */
export type ManagedMachinePresetRecipientProjectionOpenParamsV1 =
  | Readonly<{ presetId: string; mode: 'plain'; projection: unknown }>
  | Readonly<{
      presetId: string;
      mode: 'e2ee';
      projection: unknown;
      accountId: string;
      accountKey: Uint8Array;
    }>;

export function openManagedMachinePresetRecipientProjectionV1(
  params: ManagedMachinePresetRecipientProjectionOpenParamsV1,
): ManagedMachinePresetContentV1 | null {
  const projection = ManagedMachinePresetRecipientProjectionV1Schema.safeParse(params.projection);
  if (!projection.success) return null;
  if (params.mode === 'plain') {
    return openManagedMachinePresetContentV1({
      presetId: params.presetId,
      mode: 'plain',
      content: projection.data.content,
    });
  }
  if (projection.data.content.t !== 'encrypted' || projection.data.recipientEnvelope === null) return null;
  return openManagedMachinePresetContentV1({
    presetId: params.presetId,
    mode: 'e2ee',
    content: projection.data.content,
    recipients: [{ accountId: params.accountId, envelope: projection.data.recipientEnvelope }],
    accountId: params.accountId,
    accountKey: params.accountKey,
  });
}
